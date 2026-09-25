import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {dignityTuning,smellOf,dignityReading,shameMultiplier,loseDignity} from '../server/dignity.mjs';
import {DEFAULT_TUNING} from '../server/loot.mjs';

test('dignity tuning falls back per key and clamps each to its own range',()=>{
 const d=dignityTuning(null);
 assert.deepEqual([d.defeatLoss,d.defeatChildishExtra,d.witnessedWet,d.witnessedTum,d.smellPerMess,d.smellMax],[64,32,12,20,32,128]);
 assert.deepEqual([d.ptsPlug,d.ptsWet,d.ptsMess,d.ptsMouth,d.ptsLocked,d.ptsPerCute,d.sensitivityLow,d.sensitivityHigh,d.multLow,d.multHigh],[20,15,25,15,12,3,0.4,1.6,0.5,2]);
 const t=dignityTuning({...DEFAULT_TUNING,witnessed_wet_dignity:0,smell_dignity_max:5000,witnessed_tum_dignity:'oops',defeat_dignity_loss:-3,shame_pts_plug:400});
 assert.equal(t.witnessedWet,0,'0 is a real setting: that source is off');assert.equal(t.smellMax,1024);assert.equal(t.witnessedTum,20);assert.equal(t.defeatLoss,64);assert.equal(t.ptsPlug,100);
});

test('Shame scales one-way dignity loss from x0.5 to x2 and never below zero',()=>{
 assert.equal(shameMultiplier({shame_level:0}),0.5);assert.equal(shameMultiplier({shame_level:100}),2);assert.equal(shameMultiplier({shame_level:250}),2,'clamped to 100');
 const p={shame:500,shame_level:100};assert.equal(loseDignity(p,40),80);assert.equal(p.shame,420);
 const floor={shame:10,shame_level:100};assert.equal(loseDignity(floor,40),10);assert.equal(floor.shame,0);
 assert.equal(loseDignity({shame:500},0),0);
});

test('smell counts messes still worn, and a reading shows Dignity tiers plus Shame',()=>{
 assert.equal(smellOf({diaper_tum_absorbed:2,had_tum_accident:1}),3);assert.equal(smellOf({had_tum_accident:true}),1);assert.equal(smellOf({diaper_wet_absorbed:4}),0,'wet alone does not smell');assert.equal(smellOf(undefined),0);
 assert.deepEqual(dignityReading({shame:800,shame_level:12}),{dignity:800,label:'Composed',shame:12});assert.equal(dignityReading({shame:600}).label,'Flustered');assert.equal(dignityReading({shame:300}).label,'Embarrassed');assert.equal(dignityReading({shame:12}).label,'Mortified');assert.equal(dignityReading({}).dignity,1024);
});

test('peers and inspections show smell to everyone; Dignity and Shame only to a Read the Room owner; the snapshot carries live tuning',()=>{
 const db=new DatabaseSync(':memory:');let now=1000000;const chars={};
 const api=createQuestZones(db,{now:()=>now,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 const act=(owner,action,extra={})=>{now+=500;const s=api.act(owner,{action,controller:owner,request_id:randomUUID(),character_id:chars[owner]?.id,revision:chars[owner]?.revision,...extra});chars[owner]=s.character;return s;};
 try{
  act('alice','create',{name:'alice'});act('alice','enter',{zone:'honeydew-lantern',loadout:{player_info:{name:'alice',shame:1024,class_id:'fighter',level:1},inventory:[]}});
  act('bob','create',{name:'bob'});act('bob','enter',{zone:'honeydew-lantern',loadout:{player_info:{name:'bob',shame:300,shame_level:45,diaper_tum_absorbed:2,class_id:'fighter',level:1},inventory:[]}});
  const view=api.read('alice',chars.alice.id);
  assert.equal(view.peers.find(p=>p.id===chars.bob.id).smell,2,'nearby players see the stink lines');
  assert.deepEqual(view.dignityTuning,dignityTuning(DEFAULT_TUNING),'the client reads live amounts from the snapshot');
  let p=api.inspect('alice',chars.alice.id,chars.bob.id,'alice');
  assert.equal(p.player_info.smell,2);assert.equal(p.dignity_reading,undefined,'no ability, no reading');assert.equal(p.player_info.shame,undefined);assert.equal(p.player_info.shame_level,undefined);
  db.prepare('INSERT INTO quest_rpp_wallets VALUES (?,?)').run(chars.alice.id,10);
  const offer=api.read('alice',chars.alice.id).rpp.catalogue.find(o=>o.id==='read_the_room'); // Exported from magic_tree.json into combat-data.json.
  assert.equal(offer.cost,6);assert.equal(offer.name,'Read the Room');
  act('alice','rpp_buy',{offer:'read_the_room',rpp_cost:offer.cost});
  p=api.inspect('alice',chars.alice.id,chars.bob.id,'alice');
  assert.deepEqual(p.dignity_reading,{dignity:300,label:'Embarrassed',shame:45});
  assert.equal(api.inspect('bob',chars.bob.id,chars.alice.id,'bob').dignity_reading,undefined,'the ability belongs to the viewer, not the viewed');
 }finally{db.close();}
});

test('unnoticed-accident amounts ship in the live Dignity tuning',()=>{
 const t=dignityTuning(DEFAULT_TUNING);
 assert.deepEqual([t.unnoticedBelow,t.unnoticedChance,t.unnoticedMin,t.unnoticedMax,t.unnoticedWet,t.unnoticedTum,t.unnoticedPerTurn],[30,50,25,50,20,32,1]); // Below 30% continence, 50% chance, 25-50 turns, then 20/32 Dignity per accident + 1 per turn unaware.
});
