import {createFlowTriggers,triggerTypes} from './flow-triggers.mjs';
import {flowFaithCatalog,pietyMatches} from './flow-faith.mjs';
import {randomUUID} from 'node:crypto';
import {validateFlow,FLOW_NODES,flowPorts,battleMonsters} from './flow-content.mjs';
import {storyFlagsMatch,storyRequirementsMatch,setStoryFlag,flagId} from './story-flags.mjs';
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status,code:'flow_conflict'});};
export function createStoryFlows(db,{live,world,now=Date.now,enabled=false,adapters={}}){
 db.exec(`CREATE TABLE IF NOT EXISTS story_flow_content(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,draft TEXT NOT NULL,published TEXT);
 CREATE TABLE IF NOT EXISTS story_flow_history(id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(id,revision));
 CREATE TABLE IF NOT EXISTS story_flag_definitions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS story_flow_runs(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,flow TEXT NOT NULL,revision INTEGER NOT NULL,definition TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS story_flow_character ON story_flow_runs(character_id,updated);
 CREATE TABLE IF NOT EXISTS story_flow_tests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,character_id TEXT NOT NULL,body TEXT NOT NULL,expires INTEGER NOT NULL);`);
 const authoredFlags=()=>db.prepare('SELECT body FROM story_flag_definitions ORDER BY id').all().map(r=>JSON.parse(r.body));
 function flags(){const authored=authoredFlags(),ids=new Set(['matron_rosalind_defeated','school_graduated']);for(const m of Object.keys(live.published().monsters))ids.add('defeated:'+m);
  for(const r of db.prepare("SELECT DISTINCT f.key FROM quest_characters c,json_each(c.state,'$.fullDungeon.flags') f").all())if(!r.key.startsWith('story_'))ids.add(r.key);
  return [...authored,...[...ids].sort().map(id=>({id,name:id,description:'Server-recorded progression; story actions cannot modify it.',engineOwned:true,revision:0}))];
 }
 const row=r=>r?{...r,draft:JSON.parse(r.draft),published:r.published?JSON.parse(r.published):null}:null;
 const get=id=>{const r=row(db.prepare('SELECT * FROM story_flow_content WHERE id=?').get(id));return r?{...r,history:db.prepare('SELECT revision,actor,created FROM story_flow_history WHERE id=? ORDER BY revision DESC').all(id)}:null;};
 const list=()=>db.prepare('SELECT * FROM story_flow_content ORDER BY id').all().map(row);
 function catalog(){const p=live.published(),v=live.view();return {enabled,nodes:FLOW_NODES,faith:flowFaithCatalog,records:v,flags:flags(),flagReferences:Object.fromEntries(flags().map(f=>[f.id,references(f.id)])),flows:list(),npcs:[...Object.values(p.npcs),...(world.npcCatalog?.()??[])],orbs:Object.values(p.orbs??{}),quests:Object.values(p.quests),monsters:Object.values(p.monsters),zones:world.catalog(),sprites:[...v.compiledSprites,...v.assets.map(a=>a.id)],items:v.equipment,assets:v.assets,placements:world.placementCatalog?.()??[]};} // Read authored pickup targets without generating or changing any maps.
 function flagSave(input){const d=input.entry;if(!d||!flagId(d.id)||!/^story_[a-z0-9_]{1,74}$/.test(d.id))fail('Authored flag IDs must start with story_.',400);const old=db.prepare('SELECT * FROM story_flag_definitions WHERE id=?').get(d.id);if((old?.revision??0)!==input.revision)fail('This flag changed. Reload it.');if(typeof d.name!=='string'||!d.name.trim()||d.name.length>100||typeof (d.description??'')!=='string'||(d.description??'').length>1000)fail('Give the flag a name and short description.',400);const next={id:d.id,name:d.name,description:d.description??'',retired:!!d.retired,engineOwned:false,revision:(old?.revision??0)+1};
  if(next.retired&&references(d.id).length)fail('Remove the flag from published content before retiring it.');db.prepare('INSERT INTO story_flag_definitions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(d.id,next.revision,JSON.stringify(next));return next;
 }
 function references(id){const needle=JSON.stringify(id),result=[];for(const f of list())if(f.published&&JSON.stringify(f.published).includes(needle))result.push({kind:'flow',id:f.id});for(const [kind,entries] of Object.entries(live.published()))if(entries&&typeof entries==='object')for(const [key,value] of Object.entries(entries))if(JSON.stringify(value).includes(needle))result.push({kind,id:key});return result;}
 function definition(input,publish=false,assets=[]){const view=catalog(),groups={npc:'npcs',orb:'orbs',quest:'quests',monster:'monsters',zone:'zones'};for(const a of assets){const group=groups[a.kind];if(!group)fail('Unknown asset kind.');view[group]=view[group].filter(v=>v.id!==a.id).concat({...a.entry,id:a.id});}return validateFlow(input,{catalog:view,flags:flags(),publish});}
 function testDefinition(id){const f=get(id);if(!f)fail('Save this flow first.');const view=live.view(),groups={npc:'npcs',orb:'orbs',quest:'quests',monster:'monsters',zone:'zones'},needed=new Set(),assets=[];
  const collect=value=>{if(typeof value==='string')needed.add(value);else if(value&&typeof value==='object')for(const child of Object.values(value))collect(child);};collect(f.draft);
  let added=true;while(added){added=false;for(const [kind,group] of Object.entries(groups))for(const r of view[group])if(needed.has(r.id)&&!assets.some(a=>a.kind===kind&&a.id===r.id)&&JSON.stringify(r.draft)!==JSON.stringify(r.published)){assets.push({kind,id:r.id,revision:r.revision,entry:r.draft});collect(r.draft);added=true;}}
  definition(f.draft,true,assets);return {flow:f.draft,assets};
 } // Draft tests capture their referenced canonical drafts without publishing anything in the live world.
 function save(input,actor){const old=get(input.id),revision=(old?.revision??0)+1;if((old?.revision??0)!==input.revision)fail('This flow changed. Reload before saving.');let source=input.entry;if(input.action==='flow_rollback'){const historical=db.prepare('SELECT body FROM story_flow_history WHERE id=? AND revision=?').get(input.id,input.target_revision);if(!historical)fail('Published revision not found.');source=JSON.parse(historical.body);}const publishing=['flow_publish','flow_rollback'].includes(input.action);
  if(publishing&&!enabled)fail('Flow publication is disabled during rollout.');
  const assets=input.assets??[];if(!Array.isArray(assets)||assets.length>64)fail('Save at most 64 related assets.',400);
  // The authenticated caller wraps the entire bundle and its receipt in one transaction.
  live.bundle(assets,actor,publishing);
  const {flow,issues}=definition({...source,id:input.id},publishing,assets);
  if(publishing)for(const other of list().filter(r=>r.id!==flow.id&&r.published&&!r.published.retired))for(const binding of flow.bindings)if(other.published.bindings.some(b=>b.kind===binding.kind&&b.ref===binding.ref))fail('This trigger is already owned by '+other.id+'. Use ordered branches within one flow.');
  db.prepare('INSERT INTO story_flow_content VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,draft=excluded.draft,published=excluded.published').run(flow.id,revision,JSON.stringify(flow),publishing?JSON.stringify(flow):old?.published?JSON.stringify(old.published):null);
  if(publishing)db.prepare('INSERT INTO story_flow_history VALUES (?,?,?,?,?)').run(flow.id,revision,JSON.stringify(flow),actor,now());return {...get(flow.id),issues};
 }
 const unpack=r=>r?{...r,definition:JSON.parse(r.definition),state:JSON.parse(r.state)}:null;
 const active=c=>unpack(db.prepare("SELECT * FROM story_flow_runs WHERE character_id=? AND json_extract(state,'$.done') IS NOT 1 AND json_extract(state,'$.suspended') IS NOT 1 ORDER BY updated DESC LIMIT 1").get(c.id));
 const write=r=>db.prepare('UPDATE story_flow_runs SET state=?,updated=? WHERE id=?').run(JSON.stringify(r.state),now(),r.id);
 const node=r=>r.definition.flow.nodes.find(n=>n.id===r.state.node);
 function next(r,port){const edge=r.definition.flow.edges.find(e=>e.from===r.state.node&&e.port===port);if(!edge)fail('This story has a missing connection.');r.state.node=edge.to;r.state.step++;r.state.wait=null;}
 function run(r,c,s,{simulation=false,outcome=null}={}){
  const before=JSON.stringify(r.state);
  for(let budget=0;budget<256;budget++){
   const n=node(r);if(!n)break; // Parked on a block that no longer exists: snapshot() shows a notice and flow_exit clears it, instead of every read failing.
   if(n.type==='end'){r.state.done=true;break;}
   if(['dialogue','narrative','choice'].includes(n.type))break;
   if(n.type==='piety_check'){next(r,pietyMatches(s,n.piety)?'match':'no_match');continue;}
   if(n.type==='condition'){next(r,storyFlagsMatch(s,n.conditions)?'match':'no_match');continue;}
   if(n.type==='objective'){
    const ready=n.operation==='flag'?storyFlagsMatch(s,n.conditions):simulation?!!outcome:adapters.objective?.(c,s,n,r.definition);
    if(!ready)break;next(r,'complete');continue;
   }
   const receipt='flow-'+r.id+'-'+r.state.step; // Wallet request IDs accept letters, digits, underscores and hyphens only.
   if(n.type==='battle'){
    if(simulation){if(!outcome)break;next(r,['victory','defeat','retreat'].includes(outcome)?outcome:'retreat');outcome=null;continue;}
    if(!r.state.wait){if(s.run||s.pendingDefeat||s.dungeonScene)break;const encounter=adapters.battle(c,s,n,r.definition,receipt);r.state.wait={encounter,outcome:null};break;}
    if(s.run||s.pendingDefeat||s.dungeonScene||!r.state.wait.outcome)break;
    next(r,r.state.wait.outcome);continue;
   }
   if(n.type==='set_flag'||n.type==='clear_flag')setStoryFlag(s,n.flag,n.type==='set_flag',r.definition.flags);
   else if(n.type!=='entry'&&!triggerTypes.includes(n.type)&&!simulation){const effect=adapters[n.type];if(!effect)fail('This story action is not available: '+n.type);effect(c,s,n,r.definition,receipt);r.state.effects=(r.state.effects??0)+1;}
   next(r,'next');
  }
  if(!simulation&&JSON.stringify(r.state)!==before)write(r);return r;
 } // All local mutations commit with the enclosing character command; external rewards reuse durable receipt IDs.
 function available(c,s,kind,ref){return enabled&&!active(c)&&list().some(f=>f.published&&!f.published.retired&&f.published.bindings.some(b=>b.kind===kind&&b.ref===ref&&storyFlagsMatch(s,b.conditions))&&(f.published.repeatable||!db.prepare("SELECT 1 FROM story_flow_runs WHERE character_id=? AND flow=? AND json_extract(state,'$.done')=1 AND json_extract(state,'$.trigger') IS NOT 1 AND NOT (json_extract(state,'$.exited')=1 AND COALESCE(json_extract(state,'$.effects'),0)=0)").get(c.id,f.id)));}
 function review(c,s,kind,ref){
  if(!available(c,s,kind,ref))return null;
  const f=list().find(f=>f.published&&!f.published.retired&&f.published.bindings.some(b=>b.kind===kind&&b.ref===ref&&storyFlagsMatch(s,b.conditions))),b=f.published.bindings.find(b=>b.kind===kind&&b.ref===ref&&storyFlagsMatch(s,b.conditions)),reactions=kind==='npc'?live.published().npcs[ref]?.story_reactions??[]:[],index=reactions.findIndex(r=>storyFlagsMatch(s,r.conditions));
  return JSON.stringify({flow:f.id,revision:db.prepare('SELECT MAX(revision) AS revision FROM story_flow_history WHERE id=?').get(f.id).revision,entry:reactions[index]?.entry||b.entry,reaction:index});
 } // Remember the offered branch so changed flags or publication cannot silently replace an open offer.
 function start(c,s,kind,ref,expected=null){if(expected!==null&&review(c,s,kind,ref)!==expected)fail('This story offer changed. Speak to the NPC again.');if(!enabled||active(c))return false;const found=list().filter(f=>f.published&&!f.published.retired).map(f=>({f,b:f.published.bindings.find(b=>b.kind===kind&&b.ref===ref&&storyFlagsMatch(s,b.conditions))})).find(v=>v.b);if(!found)return false;
  if(!found.f.published.repeatable&&db.prepare("SELECT 1 FROM story_flow_runs WHERE character_id=? AND flow=? AND json_extract(state,'$.done')=1 AND json_extract(state,'$.trigger') IS NOT 1 AND NOT (json_extract(state,'$.exited')=1 AND COALESCE(json_extract(state,'$.effects'),0)=0)").get(c.id,found.f.id))return false;
  if(s.flowVersion!==1)fail('Update the game before starting this story.');if(s.run||s.pendingDefeat||s.dungeonScene||s.worldTurnDue||s.pendingPurchase)fail('Finish the current action before starting a story.');
  const published=live.published(),reaction=kind==='npc'?(published.npcs[ref]?.story_reactions??[]).find(r=>storyFlagsMatch(s,r.conditions)):null,entry=reaction?.entry||found.b.entry;if(!found.f.published.nodes.some(n=>n.id===entry))fail('This NPC story entry is missing.');const r={id:randomUUID(),character_id:c.id,flow:found.f.id,revision:db.prepare('SELECT MAX(revision) AS revision FROM story_flow_history WHERE id=?').get(found.f.id).revision,definition:pin(found.f.published),state:{node:entry,step:0,done:false,wait:null}};
  db.prepare('INSERT INTO story_flow_runs VALUES (?,?,?,?,?,?,?)').run(r.id,c.id,r.flow,r.revision,JSON.stringify(r.definition),JSON.stringify(r.state),now());run(r,c,s);return true;
 }
 function pin(flow){const published=live.published();return {flow,flags:flags().filter(f=>!f.engineOwned),assets:{monsters:Object.fromEntries(flow.nodes.filter(n=>['battle','spawn'].includes(n.type)).flatMap(n=>(n.type==='battle'?battleMonsters(n):[n.ref]).map(id=>[id,structuredClone(published.monsters[id])]))),quests:Object.fromEntries(flow.nodes.filter(n=>['quest','objective','objective_entry'].includes(n.type)&&published.quests[n.ref]).map(n=>[n.ref,structuredClone(published.quests[n.ref])]))}};} // Capture every referenced asset before a deferred entry starts.
 const triggers=createFlowTriggers(db,{now,list,pin});
 function trigger(c,s){
  if(!enabled||s.flowVersion!==1)return;triggers.observe(c,s);
  if(s.run||s.pendingDefeat||s.dungeonScene||s.worldTurnDue||s.pendingPurchase||adapters.canStart?.(c,s)===false)return;
  const parent=active(c);if(parent&&node(parent)?.type!=='objective')return; // A parent parked on a missing block counts as a page: no new trigger starts until it is left.
  const event=triggers.pending(c);if(!event)return;
  const before=structuredClone(s),character=structuredClone(c);db.exec('SAVEPOINT story_trigger_start');
  try{
   if(parent){parent.state.suspended=true;write(parent);} // Only exploration waits yield to sub-entrypoints; dialogue and fights stay uninterrupted.
   const r={id:event.id,character_id:c.id,flow:event.flow,revision:event.revision,definition:JSON.parse(event.definition),state:{node:event.node,step:0,done:false,wait:null,parent:parent?.id??null,trigger:true}}; // A retried deferred entry retains external reward receipts too.
   db.prepare('INSERT INTO story_flow_runs VALUES (?,?,?,?,?,?,?)').run(r.id,c.id,r.flow,r.revision,JSON.stringify(r.definition),JSON.stringify(r.state),now());run(r,c,s);triggers.started(event.id);db.exec('RELEASE story_trigger_start');
  }catch(error){
   db.exec('ROLLBACK TO story_trigger_start');db.exec('RELEASE story_trigger_start');for(const key of Object.keys(s))delete s[key];Object.assign(s,before);Object.assign(c,character);
   if(error.status!==409)throw error; // A crowded map or busy party leaves the event queued without undoing the parcel pickup.
  }
 }
 function beginTest(characterId,input,entry=null){const {flow}=definition(input,true),c=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(characterId),s=JSON.parse(c.state),published=live.published();s.flowVersion=1;s.contentVersion=1;s.questVersion=1;s.diveCombatVersion=3;
  if(entry!==null&&!flow.nodes.some(n=>n.id===entry&&['entry',...triggerTypes].includes(n.type)))fail('Choose an entry block for this test.');
  const r={id:randomUUID(),character_id:c.id,flow:flow.id,revision:0,definition:{flow,flags:flags().filter(f=>!f.engineOwned),assets:structuredClone(published)},state:{node:entry??flow.nodes.find(n=>n.type==='entry')?.id??flow.bindings[0]?.entry??flow.nodes.find(n=>triggerTypes.includes(n.type))?.id,step:0,done:false,wait:null}};
  triggers.observe(c,s);db.prepare('UPDATE story_trigger_events SET started=1 WHERE character_id=? AND flow=? AND node=?').run(c.id,flow.id,r.state.node); // A directly selected test entry also consumes its already-satisfied occurrence.
  db.prepare('INSERT INTO story_flow_runs VALUES (?,?,?,?,?,?,?)').run(r.id,c.id,r.flow,r.revision,JSON.stringify(r.definition),JSON.stringify(r.state),now());run(r,c,s);db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(s),c.id);
 } // This entry is exposed only to the separately constructed in-memory test engine.
 function objectives(c,s){trigger(c,s);if(!enabled||active(c)||s.flowVersion!==1||s.run||s.pendingDefeat||s.dungeonScene||s.worldTurnDue||s.pendingPurchase)return;for(const f of list().filter(f=>f.published&&!f.published.retired))for(const b of f.published.bindings.filter(b=>b.kind==='objective')){
  const q=db.prepare("SELECT id FROM online_quests WHERE character_id=? AND quest=? AND json_extract(state,'$.status') IN ('ready','claimed') ORDER BY created DESC LIMIT 1").get(c.id,b.ref);if(!q||s.flowObjectives?.[b.ref]===q.id)continue;
  if(start(c,s,'objective',b.ref)){s.flowObjectives??={};s.flowObjectives[b.ref]=q.id;return;}
 }} // Completion receipts belong to this character; a party member cannot advance another story.
 function act(c,s,input){const r=active(c);if(!r||input.flow_run!==r.id||input.flow_step!==r.state.step)fail('This story page changed. Refresh before choosing.');if(s.run||s.pendingDefeat||s.dungeonScene)fail('Finish the current action first.');const n=node(r);if(!n)fail('This story page is missing. Press Esc twice (or Leave story) to leave it.');if(!['dialogue','narrative','choice'].includes(n.type))fail('Wait for the story objective.');let port='next';if(n.type==='choice'){const choice=n.choices.find(v=>v.id===input.choice);if(!choice||!storyFlagsMatch(s,choice.conditions)||!storyRequirementsMatch(s,choice.requirements))fail('That story choice is no longer available.');port=choice.id;}next(r,port);run(r,c,s);write(r);}
 function exit(c,s,input){ // flow_exit: the player's escape hatch from a story page (Esc twice / Leave story). Ends this run; see available()/start() for when it may begin again.
  const r=active(c);if(!r||input.flow_run!==r.id)fail('This story already moved on. Refresh first.'); // The page step is not checked: a stuck page may never have reached this client.
  if(s.run||s.pendingDefeat||s.dungeonScene)fail('Finish the current action first.');
  const n=node(r);if(n&&['objective','battle'].includes(n.type))fail('This story is waiting for you out in the world; there is no page to leave.');
  r.state.done=true;r.state.exited=true;r.state.exitedAt=now();write(r);
 } // Effects already applied (flags, rewards) stay applied; nothing is rolled back.
 function resume(c,s){if(s.worldTurnDue||s.pendingPurchase)return;let r=active(c);if(r)run(r,c,s);
  if(!active(c)&&!s.run&&!s.pendingDefeat&&!s.dungeonScene){r=unpack(db.prepare("SELECT * FROM story_flow_runs WHERE character_id=? AND json_extract(state,'$.suspended')=1 AND json_extract(state,'$.done') IS NOT 1 ORDER BY updated DESC,rowid DESC LIMIT 1").get(c.id));if(r){delete r.state.suspended;write(r);run(r,c,s);}}
 } // When a sub-entry finishes, restore the objective wait it temporarily suspended.
 function blocking(c){const r=active(c);if(!r)return false;const n=node(r);return !n||!['objective','battle'].includes(n.type);} // A run parked on a missing block still blocks, but only until the player leaves it (flow_exit).
 function settled(c,s,encounter,outcome){const r=active(c);if(!r||r.state.wait?.encounter!==encounter)return;r.state.wait.outcome=['win','victory'].includes(outcome)?'victory':['defeat','charm_backfire','submitted'].includes(outcome)?'defeat':'retreat';write(r);}
 function snapshot(c,s){const r=active(c);if(!r)return null;const n=node(r);if(!n)return {id:r.id,flow:r.flow,revision:r.revision,step:r.state.step,node:r.state.node,type:'dialogue',title:r.definition.flow.name,text:'This story page is missing. Press Esc twice (or Leave story) to leave it.',sprite:'',choices:[],waiting:false}; // A broken run still renders, so the player can leave it instead of losing every snapshot.
  return {id:r.id,flow:r.flow,revision:r.revision,step:r.state.step,node:n.id,type:n.type,title:n.label||r.definition.flow.name,text:n.text,sprite:n.sprite,choices:n.choices.map(v=>({...v,available:storyFlagsMatch(s,v.conditions)&&storyRequirementsMatch(s,v.requirements)})),waiting:!['dialogue','narrative','choice'].includes(n.type)};}
 function preview(input){const {flow,issues}=definition(input.entry,true,input.assets??[]);const memory={faith:input.faith,fullDungeon:{flags:{...input.flags}},loadout:{player_info:{...input.stats,playerHealth:input.stats?.health??0},childish:input.stats?.childish??0}};const r={id:'preview',definition:{flow,flags:flags()},state:{node:input.node??flow.nodes.find(n=>n.type==='entry')?.id??flow.bindings[0]?.entry??flow.nodes.find(n=>triggerTypes.includes(n.type))?.id,step:0,done:false}};if(!flow.nodes.some(n=>n.id===r.state.node))fail('Choose a preview entry.');run(r,null,memory,{simulation:true,outcome:input.outcome});return {node:node(r),state:r.state,flags:memory.fullDungeon.flags,issues};}
 function inspect(characterId){const c=db.prepare('SELECT id,name,state,revision FROM quest_characters WHERE id=?').get(characterId);if(!c)fail('Character not found.',404);const s=JSON.parse(c.state);return {character:{id:c.id,name:c.name,revision:c.revision},values:s.fullDungeon?.flags??{},definitions:flags(),references:Object.fromEntries(flags().map(f=>[f.id,references(f.id)]))};}
 live.setStoryReferenceCheck?.((kind,body)=>{
  if(kind==='quest')for(const f of list().filter(f=>f.published&&!f.published.retired))for(const n of f.published.nodes.filter(n=>n.type==='objective_entry'&&n.ref===body.id))if(!body.stages?.find(stage=>stage.id===n.stage)?.objectives?.some(o=>o.id===n.objective))fail('Update the objective entry '+n.id+' in '+f.id+' before removing its quest objective.');
  const definitions=flags();function check(v){if(!v||typeof v!=='object')return;if(['all','any','none'].every(k=>Array.isArray(v[k])))for(const id of [...v.all,...v.any,...v.none])if(id.startsWith('story_')&&!definitions.some(f=>f.id===id&&!f.retired))fail('Unknown authored flag: '+id);for(const child of Object.values(v))check(child);}check(body);
  if(kind==='quest')for(const stage of body.stages??[])for(const objective of stage.objectives??[])for(const id of objective.on_complete_flags??[]){
   if(!definitions.some(f=>f.id===id&&!f.retired&&!f.engineOwned))fail('Unknown or retired objective completion flag: '+id,400);
  } // The same check covers ordinary publication, shared bundles and rollback.
  if(body.retired&&list().some(f=>f.published&&!f.published.retired&&JSON.stringify(f.published).includes(JSON.stringify(body.id))))fail('Update or retire flows referencing this asset first.');
 }); // Advanced editors use the same flag and dependency checks as the workshop.
 function gm(input,actor){
  if(['flow_assets_save','flow_assets_publish'].includes(input.action)){
   const assets=input.assets,publish=input.action==='flow_assets_publish';
   if(publish&&!enabled)fail('Workshop publication is disabled during rollout.');
   if(!Array.isArray(assets)||!assets.length||assets.length>64)fail('Choose between 1 and 64 shared assets.',400);
   live.bundle(assets,actor,publish);return {assets:assets.map(a=>({kind:a.kind,id:a.id})),published:publish};
  } // The GM transaction, audit and request receipts also cover asset-only publication; no placeholder flow is needed.
  if(['flow_save','flow_publish','flow_rollback'].includes(input.action))return save(input,actor);
  if(input.action==='flow_validate')return definition(input.entry,false,input.assets??[]);
  if(input.action==='flow_references')return references(input.id);
  if(input.action==='flow_preview')return preview(input);
  if(input.action==='flow_flag_save')return flagSave(input);
  if(input.action==='flow_flag_inspect')return inspect(input.character_id);
  if(input.action==='flow_flag_set'){const c=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(input.character_id);if(!c)fail('Character not found.',404);if(c.revision!==input.revision)fail('Character changed. Refresh first.');const s=JSON.parse(c.state);setStoryFlag(s,input.flag,input.value,flags());db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(s),c.id);return inspect(c.id);}
  fail('Unknown flow action.',400);
 }
 return {catalog,list,get,flags,references,gm,testDefinition,start,available,review,act,exit,resume,settled,snapshot,active,blocking,objectives,beginTest,enabled};
}
