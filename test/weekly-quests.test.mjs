import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateQuestContent} from '../server/quest-content.mjs';
import {hubData,hubCatalog,hubRooms} from '../server/hubs.mjs';
import {districtData} from '../server/hub-districts.mjs';
import {combatData} from '../server/combat.mjs';

// content/weekly_quests.json is uploaded by scripts/upload-weekly-quests.mjs. Publishing it
// runs the same validation the GM console does, so every reference is checked here instead
// of failing halfway through a live upload.
const pack=JSON.parse(readFileSync(new URL('../content/weekly_quests.json',import.meta.url),'utf8'));
const equipment={...hubData.equipment,...combatData.defeat_items}; // Exactly what service.mjs hands the validator.
const assetRef=value=>String(value??''); // Quests carry no artwork of their own; only NPCs do.
const validate=quest=>validateQuestContent('quest',quest,{assetRef,spells:combatData.spells,equipment});

const zones=new Set([...hubCatalog.map(h=>h.id),...hubRooms.map(z=>z.id),'dive-quarters','dive-desert','dive-tundra']);
const residents=new Set(districtData.districts.flatMap(d=>d.npcs.filter(n=>n.roaming&&n.id).map(n=>d.hub+'-garden:'+n.id))); // Only roaming residents keep an authored, stable fixture ID; static greeters are npc-<index>.
const stocked=new Set(hubData.shops.flatMap(s=>s.pool));

test('the weekly quest pack is a quest pack with unique IDs',()=>{
 assert.equal(pack.kind,'quest');
 assert.ok(Array.isArray(pack.quests)&&pack.quests.length,'The pack needs quests.');
 assert.equal(new Set(pack.quests.map(q=>q.id)).size,pack.quests.length,'Quest IDs must be unique.');
});

test('every quest passes the server schema and repeats weekly',()=>{
 for(const quest of pack.quests){
  const body=validate(quest);
  assert.equal(body.repeat,'weekly',quest.id+' must repeat weekly.');
  assert.ok(body.name.trim(),quest.id+' needs a published name.');
  assert.ok(body.stages.length,quest.id+' needs stages.');
  for(const stage of body.stages)assert.ok(stage.objectives.length,quest.id+'/'+stage.id+' needs an objective.');
 }
});

test('givers and turn-ins are existing roaming district residents',()=>{
 for(const quest of pack.quests){
  const body=validate(quest);
  assert.ok(body.givers.length,quest.id+' needs a giver.');
  for(const key of [...body.givers,body.turn_in.npc])assert.ok(residents.has(key),quest.id+' references an unknown resident: '+key);
 }
}); // A published NPC would have to be uploaded first; a resident key works against the live map as it stands.

test('the pack needs no published monsters and no Zones placements',()=>{
 for(const quest of pack.quests)for(const stage of validate(quest).stages)for(const o of stage.objectives){
  assert.ok(!['kill','interact'].includes(o.type),quest.id+'/'+o.id+' uses '+o.type+', which needs a published monster or a Zones placement.');
  assert.ok(!o.token,quest.id+'/'+o.id+' expects a placed token.');
 }
}); // Placement-backed objectives would have to be re-made whenever a monthly district layout is replaced.

test('objective targets resolve to real zones, residents and purchasable items',()=>{
 let checked=0;
 for(const quest of pack.quests)for(const stage of validate(quest).stages)for(const o of stage.objectives){
  const at=quest.id+'/'+stage.id+'/'+o.id;
  if(o.type==='visit')assert.ok(zones.has(o.target),at+' visits an unknown zone: '+o.target);
  if(o.type==='talk')assert.ok(residents.has(o.target),at+' talks to an unknown resident: '+o.target);
  if(['collect','deliver','equipment'].includes(o.type)){
   assert.ok(Object.hasOwn(equipment,o.target),at+' references an unknown item: '+o.target);
   assert.ok(stocked.has(o.target),at+' asks for '+o.target+', which no merchant stocks.'); // Market stock rotates daily and is seeded per zone, but an item outside every pool can never be obtained.
  }
  if(o.type==='equipment'&&o.slot)assert.equal(equipment[o.target].category,o.slot,at+' equips '+o.target+' into slot '+o.slot+', but its category is '+equipment[o.target].category);
  checked++;
 }
 assert.ok(checked>0,'The pack has no objectives.');
});

test('rewards reference real items and stay within the daily coin cap',()=>{
 for(const quest of pack.quests){
  const r=validate(quest).rewards;
  for(const item of [...r.items.map(i=>i.id),...r.equipment])assert.ok(Object.hasOwn(equipment,item),quest.id+' rewards an unknown item: '+item); // Rewards are granted, not bought, so they need only exist.
  assert.ok(r.coins<=hubData.config.daily_coin_cap,quest.id+' alone exceeds the daily coin cap.');
 }
});

test('the pack is spread across all three hubs',()=>{
 const perHub=new Map(hubCatalog.map(h=>[h.id,0]));
 for(const quest of pack.quests){
  const hub=quest.givers[0].split('-garden:')[0];
  perHub.set(hub,perHub.get(hub)+1);
 }
 for(const [hub,n] of perHub)assert.ok(n>0,hub+' has no weekly quests.');
});
