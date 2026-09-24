import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {campaignDives,dungeonPortals} from '../server/hubs.mjs';
import {generateFloor,validateFloor,pathTo} from '../server/dive-generation.mjs';
import {createQuestZones} from '../server/zones.mjs';

test('six authored weekly destinations retain connected content and collision over 100 seeds each',()=>{
 for(const data of campaignDives)for(let seed=0;seed<100;seed++){
  const floor=generateFloor(data,'campaign-'+seed);assert.ok(validateFloor(floor));
  assert.deepEqual(floor,generateFloor(data,'campaign-'+seed));
  assert.equal(floor.theme,data.config.theme);assert.equal(floor.enemies.filter(e=>e.id==='guardian').length,1);
  for(const enemy of floor.enemies){assert.ok(data.enemies[enemy.type]?.sprite);assert.equal(enemy.roaming,enemy.id!=='guardian'&&data.enemies[enemy.type].roaming);}
  for(const detail of floor.decorations)for(let y=detail.y;y<detail.y+detail.span_h;y++)for(let x=detail.x;x<detail.x+detail.span_w;x++)assert.equal(floor.props[y][x],1);
 }
});

test('new Dives enforce hub adjacency, isolate claims, retain fights/reconnects and fit the gateway',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-17T12:00:00Z'),c,api;
 const setup=()=>api=createQuestZones(db,{now:()=>now,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{throw Error('New Dives do not award coins');}});
 setup();
 const act=(action,extra={})=>{now+=400;const result=api.act('',{action,controller:'browser',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=result.character;return result;};
 const place=(x,y)=>{const state=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);if(state.dive){state.dive.position={x,y};state.dive.safeUntil=now+60000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),c.id);db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);};
 try{
  act('create',{name:'Alice'});
  for(const data of campaignDives){
   const {hub,zone_id}=data.config;
   act('enter',{zone:hub,loadout:{player_info:{playerHealth:100,playerHealthMax:100,str:1000,def:100},inventory:c?.loadout?.inventory??[]}});
   place(...(hub==='honeydew-lantern'?[25,25]:hub==='littlebig-clockwork'?[33,29]:[9,0]));act('hub_visit',{zone:hub+'-dives'});place(2,9); // Plaza doorsteps for the two towns; Rose's top-wall gap.
   assert.throws(()=>act('dive_enter',{zone:zone_id}),/glowing portal/);
   place(data.config.pad.x,data.config.pad.y);const entered=act('dive_enter',{zone:zone_id});
   assert.ok(Buffer.byteLength(JSON.stringify(entered))<262144);assert.equal(entered.dungeons.length,11);assert.equal(entered.dive.claimed,0);
   const floor=entered.zones.at(-1),chest=entered.dive.chests[0],near=pathTo(floor,floor.entrance,chest).at(-2)??floor.entrance;
   place(near.x,near.y);act('dive_claim',{chest:chest.id});setup();
   const resumed=act('enter',{zone:zone_id});assert.equal(resumed.dive.claimed,1);assert.equal(c.dive.returnZone,hub+'-dives');
   const enemy=resumed.dive.enemies[0],approach=pathTo(floor,floor.entrance,enemy).at(-2)??floor.entrance;
   place(approach.x,approach.y);act('dive_engage',{encounter:enemy.id});setup();
   assert.equal(act('enter',{zone:zone_id}).character.run.encounter,enemy.id);
   act('turn_ready',{loadout:c.loadout,forfeit:false});act('attack');assert.equal(c.run,null);
   assert.equal(act('dive_exit').zone,hub+'-dives');place(10,9);act('hub_visit',{zone:hub});act('leave');
   for(const other of ['princess-rose','honeydew-lantern','littlebig-clockwork'].filter(h=>h!==hub))assert.ok(!dungeonPortals(other).some(p=>p.target===zone_id));
  }
 }finally{db.close();}
});
