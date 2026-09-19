import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {availableParallelism} from 'node:os';
import {randomUUID} from 'node:crypto';

const RETENTION_MS=24*60*60*1000,MAX_SAMPLES=1440,SAMPLE_MS=60000;
const rounded=value=>Number.isFinite(value)?Math.round(Math.max(0,value)*100)/100:null;
const emptyRequests=()=>({completed:0,clientErrors:0,serverErrors:0,throttled:0,aborted:0,totalMs:0,maxMs:0});

export function createPerformanceMonitor(db,{
 now=Date.now,clock=()=>performance.now(),cpuUsage=()=>process.cpuUsage(),memoryUsage=()=>process.memoryUsage(),
 loopUsage=()=>performance.eventLoopUtilization(),delay=monitorEventLoopDelay({resolution:20}),
 cores=availableParallelism(),automatic=true,log=console.warn,
}={}){
 db.exec('CREATE TABLE IF NOT EXISTS server_performance_samples(id INTEGER PRIMARY KEY,sampled_at INTEGER NOT NULL,data TEXT NOT NULL)');
 const insert=db.prepare('INSERT INTO server_performance_samples(sampled_at,data) VALUES (?,?)');
 const prune=()=>{ // Bound disk usage by both age and row count, even after a wall-clock adjustment.
  db.prepare('DELETE FROM server_performance_samples WHERE sampled_at<?').run(now()-RETENTION_MS);
  db.exec('DELETE FROM server_performance_samples WHERE id NOT IN (SELECT id FROM server_performance_samples ORDER BY id DESC LIMIT 1440)');
 };
 prune();
 const session=randomUUID(),startedAt=now();
 let baseline={at:clock(),cpu:cpuUsage(),loop:loopUsage()},requests=emptyRequests(),timings=new Map(),active=0,peakActive=0,closed=false,recordingError=false;
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
   const elapsed=clock()-start;requests.completed++;requests.totalMs+=elapsed;requests.maxMs=Math.max(requests.maxMs,elapsed);
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
   rssMiB:rounded(memory.rss/1048576),heapMiB:rounded(memory.heapUsed/1048576),
   requests:{...requests,totalMs:rounded(requests.totalMs),maxMs:rounded(requests.maxMs),active,peakActive,
    perSecond:elapsed>0?rounded(requests.completed*1000/elapsed):null,meanMs:requests.completed?rounded(requests.totalMs/requests.completed):null},
   timings:[...timings.values()].map(t=>({...t,totalMs:rounded(t.totalMs),maxMs:rounded(t.maxMs),meanMs:rounded(t.totalMs/t.calls)})).sort((a,b)=>b.totalMs-a.totalMs)};
  return {row,baseline:{at,cpu,loop}};
 } // Process CPU uses 100% for one fully occupied core; native/background threads can take it above 100%.
 function sample(){
  if(closed)return;
  const value=capture();if(value.row.elapsedMs<1)return;
  try{insert.run(value.row.at,JSON.stringify(value.row));prune();recordingError=false;}
  catch{recordingError=true;log('quest_performance_recording_failed');} // A telemetry write failure must not stop gameplay or expose database details.
  baseline=value.baseline;requests=emptyRequests();timings=new Map();peakActive=active;delay.reset();
  return value.row;
 }
 const timer=automatic?setInterval(sample,SAMPLE_MS):null;timer?.unref();
 function snapshot(){
  const cutoff=now()-RETENTION_MS;
  const history=db.prepare("SELECT json_remove(data,'$.timings') AS data FROM server_performance_samples WHERE sampled_at>=? AND json_valid(data) ORDER BY id DESC LIMIT ?").all(cutoff,MAX_SAMPLES).reverse().map(row=>JSON.parse(row.data));
  const last=db.prepare('SELECT data FROM server_performance_samples WHERE sampled_at>=? AND json_valid(data) ORDER BY id DESC LIMIT 1').get(cutoff);
  return {startedAt,session,availableCores:cores,sampleMs:SAMPLE_MS,retentionMs:RETENTION_MS,recordingError,current:capture().row,latest:last?JSON.parse(last.data):null,history};
 } // Reading the panel never resets counters; history continues collecting while the panel is closed.
 function close(){if(closed)return;clearInterval(timer);if(clock()-baseline.at>=1000)sample();closed=true;delay.disable();}
 return {measure,measureAsync,request,sample,snapshot,close};
}
