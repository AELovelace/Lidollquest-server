import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {hubData} from '../server/hubs.mjs';
import {GODS,FAITH_SETTINGS,uniformStatus,tickFaith,dedicate,changedPadding,combatFaith} from '../server/faith.mjs';
import {faithBlessing,faithCrawlFree,blessedDef} from '../server/faith-blessing.mjs';
import {mageScaling} from '../server/combat.mjs';
import {movementDelay} from '../server/crawl.mjs';
import {DEFAULT_TUNING} from '../server/loot.mjs';

// The gods (FAITH_DESIGN.md): uniforms, piety, blessings and the GM test tool. Temples and dedication have their own tests.
const items=hubData.equipment;
const wear=(info)=>({player_info:{level:10,str:10,def:20,int:10,incontinence:50,...info},inventory:[]});
const LOOKS={
 orthain:wear({equipped_torso:'leather_vest',equipped_pants:'blue_jeans',equipped_panties:'cotton_panties'}), // grown-up, dry, standing
 sula:wear({equipped_torso:'overalls',equipped_pants:'skirtP1',equipped_panties:'diaper',panties_bulk:3,incontinence:700}), // little, padded, leaky
 nyx:wear({equipped_panties:'diaper',panties_bulk:3}), // nothing on top, nothing hiding the padding
 sable:wear({equipped_torso:'leather_vest',equipped_pants:'blue_jeans',equipped_panties:'cotton_panties'}), // covered top and bottom (cotton panties hide under jeans)
 orin:wear({})
};

test('each god has a temple, a priest and a uniform; the sample looks keep their own god and break the others',()=>{
 assert.deepEqual(Object.keys(GODS),['orthain','sula','nyx','sable','orin']);
 for(const [god,look] of Object.entries(LOOKS))assert.deepEqual(uniformStatus(god,look,items),{ok:true,reasons:[]},god);
 assert.deepEqual(uniformStatus('orthain',LOOKS.sula,items).reasons.slice(0,2),['Overalls is too childish'.replace('Overalls',items.overalls.name),'wearing a diaper']);
 assert.ok(uniformStatus('orthain',wear({...LOOKS.orthain.player_info,incontinence:150}),items).reasons.includes('incontinence too high'));
 assert.ok(uniformStatus('orthain',{...LOOKS.orthain,world:{crawling:true}},items).reasons.includes('crawling'));
 assert.deepEqual(uniformStatus('sula',LOOKS.orthain,items).reasons,['not wearing a diaper','dressed too grown-up','not incontinent enough']);
 assert.deepEqual(uniformStatus('nyx',LOOKS.sable,items).reasons,['chest covered','underwear hidden']);
 assert.ok(uniformStatus('nyx',wear({equipped_bra:'bikini_12',equipped_panties:'diaper'}),items).reasons.includes('chest covered')); // A bra is still covering.
 assert.deepEqual(uniformStatus('sable',LOOKS.nyx,items).reasons,['chest uncovered','underwear showing']);
 assert.ok(uniformStatus('sable',wear({equipped_torso:'leather_vest',equipped_pants:'blue_jeans',equipped_panties:'diaper',panties_bulk:3}),items).reasons.includes('underwear showing'),'thick padding pokes out of the jeans');
 assert.equal(uniformStatus('orin',LOOKS.sula,items).ok,true,'Orin has no uniform');
});

test('piety: +1 every few turns in uniform, falls fast in anathema, caps and floors; notices only on changes',()=>{
 const state={};dedicate(state,'orthain',1);assert.equal(state.faith.piety,0);assert.equal(state.faith.dedications,1);
 for(let n=0;n<FAITH_SETTINGS.piety_gain_every_turns*3;n++)assert.deepEqual(tickFaith(state,LOOKS.orthain,LOOKS.orthain,{items}),[]);
 assert.equal(state.faith.piety,3);
 const lines=tickFaith(state,LOOKS.orthain,LOOKS.sula,{items});assert.match(lines[0],/^Anathema! .* is too childish\. Orthain is displeased/);
 assert.equal(state.faith.piety,0);assert.equal(state.faith.anathema,true); // 3 - 3
 assert.deepEqual(tickFaith(state,LOOKS.sula,LOOKS.sula,{items}),[],'the anathema notice fires once');assert.equal(state.faith.piety,0,'never below 0');
 assert.match(tickFaith(state,LOOKS.sula,LOOKS.orthain,{items})[0],/Back in Orthain's uniform/);
 state.faith.piety=99;state.faith.gainTurns=FAITH_SETTINGS.piety_gain_every_turns-1;
 assert.match(tickFaith(state,LOOKS.orthain,LOOKS.orthain,{items}).at(-1),/full blessing is yours/);assert.equal(state.faith.piety,100);
 tickFaith(state,LOOKS.orthain,LOOKS.orthain,{items,turn:false});assert.equal(state.faith.gainTurns,0,'an equipment change is not a turn');
 assert.equal(tickFaith({},LOOKS.orthain,LOOKS.orthain,{items}).length,0,'no god, no piety');
});

test('Sable: changing the under-layer outside a changing room is anathema; Orin: cursed gear drains piety and stops the blessing',()=>{
 const state={};dedicate(state,'sable',1);state.faith.piety=50;
 const fresh=wear({...LOOKS.sable.player_info,equipped_panties:'lace_panties'});
 assert.equal(changedPadding(LOOKS.sable,fresh),true);assert.equal(changedPadding(LOOKS.sable,LOOKS.sable),false);
 assert.equal(changedPadding(wear({diaper_wet_absorbed:2}),wear({diaper_wet_absorbed:0})),true,'a diaper emptied is a change');
 tickFaith(state,LOOKS.sable,fresh,{items,turn:false,changingRoom:true});assert.equal(state.faith.piety,50,'fine in a changing room');
 assert.match(tickFaith(state,fresh,LOOKS.sable,{items,turn:false,changingRoom:false})[0],/changed out in the open/);assert.equal(state.faith.piety,50-FAITH_SETTINGS.sable_change_penalty);
 const orin={};dedicate(orin,'orin',1);orin.faith.piety=100;
 const cursed=wear({equipped_head:'sensor_cap'});
 assert.match(tickFaith(orin,LOOKS.orin,cursed,{items})[0],/locked in cursed gear/);assert.equal(orin.faith.piety,100-FAITH_SETTINGS.orin_cursed_drain);
 assert.equal(faithBlessing(combatFaith(orin),'free_breaks_per_day'),0,'no blessing while locked');
 assert.match(tickFaith(orin,cursed,LOOKS.orin,{items})[0],/Free again/);assert.ok(faithBlessing(combatFaith(orin),'free_breaks_per_day')>2.9);
});

test('blessings scale with piety: melee, magic, physical, DEF and Sula crawling at walking pace',()=>{
 const scaled=(god,piety,loadout)=>({...loadout,faith:{god,piety,locked:false}});
 const base=mageScaling(LOOKS.orthain);
 assert.equal(mageScaling(scaled('orthain',100,LOOKS.orthain)).physical,base.physical*1.2);
 assert.equal(mageScaling(scaled('orthain',50,LOOKS.orthain)).physical,base.physical*1.1);
 assert.equal(mageScaling(scaled('nyx',100,LOOKS.nyx)).physical,base.physical*1.15);
 assert.equal(mageScaling(scaled('sula',100,LOOKS.sula)).magic,mageScaling(LOOKS.sula).magic*1.2);
 assert.equal(blessedDef(scaled('nyx',100,LOOKS.nyx)),24);assert.equal(blessedDef(LOOKS.nyx),20);
 const crawler={...LOOKS.sula,world:{crawling:true}};
 assert.equal(movementDelay(crawler,DEFAULT_TUNING),DEFAULT_TUNING.crawl_move_delay_ms);
 assert.equal(faithCrawlFree({god:'sula',piety:49}),false);
 assert.equal(movementDelay(scaled('sula',50,crawler),DEFAULT_TUNING),DEFAULT_TUNING.move_delay_ms,'devout crawlers keep walking pace');
});

test('online: steps tick piety, the loadout carries the blessing, forged faith is ignored, and a GM can set a god and piety',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:1000}),adjust:()=>{},diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=400;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 try{
  act('create',{name:'Alice'});act('enter',{zone:'honeydew-lantern',loadout:{...LOOKS.orthain,faith:{god:'nyx',piety:100}}});
  assert.equal(c.loadout.faith,null,'a client cannot forge a blessing');
  act('gm_faith_set',{key:'orthain',amount:10});assert.equal(c.faith.god,'orthain');assert.equal(c.faith.piety,10);assert.deepEqual(c.loadout.faith,{god:'orthain',piety:10,locked:false});
  for(let n=0;n<FAITH_SETTINGS.piety_gain_every_turns;n++){act('move',{direction:n%2?'west':'east',world_step:true});act('world_turn',{world_turn_id:c.worldTurnDue.id,loadout:LOOKS.orthain});}
  assert.equal(c.faith.piety,11);
  act('move',{direction:'east',world_step:true});act('world_turn',{world_turn_id:c.worldTurnDue.id,loadout:LOOKS.sula});
  assert.equal(c.faith.piety,8);assert.match(c.faithNotice,/Anathema!/);assert.equal(c.loadout.faith.piety,8);
  assert.throws(()=>act('gm_faith_set',{key:'zeus'}),/Choose orthain/);
  act('gm_faith_set',{key:'none'});assert.equal(c.faith,undefined);assert.equal(c.loadout.faith,null);
 }finally{api.close();db.close();}
});
