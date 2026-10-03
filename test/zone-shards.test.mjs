import test from 'node:test';
import assert from 'node:assert/strict';
import {createZoneShards,zoneWorkerCount,zoneShardIndex,worldWorkerBudget} from '../server/zone-shards.mjs';
const workerUrl=new URL('./fixtures/zone-failure-worker.mjs',import.meta.url);
test('zone assignment is stable and worker configuration is bounded',()=>{
 assert.equal(zoneWorkerCount('auto',8),4);assert.equal(zoneWorkerCount('auto',2),0);assert.equal(zoneWorkerCount(0),0);assert.throws(()=>zoneWorkerCount(-1));assert.throws(()=>zoneWorkerCount(17));
 assert.deepEqual(worldWorkerBudget('auto','auto',8),{zoneWorkers:4,workerCount:2});assert.deepEqual(worldWorkerBudget('0','auto',8),{zoneWorkers:0,workerCount:6});assert.deepEqual(worldWorkerBudget('auto','auto',2),{zoneWorkers:0,workerCount:0});
 assert.equal(zoneShardIndex('princess-rose',4),zoneShardIndex('princess-rose',4));assert.throws(()=>createZoneShards({size:2,filename:':memory:'}));
 assert.deepEqual(worldWorkerBudget('5','5',12),{zoneWorkers:5,workerCount:5});assert.deepEqual(worldWorkerBudget('auto','auto',10),{zoneWorkers:4,workerCount:4}); // Production overrides take precedence over the generic automatic budget.
});
test('zone workers run different zones on different threads and recover after failure',async()=>{
 const pool=createZoneShards({size:2,filename:'fixture',workerUrl,timeoutMs:300});try{
  await pool.ready();const other=Array.from({length:10},(_,n)=>'zone-'+n).find(z=>zoneShardIndex(z,2)!==zoneShardIndex('first',2));
  const [a,b]=await Promise.all([pool.render('first',{}),pool.render(other,{})]);assert.notDeepEqual(a,b);assert.deepEqual(await pool.render('first',{}),a);
  await assert.rejects(pool.render('first',{mode:'crash'}),/interrupted/);await pool.render('first',{});
  await assert.rejects(pool.render('first',{mode:'hang'}),/interrupted/);await pool.render('first',{});assert.equal(pool.snapshot().workers.reduce((n,w)=>n+w.failed,0),2);
 }finally{await pool.close();}
});
test('a bounded zone queue and shutdown reject pending work without duplicate dispatch',async()=>{
 const pool=createZoneShards({size:1,filename:'fixture',workerUrl,maxQueue:1});await pool.ready();
 const first=pool.render('one',{mode:'hang'}),second=pool.render('one',{}),settled=Promise.allSettled([first,second]);
 await assert.rejects(pool.render('one',{}),/busy/);assert.equal(pool.snapshot().rejected,1);
 await pool.close();assert.deepEqual((await settled).map(v=>v.status),['rejected','rejected']);await assert.rejects(pool.render('one',{}),/shutting down/);await assert.rejects(pool.ready(),/shutting down/);await pool.close();
});

test('an idle core serves queued reads from a hot zone without waiting for its preferred worker',async()=>{
 const pool=createZoneShards({size:2,filename:'fixture',workerUrl,timeoutMs:500});try{
  await pool.ready();const first=pool.render('crowded',{mode:'hang'}),failed=assert.rejects(first,/interrupted/),second=await pool.render('crowded',{});
  assert.ok(second.length);assert.equal(pool.snapshot().workers.reduce((n,w)=>n+w.completed,0),1);assert.equal(pool.snapshot().busy,1);await failed;
 }finally{await pool.close();}
});
