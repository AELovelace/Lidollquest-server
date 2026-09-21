import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {diveData} from '../server/dive.mjs';
import {seeded} from '../server/dive-generation.mjs';

test('successful claims alone use the floor allowance; full bags, duplicate commands and reconnects retain it',()=>{
 const originalPool=diveData.item_pool;
 diveData.item_pool=[...Array(30).fill('cotton_panties'),'diaper']; // A synthetic distribution makes repeat panty rolls easy to exercise through the real API.
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-17T12:00:00Z'),api,c;
 const setup=()=>api=createQuestZones(db,{now:()=>now,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{throw Error('Loot does not award coins');}});
 const command=(action,extra={})=>({action,controller:'browser',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});
 const send=input=>{now+=400;const value=api.act('',input);c=value.character;return value;};
 const act=(action,extra={})=>send(command(action,extra));
 const edit=fn=>{const state=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);fn(state);db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),c.id);};
 const place=p=>{edit(state=>{if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=now+60000;}});db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(p.x,p.y,c.id);};
 const progress=()=>JSON.parse(db.prepare('SELECT state FROM dive_progress WHERE character_id=? AND route=? AND edition=?').get(c.id,'quarters-pilot',c.dive.edition).state);
 function enter(){act('enter',{zone:'princess-rose',loadout:{player_info:{playerHealth:100,playerHealthMax:100},inventory:[]}});place({x:9,y:0});act('hub_visit',{zone:'princess-rose-dives'});place({x:6,y:5});return act('dive_enter',{zone:'dive-quarters'});}
 try{
  setup();act('create',{name:'Alice'});const entered=enter();
  const candidates=[...entered.dive.chests,...entered.dive.pickups.filter(p=>p.kind==='treasure')].filter(ch=>diveData.item_pool[seeded(`quarters-pilot:${c.dive.edition}:1:${c.id}:${ch.id}`)(31)]==='cotton_panties');
  assert.ok(candidates.length>=3);
  place(candidates[0]);act('dive_claim',{chest:candidates[0].id});assert.equal(c.loadout.inventory.at(-1).item_id,'cotton_panties');
  place(candidates[1]);edit(state=>state.loadout.inventory=Array.from({length:99},()=>structuredClone(diveData.items.adult_food)));
  const before=progress();assert.throws(()=>act('dive_claim',{chest:candidates[1].id}),/Inventory full/);assert.deepEqual(progress(),before);
  edit(state=>state.loadout.inventory=[]);const claim=command('dive_claim',{chest:candidates[1].id});send(claim);assert.equal(c.loadout.inventory.at(-1).item_id,'diaper');
  const committed=progress();send(claim);assert.deepEqual(progress(),committed);assert.equal(c.loadout.inventory.length,1,'duplicate commands cannot duplicate the replacement');
  setup();act('enter',{zone:'dive-quarters'});place(candidates[2]);act('dive_claim',{chest:candidates[2].id});assert.equal(c.loadout.inventory.at(-1).is_diaper,true,'reconnect cannot reset the allowance');
  act('dive_exit');place({x:10,y:9});act('hub_visit',{zone:'princess-rose'});act('leave');
  act('create',{name:'Alice second character'});const second=enter();
  const fresh=second.dive.chests.find(ch=>diveData.item_pool[seeded(`quarters-pilot:${c.dive.edition}:1:${c.id}:${ch.id}`)(31)]==='cotton_panties');assert.ok(fresh);
  place(fresh);act('dive_claim',{chest:fresh.id});assert.equal(c.loadout.inventory.at(-1).item_id,'cotton_panties','another character has an independent floor allowance');
 }finally{diveData.item_pool=originalPool;db.close();}
});
