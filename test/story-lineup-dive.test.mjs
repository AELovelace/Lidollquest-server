import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
import {DIVE_ZONE} from '../server/dive.mjs';

test('dungeon story battle pins and settles exactly three selected foes across restart',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-20T12:00:00Z'),api,c;
 const live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells});
 const prior=process.env.QUEST_FLOWS_ENABLED;process.env.QUEST_FLOWS_ENABLED='true';
 const boot=()=>api=createQuestZones(db,{live,now:()=>now,roll:()=>0,grant:()=>({owner:'gm',id:'grant',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});boot();
 const act=(action,extra={})=>{now+=500;const r=api.act('',{action,request_id:randomUUID(),controller:'controller',character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 try{
  act('create',{name:'Dungeon GM'});act('enter',{zone:'princess-rose',flow_version:1,quest_version:1,content_version:1,combat_version:3,loadout:{player_info:{playerHealth:100,playerHealthMax:100,level:1},inventory:[],player_spells:[]}});act('dive_enter');act('gm_god_mode',{value:true});
  const ids=Object.keys(live.published().monsters),monsters=[ids[0],ids[1],ids[0]],f=api.world.flows;
  f.gm({action:'flow_flag_save',revision:0,entry:{id:'story_lineup_won',name:'Whole lineup defeated'}},'gm');
  const entry={id:'dungeon_lineup',name:'Dungeon lineup',nodes:[{id:'start',type:'entry'},{id:'fight',type:'battle',monsters},{id:'won',type:'set_flag',flag:'story_lineup_won'},{id:'done',type:'end'}],edges:[{from:'start',port:'next',to:'fight'},{from:'fight',port:'victory',to:'won'},...['defeat','retreat'].map(port=>({from:'fight',port,to:'done'})),{from:'won',port:'next',to:'done'}],bindings:[{kind:'zone',ref:DIVE_ZONE,entry:'start'}]};
  f.gm({action:'flow_publish',id:entry.id,entry,revision:0},'gm');
  const row=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(c.id),state=JSON.parse(row.state);
  assert.equal(f.start(row,state,'zone',DIVE_ZONE),true);
  db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),c.id); // The surrounding player command normally persists the initiating character.
  let r=api.read('',c.id);c=r.character;const encounter=c.run.sharedEncounter,targets=r.encounter.enemies.map(e=>e.id);
  assert.equal(targets.length,3);assert.equal(new Set(targets).size,3);
  const run=f.active(c);assert.deepEqual(run.definition.flow.nodes.find(n=>n.id==='fight').monsters,monsters);assert.ok(run.definition.assets.monsters[ids[1]]);
  const floor=JSON.parse(db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(c.dive.route,c.dive.edition).content);
  assert.deepEqual(floor.enemies.filter(e=>e.engaged===encounter).map(e=>e.type),monsters); // Nearby random enemies never get added to an authored lineup.
  api.close();boot();r=api.read('',c.id);c=r.character;assert.deepEqual(r.encounter.enemies.map(e=>e.id),targets);
  for(const [i,target] of targets.entries()){
   now+=10000;db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(now,c.id);r=api.read('',c.id);c=r.character;
   act('turn_ready',{battle:encounter,cycle:c.run.cycle,patch:[],forfeit:false});r=act('attack',{battle:encounter,cycle:c.run.cycle,target});
   if(i<2){assert.equal(c.run.sharedEncounter,encounter);assert.equal(c.fullDungeon?.flags?.story_lineup_won,undefined);}
  }
  assert.equal(c.run,null);assert.equal(c.fullDungeon.flags.story_lineup_won,true);assert.equal(r.flowScene,null);
 }finally{api.close();db.close();if(prior===undefined)delete process.env.QUEST_FLOWS_ENABLED;else process.env.QUEST_FLOWS_ENABLED=prior;}
});

for(const action of ['flee','submit'])test(`dungeon story battle foes leave the floor after a ${action}`,()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-20T12:00:00Z'),api,c;
 const live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells});
 const prior=process.env.QUEST_FLOWS_ENABLED;process.env.QUEST_FLOWS_ENABLED='true';
 api=createQuestZones(db,{live,now:()=>now,roll:()=>0,grant:()=>({owner:'gm',id:'grant',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const act=(name,extra={})=>{now+=500;const r=api.act('',{action:name,request_id:randomUUID(),controller:'controller',character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 const floor=()=>JSON.parse(db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(c.dive.route,c.dive.edition).content); // The saved dungeon floor, as every other player would load it.
 try{
  act('create',{name:'Story Loser'});act('enter',{zone:'princess-rose',flow_version:1,quest_version:1,content_version:1,combat_version:3,loadout:{player_info:{playerHealth:100,playerHealthMax:100,level:1},inventory:[],player_spells:[]}});act('dive_enter');
  const ids=Object.keys(live.published().monsters),f=api.world.flows;
  const entry={id:'dungeon_loss',name:'Dungeon loss',nodes:[{id:'start',type:'entry'},{id:'fight',type:'battle',monsters:[ids[0],ids[1]]},{id:'done',type:'end'}],edges:[{from:'start',port:'next',to:'fight'},...['victory','defeat','retreat'].map(port=>({from:'fight',port,to:'done'}))],bindings:[{kind:'zone',ref:DIVE_ZONE,entry:'start'}]};
  f.gm({action:'flow_publish',id:entry.id,entry,revision:0},'gm');
  const row=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(c.id),state=JSON.parse(row.state);
  assert.equal(f.start(row,state,'zone',DIVE_ZONE),true);
  db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),c.id); // The surrounding player command normally persists the initiating character.
  c=api.read('',c.id).character;const encounter=c.run.sharedEncounter;
  assert.equal(floor().enemies.filter(e=>e.storyBattle).length,2); // Both lineup foes are on the floor while the fight runs.
  now+=10000;db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(now,c.id);c=api.read('',c.id).character; // Let the action gauge fill.
  act('turn_ready',{battle:encounter,cycle:c.run.cycle,patch:[],forfeit:false});act(action,{battle:encounter,cycle:c.run.cycle}); // Lose the fight without beating anyone.
  assert.equal(c.run,null);
  assert.deepEqual(floor().enemies.filter(e=>e.storyOwner===c.id),[]); // Nothing from the story is left wandering the overworld.
 }finally{api.close();db.close();if(prior===undefined)delete process.env.QUEST_FLOWS_ENABLED;else process.env.QUEST_FLOWS_ENABLED=prior;}
}); // Before 2026-10-08 a lost story battle reset its foes to their tiles and they lingered for everyone.
