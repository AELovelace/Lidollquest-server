import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {walkable} from '../server/dive-generation.mjs';

test('hub and Dive movement enforce a doubled crawl cooldown, including forced equipment',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-18T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const act=(action,extra={})=>{const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=?,moved=? WHERE character_id=?').run(x,y,time,c.id);
 try{
  act('create',{name:'Crawler'});act('enter',{zone:'princess-rose',loadout:{player_info:{stamina:20,stat_points:0},inventory:[],world:{crawling:true}}});
  for(const dive of [false,true]){
   if(dive){time+=1000;const s=act('dive_enter',{zone:'dive-quarters'}),floor=s.zones.find(z=>z.id===s.zone);
    let pair;for(let y=1;y<floor.height-1&&!pair;y++)for(let x=1;x<floor.width-2&&!pair;x++)if(walkable(floor,x,y)&&walkable(floor,x+1,y)&&![...s.dive.enemies,...(floor.exits??[]),floor.entrance].some(e=>e.y===y&&(e.x===x||e.x===x+1)))pair={x,y};
    assert.ok(pair);place(pair.x,pair.y);
   }else place(10,9);
   time+=399;assert.throws(()=>act('move',{direction:'east'}),/too fast/);time++;act('move',{direction:'east'});
   const loadout=structuredClone(c.loadout);loadout.world.crawling=false;loadout.player_info.equipped_accessory_1='';act('loadout',{loadout});
   time+=199;assert.throws(()=>act('move',{direction:'west'}),/too fast/);time++;act('move',{direction:'west'});
   loadout.player_info.equipped_accessory_1='cursed_crawling_anklets';act('loadout',{loadout});
   assert.equal(c.loadout.world.crawling,true);time+=399;assert.throws(()=>act('move',{direction:'east'}),/too fast/);time++;act('move',{direction:'east'});
  }
 }finally{db.close();}
});

test('movement reserves one needs turn, blocks conflicting mutations and restores it across reconnect/replay',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.now(),zones,c;
 const start=()=>zones=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});start();
 const cmd=(action,extra={})=>({action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});
 const send=body=>{time+=350;const s=zones.act('',body);c=s.character;return s;};const act=(action,extra)=>send(cmd(action,extra));
 try{
  act('create',{name:'Alice'});act('enter',{zone:'honeydew-lantern',loadout:{player_info:{wet:10,tum:20,hunger:100,thirst:100},inventory:[{item_id:'adult_food'}],world:{turn_count:8,crawling:false,wet_only_mode:false}}});
  const move=cmd('move',{direction:'east',world_step:true});send(move);const turn=c.worldTurnDue.id;
  assert.equal(send(move).character.worldTurnDue.id,turn);
  assert.throws(()=>act('move',{direction:'east',world_step:true}),/pending exploration/);
  assert.throws(()=>act('loadout',{loadout:{player_info:{},inventory:[]}}),/pending exploration/);
  start();act('enter',{zone:'honeydew-lantern',loadout:{player_info:{},inventory:[]}});assert.equal(c.worldTurnDue.id,turn);assert.equal(c.loadout.inventory.length,1);
  assert.throws(()=>act('world_turn',{world_turn_id:'wrong',loadout:c.loadout}),/no longer pending/);
  const next=structuredClone(c.loadout);next.player_info.wet=11;next.player_info.hunger=99;next.world.turn_count=9;next.world.crawling=true;
  const commit=cmd('world_turn',{world_turn_id:turn,loadout:next});send(commit);send(commit);
  assert.equal(c.worldTurnDue,undefined);assert.equal(c.loadout.world.turn_count,9);assert.equal(c.loadout.player_info.hunger,99);assert.equal(c.loadout.inventory.length,1);
  act('move',{direction:'north',world_step:true});assert.ok(c.worldTurnDue);
 }finally{db.close();}
});
