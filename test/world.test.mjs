import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

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
