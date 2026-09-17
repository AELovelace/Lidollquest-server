import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

test('hall portals validate proximity, preserve inventory, restore on reconnect and cross to the destination hall',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 function act(action,extra={}){time+=350;const s=c?api.read('',c.id):null;c=s?.character??c;const result=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=result.character;return result;}
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 try{
  act('create',{name:'Alice'});
  for(const root of ['honeydew-lantern','littlebig-clockwork','princess-rose']){
   act('enter',{zone:root,loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[{item_id:'adult_food'}]}});
   place(10,3);const hall=act('hub_visit',{zone:root+'-dives'});assert.equal(hall.zone,root+'-dives');
   for(const portal of hall.zones.find(z=>z.id===hall.zone).portals){
    assert.throws(()=>act('dive_enter',{zone:portal.target}),/glowing portal/);
    place(portal.x,portal.y);const dungeon=act('dive_enter',{zone:portal.target});
    assert.equal(c.hubVisit,undefined);assert.equal(c.dive.origin,root);assert.equal(c.dive.returnZone,root+'-dives');
    const inventory=structuredClone(c.loadout.inventory);const resumed=act('enter',{zone:portal.target,loadout:{player_info:{},inventory:[]}});assert.deepEqual(resumed.character.loadout.inventory,inventory);
    const back=act('dive_exit');assert.equal(back.zone,root+'-dives');assert.equal(c.hubVisit,root+'-dives');
    assert.equal(act('enter',{zone:root,loadout:{player_info:{},inventory:[]}}).zone,root+'-dives');assert.deepEqual(c.loadout.inventory,inventory);
   }
   if(root==='princess-rose')continue; // Its crossing has dedicated two-direction Tundra coverage.
   place(14,4);const desert=act('dive_enter',{zone:'dive-desert'}),opposite=root==='honeydew-lantern'?'littlebig-clockwork':'honeydew-lantern';
   const exit=desert.zones.find(z=>z.id==='dive-desert').exits.find(e=>e.zone===opposite);place(exit.x,exit.y);
   assert.equal(act('dive_exit',{zone:opposite}).zone,opposite+'-dives');assert.equal(c.hubVisit,opposite+'-dives');
   assert.equal(act('hub_visit',{zone:opposite}).zone,opposite);assert.equal(c.hubVisit,undefined);
  }
 }finally{db.close();}
});
