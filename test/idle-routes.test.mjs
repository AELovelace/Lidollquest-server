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
