import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createPerformanceMonitor} from '../server/performance.mjs';

function harness({automatic=false}={}){
 const db=new DatabaseSync(':memory:');let time=0,wall=1_800_000_000_000,user=0,system=0,active=0,idle=0,disabled=false;
 const delay={count:2,max:80e6,percentile:()=>25e6,enable(){},disable(){disabled=true;},reset(){this.count=0;}};
 const options={automatic,clock:()=>time,now:()=>wall,cpuUsage:()=>({user,system}),loopUsage:()=>({active,idle}),memoryUsage:()=>({rss:100*1048576,heapUsed:40*1048576}),delay,cores:4,log:()=>{}};
 const monitor=createPerformanceMonitor(db,options);
 return {db,options,monitor,delay,disabled:()=>disabled,
  advance(ms,{cpu=0,kernel=0,busy=0}={}){time+=ms;wall+=ms;user+=cpu;system+=kernel;active+=busy;idle+=ms-busy;},
  close(){monitor.close();db.close();}};
}

test('CPU is measured per core with monotonic elapsed time; reads never consume counters',()=>{
 const h=harness();try{
  h.advance(1000,{cpu:1_250_000,kernel:250_000,busy:800});
  const first=h.monitor.snapshot();assert.equal(first.current.cpuPercent,150);assert.equal(first.current.eventLoopPercent,80);
  assert.equal(first.current.delayP95Ms,25);assert.equal(first.current.delayMaxMs,80);
  assert.equal(first.current.rssMiB,100);assert.equal(first.current.heapMiB,40);assert.equal(first.availableCores,4);
  assert.deepEqual(h.monitor.snapshot(),first); // Multiple open admin tabs cannot change the measurement interval.
  h.monitor.sample();assert.equal(h.monitor.snapshot().history.length,1);
  h.advance(1000,{cpu:200_000,busy:100});const next=h.monitor.snapshot().current;
  assert.equal(next.cpuPercent,20);assert.equal(next.eventLoopPercent,10);assert.equal(next.delayP95Ms,null);
 }finally{h.close();}assert.equal(h.disabled(),true);
});

test('timing scopes preserve return values and errors, including overlapping async work',async()=>{
 const h=harness();try{
  const expected=Error('synthetic failure');
  assert.equal(h.monitor.measure('generation',()=>{h.advance(20);return 17;}),17);
  assert.throws(()=>h.monitor.measure('generation',()=>{h.advance(5);throw expected;}),error=>error===expected);
  let release;const waiting=h.monitor.measureAsync('account.authenticate',()=>new Promise(resolve=>{release=resolve;}));
  h.monitor.measure('simulation',()=>h.advance(10));release('ok');assert.equal(await waiting,'ok');
  await assert.rejects(h.monitor.measureAsync('account.authenticate',async()=>{h.advance(5);throw expected;}),error=>error===expected);
  const timings=h.monitor.snapshot().current.timings,gen=timings.find(t=>t.name==='generation'),auth=timings.find(t=>t.name==='account.authenticate');
  assert.deepEqual(gen,{name:'generation',calls:2,errors:1,totalMs:25,maxMs:20,meanMs:12.5});
  assert.equal(auth.totalMs,15);assert.equal(auth.errors,1);
  h.monitor.sample();assert.equal(h.monitor.snapshot().current.timings.length,0);
  assert.deepEqual(h.monitor.snapshot().latest.timings,timings);
  assert.equal(h.monitor.snapshot().history[0].timings,undefined); // Historical charts do not repeatedly download every detailed timing bucket.
 }finally{h.close();}
});

test('gameplay response counters handle rejection, in-flight requests, and disconnects exactly once',()=>{
 const h=harness();try{
  const response=status=>Object.assign(new EventEmitter(),{statusCode:status,writableFinished:true});
  const success=response(200),throttled=response(429),failure=response(503),aborted=response(200);
  for(const res of [success,throttled,failure,aborted])h.monitor.request(res);
  h.advance(100);success.emit('finish');success.emit('close');throttled.emit('finish');failure.emit('finish');
  h.monitor.sample();const saved=h.monitor.snapshot().history[0].requests;
  assert.equal(saved.completed,3);assert.equal(saved.active,1);assert.equal(saved.peakActive,4);assert.equal(saved.throttled,1);
  assert.equal(saved.clientErrors,1);assert.equal(saved.serverErrors,1);assert.equal(saved.meanMs,100);assert.equal(saved.perSecond,30);
  h.advance(100);aborted.writableFinished=false;aborted.emit('close');aborted.emit('finish');
  const next=h.monitor.snapshot().current.requests;assert.equal(next.completed,1);assert.equal(next.aborted,1);assert.equal(next.active,0);assert.equal(next.maxMs,200);
 }finally{h.close();}
});

test('history survives monitor restarts and is bounded by age and sample count',()=>{
 const h=harness();let restarted;try{
  h.advance(60000,{cpu:1e6});h.monitor.sample();const saved=h.monitor.snapshot().history[0];h.monitor.close();
  restarted=createPerformanceMonitor(h.db,h.options);
  assert.deepEqual(restarted.snapshot().history,[saved]);assert.notEqual(restarted.snapshot().session,saved.session);
  const insert=h.db.prepare('INSERT INTO server_performance_samples(sampled_at,data) VALUES (?,?)');
  h.db.exec('BEGIN');for(let i=0;i<1500;i++)insert.run(saved.at,JSON.stringify(saved));h.db.exec('COMMIT');
  h.advance(60000);restarted.sample();assert.equal(h.db.prepare('SELECT COUNT(*) n FROM server_performance_samples').get().n,1440);
  h.advance(86400001);restarted.sample();assert.equal(restarted.snapshot().history.length,1);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM server_performance_samples').get().n,1);
 }finally{restarted?.close();h.close();}
});

test('a metrics write failure is visible and does not throw into gameplay',()=>{
 const h=harness();try{
  h.db.exec("CREATE TRIGGER no_metrics BEFORE INSERT ON server_performance_samples BEGIN SELECT RAISE(FAIL,'synthetic disk failure'); END;");
  h.advance(60000);assert.doesNotThrow(()=>h.monitor.sample());assert.equal(h.monitor.snapshot().recordingError,true);
  assert.equal(h.monitor.measure('still-working',()=>12),12);
  h.db.exec('DROP TRIGGER no_metrics');h.advance(60000);h.monitor.sample();assert.equal(h.monitor.snapshot().recordingError,false);
 }finally{h.close();}
});

test('the minute timer records with no dashboard reads and shutdown saves one partial interval',t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const h=harness({automatic:true});try{
  h.advance(60000,{cpu:30e6,busy:30000});t.mock.timers.tick(60000);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM server_performance_samples').get().n,1);
  assert.equal(h.monitor.snapshot().latest.cpuPercent,50);
  h.advance(5000,{cpu:1e6,busy:1000});h.monitor.close();h.monitor.close();
  const rows=h.db.prepare('SELECT data FROM server_performance_samples ORDER BY id').all();assert.equal(rows.length,2);
  assert.equal(JSON.parse(rows[1].data).elapsedMs,5000);assert.equal(h.disabled(),true);
  h.advance(60000);t.mock.timers.tick(60000);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM server_performance_samples').get().n,2);
 }finally{h.close();}
});
