import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {hubCatalog,hubRooms,hubDefinition,roomExit,hubData} from '../server/hubs.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {combatData} from '../server/combat.mjs';

test('lobby definitions discard legacy campaign exits; annex return doors remain',()=>{
 for(const lobby of hubCatalog){
  assert.equal(roomExit(lobby),null,lobby.id);
  assert.equal(hubDefinition(lobby,0,1,{offers:false}).exit,null,lobby.id);
  assert.ok(hubDefinition(lobby,0,1,{offers:false}).portals.length,'real destinations remain');
 }
 for(const annex of hubRooms)assert.deepEqual(hubDefinition(annex,0,1,{offers:false}).exit,annex.exit,annex.id);
 assert.equal(hubDefinition({id:'old-lobby',exit:{x:1,y:10}},0).exit,null);
 assert.equal(hubDefinition({id:'missing-exit',parent:'utopia-arcanum'},0).exit,null,'no fallback stairs');
});

test('Utopia snapshots and editor maps omit stale saved stairs without regenerating the district',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-12T12:00:00Z');
 const live=createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment});
 const zones=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 let c;const act=(action,extra={})=>{time+=1500;const result=zones.act('token',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=result.character;return result;};
 try{
  act('create',{name:'Alice'});
  const snapshot=act('enter',{zone:'utopia-arcanum',loadout:{player_info:{playerHealth:20},inventory:[]}});
  assert.equal(snapshot.zones.find(z=>z.id==='utopia-arcanum').exit,null,'players receive no logout tile');
  const before=zones.world.map('utopia-arcanum'),saved=structuredClone(before.floor);
  saved.exits=[{x:1,y:10,style:'stairs'}]; // Simulate world_hub_maps written by an older deployment.
  db.prepare('INSERT OR REPLACE INTO world_hub_maps VALUES (?,?,?,?)').run('utopia-arcanum',before.edition,JSON.stringify(saved),time);
  const after=zones.world.map('utopia-arcanum');
  assert.deepEqual(after.floor.exits,[],'the editor cannot render a destinationless stair');
  assert.equal(after.edition,before.edition,'no district reset needed');
  assert.deepEqual(after.floor.walls,before.floor.walls,'terrain is preserved');
  assert.deepEqual(after.floor.portals,before.floor.portals,'real destinations are preserved');
  const annex=zones.world.map('utopia-arcanum-dives');
  assert.equal(annex.floor.exits.length,1,'the workshop still has its return door');
 }finally{db.close();}
});
