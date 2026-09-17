import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

test('both rows of each hub wall gap warp atomically; adjacent walls stay solid and retries cannot bounce',()=>{
 const db=new DatabaseSync(':memory:');let time=1000000,c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'a',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 function command(action,extra={}){time+=500;return {action,request_id:randomUUID(),controller:'a',character_id:c?.id,revision:c?.revision,...extra};}
 function send(input){const s=api.act('',input);c=s.character;return s;}
 const act=(action,extra)=>send(command(action,extra));
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 try{
  act('create',{name:'Alice'});
  for(const lobby of ['honeydew-lantern','littlebig-clockwork'])for(const [kind,x,direction] of [['garden',0,'west'],['beds',19,'east']])for(const y of [5,6]){
   const snapshot=act('enter',{zone:lobby,loadout:{player_info:{},inventory:[{item_id:'adult_food'}]}}),definition=snapshot.zones.find(z=>z.id===lobby),sx=x===0?1:18;
   assert.equal(definition.walls[y][x],0);assert.equal(definition.walls[4][x],1);assert.equal(definition.walls[7][x],1);
   place(sx,4);assert.throws(()=>act('move',{direction}),/blocked/);
   place(sx,y);assert.throws(()=>act('hub_visit',{zone:lobby+'-'+kind}),/Walk through|Stand next/);
   const move=command('move',{direction,world_step:true}),entered=send(move);assert.equal(entered.zone,lobby+'-'+kind);assert.equal(entered.character.loadout.inventory.length,1);
   const retry=send(move);assert.equal(retry.zone,entered.zone);assert.deepEqual(retry.position,entered.position);assert.equal(c.worldTurnDue,undefined);
   const room=entered.zones.find(z=>z.id===entered.zone),exit=room.exit;assert.equal(room.walls[exit.y][exit.x],0);assert.equal(room.walls[exit.y+1][exit.x],0);
   assert.ok(entered.position.x>0&&entered.position.x<room.width-1,'arrival stays inside the room, off the warp boundary');
   act('hub_visit',{zone:lobby});
  }
 }finally{db.close();}
});
