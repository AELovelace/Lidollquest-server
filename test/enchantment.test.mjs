import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createEnchanter,itemScore,scoreTier,chancePercent,curseChancePercent,blessChancePercent,statPower} from '../server/enchantment.mjs';

// Shared loot rolls one slot-legal curse or blessing onto a single copy of an item.
// Curses and blessings own separate rarity-scaled chance ramps: the curse ramp falls
// as rarity rises and the blessing ramp climbs, so scavenged junk is mostly cursed
// and treasure is mostly a boon. These tests hold the contract the campaign relies
// on: the same seed gives the same result, the garment gate is never crossed, story
// gear the client matches by id is never overwritten, and that rarity slope holds.

const data=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8'));
const table=data.enchantments,tuning=table.tuning;
const entries=[...table.curses,...table.blessings];
const slotsOf=new Map(entries.map(entry=>[entry.id,new Set(entry.slots)]));

test('the exported table ships fifty curses and fifty blessings with unique ids',()=>{
 assert.equal(table.curses.length,50);
 assert.equal(table.blessings.length,50);
 assert.equal(new Set(entries.map(entry=>entry.id)).size,100); // enchant_find() searches both tables by id
 for(const entry of entries){
  assert.ok(entry.slots.length,entry.id);                      // an ungated entry could land on anything
  assert.equal(entry.effect.effect_id,entry.id);               // the client keys tooltips off this
 }
});

test('the same seed always produces the same enchantment',()=>{
 const enchant=createEnchanter(table),id=Object.keys(data.items).sort()[400];
 const a=structuredClone(data.items[id]),b=structuredClone(data.items[id]);
 enchant(a,'route:1:1:alice:chest-7');enchant(b,'route:1:1:alice:chest-7');
 assert.deepEqual(a,b); // Dive floors regenerate; a re-roll must not change a player's recorded loot.
});

test('rolls never cross the garment gate and always install a proc',()=>{
 const enchant=createEnchanter(table);let applied=0;
 for(const id of Object.keys(data.items).sort())for(let n=0;n<20;n++){
  const item=structuredClone(data.items[id]);
  enchant(item,`gate:${id}:${n}`);
  if(!item.enchantment)continue;
  applied++;
  assert.ok(slotsOf.get(item.enchantment.id).has(item.category),`${item.enchantment.id} landed on a ${item.category}`);
  assert.equal(item.magical_effects.length,1);                 // one proc per item keeps popups sane
  assert.equal(item.enchantment.alignment==='blessing',item.blessed===true);
  if(item.enchantment.alignment==='curse')assert.equal(item.cursed===true,item.enchantment.sticky===true);
 }
 assert.ok(applied>500,'a roller that never fires proves nothing');
});

test('quest gear and permanently flagged story items are left alone',()=>{
 const enchant=createEnchanter(table);let checked=0;
 for(const [id,definition] of Object.entries(data.items)){
  if(!(definition.cursed||definition.blessed||definition.quest_item||definition.magical_effects?.length))continue;
  checked++;
  for(let n=0;n<20;n++){
   const item=structuredClone(definition);
   enchant(item,`story:${id}:${n}`);
   assert.equal(item.enchantment,undefined,id);                // Nanny Mabel and the Cursed Altar match these by id
   assert.deepEqual(item,definition,id);
  }
 }
 assert.ok(checked>0,'the catalog should still carry story gear');
});

test('the curse ramp falls and the blessing ramp climbs as rarity rises',()=>{
 assert.ok(tuning.curse_chance_low_rarity>tuning.curse_chance_high_rarity);
 assert.ok(tuning.bless_chance_low_rarity<tuning.bless_chance_high_rarity);
 const cheap=data.items.rattle_1,rich=data.items.short_sword;
 if(cheap&&rich){
  const cs=itemScore(cheap,tuning),rs=itemScore(rich,tuning);
  assert.ok(curseChancePercent(cheap,cs,tuning)>curseChancePercent(rich,rs,tuning),'junk must be likelier to be cursed');
  assert.ok(blessChancePercent(cheap,cs,tuning)<blessChancePercent(rich,rs,tuning),'treasure must be likelier to bless');
 }
 for(const item of Object.values(data.items)){
  const score=itemScore(item,tuning);
  for(const chance of [curseChancePercent(item,score,tuning),blessChancePercent(item,score,tuning)])
   assert.ok(chance>=0&&chance<=100);
  assert.ok(chancePercent(item,score,tuning)<50,'plain gear must stay the common outcome');
 }
});

test('the measured cursed rate falls tier by tier across the whole catalog',()=>{
 const enchant=createEnchanter(table),buckets=new Map();
 for(const [id,definition] of Object.entries(data.items)){
  if(definition.cursed||definition.blessed||definition.quest_item||definition.magical_effects?.length)continue;
  const tier=scoreTier(itemScore(definition,tuning),tuning);
  const bucket=buckets.get(tier)??{n:0,cursed:0,blessed:0};
  // The upper tiers hold only a handful of items, so they need plenty of rolls
  // each before the measured rate settles enough to compare tier against tier.
  for(let r=0;r<150;r++){
   const item=structuredClone(definition);
   enchant(item,`rate:${id}:${r}`);
   bucket.n++;
   if(item.enchantment)item.enchantment.alignment==='curse'?bucket.cursed++:bucket.blessed++;
  }
  buckets.set(tier,bucket);
 }
 let previous=null,first=null,last=null;
 for(const {name} of tuning.rarity_tiers){
  const bucket=buckets.get(name);
  if(!bucket||bucket.n<800)continue; // a tier with a couple of items is still too noisy to assert on
  const rate=bucket.cursed/bucket.n;
  if(previous!==null)assert.ok(rate<previous+0.005,`cursed rate rose at the ${name} tier`); // small tolerance for seed noise
  previous=rate;
  if(first===null)first=rate;
  last=rate;
 }
 assert.ok(first!==null&&last!==null,'no tier had enough samples to measure');
 assert.ok(first>last*1.4,'the cheapest tier should be clearly more cursed than the richest');
});

test('a copy is never both cursed and blessed',()=>{
 const enchant=createEnchanter(table);
 for(const [id,definition] of Object.entries(data.items)){
  if(definition.cursed||definition.blessed)continue;
  for(let n=0;n<10;n++){
   const item=structuredClone(definition);
   enchant(item,`both:${id}:${n}`);
   assert.ok(!(item.cursed&&item.blessed),id); // one roll picks between the two bands
  }
 }
});

test('an authored rarity tier steers the score without discarding the item stats',()=>{
 const base={item_id:'x',category:'torso',value:15,def:1};
 const plain=itemScore(base,tuning);
 const legendary=itemScore({...base,rarity:'legendary'},tuning);
 const common=itemScore({...base,rarity:'common'},tuning);
 assert.ok(legendary>plain&&plain>common);                      // the tier moves the score in both directions
 assert.ok(legendary<1,'the authored tier blends with the derived score rather than replacing it');
 assert.equal(scoreTier(0,tuning),tuning.rarity_tiers[0].name); // every score must land in some tier
});

test('stat power weighs modifiers above raw stats',()=>{
 assert.equal(statPower({atk:4}),4);
 assert.equal(statPower({atk_mod:4}),8);                        // modifiers are strictly better, so they count double
 assert.equal(statPower({hp_regen:3}),6);
 assert.equal(statPower({name:'not a number',atk:'5'}),0);      // non-numeric fields contribute nothing
});

test('a missing or empty table degrades to a no-op rather than throwing',()=>{
 for(const shape of [undefined,{},{curses:[],blessings:[]}]){
  const item={item_id:'x',category:'torso',value:15};
  assert.deepEqual(createEnchanter(shape)(structuredClone(item),'k'),item);
 }
 assert.throws(()=>createEnchanter({curses:[{id:'dupe'}],blessings:[{id:'dupe'}]}),/unique/); // ambiguous lookups must fail loudly
});
