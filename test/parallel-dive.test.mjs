import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {createQuestZones} from '../server/zones.mjs';
import {generateFloor,enemyRoams,pathTo,walkable,inside} from '../server/dive-generation.mjs';
import {diveData} from '../server/dive.mjs';
import {computeTask} from '../server/compute-tasks.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),character,pending;const measures=[];
 const compute={submit(kind,input){assert.equal(kind,'paths');assert.equal(pending,undefined);return new Promise((resolve,reject)=>{pending={input:structuredClone(input),resolve,reject};});}};
 const api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},measure:(name,work)=>{measures.push(name);return work();},diveOptions:{compute,generate:(...args)=>generateFloor(...args),log:()=>{}}});
 const act=(action,extra={})=>{const result=api.act('',{action,request_id:randomUUID(),controller:'a',character_id:character?.id,revision:character?.revision,...extra});character=result.character;return result;};
 act('create',{name:'Walker'});act('enter',{zone:'princess-rose',loadout:{player_info:{playerHealth:100,playerHealthMax:100,str:4,def:4},inventory:[]},combat_version:2});act('dive_enter');
 const visit=character.dive,record=()=>db.prepare('SELECT * FROM dive_editions WHERE route=? AND edition=?').get(visit.route,visit.edition);
 const saveFloor=f=>db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=?').run(JSON.stringify(f),visit.route,visit.edition);
 const f=JSON.parse(record().content),foe=f.enemies.find(e=>enemyRoams(diveData,e));let path;
 const safe=f.safeRooms??f.rooms.slice(0,1),others=new Set(f.enemies.filter(e=>e.id!==foe.id).map(e=>e.x+','+e.y));
 for(let y=1;y<f.height-1&&!path;y++)for(let x=1;x<f.width-1&&!path;x++){
  if(!walkable(f,x,y)||safe.some(r=>inside(r,x,y)))continue;
  const candidate=pathTo(f,foe,{x,y},3);
  if(candidate?.length===3&&candidate.every(p=>!others.has(p.x+','+p.y)&&!safe.some(r=>inside(r,p.x,p.y))))path=candidate;
 }
 assert.ok(path);for(const enemy of f.enemies)if(enemy.id!==foe.id)enemy.roaming=false;saveFloor(f);
 const state=()=>JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(character.id).state);
 const saveState=s=>db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(s),character.id);
 const target=path.at(-1),s=state();s.dive.position=target;s.dive.safeUntil=0;saveState(s);
 db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(target.x,target.y,character.id);
 return {db,api,path,foe,character,state,saveState,record,saveFloor,measures,
  tick(ms=1100){time+=ms;api.tick();},advance:ms=>time+=ms,
  async finish(){assert.ok(pending);const job=pending;pending=undefined;job.resolve(computeTask('paths',job.input));await setImmediate();},
  close(){api.close();db.close();}};
} // Deferred calculations let tests change authoritative state while the worker is busy.

test('parallel pursuit matches synchronous movement and starts exactly one encounter on contact',async()=>{
 const h=fixture();try{
  for(let step=0;step<3;step++){
   h.tick();h.db.exec('BEGIN');h.db.exec('ROLLBACK'); // A pending worker must never hold the writer transaction open.
   await h.finish();const foe=JSON.parse(h.record().content).enemies.find(e=>e.id===h.foe.id);
   if(step<2)assert.deepEqual({x:foe.x,y:foe.y},h.path[step]);
  }
  assert.equal(h.state().run?.encounter,h.foe.id);assert.equal(JSON.parse(h.record().content).enemies.filter(e=>e.engaged===h.character.id).length,1);
 }finally{h.close();}
});
test('parallel pursuit creates one current-protocol shared encounter',async()=>{
 const h=fixture();try{
  const s=h.state();s.diveCombatVersion=3;h.saveState(s);
  for(let step=0;step<3;step++){h.tick();await h.finish();}
  const run=h.state().run;assert.ok(run.sharedEncounter);assert.equal(run.encounter,h.foe.id);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM quest_dive_encounters').get().n,1);
  assert.equal(JSON.parse(h.record().content).enemies.find(e=>e.id===h.foe.id).engaged,run.sharedEncounter);
 }finally{h.close();}
});
test('worker delivery latency preserves the one-second pursuit cadence',async()=>{
 const h=fixture();try{
  const initial=h.record().updated;
  h.tick(1000);h.advance(25);await h.finish();assert.equal(h.record().updated,initial+1000);
  h.tick(975);h.advance(25);await h.finish();assert.equal(h.record().updated,initial+2000);
  const foe=JSON.parse(h.record().content).enemies.find(e=>e.id===h.foe.id);assert.deepEqual({x:foe.x,y:foe.y},h.path[1]);
 }finally{h.close();}
});
for(const change of ['position','floor','edition'])test('parallel pursuit discards stale '+change+' results',async()=>{
 const h=fixture();try{
  h.tick();
  if(change==='position')h.db.prepare('UPDATE quest_presence SET x=x+1 WHERE character_id=?').run(h.character.id);
  if(change==='floor'){const f=JSON.parse(h.record().content);f.enemies[0].engaged='another-character';h.saveFloor(f);}
  if(change==='edition'){const row=h.record();h.db.prepare('INSERT INTO dive_editions VALUES (?,?,1,?,?,?,?)').run(row.route,'newer-edition',row.starts+1,row.ends+1,row.content,row.updated);}
  const before=h.record().content;await h.finish();assert.equal(h.record().content,before);assert.equal(h.state().run,null);assert.ok(h.measures.includes('worker.stale.paths'));
 }finally{h.close();}
});
test('parallel pursuit starts combat using fresh inventory and character revision',async()=>{
 const h=fixture();try{
  h.tick();await h.finish();h.tick();await h.finish();
  h.tick();const s=h.state();s.loadout.inventory.push({item_id:'synthetic-keepsake'});h.saveState(s);
  const revision=h.db.prepare('SELECT revision FROM quest_characters WHERE id=?').get(h.character.id).revision;
  await h.finish();assert.equal(h.state().loadout.inventory[0].item_id,'synthetic-keepsake');assert.equal(h.state().run.encounter,h.foe.id);
  assert.ok(h.db.prepare('SELECT revision FROM quest_characters WHERE id=?').get(h.character.id).revision>revision);
 }finally{h.close();}
});
for(const stateKey of ['run','pendingDefeat','worldTurnDue'])test('parallel pursuit rechecks new '+stateKey+' before engaging',async()=>{
 const h=fixture();try{
  h.tick();await h.finish();h.tick();await h.finish();h.tick();
  const s=h.state();s[stateKey]={id:'arrived-during-computation'};h.saveState(s);await h.finish();
  assert.deepEqual(h.state()[stateKey],{id:'arrived-during-computation'});
  assert.equal(JSON.parse(h.record().content).enemies.find(e=>e.id===h.foe.id).engaged,null);
 }finally{h.close();}
});
test('parallel pursuit ignores a result after shutdown',async()=>{
 const h=fixture();try{
  h.tick();h.close();await h.finish(); // Closing SQLite before delivery must not produce an unhandled rejection or late write.
 }finally{h.api.close();if(h.db.isOpen)h.db.close();}
});
