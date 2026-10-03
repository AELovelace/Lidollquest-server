import test from 'node:test';
import assert from 'node:assert/strict';
import {createComputePool,computeWorkerCount} from '../server/compute-pool.mjs';
import {computeTask,floorKey,resolveFloor,FLOOR_CACHE_LIMIT} from '../server/compute-tasks.mjs';
import {diveData} from '../server/dive.mjs';
import {desertData} from '../server/zones.mjs';

const workerUrl=new URL('./fixtures/compute-failure-worker.mjs',import.meta.url);
test('worker count supports VM headroom and explicit rollback without accepting malformed settings',()=>{
 assert.equal(computeWorkerCount('auto',8),6);assert.equal(computeWorkerCount('auto',1),0);assert.equal(computeWorkerCount('0'),0);assert.equal(computeWorkerCount('4'),4);
 for(const value of ['',-1,'2.5','NaN',33])assert.throws(()=>computeWorkerCount(value));
});
test('real workers generate identical room/desert floors and batch paths without mutating inputs',async()=>{
 const timings=[],pool=createComputePool({size:2,observe:(...row)=>timings.push(row)});
 try{
  const inputs=[{generator:'rooms',data:diveData,edition:'2026-09-14'},{generator:'desert',data:desertData,edition:'2026-09-14'}];
  const pending=inputs.map(input=>pool.submit('generate',input));assert.equal(pool.snapshot().busy,2);
  const floors=await Promise.all(pending);
  for(let i=0;i<inputs.length;i++)assert.deepEqual(floors[i],computeTask('generate',inputs[i]));
  const floor=floors[0],input={floor,starts:[floor.entrance,floor.enemies[0]],targets:[floor.chests[0],floor.entrance],limit:20},before=JSON.stringify(input);
  assert.deepEqual(await pool.submit('paths',input),computeTask('paths',input));assert.equal(JSON.stringify(input),before);
  assert.equal(pool.snapshot().workers.reduce((n,w)=>n+w.completed,0),3);
  assert.ok(timings.some(([name])=>name==='worker.queue.paths'));assert.ok(timings.some(([name])=>name==='worker.generate'));
  await assert.rejects(pool.submit('generate',{generator:'invalid'}),/Unknown floor generator/);
  assert.deepEqual(await pool.submit('paths',input),computeTask('paths',input));
 }finally{await pool.close();}
});
test('worker crash and timeout reject their job and replacement accepts subsequent work',async()=>{
 const pool=createComputePool({size:1,workerUrl,timeoutMs:500});
 try{
  await assert.rejects(pool.submit('paths',{mode:'crash'}),/exited/);
  assert.equal(typeof await pool.submit('paths',{mode:'ok'}),'number');
  await assert.rejects(pool.submit('paths',{mode:'hang'}),/timed out/);
  assert.equal(typeof await pool.submit('paths',{mode:'ok'}),'number');
  assert.equal(pool.snapshot().workers[0].failed,2);
 }finally{await pool.close();}
});
test('bounded queue and shutdown settle all pending jobs without keeping workers alive',async()=>{
 const pool=createComputePool({size:1,maxQueue:1,workerUrl});
 const first=pool.submit('paths',{mode:'hang'}),second=pool.submit('paths',{mode:'ok'});
 const settled=Promise.allSettled([first,second]);
 await assert.rejects(pool.submit('paths',{mode:'ok'}),/queue is full/);assert.equal(pool.snapshot().rejected,1);
 await pool.close();assert.deepEqual((await settled).map(r=>r.status),['rejected','rejected']);
 await assert.rejects(pool.submit('paths',{}),/closed/);await pool.close();
});
test('keyed floors cross the thread boundary once per worker and recover from a worker-side eviction',async()=>{
 const timings=[],pool=createComputePool({size:1,observe:name=>timings.push(name),floorCacheLimit:FLOOR_CACHE_LIMIT*4}); // The pool remembers more than the worker so the worker forgets first and the resend path is exercised.
 try{
  const floor=computeTask('generate',{generator:'rooms',data:diveData,edition:'2026-09-14'}),keyed={key:floorKey('dive-test',floor.edition,floor),width:floor.width,height:floor.height,walls:floor.walls,props:floor.props};
  const input={floor:keyed,starts:[floor.entrance,floor.enemies[0]],targets:[floor.chests[0],floor.entrance],limit:20},expected=computeTask('paths',{...input,floor});
  assert.deepEqual(await pool.submit('paths',input),expected);assert.deepEqual(await pool.submit('paths',input),expected);
  assert.equal(timings.filter(n=>n==='worker.floor.sent').length,1);assert.equal(timings.filter(n=>n==='worker.floor.cached').length,1); // Second batch shipped only the key.
  for(let i=0;i<FLOOR_CACHE_LIMIT;i++)await pool.submit('paths',{floor:{key:'tiny:'+i,width:1,height:1,walls:[[0]]},starts:[],targets:[],limit:1}); // Push the real floor out of the worker's cache.
  assert.deepEqual(await pool.submit('paths',input),expected);
  assert.equal(timings.filter(n=>n==='worker.floor.resent').length,1);assert.equal(pool.snapshot().workers[0].failed,0); // The miss healed inside the same job: no error reached the caller.
  const changed=structuredClone(floor);changed.walls[floor.entrance.y][floor.entrance.x]^=1;assert.notEqual(floorKey('z','e',changed),floorKey('z','e',floor)); // Any wall change renames the floor.
  const props=structuredClone(floor);props.props[floor.entrance.y][floor.entrance.x]=1;assert.notEqual(floorKey('z','e',props),floorKey('z','e',floor));
  const cache=new Map();assert.throws(()=>resolveFloor({floor:{key:'nope'}},cache),/floor_missing/);assert.equal(resolveFloor({floor:{width:1}},cache).floor.width,1); // Unkeyed input passes straight through.
 }finally{await pool.close();}
});
