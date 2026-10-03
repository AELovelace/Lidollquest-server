import {readFileSync} from 'node:fs';

const full=JSON.parse(readFileSync(new URL('./full-dungeons-data.json',import.meta.url),'utf8'));
const weekly=JSON.parse(readFileSync(new URL('../content/weekly_quests.json',import.meta.url),'utf8'));
export const removedQuestIds=new Set([...Object.keys(full.quests).map(id=>'full-'+id),...weekly.quests.map(q=>q.id)]); // Caverns is deliberately excluded: its rewritten story belongs to the GM team.
const careNpcs=new Set(['objNPCNursemaid','objNPCFriendlyNurse','objNPCNurseVaccine']);
export const essentialNativeNpc=(id,npc)=>careNpcs.has(id)||npc?.special?.is_merchant===true;
const nativeServices=new Set(full.routes.flatMap(r=>Object.entries(r.npcs).filter(([id,n])=>essentialNativeNpc(id,n)).map(([id])=>id)));
const innkeepers=new Set(['innkeeper','concierge','landlady','pod-warden']);
export const essentialFixture=f=>f.id!=='token-admission-form'&&(f.kind!=='npc'||f.service||innkeepers.has(f.id)||nativeServices.has(f.content)); // Pip is retained as a guide service; the admission form existed solely for a removed hospital quest.

export function serviceNpc(id,npc){
 const out={name:npc.name,sprite:npc.sprite,dialogue_mode:'covered',default_tree:'dialogue_covered',dialogue_covered:[{text:npc.special?.is_merchant?'Browse the available supplies.':'Care services are available here.'}]};
 if(npc.special)out.special=structuredClone(npc.special);
 if(npc.diaper_change){out.diaper_change=structuredClone(npc.diaper_change);delete out.diaper_change.narrative_chunk;out.diaper_change.refusal_text='Care supplies are temporarily unavailable.';}
 return out;
} // Retain service mechanics and artwork, with short neutral text instead of campaign branches.
export function blankCanvasRoute(data){
 const out=structuredClone(data);
 if(out.npcs)out.npcs=Object.fromEntries(Object.entries(out.npcs).filter(([id,n])=>essentialNativeNpc(id,n)).map(([id,n])=>[id,serviceNpc(id,n)]));
 if(out.adaptations)out.adaptations={...out.adaptations,npc_services:{},quest_text:{}};
 return out;
}
export function serviceFixture(f){
 if(f.kind!=='npc'||f.service==='tutor')return f;
 const out={...f};for(const key of ['story_dialogue','story_event','story_labels','diaper_change','topics','childish','regressed'])delete out[key];
 out.line=f.service==='curse_remove'?'Choose a piece of cursed equipment to remove.':f.service==='dedicate'?'Choose your dedication at this temple.':innkeepers.has(f.id)?'Beds and rest facilities are available here.':'Services are available here.';
 return out;
}
export function clearBuiltinFixtures(floor){
 const removed=(floor.fixtures??[]).filter(f=>!essentialFixture(f));if(!removed.length)return false;
 floor.fixtures=floor.fixtures.filter(essentialFixture);
 for(const f of removed)for(let y=f.y;y<f.y+(f.span_h??1);y++)for(let x=f.x;x<f.x+(f.span_w??1);x++){
  const occupied=[...floor.fixtures,...(floor.decorations??[])].some(p=>p.solid!==false&&x>=p.x&&x<p.x+(p.span_w??1)&&y>=p.y&&y<p.y+(p.span_h??1));
  if(!occupied&&floor.props?.[y])floor.props[y][x]=0;
 }
 return true;
} // Clear only removed NPC collision cells; terrain, treasures, GM placements and editions remain intact.

export function migrateBlankCanvas(db,now=Date.now){
 db.exec('CREATE TABLE IF NOT EXISTS world_blank_canvas_migrations(id TEXT PRIMARY KEY,created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS world_story_archive(seq INTEGER PRIMARY KEY,source TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL)');
 if(db.prepare('SELECT 1 FROM world_blank_canvas_migrations WHERE id=?').get('online-npcs-quests-v1'))return;
 const exists=table=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
 const archive=db.prepare('INSERT INTO world_story_archive(source,body,created) VALUES (?,?,?)');
 function remove(table,test,keys){
  if(!exists(table))return;
  for(const row of db.prepare('SELECT * FROM '+table).all())if(test(row)){archive.run(table,JSON.stringify(row),now());db.prepare('DELETE FROM '+table+' WHERE '+keys.map(k=>k+'=?').join(' AND ')).run(...keys.map(k=>row[k]));}
 } // Table and key names are internal constants; archived rows allow deliberate recovery without loading old content into the workshop.
 db.exec('SAVEPOINT blank_canvas');try{
  const removedSheets=new Set();
  if(exists('world_content'))for(const row of db.prepare("SELECT id,draft FROM world_content WHERE kind='sheet'").all()){
   const sheet=JSON.parse(row.draft);if(['native_npc','npc_services','fixture','npc_event'].includes(sheet.category)||sheet.category==='narrative'&&sheet.key?.startsWith('npc_change_'))removedSheets.add(row.id);
  }
  const removedContent=r=>r.kind==='quest'&&removedQuestIds.has(r.id)||r.kind==='sheet'&&removedSheets.has(r.id);
  remove('world_content',removedContent,['kind','id']);remove('world_content_history',removedContent,['kind','id','revision']);remove('world_content_authorship',removedContent,['kind','id']);
  const instances=new Set(exists('online_quests')?db.prepare('SELECT id,quest FROM online_quests').all().filter(q=>removedQuestIds.has(q.quest)).map(q=>q.id):[]);
  remove('online_quest_events',r=>instances.has(r.instance),['instance','event']);remove('online_quest_flag_resets',r=>instances.has(r.instance),['instance']);remove('online_quests',r=>instances.has(r.id),['id']);
  remove('online_conversations',r=>{const d=JSON.parse(r.definition);return d.campaign_npc||removedQuestIds.has(d.quest);},['character_id']);
  if(exists('quest_characters'))for(const row of db.prepare('SELECT id,state FROM quest_characters').all()){
   const s=JSON.parse(row.state);let changed=false;
   if(instances.has(s.questTracked)){delete s.questTracked;changed=true;}
   if(s.npcInteraction?.npc&&full.routes.some(r=>s.npcInteraction.npc.startsWith(r.config.zone_id+':npc-'))){delete s.npcInteraction;changed=true;}
   if(changed)db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(s),row.id);
  }
  db.prepare('INSERT INTO world_blank_canvas_migrations VALUES (?,?)').run('online-npcs-quests-v1',now());db.exec('RELEASE blank_canvas');
 }catch(error){db.exec('ROLLBACK TO blank_canvas');db.exec('RELEASE blank_canvas');throw error;}
} // One-time cleanup leaves the rewritten Caverns bundle, GM-created records, inventories and reward receipts untouched.

export function migrateRemovedQuestLogs(db,now=Date.now){
 db.exec('CREATE TABLE IF NOT EXISTS world_blank_canvas_migrations(id TEXT PRIMARY KEY,created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS world_story_archive(seq INTEGER PRIMARY KEY,source TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL)');
 const migration='online-removed-questlogs-v1';if(db.prepare('SELECT 1 FROM world_blank_canvas_migrations WHERE id=?').get(migration))return;
 const exists=table=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
 const rows=table=>exists(table)?db.prepare('SELECT * FROM '+table).all():[];
 const archive=db.prepare('INSERT INTO world_story_archive(source,body,created) VALUES (?,?,?)');
 function remove(table,test,keys){for(const row of rows(table))if(test(row)){archive.run(table,JSON.stringify(row),now());db.prepare('DELETE FROM '+table+' WHERE '+keys.map(k=>k+'=?').join(' AND ')).run(...keys.map(k=>row[k]));}} // Archive each removed row inside the same transaction as its deletion.
 db.exec('SAVEPOINT removed_questlogs');try{
  const instances=new Set(rows('online_quests').filter(q=>removedQuestIds.has(q.quest)).map(q=>q.id));
  for(const row of db.prepare("SELECT body FROM world_story_archive WHERE source='online_quests'").all()){const q=JSON.parse(row.body);if(removedQuestIds.has(q.quest))instances.add(q.id);} // Recover stale tracking/event references after the earlier world cleanup already archived their attempts.
  for(const q of rows('online_quest_claims'))if(removedQuestIds.has(q.quest))instances.add(q.instance); // Paid receipts identify old attempts but remain intact to prevent duplicate rewards.
  remove('online_quest_events',r=>instances.has(r.instance),['instance','event']);
  remove('online_quest_flag_resets',r=>instances.has(r.instance),['instance']);
  remove('online_quests',r=>removedQuestIds.has(r.quest),['id']); // Includes active, choice, ready, abandoned, failed and claimed journal entries for every character.
  remove('online_conversations',r=>{const d=JSON.parse(r.definition);return removedQuestIds.has(d.quest)||Object.keys(d.quest_reviews??{}).some(id=>removedQuestIds.has(id))||(d.dialogue??[]).some(p=>(p.actions??[]).some(a=>removedQuestIds.has(a.quest)));},['character_id']);
  for(const row of rows('quest_characters')){
   const state=JSON.parse(row.state);let changed=false;
   if(instances.has(state.questTracked)){delete state.questTracked;changed=true;}
   if(removedQuestIds.has(state.questReward?.quest)){delete state.questReward;changed=true;} // Remove only the obsolete notice, never the earned balance, XP or items.
   if(changed){archive.run('quest_characters',JSON.stringify(row),now());db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),row.id);}
  }
  db.prepare('INSERT INTO world_blank_canvas_migrations VALUES (?,?)').run(migration,now());db.exec('RELEASE removed_questlogs');
 }catch(error){db.exec('ROLLBACK TO removed_questlogs');db.exec('RELEASE removed_questlogs');throw error;}
} // Separate startup marker also reaches worlds which have already completed online-npcs-quests-v1.

export function restoreCompanionSheets(db,now=Date.now){
 const marker='online-companions-restored-v1';if(db.prepare('SELECT 1 FROM world_blank_canvas_migrations WHERE id=?').get(marker))return;
 db.exec('SAVEPOINT restore_companions');try{
  const restored=new Set(),tables={world_content:['kind','id','revision','draft','published'],world_content_history:['kind','id','revision','body','actor','created'],world_content_authorship:['kind','id','complete','revision','actor','updated']};
  const archived=db.prepare("SELECT source,body FROM world_story_archive WHERE source IN ('world_content','world_content_history','world_content_authorship') ORDER BY seq").all().map(r=>({...r,row:JSON.parse(r.body)}));
  for(const {source,row} of archived)if(source==='world_content'&&row.kind==='sheet'&&['follower','tutor'].includes(JSON.parse(row.draft).category)){
   if(db.prepare('SELECT 1 FROM world_content WHERE kind=? AND id=?').get(row.kind,row.id))continue; // Preserve any newer GM work rather than replacing it from the archive.
   db.prepare('INSERT INTO world_content(kind,id,revision,draft,published) VALUES (?,?,?,?,?)').run(...tables.world_content.map(k=>row[k]));restored.add(row.id);
  }
  for(const {source,row} of archived)if(source!=='world_content'&&row.kind==='sheet'&&restored.has(row.id)){
   const keys=tables[source];db.prepare('INSERT OR IGNORE INTO '+source+'('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));
  }
  db.prepare('INSERT INTO world_blank_canvas_migrations VALUES (?,?)').run(marker,now());db.exec('RELEASE restore_companions');
 }catch(error){db.exec('ROLLBACK TO restore_companions');db.exec('RELEASE restore_companions');throw error;}
} // If the earlier cleanup already ran, recover only companion/Pip edits and history; retain the archive and leave removed stories alone.
