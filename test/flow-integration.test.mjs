import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
for(const lineupSize of [1,2,3])test('actual story combat with '+lineupSize+' enemies, NPC reactions, bundles and test recovery',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-20T12:00:00Z'),api,c;const live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells}),paid=[];
 const boot=()=>api=createQuestZones(db,{live,now:()=>now,roll:()=>0,grant:()=>({owner:'gm',id:'grant',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:25}),adjust:(...args)=>{assert.match('arena-'+args[3],/^[A-Za-z0-9_-]{1,80}$/);paid.push(args);},diveOptions:{log:()=>{}}});
 const prior=process.env.QUEST_FLOWS_ENABLED;process.env.QUEST_FLOWS_ENABLED='true';boot();
 const act=(action,extra={})=>{now+=500;const r=api.act('',{action,request_id:randomUUID(),controller:'controller',character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 const transaction=work=>{db.exec('BEGIN');try{const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');live.invalidate();throw e;}};
 try{
  act('create',{name:'GM'});act('enter',{zone:'honeydew-lantern',flow_version:1,quest_version:1,content_version:1,combat_version:3,loadout:{player_info:{playerHealth:20,playerHealthMax:20,level:1},inventory:[],player_spells:[]}});
  const f=api.world.flows;f.gm({action:'flow_flag_save',revision:0,entry:{id:'story_scout',name:'Scout rescued'}},'gm');
  const entry={id:'scout_story',name:'Scout story',nodes:[{id:'start',type:'entry'},{id:'say',type:'dialogue',text:'Help the scout.'},{id:'flag',type:'set_flag',flag:'story_scout'},{id:'reward',type:'reward',rewards:{coins:3,xp:1}},{id:'done',type:'end'}],edges:[{from:'start',port:'next',to:'say'},{from:'say',port:'next',to:'flag'},{from:'flag',port:'next',to:'reward'},{from:'reward',port:'next',to:'done'}],bindings:[{kind:'npc',ref:'scout',entry:'start'}]};
  const npc={id:'scout',name:'Scout',quests:['scout_quest'],dialogue:[{id:'hello',text:'Hello',next:'close',actions:[]},{id:'thanks',text:'Thank you',next:'close',actions:[]}],story_reactions:[{conditions:{all:['story_scout']},page:'thanks'}]};
  const quest={id:'scout_quest',name:'Visit scout',givers:['scout'],turn_in:{mode:'journal'},stages:[{id:'visit',objectives:[{id:'win',type:'kill',target:Object.keys(live.published().monsters)[0]}],next:'complete'}]};
  transaction(()=>f.gm({action:'flow_publish',id:entry.id,entry,revision:0,assets:[{kind:'npc',id:npc.id,entry:npc,revision:0},{kind:'quest',id:quest.id,entry:quest,revision:0}]},'gm'));
  assert.equal(live.published().npcs.scout.name,'Scout');
  const bad={...entry,id:'broken',edges:[]};assert.throws(()=>transaction(()=>f.gm({action:'flow_publish',id:'broken',entry:bad,revision:0,assets:[{kind:'npc',id:'scout',revision:2,entry:{...npc,name:'Must roll back'}}]},'gm')),/Connect/);assert.equal(live.published().npcs.scout.name,'Scout');
  let map=api.world.map('honeydew-lantern'),placed;
  for(let y=2;y<map.floor.height-2&&!placed;y++)for(let x=2;x<map.floor.width-2&&!placed;x++)try{placed=api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'npc',content:'scout',x,y});}catch(e){if(!/reachable tile/.test(e.message))throw e;}
  assert.ok(placed);const at=placed.placements.find(p=>p.content==='scout');db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(at.x+1,at.y,c.id);
  let r=act('npc_talk',{placement:at.id,edition:map.edition});assert.equal(r.onlineQuests.conversation,null,'a bound story replaces the chat');assert.equal(r.flowScene.text,'Help the scout.'); // Bumping plays the story straight away.
  const request={action:'flow_continue',request_id:randomUUID(),controller:'controller',character_id:c.id,revision:c.revision,flow_run:r.flowScene.id,flow_step:r.flowScene.step};r=api.act('',request);c=r.character;api.act('',request);assert.equal(paid.length,1);assert.equal(c.fullDungeon.flags.story_scout,true);
  db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(at.x+1,at.y,c.id); // Return from the encounter tile before revisiting the scout.
  r=act('npc_talk',{placement:at.id,edition:map.edition});assert.equal(r.onlineQuests.conversation.text,'Thank you');act('npc_close');
  assert.throws(()=>act('loadout',{fullDungeon:{flags:{school_graduated:true}}}),/Unsupported/);
  const before=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state,code=api.world.flowTests.create(entry.id,'gm',{story_scout:false}).id;
  r=act('flow_test_start',{test_code:code});assert.equal(r.flowTest.isolated,true);assert.equal(c.fullDungeon.flags.story_scout,false,'Override belongs only to the test copy');assert.equal(r.flowScene.text,'Help the scout.');
  const id=c.id;api.close();boot();r=api.read('',id);c=r.character;assert.equal(r.flowTest.id,code);assert.equal(r.flowScene.text,'Help the scout.');
  act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});assert.equal(paid.length,1,'Test rewards never reach the real wallet');assert.equal(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id).state,before,'Test play cannot write the real character');
  r=act('flow_test_stop');assert.equal(r.flowTest,undefined);assert.equal(r.coins,25);
  assert.throws(()=>act('loadout',{test_session:code,loadout:{player_info:{level:99},inventory:[]}}),/test ended/);
  // A real story battle uses shared encounter settlement, rather than the preview's simulated outcome.
  const monsterIds=Object.keys(live.published().monsters),lineup=[monsterIds[0],monsterIds[1],monsterIds[0]].slice(0,lineupSize);
  const battle=structuredClone(entry);battle.repeatable=true;battle.nodes.splice(2,0,{id:'fight',type:'battle',...(lineupSize===1?{ref:lineup[0]}:{monsters:lineup})});battle.edges.find(e=>e.from==='say').to='fight';battle.edges.push({from:'fight',port:'victory',to:'flag'},{from:'fight',port:'defeat',to:'done'},{from:'fight',port:'retreat',to:'done'});
  battle.nodes.push({id:'accept',type:'quest',operation:'accept',ref:quest.id},{id:'wait',type:'objective',operation:'quest',ref:quest.id},{id:'claim',type:'quest',operation:'claim',ref:quest.id},{id:'orb_page',type:'narrative',text:'The rescued scout lights this path.'});
  battle.edges.find(e=>e.from==='say').to='accept';battle.edges.find(e=>e.from==='fight'&&e.port==='victory').to='wait';battle.edges.push({from:'accept',port:'next',to:'fight'},{from:'wait',port:'complete',to:'claim'},{from:'claim',port:'next',to:'flag'},{from:'orb_page',port:'next',to:'done'});
  const orb={id:'scout_orb',title:'Scout memory',colour:'#ffccdd',pages:[{text:'Legacy memory'}],story_conditions:{all:['story_scout']}};battle.bindings.push({kind:'orb',ref:orb.id,entry:'orb_page'});
  transaction(()=>api.world.flows.gm({action:'flow_publish',id:battle.id,entry:battle,revision:1,assets:[{kind:'orb',id:orb.id,entry:orb,revision:0}]},'gm'));
  api.world.flows.gm({action:'flow_flag_set',character_id:c.id,revision:c.revision,flag:'story_scout',value:false},'gm');c=api.read('',c.id).character;
  act('gm_god_mode',{value:true});r=act('npc_talk',{placement:at.id,edition:map.edition});r=act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});
  assert.ok(c.run?.sharedEncounter);const encounter=c.run.sharedEncounter,targets=r.encounter.enemies.map(v=>v.id);
  assert.equal(targets.length,lineupSize);assert.equal(new Set(targets).size,lineupSize);
  const pinned=api.world.flows.active(c).definition.assets.monsters;assert.ok(lineup.every(id=>pinned[id]));
  api.close();boot();r=api.read('',c.id);c=r.character;assert.deepEqual(r.encounter.enemies.map(v=>v.id),targets);
  for(const [i,target] of targets.entries()){
   now+=10000;db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(now,c.id);r=api.read('',c.id);c=r.character;
   act('turn_ready',{battle:encounter,cycle:c.run.cycle,patch:[],forfeit:false});r=act('attack',{battle:encounter,cycle:c.run.cycle,target});
   if(i<targets.length-1){assert.equal(c.run.sharedEncounter,encounter);assert.equal(paid.length,1);assert.equal(c.fullDungeon.flags.story_scout,false);}
  }

  assert.equal(c.run,null);assert.equal(r.flowScene,null);assert.equal(paid.length,2,'One real flow reward per completed run');
  assert.equal(c.fullDungeon.flags.story_scout,true);assert.ok(r.onlineQuests.instances.some(q=>q.quest===quest.id&&q.status==='claimed'));
  db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(at.x+1,at.y,c.id); // Return from the encounter tile before revisiting the scout.
  r=act('npc_talk',{placement:at.id,edition:map.edition});assert.equal(r.onlineQuests.conversation.text,'Thank you');act('npc_close');
  map=api.world.map(map.id);let orbPlacement;
  for(let y=2;y<map.floor.height-2&&!orbPlacement;y++)for(let x=2;x<map.floor.width-2&&!orbPlacement;x++)try{orbPlacement=api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'orb',content:orb.id,x,y});}catch(e){if(!/reachable tile/.test(e.message))throw e;}
  assert.ok(orbPlacement);const orbAt=orbPlacement.placements.find(p=>p.content===orb.id);db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(orbAt.x+1,orbAt.y,c.id);
  r=act('orb_read',{placement:orbAt.id,edition:map.edition});assert.equal(r.flowScene.text,'The rescued scout lights this path.');act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});

 }finally{api.close();db.close();if(prior===undefined)delete process.env.QUEST_FLOWS_ENABLED;else process.env.QUEST_FLOWS_ENABLED=prior;}
});
