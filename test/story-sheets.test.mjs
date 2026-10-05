import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {campaignDialogue} from '../server/full-dungeon-rules.mjs';
import {fullDungeonNpc,nativeNpcSource} from '../server/full-dungeon-quests.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
import {sheetId} from '../server/story-sheets.mjs';
import {createFollowers} from '../server/followers.mjs';
import {createTutor} from '../server/tutor.mjs';

const questLibraryPack=JSON.parse(readFileSync(new URL('../content/weekly_quests.json',import.meta.url),'utf8')).quests;
function fixture(){const db=new DatabaseSync(':memory:'),start=()=>{const live=createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment,questLibraryPack});for(const d of fullDungeons)live.register(d);return live;};return {db,live:start(),start};} // Reopening content on the same DB simulates service restart without recreating saves.

test('standalone content stores need no quest catalogue; supplied library rewards remain validated',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const live=createWorldContent(db);
  assert.deepEqual(live.view().quests,[],'A monster/artwork store does not implicitly import optional quest rewards');
  const quest={...structuredClone(questLibraryPack[0]),rewards:{items:[{id:'missing_reward_item',count:1}]}};
  assert.throws(()=>createWorldContent(db,{questLibraryPack:[quest]}),/Choose existing equipment or items/,'Explicit library imports still reject unknown rewards');
  const imported=createWorldContent(db,{equipment:{missing_reward_item:{name:'Test item'}},questLibraryPack:[quest]});
  assert.equal(imported.entry('quest',quest.id).published,null,'Importing the library does not activate its quests');
  assert.equal(imported.view().quests.length,1);
  assert.throws(()=>createWorldContent(db,{questLibraryPack:[{...quest,rewards:{spells:['missing_reward_spell']}}]}),/Choose existing spells/);
 }finally{db.close();}
}); // The deployment regression came from hidden weekly-pack loading in otherwise valid minimal stores.
const state=(score=0,world={},info={},flags={})=>({loadout:{player_info:{...info},childish:score,world},fullDungeon:{flags,counters:{},once:{}}});
function change(live,row,body,publish=true){return live.change({action:publish?'content_publish':'content_save',kind:'sheet',id:row.id,revision:row.revision,entry:{...row.draft,body}},'test-gm');}

test('every imported NPC, service, scene and tour validates; all native greeting routes retain their behavior',()=>{
 const f=fixture();try{
  const rows=f.live.view().sheets;assert.equal(rows.filter(r=>r.draft.category==='native_npc').length,56);
  assert.equal(rows.filter(r=>r.draft.category==='narrative').length,182); // 2026-10-05: the campaign's 21 tq_ traps and their narratives left the registry (84 route narratives).
  for(const row of rows)assert.doesNotThrow(()=>f.live.validateSheet(row.draft),row.draft.key);
  let routes=0;
  for(const d of fullDungeons)for(const [id,npc] of Object.entries(d.npcs)){
   const imported=f.live.sheet('native_npc',d.config.zone_id,id),cases=[state(0),state(4),state(7),state(0,{panties_showing:true}),state(0,{panties_showing:true},{had_wet_accident:true}),state(0,{panties_showing:true},{had_tum_accident:true})];
   for(const branch of npc.dialogue_flag_branches??[])for(const score of [0,4,7])cases.push(state(score,{}, {},Object.fromEntries([...(branch.all_flags??[]),...(branch.any_flags??[])].map(k=>[k,true]))));
   for(const s of cases){assert.deepEqual(campaignDialogue(imported,structuredClone(s)),campaignDialogue(npc,structuredClone(s)),id);routes++;}
  }
  assert.ok(routes>336,'Flag-dependent routes were compared too.');
 }finally{f.db.close();}
});

test('drafts, atomic bundles, rollback and restart preserve source identity and existing publications',()=>{
 const f=fixture();try{
  const id=sheetId('native_npc',fullDungeons[0].config.zone_id,'objFriendlyTest');let row=f.live.entry('sheet',id),body=structuredClone(row.draft.body),tree=body.default_tree;body[tree][0].text='Edited greeting.';
  row=change(f.live,row,body,false);assert.notEqual(f.live.sheet('native_npc',row.draft.zone,row.draft.key)[tree][0].text,'Edited greeting.');
  row=change(f.live,row,body);assert.equal(f.live.sheet('native_npc',row.draft.zone,row.draft.key)[tree][0].text,'Edited greeting.');const publishedRevision=row.revision;
  const reopened=f.start();assert.equal(reopened.entry('sheet',id).published.body[tree][0].text,'Edited greeting.');
  const broken=structuredClone(body);broken[tree][0].actions[0].next='missing_page';assert.throws(()=>change(f.live,row,broken),/missing page/);
  assert.throws(()=>change(f.live,{...row,revision:0},body),/draft changed/);
  const other=f.live.view().sheets.find(r=>r.draft.category==='narrative');f.db.exec('BEGIN');try{assert.throws(()=>f.live.bundle([{kind:'sheet',id,revision:row.revision,entry:{...row.draft,body}},{kind:'sheet',id:other.id,revision:other.revision,entry:{...other.draft,body:{...other.draft.body,beats:[]}}}],'gm',true),/at least one page/);}finally{f.db.exec('ROLLBACK');f.live.invalidate();}
  assert.equal(f.live.entry('sheet',id).revision,publishedRevision);
  body[tree][0].text='Second publication.';row=change(f.live,row,body);
  row=f.live.change({action:'content_rollback',kind:'sheet',id,revision:row.revision,target_revision:publishedRevision},'gm');assert.equal(row.published.body[tree][0].text,'Edited greeting.');
  assert.equal(f.live.sheetDefault(id).body[tree][0].text,fullDungeons[0].npcs.objFriendlyTest[tree][0].text);assert.equal(f.live.sheetHistory(id,publishedRevision).body[tree][0].text,'Edited greeting.');
 }finally{f.db.close();}
});

test('published native sheets retain special services, care and pinned conversation inputs',()=>{
 const f=fixture();try{
  const d=fullDungeons.find(d=>Object.values(d.npcs).some(n=>n.name==='Basil')),key=Object.keys(d.npcs).find(k=>d.npcs[k].name==='Basil'),ref=d.config.zone_id+':npc-'+key,n={content:key};
  const source=nativeNpcSource(n,ref,f.live),pinned=fullDungeonNpc(n,ref,state(),source,f.live);
  assert.ok(pinned.dialogue[0].actions.some(a=>a.once_key==='full-letter-for-nell'));
  const row=f.live.entry('sheet',sheetId('native_npc',d.config.zone_id,key)),body=structuredClone(row.draft.body);body[body.default_tree][0].text='Changed after acceptance.';change(f.live,row,body);
  assert.deepEqual(fullDungeonNpc(n,ref,state(),source,f.live),pinned,'Pinned raw data still selects the original greeting.');
  const care=fullDungeons.flatMap(d=>Object.entries(d.npcs).map(([key,npc])=>({d,key,npc}))).find(v=>v.npc.diaper_change);
  const careRef=care.d.config.zone_id+':npc-'+care.key,careSource=nativeNpcSource({content:care.key},careRef,f.live),definition=fullDungeonNpc({content:care.key},careRef,state(),careSource,f.live);
  assert.deepEqual(definition.campaign_care,care.npc.diaper_change);assert.ok(definition.dialogue[0].actions.some(a=>a.campaign_change));
 }finally{f.db.close();}
});

test('resident edits preserve service identity and geometry; invalid topics and price templates cannot publish',()=>{
 const f=fixture();try{
  const original={id:'priest',kind:'npc',name:'Priest',line:'Welcome.',service:'dedicate',god:'orin',x:4,y:5};f.live.fixtureSheet('test-hub',original);
  let row=f.live.entry('sheet',sheetId('fixture','test-hub','priest')),body={...row.draft.body,line:'New welcome.',topics:[{id:'question',text:'Ask away.',next:'close',actions:[{label:'Thanks.',next:'close'}]}]};row=change(f.live,row,body);
  const resolved=f.live.fixtureSheet('test-hub',original);assert.equal(resolved.line,'New welcome.');for(const k of ['service','god','x','y','id'])assert.equal(resolved[k],original[k]);assert.equal(resolved.topics[0].text,'Ask away.');
  assert.throws(()=>change(f.live,row,{...body,service:'curse_remove'}),/unsupported field/);
  assert.throws(()=>change(f.live,row,{...body,topics:[{id:'question',text:'Broken',next:'lost'}]}),/missing page/);
  const text=f.live.entry('sheet',sheetId('presentation','online','interaction_text'));assert.throws(()=>change(f.live,text,{...text.draft.body,curse_pay:'Free!'}),/price.*placeholder/);
 }finally{f.db.close();}
});

test('companion and tutorial sheets update their actual runtime and retain prior tutor settings',()=>{
 const f=fixture();try{
  const followers=createFollowers(f.db,{live:f.live,enabled:false});const row=f.live.view().sheets.find(r=>r.draft.category==='follower');change(f.live,row,{...row.draft.body,persona:'A newly authored voice.',fallback:'A new fallback.'});assert.equal(followers.catalog[row.draft.key].online.persona,'A newly authored voice.');
  const tutor=createTutor(f.db,{live:f.live,url:''});tutor.gmSet({name:'Pippa',greeting:'Ask Pippa.'},'gm');assert.equal(tutor.settings().name,'Pippa');
  const t=f.live.entry('sheet',sheetId('tutor','online','guide'));change(f.live,t,{...t.draft.body,greeting:'Published from a sheet.'});assert.equal(tutor.settings().greeting,'Published from a sheet.');
 }finally{f.db.close();}
});

test('the online registry imports all shipped source sheets without spawning duplicate NPCs',()=>{
 const f=fixture();let api;try{api=createQuestZones(f.db,{live:f.live,now:()=>Date.parse('2026-10-02T12:00:00Z'),diveOptions:{log:()=>{}}});const view=f.live.view();assert.ok(view.sheets.filter(r=>r.draft.category==='fixture').length>=59);assert.ok(view.quests.length>=16);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM world_placements').get().n,0);for(const r of view.sheets)assert.doesNotThrow(()=>f.live.validateSheet(r.draft),r.draft.name);}finally{api?.close();f.db.close();}
});

test('older accepted quests gain native snapshots once without changing progress or promised rewards',()=>{
 const f=fixture();let api;const start=()=>createQuestZones(f.db,{live:f.live,now:()=>Date.parse('2026-10-02T12:00:00Z'),diveOptions:{log:()=>{}}});
 try{
  api=start();const definition=structuredClone(Object.values(f.live.published().quests).find(q=>q.id.startsWith('full-'))),progress={status:'abandoned',stage:definition.stages[0].id,progress:{saved:3},elapsed:17,last_tick:123};
  f.db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)').run('legacy-attempt','legacy-character',definition.id,'old-revision',JSON.stringify(definition),JSON.stringify(progress),123); // Simulate an accepted save made before sheets existed.
  api.close();api=start();const read=()=>f.db.prepare('SELECT * FROM online_quests WHERE id=?').get('legacy-attempt'),first=read(),saved=JSON.parse(first.definition);
  assert.ok(Object.keys(saved.native_npcs).length);assert.deepEqual(saved.rewards,definition.rewards);assert.deepEqual(saved.stages,definition.stages);const after=JSON.parse(first.state);for(const key of ['status','stage','progress','elapsed'])assert.deepEqual(after[key],progress[key]); // Existing boot logic resets connection-clock fields independently of the content upgrade.
  api.close();api=start();assert.equal(read().definition,first.definition);assert.equal(read().revision,first.revision);
 }finally{api?.close();f.db.close();}
});

test('optional weekly quests are editable drafts without live offers until explicitly published',()=>{
 const f=fixture();try{const optional=f.live.view().quests.filter(r=>!r.published);assert.equal(optional.length,26);assert.equal(Object.keys(f.live.published().quests).length,0);const row=optional[0];f.live.change({action:'content_save',kind:'quest',id:row.id,revision:row.revision,entry:row.draft},'gm');assert.equal(f.live.published().quests[row.id],undefined);assert.equal(f.live.entry('quest',row.id).published,null);}finally{f.db.close();}
});

test('the default game service leaves old optional quest sheets out of the online canvas',async()=>{
 const {createQuestService}=await import('../server/service.mjs');
 const service=createQuestService({questPack:[],now:()=>Date.parse('2026-10-02T12:00:00Z'),log:()=>{}});
 try{
  for(const quest of questLibraryPack){
   assert.throws(()=>service.live.entry('quest',quest.id),error=>error.status===404);
   assert.equal(service.live.published().quests[quest.id],undefined);
  }
 }finally{service.server.emit('close');}
}); // Old imports remain covered by standalone fixtures; production starts with the team's online canvas.


test('built-in provenance and explicit human re-authoring status survive saves, publication, rollback and restart',()=>{
 const f=fixture();try{
  let row=f.live.view().sheets.find(r=>r.draft.category==='native_npc');const id=row.id;
  assert.equal(row.authorship.builtin,true);assert.equal(row.authorship.needs_reauthoring,true);
  for(const q of f.live.view().quests)assert.equal(q.authorship.needs_reauthoring,true);
  row=change(f.live,row,row.draft.body,false);row=change(f.live,row,row.draft.body);
  assert.equal(row.authorship.needs_reauthoring,true,'Saving and publishing do not count as human re-authoring.');
  const original=structuredClone(f.live.published()),contentRevision=row.revision;
  const marked=f.live.markAuthorship({kind:'sheet',id,revision:0,complete:true},'human-editor');
  assert.equal(marked.needs_reauthoring,false);assert.equal(marked.actor,'human-editor');
  assert.deepEqual(f.live.published(),original,'Editorial metadata cannot change live content or its revision.');
  assert.equal(f.live.entry('sheet',id).revision,contentRevision);
  assert.throws(()=>f.live.markAuthorship({kind:'sheet',id,revision:0,complete:false},'other-editor'),/status changed/);
  assert.throws(()=>f.live.markAuthorship({kind:'sheet',id,revision:1,complete:'yes'},'human-editor'),/Choose whether/);
  row=change(f.live,row,row.draft.body,false);
  f.live.change({action:'content_rollback',kind:'sheet',id,revision:row.revision,target_revision:contentRevision},'human-editor');
  const reopened=f.start();assert.equal(reopened.entry('sheet',id).authorship.needs_reauthoring,false);
  assert.equal(reopened.entry('sheet',id).authorship.builtin,true);
  reopened.markAuthorship({kind:'sheet',id,revision:1,complete:false},'human-editor');
  assert.equal(reopened.entry('sheet',id).authorship.needs_reauthoring,true);
  const quest=reopened.view().quests[0];reopened.markAuthorship({kind:'quest',id:quest.id,revision:0,complete:true},'human-editor');
  assert.equal(reopened.entry('quest',quest.id).authorship.needs_reauthoring,false);
  const custom={...quest.draft,id:'custom-human-quest',authorship:{builtin:true}};
  const saved=reopened.change({action:'content_save',kind:'quest',id:custom.id,revision:0,entry:custom},'human-editor');
  assert.equal(saved.authorship,null,'Custom sheets must not acquire built-in origin from user fields.');
  assert.throws(()=>reopened.markAuthorship({kind:'quest',id:custom.id,revision:0,complete:true},'human-editor'),/Only built-in/);
 }finally{f.db.close();}
});

test('seeded Caverns content keeps its origin after human edits; custom assets do not acquire the marker',()=>{
 const f=fixture();try{
  const orb={id:'seeded-orb',title:'Seeded story',colour:'#123456',pages:[{id:'intro',text:'A story.',next:'close'}]};
  let row=f.live.change({action:'content_publish',kind:'orb',id:orb.id,revision:0,entry:orb},'shipped-caverns');
  row=f.live.change({action:'content_publish',kind:'orb',id:orb.id,revision:row.revision,entry:{...row.draft,title:'Edited story'}},'human-editor');
  assert.equal(row.authorship.builtin,true);assert.equal(row.authorship.needs_reauthoring,true);
  const custom=f.live.change({action:'content_publish',kind:'orb',id:'custom-orb',revision:0,entry:{...orb,id:'custom-orb'}},'human-editor');
  assert.equal(custom.authorship,null);
 }finally{f.db.close();}
});
