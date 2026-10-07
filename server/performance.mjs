import {performance,monitorEventLoopDelay,createHistogram} from 'node:perf_hooks';
import {availableParallelism} from 'node:os';
import {randomUUID} from 'node:crypto';

const RETENTION_MS=24*60*60*1000,MAX_SAMPLES=1440,SAMPLE_MS=60000;
const rounded=value=>Number.isFinite(value)?Math.round(Math.max(0,value)*100)/100:null;
const emptyRequests=()=>({completed:0,clientErrors:0,serverErrors:0,throttled:0,aborted:0,totalMs:0,maxMs:0});
const PROBE_MS=100;
const emptyLag=()=>({slowRequests:0,severeRequests:0,loopStalls:0,maxLoopLagMs:0,requestThresholdMs:250,severeThresholdMs:1000,loopThresholdMs:100,probeMs:PROBE_MS}); // Store thresholds with each sample so history keeps its original meaning.

// db.write_lock: how long the coordinator's connection holds SQLite's single write lock. Every command runs in one
// BEGIN IMMEDIATE transaction with its game logic inside, so this row's total, divided by the interval, is the share of
// time no other writer could commit. It sets the ceiling of any multi-writer design (several coordinators, optimistic
// writes): at 100% writers can only queue. Measured from node:sqlite's isTransaction flag rather than by parsing SQL,
// so BEGIN, SAVEPOINT/RELEASE, ROLLBACK TO and a failed COMMIT are all counted correctly. Autocommit statements outside
// a transaction (single quick writes) are not included.
export function timeWriteLock(db,observe,clock=()=>performance.now()){
 if(db.writeLockTimed||typeof db.isTransaction!=='boolean')return db; // Once per handle; skip quietly on a Node without isTransaction.
 const run=db.exec.bind(db);let started=null; // The exec below us (statement cache, balance stats) and when the open transaction began.
 db.exec=sql=>{
  const before=db.isTransaction;
  try{return run(sql);}
  finally{
   const after=db.isTransaction;
   if(!before&&after)started=clock(); // BEGIN / outermost SAVEPOINT: the lock is now held.
   else if(before&&!after&&started!==null){observe('db.write_lock',clock()-started);started=null;} // COMMIT / ROLLBACK / outermost RELEASE: released.
  }
 };
 Object.defineProperty(db,'writeLockTimed',{value:true});
 return db;
}

export function createPerformanceMonitor(db,{
 now=Date.now,clock=()=>performance.now(),cpuUsage=()=>process.cpuUsage(),memoryUsage=()=>process.memoryUsage(),
 loopUsage=()=>performance.eventLoopUtilization(),delay=monitorEventLoopDelay({resolution:20}),
 cores=availableParallelism(),automatic=true,probeLag=automatic,log=console.warn,workers=()=>null,shards=()=>null, // probeLag: run the 100 ms stall heartbeat even when sampling is manual (deploy/crowd-test.mjs takes its own samples).
}={}){
 db.exec('CREATE TABLE IF NOT EXISTS server_performance_samples(id INTEGER PRIMARY KEY,sampled_at INTEGER NOT NULL,data TEXT NOT NULL)');
 const insert=db.prepare('INSERT INTO server_performance_samples(sampled_at,data) VALUES (?,?)');
 const prune=()=>{ // Bound disk usage by both age and row count, even after a wall-clock adjustment.
  db.prepare('DELETE FROM server_performance_samples WHERE sampled_at<?').run(now()-RETENTION_MS);
  db.exec('DELETE FROM server_performance_samples WHERE id NOT IN (SELECT id FROM server_performance_samples ORDER BY id DESC LIMIT 1440)');
 };
 prune();
 const session=randomUUID(),startedAt=now();
 const requestLatency=createHistogram(); // A bounded histogram records request percentiles without storing individual requests.
 let baseline={at:clock(),cpu:cpuUsage(),loop:loopUsage()},requests=emptyRequests(),lag=emptyLag(),lastProbe=baseline.at,timings=new Map(),active=0,peakActive=0,closed=false,recordingError=false;
 delay.enable(); // This histogram observes stalls without recording request bodies or account identifiers.

 function observe(name,elapsed,failed=false){
  if(!timings.has(name)&&timings.size>=128)return; // Instrumentation labels are code-owned; keep a hard ceiling as a second guard.
  const row=timings.get(name)??{name,calls:0,errors:0,totalMs:0,maxMs:0};
  row.calls++;row.errors+=Number(failed);row.totalMs+=elapsed;row.maxMs=Math.max(row.maxMs,elapsed);timings.set(name,row);
 }
 function measure(name,work){
  const start=clock();let failed=true;
  try{const result=work();failed=false;return result;}finally{observe(name,clock()-start,failed);}
 } // Synchronous scopes include SQLite time and may nest; their durations must not be added together.
 async function measureAsync(name,work){
  const start=clock();let failed=true;
  try{const result=await work();failed=false;return result;}finally{observe(name,clock()-start,failed);}
 } // Async elapsed time includes network waits and is deliberately not labelled CPU time.
 function request(res){
  const start=clock();active++;peakActive=Math.max(peakActive,active);let finished=false;
  function finish(){
   if(finished)return;finished=true;active--;res.off('finish',finish);res.off('close',finish);
   const elapsed=clock()-start;requests.completed++;requests.totalMs+=elapsed;requests.maxMs=Math.max(requests.maxMs,elapsed);requestLatency.record(Math.max(1,Math.round(elapsed*1e6)));
   if(elapsed>=lag.requestThresholdMs)lag.slowRequests++;
   if(elapsed>=lag.severeThresholdMs)lag.severeRequests++; // One-second responses are a subset of slow responses, including errors and disconnected requests.
   if(!res.writableFinished)requests.aborted++;
   else if(res.statusCode>=500)requests.serverErrors++;
   else if(res.statusCode>=400)requests.clientErrors++;
   if(res.statusCode===429)requests.throttled++;
  }
  res.once('finish',finish);res.once('close',finish);
 } // Track each gameplay response once, including rejected requests and disconnected clients.

 function capture(){
  const at=clock(),cpu=cpuUsage(),loop=loopUsage(),memory=memoryUsage(),elapsed=at-baseline.at;
  const busy=loop.active-baseline.loop.active,idle=loop.idle-baseline.loop.idle;
  const row={session,at:now(),elapsedMs:rounded(elapsed),
   cpuPercent:elapsed>0?rounded(((cpu.user-baseline.cpu.user)+(cpu.system-baseline.cpu.system))/(elapsed*10)):null,
   eventLoopPercent:busy+idle>0?rounded(100*busy/(busy+idle)):null,
   delayP95Ms:delay.count?rounded(delay.percentile(95)/1e6):null,delayMaxMs:delay.count?rounded(delay.max/1e6):null,
   rssMiB:rounded(memory.rss/1048576),heapMiB:rounded(memory.heapUsed/1048576),workers:workers(),shards:shards(),lag:{...lag,maxLoopLagMs:rounded(lag.maxLoopLagMs)},
   requests:{...requests,totalMs:rounded(requests.totalMs),maxMs:rounded(requests.maxMs),active,peakActive,
    perSecond:elapsed>0?rounded(requests.completed*1000/elapsed):null,meanMs:requests.completed?rounded(requests.totalMs/requests.completed):null,p95Ms:requestLatency.count?rounded(requestLatency.percentile(95)/1e6):null},
   timings:[...timings.values()].map(t=>({...t,totalMs:rounded(t.totalMs),maxMs:rounded(t.maxMs),meanMs:rounded(t.totalMs/t.calls)})).sort((a,b)=>b.totalMs-a.totalMs)};
  return {row,baseline:{at,cpu,loop}};
 } // Process CPU uses 100% for one fully occupied core; native/background threads can take it above 100%.
 function sample(){
  if(closed)return;
  const value=capture();if(value.row.elapsedMs<1)return;
  try{insert.run(value.row.at,JSON.stringify(value.row));prune();recordingError=false;}
  catch{recordingError=true;log('quest_performance_recording_failed');} // A telemetry write failure must not stop gameplay or expose database details.
  baseline=value.baseline;requests=emptyRequests();lag=emptyLag();timings=new Map();peakActive=active;delay.reset();requestLatency.reset();
  return value.row;
 }
 const probe=probeLag?setInterval(()=>{
  const at=clock(),late=Math.max(0,at-lastProbe-PROBE_MS);lastProbe=at;
  lag.maxLoopLagMs=Math.max(lag.maxLoopLagMs,late);if(late>=lag.loopThresholdMs)lag.loopStalls++;
 },PROBE_MS):null;probe?.unref(); // Count one delayed heartbeat when the loop resumes, not every missed beat; subtract the scheduled wait.
 const timer=automatic?setInterval(sample,SAMPLE_MS):null;timer?.unref();
 function snapshot(){
  const cutoff=now()-RETENTION_MS;
  const history=db.prepare("SELECT json_remove(data,'$.timings') AS data FROM server_performance_samples WHERE sampled_at>=? AND json_valid(data) ORDER BY id DESC LIMIT ?").all(cutoff,MAX_SAMPLES).reverse().map(row=>JSON.parse(row.data));
  const last=db.prepare('SELECT data FROM server_performance_samples WHERE sampled_at>=? AND json_valid(data) ORDER BY id DESC LIMIT 1').get(cutoff);
  return {startedAt,session,availableCores:cores,sampleMs:SAMPLE_MS,retentionMs:RETENTION_MS,recordingError,current:capture().row,latest:last?JSON.parse(last.data):null,history};
 } // Reading the panel never resets counters; history continues collecting while the panel is closed.
 function close(){if(closed)return;clearInterval(timer);clearInterval(probe);if(clock()-baseline.at>=1000)sample();closed=true;delay.disable();}
 return {measure,measureAsync,observe,request,sample,snapshot,close};
}
