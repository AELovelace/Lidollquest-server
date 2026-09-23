import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

test('Quarters entry belongs only to Rose; retired hub entries resume and return without reopening their pads',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),c;
 const options={now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{}};
 let api=createQuestZones(db,options);
 const act=(action,extra={})=>{time+=350;c=c?api.read('',c.id).character:c;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const expected={
  'princess-rose':['dive-quarters','dive-dungeon'], // Frostveil opens from the Rose garden wall, so its hall lists no Tundra gap.
  'honeydew-lantern':['dive-tundra','dive-desert','dive-nursery','dive-school','dive-forest'],
  'littlebig-clockwork':['dive-desert','dive-mansion','dive-hospital'],
 };
 try{
  act('create',{name:'Alice'});
  for(const hub of ['honeydew-lantern','littlebig-clockwork','princess-rose']){
   act('enter',{zone:hub,loadout:{player_info:{playerHealth:50},inventory:[{item_id:'adult_food'}]}});
   if(hub!=='princess-rose')for(const action of ['enter','dive_enter'])assert.throws(()=>act(action,{zone:'dive-quarters'}),/glowing portal/);
   place(9,0);const hall=act('hub_visit',{zone:hub+'-dives'}),pads=hall.zones.find(z=>z.id===hall.zone).portals;
   assert.deepEqual(pads.map(p=>p.target),expected[hub]);
   place(6,4);
   if(hub==='princess-rose'){
    const pad=pads.find(p=>p.target==='dive-quarters');assert.deepEqual([pad.x,pad.y],[6,4]);
    act('dive_enter',{zone:'dive-quarters'});assert.equal(act('dive_exit').zone,hub+'-dives');
   }else{
    for(const action of ['enter','dive_enter'])assert.throws(()=>act(action,{zone:'dive-quarters'}),/glowing portal/);
    assert.throws(()=>act('dive_enter'),/glowing portal/); // Older clients cannot bypass the revised destination list.
    const desert=pads.find(p=>p.target==='dive-desert');assert.deepEqual([desert.x,desert.y,desert.side],hub==='honeydew-lantern'?[19,5,'right']:[0,5,'left']); // Desert opens through Lantern's east wall and LittleBig's west wall.
   }
   place(10,9);act('hub_visit',{zone:hub});act('leave');
  }
  for(const oldHub of ['honeydew-lantern','littlebig-clockwork']){
   act('enter',{zone:'princess-rose'});act('dive_enter');
   const state=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);
   state.dive.origin=oldHub;state.dive.returnZone=oldHub+'-dives'; // Reproduce an existing visit created before the pad removal.
   db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),c.id);
   const inventory=structuredClone(c.loadout.inventory),edition=c.dive.edition;
   api=createQuestZones(db,options);const resumed=act('enter',{zone:'dive-quarters'});
   assert.equal(resumed.zone,'dive-quarters');assert.equal(c.dive.edition,edition);assert.deepEqual(c.loadout.inventory,inventory);
   assert.equal(act('dive_exit').zone,oldHub+'-dives');
   place(6,4);assert.throws(()=>act('dive_enter'),/glowing portal/);
   place(10,9);act('hub_visit',{zone:oldHub});act('leave');
  }
 }finally{db.close();}
});
