import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createQuestZones} from '../server/zones.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {diveData} from '../server/dive.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z');const jobs=[],logs=[];
 const compute={submit(kind,input){assert.equal(kind,'generate');return new Promise((resolve,reject)=>jobs.push({input:structuredClone(input),resolve,reject}));}};
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{compute,log:(...parts)=>logs.push(parts)}});
 return {api,db,jobs,logs,advance:ms=>time+=ms,count:()=>db.prepare('SELECT COUNT(*) n FROM dive_editions WHERE route=?').get(diveData.config.route).n,close(){api.close();db.close();}};
}
test('generation de-duplicates concurrent preparation and does not install a superseded weekly result',async()=>{
 const h=fixture();try{
  const first=h.api.prepare(),second=h.api.prepare();assert.equal(h.jobs.length,1);assert.equal(h.count(),0);
  h.db.exec('BEGIN');h.db.exec('ROLLBACK'); // Preparation returns control without retaining the database writer lock.
  h.advance(7*86400000);h.jobs[0].resolve(computeTask('generate',h.jobs[0].input));await Promise.all([first,second]);assert.equal(h.count(),0);
  const next=h.api.prepare();assert.equal(h.jobs.length,2);h.jobs[1].resolve(computeTask('generate',h.jobs[1].input));await next;assert.equal(h.count(),1);
  await h.api.prepare();assert.equal(h.jobs.length,2); // Restart/preparation reuses committed editions instead of rerolling them.
 }finally{h.close();}
});
test('generation failure is bounded by retry backoff and cannot write after close',async()=>{
 const h=fixture();try{
  const first=h.api.prepare();h.jobs[0].reject(Error('synthetic worker failure'));await first;
  assert.equal(h.count(),0);assert.equal(h.logs[0][0],'dive_generation_failed');await h.api.prepare();assert.equal(h.jobs.length,1);
  h.advance(60001);const second=h.api.prepare();assert.equal(h.jobs.length,2);
  const floor=computeTask('generate',h.jobs[1].input);h.close();h.jobs[1].resolve(floor);await second;
 }finally{h.api.close();if(h.db.isOpen)h.db.close();}
});
