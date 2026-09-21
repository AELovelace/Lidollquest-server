import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {walkable} from '../server/dive-generation.mjs';

test('hall portals validate proximity, preserve inventory, restore on reconnect and cross to the destination hall',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 function act(action,extra={}){time+=350;const s=c?api.read('',c.id):null;c=s?.character??c;const result=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=result.character;return result;}
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const enter=portal=>{if(portal.style!=='gap'){place(portal.x,portal.y);return act('dive_enter',{zone:portal.target});}place(portal.side==='left'?1:18,portal.y);return act('move',{direction:portal.side==='left'?'west':'east'});}; // Wilderness routes open through the hall's side walls.
 try{
  act('create',{name:'Alice'});
  for(const root of ['honeydew-lantern','littlebig-clockwork','princess-rose']){
   act('enter',{zone:root,loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[{item_id:'adult_food'}]}});
   place(10,3);const hall=act('hub_visit',{zone:root+'-dives'});assert.equal(hall.zone,root+'-dives');
   for(const portal of hall.zones.find(z=>z.id===hall.zone).portals){
    place(2,9); // Expanded halls can legitimately offer a pad next to their arrival tile.
    assert.throws(()=>act('dive_enter',{zone:portal.target}),portal.style==='gap'?/wall opening/:/glowing portal/);
    const dungeon=enter(portal);assert.equal(dungeon.zone,portal.target);
    assert.equal(c.hubVisit,undefined);assert.equal(c.dive.origin,root);assert.equal(c.dive.returnZone,root+'-dives');
    const inventory=structuredClone(c.loadout.inventory);const resumed=act('enter',{zone:portal.target,loadout:{player_info:{},inventory:[]}});assert.deepEqual(resumed.character.loadout.inventory,inventory);
    const back=act('dive_exit');assert.equal(back.zone,root+'-dives');assert.equal(c.hubVisit,root+'-dives');
    assert.equal(act('enter',{zone:root,loadout:{player_info:{},inventory:[]}}).zone,root+'-dives');assert.deepEqual(c.loadout.inventory,inventory);
   }
   if(root==='princess-rose')continue; // Its crossing has dedicated two-direction Tundra coverage.
   const desert=enter(hall.zones.find(z=>z.id===hall.zone).portals.find(p=>p.target==='dive-desert')),opposite=root==='honeydew-lantern'?'littlebig-clockwork':'honeydew-lantern';
   const exit=desert.zones.find(z=>z.id==='dive-desert').exits.find(e=>e.zone===opposite);place(exit.x,exit.y);
   assert.equal(act('dive_exit',{zone:opposite}).zone,opposite+'-dives');assert.equal(c.hubVisit,opposite+'-dives');
   assert.equal(act('hub_visit',{zone:opposite}).zone,opposite);assert.equal(c.hubVisit,undefined);
  }
 }finally{db.close();}
});


test('walking back onto every Dive portal returns to the hall after needs settle and replays safely',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'walker',id:'walk',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{}});
 const command=(action,extra={})=>({action,controller:'walk',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});
 const act=(action,extra={})=>{time+=350;const result=api.act('',command(action,extra));c=result.character;return result;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 try{
  act('create',{name:'Walker'});
  for(const hub of ['princess-rose','honeydew-lantern','littlebig-clockwork']){
   act('enter',{zone:hub,loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[{item_id:'adult_food'}]}});
   place(10,3);const hall=act('hub_visit',{zone:hub+'-dives'});
   for(const pad of hall.zones.find(z=>z.id===hall.zone).portals){
    place(pad.x,pad.y);const entered=act('dive_enter',{zone:pad.target});
    const floor=entered.zones.find(z=>z.id===pad.target),portal=floor.exits.find(e=>e.zone===hub)??floor.entrance;
    assert.equal(act('heartbeat').zone,pad.target,'arriving on a portal does not immediately eject the player');
    const directions=[['east','west',1,0],['west','east',-1,0],['south','north',0,1],['north','south',0,-1]];
    const [away,back,dx,dy]=directions.find(([, ,dx,dy])=>walkable(floor,portal.x+dx,portal.y+dy));
    place(portal.x,portal.y);const moved=act('move',{direction:away,world_step:true});
    assert.deepEqual(moved.position,{x:portal.x+dx,y:portal.y+dy});assert.ok(c.worldTurnDue);
    assert.throws(()=>act('move',{direction:back,world_step:true}),/pending exploration turn/);
    const loadout=structuredClone(c.loadout);loadout.player_info.hunger=123;
    act('world_turn',{world_turn_id:c.worldTurnDue.id,loadout});
    time+=350;const input=command('move',{direction:back,world_step:true}),returned=api.act('',input);c=returned.character;
    assert.equal(returned.zone,hub+'-dives',pad.target+' returns by contact');
    assert.equal(c.dive,null);assert.equal(c.worldTurnDue,undefined);assert.equal(c.loadout.player_info.hunger,123);assert.deepEqual(c.loadout.inventory,loadout.inventory);
    assert.deepEqual(api.act('',input).receipt,returned.receipt,'retry cannot run a second transfer');
    assert.equal(act('enter',{zone:hub}).zone,hub+'-dives','reconnect retains the destination hall');
   }
   place(10,9);act('hub_visit',{zone:hub});act('leave');
  }
 }finally{db.close();}
});
