import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createQuestZones} from '../server/zones.mjs';

// Empty routes must not read and decode their whole floor every second: with ~22 routes
// that alone kept the world timer near 120 ms per tick for a single online player.
test('empty routes skip floor decoding between sweeps and resume it on their sweep deadline',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-16T12:00:00Z');const counts=new Map(); // counts: label -> calls this window.
 const measure=(name,work)=>{counts.set(name,(counts.get(name)??0)+1);return work();}; // Spy stand-in for the performance monitor.
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,measure,grant:()=>({owner:'alice',id:'alice',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 try{
  zones.tick();time+=1000;zones.tick(); // First ticks generate every weekly floor and run one full pass per route.
  counts.clear();
  for(let n=0;n<5;n++){time+=1000;zones.tick();} // Five idle seconds, nobody present anywhere.
  assert.equal(counts.get('floor.decode')??0,0,'idle routes stay settled without decoding floors');
  time+=20000;zones.tick(); // Past the 15 s idle sweep deadline.
  assert.ok((counts.get('floor.decode')??0)>0,'an idle route still runs its full pass on its sweep deadline');
 }finally{zones.close();db.close();}
});

test('the remembered weekly window matches a fresh calculation on both sides of every boundary',async()=>{
 const {weeklyWindow}=await import('../server/dive-generation.mjs');
 const fresh=t=>{const w=weeklyWindow(Date.parse('1999-01-01T00:00:00Z'));return weeklyWindow(t);}; // Asking far away first forces a real recalculation for t.
 let t=Date.parse('2026-02-20T10:00:00Z');
 for(let n=0;n<60;n++){ // ~60 weeks, crossing both DST changes; walk each boundary edge.
  const w=weeklyWindow(t);assert.deepEqual(weeklyWindow(t),w,'repeat answer is stable');assert.deepEqual(fresh(t),w,'memo equals recalculation');
  assert.deepEqual(weeklyWindow(w.ends-1),w,'last millisecond is still this week');
  const next=weeklyWindow(w.ends);assert.equal(next.start,w.ends,'the boundary instant opens the next week');assert.deepEqual(fresh(w.ends),next);
  assert.deepEqual(weeklyWindow(w.start-1),fresh(w.start-1),'going backwards recalculates');
  w.edition='edited';assert.notEqual(weeklyWindow(t).edition,'edited','callers get copies');
  t=next.start+3*86400000+12345;
 }
});
