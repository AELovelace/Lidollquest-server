import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createLootStore,validateAffix,validateTuning} from '../server/loot-store.mjs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';
import {createLootRoller} from '../server/loot.mjs';

// Gamemasters retune rarity weights, the level curve and the affix pool from the /gm
// panel. Everything is validated on the way in, because a malformed affix would
// otherwise reach the loot roller and break a live dive. These tests hold that
// boundary, plus the promise that an edit lands without restarting the service.

const data=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8'));
const base=data.loot;
const store=()=>createLootStore(new DatabaseSync(':memory:'),{now:()=>1700000000000});

const affix=(over={})=>({
 id:'test_soggy',adjective:'Soggy',suffix_title:'of the Puddle',slots:['panties'],weight:10,min_rarity:'uncommon',tags:['wet'],
 stats:[{key:'wet_resist',min:1,max:2,per_level_min:0,per_level_max:0.05}],flavour:'It squelches.',...over});

test('a valid affix is normalised rather than trusted',()=>{
 const out=validateAffix({...affix(),id:'  Test_SOGGY ',adjective:'  Soggy ',tags:['Wet','wet',' ']});
 assert.equal(out.id,'test_soggy');
 assert.equal(out.adjective,'Soggy');
 assert.deepEqual(out.tags,['wet']);
 assert.equal(out.enabled,true);
 assert.equal(out.bonus_only,false);
});

test('affixes that would break the roller are refused',()=>{
 const cases=[
  [{id:'X'},/Id must be/],
  [{adjective:'',suffix_title:''},/adjective/],
  [{slots:[]},/at least one slot/],
  [{slots:['helmet']},/not an equipment slot/],
  [{slots:['dress']},/torso and pants/],
  [{min_rarity:'mythic'},/not a rarity tier/],
  [{stats:[]},/one to four stat lines/],
  [{stats:[{key:'is_diaper',min:1,max:1}]},/diaper is identity/],
  [{stats:[{key:'value',min:1,max:1}]},/not a stat an affix may change/],
  [{stats:[{key:'def',min:5,max:1}]},/cannot be above max/],
  [{stats:[{key:'def',min:0,max:0,per_level_max:0}]},/would do nothing/],
  [{weight:0},/Weight must be between/],
 ];
 for(const [over,message] of cases)assert.throws(()=>validateAffix(affix(over)),message,JSON.stringify(over));
 assert.doesNotThrow(()=>validateAffix(affix({adjective:null,suffix_title:null,bonus_only:true})));
});

test('tuning is bounded and nested blocks are validated whole',()=>{
 assert.deepEqual(validateTuning({level_growth:0.1}),{level_growth:0.1});
 assert.throws(()=>validateTuning({level_growth:9}),/between 0 and 0.25/);
 assert.throws(()=>validateTuning({ilvl_cap:100.5}),/whole number/);
 assert.throws(()=>validateTuning({made_up:1}),/Unknown tuning value/);
 assert.throws(()=>validateTuning({}),/at least one/);
 const rarity=structuredClone(base.tuning.rarity);
 rarity.epic.affixes=9;
 assert.throws(()=>validateTuning({rarity}),/epic affixes must be between 0 and 6/);
 rarity.epic.affixes=3;rarity.epic.colour='purple';
 assert.throws(()=>validateTuning({rarity}),/#rrggbb/);
 rarity.epic.colour='#B45FFF';
 assert.equal(validateTuning({rarity}).rarity.epic.colour,'#b45fff');
 assert.throws(()=>validateTuning({luck_profiles:{}}),/at least one luck profile/);
 assert.equal(validateTuning({luck_profiles:{event:{rare:4}}}).luck_profiles.event.legendary,1,'missing tiers default to x1');
 assert.throws(()=>validateTuning({overcap:{str:{per_point:9,ceiling:50}}}),/per point/);
 assert.throws(()=>validateTuning({zone_levels:{forest:{min:20,max:5}}}),/min cannot be above max/);
 assert.deepEqual(validateTuning({route_levels:{'dive-forest':{base:8,per_floor:2}}}).route_levels,{'dive-forest':{base:8,per_floor:2}});
 assert.deepEqual(validateTuning({legendary_titles:[' Thistledown ','',' Thistledown']}).legendary_titles,['Thistledown']);
});

test('overrides layer over the shipped table and retire rather than delete shipped affixes',()=>{
 const s=store();
 assert.equal(s.apply(base).affixes.length,base.affixes.length);
 s.save(affix(),'gm');
 assert.equal(s.apply(base).affixes.length,base.affixes.length+1);
 assert.equal(s.list(base).find(a=>a.id==='test_soggy').source,'custom');
 const shipped=base.affixes[0].id;
 s.save({...base.affixes[0],weight:99},'gm');
 assert.equal(s.list(base).find(a=>a.id===shipped).source,'edited');
 assert.equal(s.apply(base).affixes.find(a=>a.id===shipped).weight,99);
 assert.deepEqual(s.remove(shipped,base,'gm'),{id:shipped,retired:true,source:'shipped'});
 assert.equal(s.apply(base).affixes.some(a=>a.id===shipped),false);
 assert.equal(s.list(base).find(a=>a.id===shipped).retired,true);
 s.restore(shipped,'gm');
 assert.equal(s.apply(base).affixes.find(a=>a.id===shipped).weight,base.affixes[0].weight,'restoring drops the edit too');
 assert.deepEqual(s.remove('test_soggy',base,'gm'),{id:'test_soggy',retired:false,source:'custom'});
 assert.throws(()=>s.remove('nope',base),/does not exist/);
 s.tune({legendary_titles:['Only One']},'gm');
 assert.deepEqual(s.apply(base).legendary_titles,['Only One']);
 assert.equal(s.apply(base).tuning.legendary_titles,undefined,'titles live beside the tuning, not inside it');
 s.reset('tuning');
 assert.deepEqual(s.apply(base).legendary_titles,base.legendary_titles);
});

test('a retune reaches the next chest without a restart, and claimed loot keeps its roll',()=>{
 const s=store();
 const roll=createDiveLootRoller(data,{loot:s,lootTable:base});
 const rolls={};
 const first=roll('ed','alice',{id:'chest-1'},rolls);
 rolls['chest-1']=first;
 const rarity=structuredClone(base.tuning.rarity);
 for(const tier of ['uncommon','rare','epic','legendary'])rarity[tier].weight=0; // everything common now
 s.tune({rarity},'gm');
 assert.deepEqual(roll('ed','alice',{id:'chest-1'},rolls),first,'the receipt wins');
 let plain=0;
 for(let n=2;n<40;n++){const item=roll('ed','alice',{id:'chest-'+n},rolls);if(!item.loot||item.loot.rarity==='common')plain++;}
 assert.equal(plain,38,'every fresh wearable rolls common after the retune');
 const baseline=createLootRoller(base),live=createLootRoller(s.apply(base));
 assert.notEqual(live.tuning.rarity.rare.weight,baseline.tuning.rarity.rare.weight);
});
