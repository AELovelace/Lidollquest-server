import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createQuestService} from '../server/service.mjs';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {blankCanvasRoute,clearBuiltinFixtures,essentialFixture,removedQuestIds,migrateBlankCanvas,migrateRemovedQuestLogs,restoreCompanionSheets} from '../server/blank-canvas.mjs';
import {nativeNpcSource,fullDungeonNpc} from '../server/full-dungeon-quests.mjs';

test('online route stripping preserves care mechanics, offline sources and Caverns placements',()=>{
 const route=fullDungeons.find(r=>r.config.zone_id==='dungeon-castle-dungeon'),before=structuredClone(route),clean=blankCanvasRoute(route);
 assert.deepEqual(Object.keys(clean.npcs).sort(),['objNPCMerchant','objNPCNursemaid']);assert.deepEqual(route,before);
 assert.ok(clean.npcs.objNPCNursemaid.diaper_change.diaper_pool.length);assert.equal(clean.npcs.objNPCNursemaid.diaper_change.narrative_chunk,undefined);assert.deepEqual(clean.adaptations.npc_services,{});
 const f={fixtures:[{id:'npc-old',kind:'npc',content:'objFriendlyTest',x:2,y:2},{id:'npc-care',kind:'npc',content:'objNPCNursemaid',x:3,y:2},{id:'bank',kind:'bank',x:4,y:2}],props:Array.from({length:6},()=>Array(6).fill(0)),authoredPlacements:[{kind:'npc',content:'caverns_surveyor',x:1,y:1}]};f.props[2][2]=f.props[2][3]=1;
 assert.equal(clearBuiltinFixtures(f),true);assert.equal(f.props[2][2],0);assert.equal(f.props[2][3],1);assert.equal(f.authoredPlacements[0].content,'caverns_surveyor');assert.equal(clearBuiltinFixtures(f),false);
});

test('restoring companions recovers archived sheet edits and history without overwriting newer work',()=>{
 const service=createQuestService({blankCanvas:false,log:()=>{}}),db=service.db;try{
  const sheets=['follower','tutor'].map(category=>service.live.view().sheets.find(s=>s.draft.category===category));
  for(const sheet of sheets){const draft=structuredClone(sheet.draft);draft.body.name='Rewritten '+draft.body.name;service.live.change({action:'content_save',kind:'sheet',id:sheet.id,revision:sheet.revision,entry:draft},'Doll');service.live.change({action:'content_publish',kind:'sheet',id:sheet.id,revision:sheet.revision+1},'Doll');}
  migrateBlankCanvas(db);const prior=db.prepare("SELECT * FROM world_content WHERE kind='sheet' AND id=?").get(sheets[0].id),history=db.prepare('SELECT * FROM world_content_history WHERE id=?').all(sheets[0].id);
  for(const sheet of sheets)for(const table of ['world_content','world_content_history','world_content_authorship']){
   for(const row of db.prepare('SELECT * FROM '+table+' WHERE id=?').all(sheet.id))db.prepare('INSERT INTO world_story_archive(source,body,created) VALUES (?,?,?)').run(table,JSON.stringify(row),1);
   if(sheet===sheets[0])db.prepare('DELETE FROM '+table+' WHERE id=?').run(sheet.id); // Pip has newer live data: only the missing companion should be restored.
  }
  const tutor=db.prepare('SELECT * FROM world_content WHERE id=?').get(sheets[1].id);restoreCompanionSheets(db);
  assert.deepEqual(db.prepare('SELECT * FROM world_content WHERE id=?').get(sheets[0].id),prior);assert.deepEqual(db.prepare('SELECT * FROM world_content_history WHERE id=?').all(sheets[0].id),history);assert.deepEqual(db.prepare('SELECT * FROM world_content WHERE id=?').get(sheets[1].id),tutor);
  restoreCompanionSheets(db);assert.deepEqual(db.prepare('SELECT * FROM world_content WHERE id=?').get(sheets[0].id),prior);
 }finally{service.server.emit('close');}
});

test('restart clears old online NPCs and quests, preserving rewritten Caverns, GM content, rewards and maps',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lidoll-blank-canvas-')),filename=join(dir,'world.sqlite'),now=()=>Date.parse('2026-10-02T12:00:00Z'),prior=process.env.QUEST_FLOWS_ENABLED;
 process.env.QUEST_FLOWS_ENABLED='true';let service;
 try{
  service=createQuestService({filename,now,blankCanvas:false,log:()=>{}});service.zones.tick();await service.prepare();
  const oldId=[...removedQuestIds].find(id=>service.live.published().quests[id]),old=service.live.entry('quest',oldId);
  service.live.change({action:'content_save',kind:'quest',id:oldId,revision:old.revision,entry:old.draft},'old-edit');
  const cavern=service.live.entry('npc','caverns_surveyor'),rewritten=structuredClone(cavern.draft);rewritten.dialogue[0].text='Doll wrote this Caverns dialogue.';
  service.live.change({action:'content_save',kind:'npc',id:cavern.id,revision:cavern.revision,entry:rewritten},'Doll');service.live.change({action:'content_publish',kind:'npc',id:cavern.id,revision:cavern.revision+1},'Doll');
  const gmNpc={id:'team_keeper',name:'Team Keeper',dialogue:[{id:'hello',text:'Written by the team.',next:'close',actions:[]}]};service.live.change({action:'content_save',kind:'npc',id:gmNpc.id,revision:0,entry:gmNpc},'Doll');service.live.change({action:'content_publish',kind:'npc',id:gmNpc.id,revision:1},'Doll');
  const db=service.db,state={questTracked:'old-attempt',loadout:{player_info:{level:10},inventory:[{item_id:'wood',quantity:3}]}};
  db.prepare('INSERT INTO quest_characters(id,owner,name,created,revision,state,creation_id) VALUES (?,?,?,?,?,?,?)').run('player','owner','Player',now(),0,JSON.stringify(state),'creation');
  db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)').run('old-attempt','player',oldId,'old',JSON.stringify(old.draft),JSON.stringify({status:'active'}),now());
  db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)').run('caverns-attempt','player','caverns_survey','pinned',JSON.stringify({...service.live.published().quests.caverns_survey,native_npcs:{}}),JSON.stringify({status:'active',progress:{markers:2}}),now());
  db.prepare('INSERT INTO online_quest_claims VALUES (?,?,?,?,?)').run('paid-old','player',oldId,now(),JSON.stringify({coins:15}));
  const caveIds=['caverns_surveyor','caverns_survey','caverns_memory'],protectedContent=db.prepare("SELECT * FROM world_content WHERE id IN ('caverns_surveyor','caverns_survey','caverns_memory','team_keeper') ORDER BY id").all(),protectedFlow=db.prepare("SELECT * FROM story_flow_content WHERE id='coastal_caverns_story'").get(),protectedAttempt=db.prepare("SELECT * FROM online_quests WHERE id='caverns-attempt'").get();
  const map=service.zones.world.map('dungeon-castle-dungeon'),cave=service.zones.world.map('dungeon-coastal-caverns');
  assert.ok(map.floor.fixtures.some(f=>f.content==='objFriendlyTest'));
  const oldFloor=structuredClone(map.floor),hub=service.zones.world.map('honeydew-lantern'),hubEdition=hub.edition;
  assert.ok(hub.floor.fixtures.some(f=>f.kind==='npc'&&!essentialFixture(f)));
  service.server.emit('close');service=null;

  service=createQuestService({filename,now,log:()=>{}});await service.prepare();
  assert.ok(service.db.prepare("SELECT 1 FROM world_blank_canvas_migrations WHERE id='online-removed-questlogs-v1'").get(),'startup runs the separate player journal migration');
  assert.deepEqual(service.db.prepare("SELECT * FROM world_content WHERE id IN ('caverns_surveyor','caverns_survey','caverns_memory','team_keeper') ORDER BY id").all(),protectedContent);
  assert.deepEqual(service.db.prepare("SELECT * FROM story_flow_content WHERE id='coastal_caverns_story'").get(),protectedFlow);
  const keptAttempt=service.db.prepare("SELECT * FROM online_quests WHERE id='caverns-attempt'").get();assert.equal(keptAttempt.definition,protectedAttempt.definition);assert.equal(keptAttempt.revision,protectedAttempt.revision);assert.deepEqual(JSON.parse(keptAttempt.state).progress,JSON.parse(protectedAttempt.state).progress);assert.equal(JSON.parse(keptAttempt.state).status,'active'); // Normal startup may refresh timer bookkeeping, never progress or the pinned story.
  assert.equal(service.db.prepare("SELECT COUNT(*) n FROM online_quests WHERE id='old-attempt'").get().n,0);assert.equal(service.db.prepare("SELECT COUNT(*) n FROM online_quest_claims WHERE instance='paid-old'").get().n,1);
  const nextState=JSON.parse(service.db.prepare("SELECT state FROM quest_characters WHERE id='player'").get().state);assert.deepEqual(nextState.loadout,state.loadout);assert.equal(nextState.questTracked,undefined);
  assert.ok(service.db.prepare('SELECT COUNT(*) n FROM world_story_archive').get().n>0);
  assert.ok(service.live.view().quests.every(q=>!removedQuestIds.has(q.id)));assert.ok(service.live.view().npcs.some(n=>n.id==='team_keeper'));assert.ok(service.live.view().sheets.every(s=>s.draft.category!=='npc_event'));assert.equal(service.live.view().sheets.filter(s=>s.draft.category==='follower').length,7);assert.ok(service.live.view().sheets.some(s=>s.draft.category==='tutor'));
  const cleanMap=service.zones.world.map('dungeon-castle-dungeon');assert.equal(cleanMap.edition,map.edition);assert.deepEqual(cleanMap.floor.walls,oldFloor.walls);assert.deepEqual(cleanMap.floor.chests,oldFloor.chests);assert.ok(cleanMap.floor.fixtures.every(essentialFixture));assert.ok(cleanMap.floor.fixtures.some(f=>f.content==='objNPCNursemaid'));
  const cleanHub=service.zones.world.map('honeydew-lantern');assert.equal(cleanHub.edition,hubEdition);assert.ok(cleanHub.floor.fixtures.every(essentialFixture));assert.ok(cleanHub.floor.fixtures.some(f=>f.kind==='shop'));assert.ok(cleanHub.floor.fixtures.some(f=>f.kind==='bank'));
  const care=nativeNpcSource({content:'objNPCNursemaid'},'dungeon-castle-dungeon:npc-objNPCNursemaid',service.live);const conversation=fullDungeonNpc({content:'objNPCNursemaid'},'dungeon-castle-dungeon:npc-objNPCNursemaid',{loadout:{player_info:{},world:{}}},care,service.live);assert.ok(conversation.dialogue[0].actions.some(a=>a.campaign_change));assert.equal(conversation.campaign_care_narrative,null);
  if(cave.floor)assert.deepEqual(service.zones.world.map('dungeon-coastal-caverns').floor.authoredPlacements,cave.floor.authoredPlacements);
  for(const id of caveIds)assert.ok(service.live.entry(id==='caverns_survey'?'quest':id==='caverns_memory'?'orb':'npc',id).published);
  assert.equal(service.zones.followers.enabled,true,'companions are an explicit exception to the world cleanup');
  const archived=service.db.prepare('SELECT COUNT(*) n FROM world_story_archive').get().n;service.server.emit('close');service=null;
  service=createQuestService({filename,now,log:()=>{}});assert.equal(service.db.prepare('SELECT COUNT(*) n FROM world_story_archive').get().n,archived,'migration runs once');assert.equal(service.live.entry('npc','caverns_surveyor').published.dialogue[0].text,rewritten.dialogue[0].text);
 }finally{service?.server.emit('close');if(prior===undefined)delete process.env.QUEST_FLOWS_ENABLED;else process.env.QUEST_FLOWS_ENABLED=prior;rmSync(dir,{recursive:true,force:true});}
});

test('separate quest-log migration cleans every status after world cleanup, preserves Caverns and rewards, and rolls back failures',()=>{
 const now=()=>Date.parse('2026-10-02T12:00:00Z'),service=createQuestService({blankCanvas:false,now,log:()=>{}}),db=service.db;
 try{
  const oldId=[...removedQuestIds].find(id=>service.live.published().quests[id]),definition=service.live.published().quests[oldId];
  migrateBlankCanvas(db,now); // Simulate a world that has already received the previous release's migration.
  const savedState={questTracked:'old-active',questReward:{quest:oldId,coins:15},loadout:{player_info:{xp:123},inventory:[{item_id:'wood',quantity:3}]},storyFlags:{caverns_found:true}};
  const character=db.prepare('INSERT INTO quest_characters(id,owner,name,created,revision,state,creation_id) VALUES (?,?,?,?,?,?,?)');
  character.run('player','owner','Player',now(),4,JSON.stringify(savedState),'p');
  character.run('offline','other-owner','Offline',now(),8,JSON.stringify({...savedState,questTracked:'previously-archived'}),'o');
  character.run('caverns-player','third-owner','Caverns',now(),2,JSON.stringify({questTracked:'kept-caverns',questReward:{quest:'caverns_survey',coins:2},loadout:savedState.loadout}),'c');
  const insert=db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)');
  for(const [index,status] of ['active','choice','ready','abandoned','failed','claimed'].entries())insert.run('old-'+status,index%2?'offline':'player',oldId,'old',JSON.stringify(definition),JSON.stringify({status}),now());
  const weekly=[...removedQuestIds].find(id=>!id.startsWith('full-'));insert.run('old-weekly','offline',weekly,'old',JSON.stringify({...definition,id:weekly}),JSON.stringify({status:'active'}),now());
  for(const [id,quest] of [['kept-caverns','caverns_survey'],['kept-gm','gm_original']])insert.run(id,id==='kept-caverns'?'caverns-player':'player',quest,'pinned',JSON.stringify({...definition,id:quest}),JSON.stringify({status:'active',stage:definition.stages[0].id,progress:{written:2}}),now());
  db.prepare('INSERT INTO world_story_archive(source,body,created) VALUES (?,?,?)').run('online_quests',JSON.stringify({id:'previously-archived',quest:oldId}),now());
  for(const id of ['old-active','old-claimed','previously-archived','kept-caverns','kept-gm']){
   db.prepare('INSERT INTO online_quest_events VALUES (?,?)').run(id,'event');
   db.prepare('INSERT INTO online_quest_flag_resets VALUES (?,?,?,?,?)').run(id,'player',now()+86400000,JSON.stringify(['caverns_found']),0);
  }
  db.prepare('INSERT INTO online_quest_claims VALUES (?,?,?,?,?)').run('old-claimed','offline',oldId,now(),JSON.stringify({coins:15,xp:20}));
  const conversation=db.prepare('INSERT INTO online_conversations VALUES (?,?,?,?,?,?,?,?)');
  conversation.run('player','stale','service','hub','edition',JSON.stringify({dialogue:[{actions:[{effect:'offer',quest:oldId}]}]}),'hello',now()+60000);
  conversation.run('caverns-player','kept','surveyor','caverns','edition',JSON.stringify({dialogue:[{actions:[{effect:'offer',quest:'caverns_survey'}]}]}),'hello',now()+60000);
  const kept=db.prepare("SELECT * FROM online_quests WHERE id LIKE 'kept-%' ORDER BY id").all(),claims=db.prepare('SELECT * FROM online_quest_claims').all(),cavernsPlayer=db.prepare("SELECT * FROM quest_characters WHERE id='caverns-player'").get();
  const before=db.prepare('SELECT COUNT(*) n FROM world_story_archive').get().n;
  db.exec("CREATE TRIGGER fail_journal_cleanup BEFORE DELETE ON online_quests BEGIN SELECT RAISE(ABORT,'simulated cleanup failure'); END");
  assert.throws(()=>migrateRemovedQuestLogs(db,now),/simulated cleanup failure/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM world_story_archive').get().n,before);assert.equal(db.prepare('SELECT COUNT(*) n FROM online_quest_events').get().n,5);assert.equal(db.prepare("SELECT 1 FROM world_blank_canvas_migrations WHERE id='online-removed-questlogs-v1'").get(),undefined);
  db.exec('DROP TRIGGER fail_journal_cleanup');migrateRemovedQuestLogs(db,now);
  assert.deepEqual(db.prepare('SELECT * FROM online_quests ORDER BY id').all(),kept);assert.deepEqual(db.prepare('SELECT * FROM online_quest_claims').all(),claims);assert.deepEqual(db.prepare("SELECT * FROM quest_characters WHERE id='caverns-player'").get(),cavernsPlayer);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM online_quest_events').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM online_quest_flag_resets').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM online_conversations').get().n,1);
  for(const id of ['player','offline']){const row=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(id),state=JSON.parse(row.state);assert.equal(state.questTracked,undefined);assert.equal(state.questReward,undefined);assert.deepEqual(state.loadout,savedState.loadout);assert.deepEqual(state.storyFlags,savedState.storyFlags);assert.equal(row.revision,id==='player'?5:9);}
  const player=db.prepare("SELECT * FROM quest_characters WHERE id='player'").get();assert.deepEqual(service.zones.quests.snapshot(player,JSON.parse(player.state)).instances.map(q=>q.quest),['gm_original'],'the actual journal snapshot omits removed attempts');
  const after=db.prepare('SELECT COUNT(*) n FROM world_story_archive').get().n;assert.ok(after>before);migrateRemovedQuestLogs(db,now);assert.equal(db.prepare('SELECT COUNT(*) n FROM world_story_archive').get().n,after);assert.equal(db.prepare("SELECT revision FROM quest_characters WHERE id='player'").get().revision,5);
 }finally{service.server.emit('close');}
});
