import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {hubData} from '../server/hubs.mjs';
import {readFileSync} from 'node:fs';
const combatData=JSON.parse(readFileSync(new URL('../server/combat-data.json',import.meta.url),'utf8'));

test('saved placements, DM maps, presence and hubVisit for a retired room (the old Rose Resting Hall) never crash the service',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-23T12:00:00Z');
 const live=createWorldContent(db,{now:()=>time,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment});
 const options={now:()=>time,roll:()=>0,live,grant:()=>({owner:'alice',id:'alice',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}};
 let zones=createQuestZones(db,options);
 try{
  const act=(id,action,extra={})=>{time+=350;const s=id?zones.read('',id):null;return zones.act('',{action,request_id:randomUUID(),controller:'window',character_id:id,revision:s?.character.revision,...extra});};
  const c=act(null,'create',{name:'Alice'}).character;
  act(c.id,'enter',{zone:'princess-rose',loadout:{player_info:{playerHealth:50},inventory:[]},combat_version:3,content_version:1,defeat_version:1});
  // Reproduce a database written before the redesign: the character was last seen in the Resting Hall, and staff had placed NPCs and a DM monster there.
  db.prepare('UPDATE quest_presence SET zone=?,x=3,y=4 WHERE character_id=?').run('princess-rose-beds',c.id);
  db.prepare("UPDATE quest_characters SET state=json_set(state,'$.hubVisit','princess-rose-beds') WHERE id=?").run(c.id);
  db.prepare('INSERT OR REPLACE INTO world_placement_maps VALUES (?,?,?,?)').run('princess-rose-beds','hub-princess-rose-beds','old-signature',JSON.stringify([{id:'npc-old',kind:'npc',content:'ghost',x:4,y:4,home:{x:4,y:4}}]));
  db.prepare('INSERT OR REPLACE INTO world_hub_maps VALUES (?,?,?,?)').run('princess-rose-beds','hub-princess-rose-beds',JSON.stringify({enemies:[{id:'dm-old',type:'ghost',definition:{name:'Ghost',hp:1},x:5,y:5,spawn:{x:5,y:5},manual:true,roaming:true,engaged:null,respawnAt:0,dead:false}]}),time);
  zones.close();zones=createQuestZones(db,options); // Boot against the old rows, exactly like a deployment restart.
  const parked=db.prepare('SELECT zone,x,y FROM quest_presence WHERE character_id=?').get(c.id);
  assert.equal(parked.zone,'princess-rose');assert.equal(parked.x,10);assert.equal(parked.y,12); // A parked character is moved to the Rose garden spawn at boot (SQLite rows are not plain objects, so compare fields).
  time+=1001;zones.tick();time+=1001;zones.tick(); // The placement walker and DM monster clock both skip the retired room instead of throwing "Unknown hub".
  const resumed=act(c.id,'enter',{zone:'princess-rose',loadout:{player_info:{},inventory:[]},combat_version:3,content_version:1,defeat_version:1});
  assert.equal(resumed.zone,'princess-rose');assert.equal(resumed.character.hubVisit,undefined,'a stale hubVisit to the retired annex is dropped');
  assert.equal(act(c.id,'move',{direction:'east'}).position.x,11);
  assert.ok(zones.world.catalog().every(z=>z.id!=='princess-rose-beds'));
 }finally{zones.close();db.close();}
});
