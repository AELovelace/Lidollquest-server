import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

test('a stored large character settles a pending move, walks, reconnects and leaves using compact updates',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-10-12T20:00:00Z');
 const api=createQuestZones(db,{now:()=>now,roll:()=>0,grant:()=>({owner:'large',id:'large',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 let id;
 const read=()=>api.read('',id),command=(action,extra={})=>({action,controller:'large',request_id:randomUUID(),character_id:id,revision:read().character.revision,...extra});
 const send=input=>{now+=1000;return api.act('',input);},act=(action,extra)=>send(command(action,extra));
 try{
  id=api.act('',{action:'create',controller:'large',request_id:randomUUID(),name:'Large bag'}).character.id;
  act('enter',{zone:'princess-rose',loadout:{player_info:{playerHealth:100,playerHealthMax:100,stamina:100,wet:0},inventory:[],world:{crawling:false}}});
  const state=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id).state);
  state.loadout.inventory=Array.from({length:99},(_,i)=>({item_id:'saved-gear-'+i,desc:'x'.repeat(2200)}));
  state.loadout.player_info.effects=[{source:'memorial',steps:12}]; // A saved nested struct exercises GameMaker's property reordering during login.
  const inventory=structuredClone(state.loadout.inventory);db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),id); // Emulate legitimate server loot growing beyond the old import limit.
  let s=read();assert.equal(s.loadoutDeltaVersion,1);assert.ok(Buffer.byteLength(JSON.stringify(s.character.loadout))>192*1024);assert.ok(Buffer.byteLength(JSON.stringify(s))<1024*1024,'large character snapshots fit the browser gateway');
  const map=s.zones.find(z=>z.id===s.zone);let start;
  for(let y=2;y<map.height-2&&!start;y++)for(let x=2;x<map.width-4&&!start;x++)if([0,1,2,3].every(dx=>map.walls[y][x+dx]===0&&!map.fixtures.some(f=>f.solid!==false&&x+dx>=f.x&&x+dx<f.x+(f.span_w??1)&&y>=f.y&&y<f.y+(f.span_h??1))&&!map.portals.some(p=>p.x===x+dx&&p.y===y)))start={x,y};
  assert.ok(start);db.prepare('UPDATE quest_presence SET x=?,y=?,moved=0 WHERE character_id=?').run(start.x,start.y,id);
  s=act('move',{direction:'east',world_step:true});assert.ok(s.character.worldTurnDue);
  const update=command('world_turn',{world_turn_id:s.character.worldTurnDue.id,loadout_changes:[{path:['player_info','wet'],before:0,after:1}]});
  assert.ok(Buffer.byteLength(JSON.stringify(update))<1024);s=send(update);send(update);
  assert.equal(s.character.worldTurnDue,undefined);assert.equal(s.character.loadout.player_info.wet,1);assert.deepEqual(s.character.loadout.inventory,inventory);
  assert.throws(()=>act('loadout',{loadout_changes:[{path:['player_info','wet'],before:0,after:2}]}),/changed/);
  const stale=command('loadout',{loadout_changes:[]});act('loadout',{loadout_changes:[]});assert.throws(()=>send(stale),/Character changed/);
  s=act('walk',{steps:['east','east'],loadout_changes:[]});assert.equal(s.position.x,start.x+3);assert.deepEqual(s.character.loadout.inventory,inventory);
  const login=command('enter',{zone:'princess-rose',loadout_changes:[{path:['player_info','effects'],before:[{steps:12,source:'memorial'}],after:[]}]});
  s=send(login);assert.equal(s.zone,'princess-rose');assert.deepEqual(s.character.loadout.inventory,inventory);assert.deepEqual(s.character.loadout.player_info.effects,[]);
  assert.equal(send(login).character.revision,s.character.revision); // Replaying the accepted login does not apply changes twice.
  assert.equal(act('leave').zone,null);assert.deepEqual(read().character.loadout.inventory,inventory);
 }finally{api.close();db.close();}
});
