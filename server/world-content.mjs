import {validateQuestContent,checkQuestReferences,objectiveTypes,stateFields,questStats} from './quest-content.mjs';
import {validateWorldPng} from './world-png.mjs';
import {createHash} from 'node:crypto';
import {defaultScenes,compiledArtwork,defaultSceneRefs,registerDefaultScenes,pinDefeat} from './defeat-scenes.mjs';
const clone=structuredClone;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,code:'world_content_invalid'});};
const id=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{1,79}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const text=(value,max=4000)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008]/.test(value)?value:fail('Invalid text.');
const number=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max?value:fail(`Use a number between ${min} and ${max}.`);
const integer=(value,min,max)=>Number.isSafeInteger(value)?number(value,min,max):fail('Use a whole number.');

export function createWorldContent(db,{now=Date.now,spells={},equipment={},defeatEquipment={},questPack=[]}={}){
 registerDefaultScenes(db);
 db.exec(`CREATE TABLE IF NOT EXISTS world_content(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,draft TEXT NOT NULL,published TEXT,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS world_content_history(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(kind,id,revision));
 CREATE TABLE IF NOT EXISTS world_assets(id TEXT PRIMARY KEY,png TEXT NOT NULL,frames INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS world_commands(actor TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor,id));`);
 db.prepare("UPDATE world_content SET draft=replace(draft,'honeydew-lantern-garden:','honeydew-lantern:'),published=replace(published,'honeydew-lantern-garden:','honeydew-lantern:') WHERE kind='quest' AND (draft LIKE '%honeydew-lantern-garden:%' OR published LIKE '%honeydew-lantern-garden:%')").run(); // Honeydew Village's residents moved from the retired Market Square annex into the lobby town (2026-09-23); saved quests keep pointing at the same people.
 const baselines={monster:new Map(),zone:new Map(),npc:new Map(),quest:new Map()},routes=new Map(),compiledSprites=new Set(['sprItem',...Object.keys(compiledArtwork)]);let cache=null;
 function register(data){ // Register route-local baselines without rewriting exported files or collapsing distinct aliases.
  const zone=data.config.zone_id??'dive-quarters';routes.set(zone,clone(data));
  for(const [key,raw] of Object.entries(data.enemies)){
   const existing=baselines.monster.get(key),entry={...clone(raw),id:key,enemy_id:raw.enemy_id??key,retired:false,...(defeatEquipment[raw.enemy_id??key]?{defeat_equipment:clone(defeatEquipment[raw.enemy_id??key])}:{})};
   for(const sprite of [raw.sprite,raw.battle_sprite])if(sprite)compiledSprites.add(sprite);
   if(!existing)baselines.monster.set(key,entry);
  }
  baselines.zone.set(zone,{id:zone,static:!!data.config.static,spawning:true,enemies_roam:true,enemies_per_room:data.config.enemies_per_room,enemy_respawn_seconds:data.config.enemy_respawn_seconds,boss_respawn_seconds:data.config.boss_respawn_seconds,pursuit_steps:data.config.pursuit_steps,roaming:true,boss_enemy_id:data.config.boss_enemy_id??(data.enemies.dive_iris?'dive_iris':null),pool:(data.enemy_types??[{enemy_id:'diaper_fairy',weight:60},{enemy_id:'teddy_mimic',weight:40}]).map(e=>({enemy_id:e.enemy_id,weight:e.weight??e.chance}))});cache=null;
 }
 function registerQuestPack(pack){ // Shipped content is validated at boot, so a malformed pack stops the service instead of half-loading.
  for(const quest of pack){
   const body=validate('quest',quest);
   if(body.retired)continue; // A retired entry stays in the file as documentation without being offered.
   baselines.quest.set(body.id,body);
  }
  cache=null;
 }
 function rows(){return db.prepare('SELECT * FROM world_content').all();}
 function effective(value){const out=clone(value);if(!out.defeat&&defaultSceneRefs[out.enemy_id??out.id]){out.defeat_ref=defaultSceneRefs[out.enemy_id??out.id];out.defeat_inherited=true;}return out;} // Map definitions retain immutable references instead of copying every page into every room.
 function published(){
  if(cache)return cache;const monsters=Object.fromEntries([...baselines.monster].map(([k,v])=>[k,clone(v)])),zones=Object.fromEntries([...baselines.zone].map(([k,v])=>[k,clone(v)]));let revision=0;const npcs={},quests=Object.fromEntries([...baselines.quest].map(([k,v])=>[k,clone(v)])); // A shipped quest pack is live on boot; a saved row still overlays it, so the panel can edit or retire any one of them.
  for(const row of rows()){if(row.published)({monster:monsters,zone:zones,npc:npcs,quest:quests}[row.kind])[row.id]=JSON.parse(row.published);}
  for(const key of Object.keys(monsters))monsters[key]=effective(monsters[key]);
  revision=db.prepare('SELECT COALESCE(SUM(revision),0) n FROM (SELECT MAX(revision) revision FROM world_content_history GROUP BY kind,id)').get().n;return cache={monsters,zones,npcs,quests,revision,enabled:rows().some(r=>r.published)};
 }
 function entry(kind,key){const row=db.prepare('SELECT * FROM world_content WHERE kind=? AND id=?').get(kind,key),base=baselines[kind]?.get(key);if(!row&&!base)fail('Content not found.',404);const draft=row?JSON.parse(row.draft):clone(base);return {kind,id:key,revision:row?.revision??0,draft,published:row?.published?JSON.parse(row.published):clone(base??null),...(kind==='monster'?{effective_defeat:pinDefeat(effective(draft)).defeat??null,default_defeat:clone(defaultScenes[draft.enemy_id??key]??null),defeat_source:draft.defeat?'Admin override':'Game default'}:{}),history:db.prepare('SELECT revision,actor,created FROM world_content_history WHERE kind=? AND id=? ORDER BY revision DESC').all(kind,key)};}
 function assetRef(value){if(value===null||value==='')return '';if(typeof value!=='string'||value.length>100)fail('Choose an artwork asset.');if(value.startsWith('managed-')){if(!db.prepare('SELECT 1 FROM world_assets WHERE id=?').get(value))fail('Artwork is unavailable.');}else if(!compiledSprites.has(value)||!/^[A-Za-z][A-Za-z0-9_]*$/.test(value))fail('Choose a compiled sprite or uploaded artwork.');return value;}
 function beats(value){
  if(!Array.isArray(value)||value.length>64||value.some(v=>!v||typeof v!=='object'||Array.isArray(v)))fail('Use up to 64 scene pages.');const names=new Set(value.map((v,i)=>v.id??String(i)));if(names.size!==value.length)fail('Scene page IDs must be unique.');
  const next=v=>Number.isInteger(v)?(v>=0&&v<value.length?(value[v].id??String(v)):fail('Scene choice points to an unknown page.')):v==null||v==='close'||names.has(v)?v:fail('Scene choice points to an unknown page.');
  return value.map((v,i)=>({id:text(v.id??String(i),80),text:text(v.text??''),next:next(v.next),...(v.sprite?{sprite:assetRef(v.sprite)}:{}),...(v.sprite_side?{sprite_side:text(v.sprite_side,20)}:{}),...(v.sprite_index!=null?{sprite_index:integer(v.sprite_index,0,10000)}:{}),...(v.title_override?{title_override:text(v.title_override,100)}:{}),...(v.actions?{actions:(Array.isArray(v.actions)&&v.actions.length<=8?v.actions:fail('Use up to eight choices per page.')).map(a=>({label:text(a.label,160),next:next(a.next)}))}:{})}));
 }
 function validate(kind,value){
  if(!value||!id(value.id))fail('Choose a stable lowercase content ID.');
  if(['npc','quest'].includes(kind))return validateQuestContent(kind,value,{assetRef,spells,equipment});
  if(kind==='monster'){
   const out={id:value.id,enemy_id:value.enemy_id??value.id,name:text(value.name,100),retired:!!value.retired};if(!id(out.enemy_id))fail('Invalid enemy identity.');
   for(const key of ['hp','str','def','dex','exp'])out[key]=integer(value[key],key==='hp'?1:0,key==='hp'?100000:10000);
   out.spell_cast_chance=number(value.spell_cast_chance??0,0,1);out.enemy_spells=value.enemy_spells??[];
   if(!Array.isArray(out.enemy_spells)||out.enemy_spells.length>32||out.enemy_spells.some(s=>!Object.hasOwn(spells,s)))fail('Choose existing spells.');
   out.sprite=assetRef(value.sprite??'');out.battle_sprite=assetRef(value.battle_sprite??'');out.roaming=!!value.roaming;
   if(value.defeat){out.defeat={};if(value.defeat.schema===2){out.defeat.schema=2;for(const variant of ['first','repeat','charm']){const scene=value.defeat[variant];if(!scene){if(variant==='charm')continue;fail('First and repeat scenes are required.');}out.defeat[variant]={};for(const key of ['dialogues','aftermaths']){const list=scene[key];if(!Array.isArray(list)||!list.length||list.length>16||new Set(list.map(v=>v.id)).size!==list.length)fail('Use one to sixteen uniquely named scene variants.');out.defeat[variant][key]=list.map(v=>({id:text(v.id,80),...(key==='aftermaths'?{title:text(v.title??'After the battle',100)}:{}),pages:beats(v.pages??[])}));}}}else for(const variant of ['first','repeat']){const scene=value.defeat[variant];if(scene)out.defeat[variant]={title:text(scene.title??'After the battle',100),dialogue:beats(scene.dialogue??[]),aftermath:beats(scene.aftermath??[])};}}
   if(value.defeat_equipment){out.defeat_equipment={};for(const variant of ['first','repeat']){const kit=value.defeat_equipment[variant]??[];if(!Array.isArray(kit)||kit.length>16||kit.some(k=>!Object.hasOwn(equipment,k)&&!(defeatEquipment[out.enemy_id]?.[variant]??[]).includes(k)))fail('Choose existing defeat equipment.');out.defeat_equipment[variant]=[...kit];}}
   if(Buffer.byteLength(JSON.stringify(out))>256*1024)fail('Keep monster text and choices below 256 KiB.');
   return out;
  }
  if(kind!=='zone'||!routes.has(value.id))fail('Unknown Dive.');
  const out={id:value.id,static:!!value.static,spawning:!!value.spawning,enemies_roam:value.enemies_roam!==false,enemies_per_room:integer(value.enemies_per_room,0,6),enemy_respawn_seconds:integer(value.enemy_respawn_seconds,1,604800),boss_respawn_seconds:integer(value.boss_respawn_seconds,1,604800),pursuit_steps:integer(value.pursuit_steps,0,32),boss_enemy_id:value.boss_enemy_id||null};
  if(!Array.isArray(value.pool)||value.pool.length>128)fail('Invalid monster pool.');out.pool=value.pool.map(e=>({enemy_id:e.enemy_id,weight:integer(e.weight,1,1000)}));
  if(out.spawning&&out.enemies_per_room&&!out.pool.length)fail('Choose at least one spawn monster.');
  return out;
 }
 function checkReferences(kind,body){
  const live=published();
  if(['npc','quest'].includes(kind)){checkQuestReferences(kind,body,live);referenceCheck?.(kind,body);}
  if(kind==='zone'){for(const key of [...body.pool.map(e=>e.enemy_id),body.boss_enemy_id].filter(Boolean))if(!live.monsters[key]||live.monsters[key].retired)fail('Publish every referenced monster first.');}
  if(['monster','npc'].includes(kind)&&body.retired)for(const quest of Object.values(live.quests))if(!quest.retired&&(kind==='npc'&&(quest.givers.includes(body.id)||quest.turn_in.npc===body.id)||quest.stages.some(s=>s.objectives.some(o=>(kind==='monster'?o.type==='kill':o.type==='talk')&&o.target===body.id))))fail('Update or retire the quests referencing this definition first.');
  if(kind==='monster'&&body.retired)for(const z of Object.values(live.zones))if(z.boss_enemy_id===body.id||z.pool.some(e=>e.enemy_id===body.id))fail('Remove this monster from zone pools and bosses before retiring it.');
 }
 function change(input,actor){
  const kind=input.kind,key=input.id;if(!['monster','zone','npc','quest'].includes(kind)||!id(key))fail('Unknown content kind or ID.');
  const row=db.prepare('SELECT * FROM world_content WHERE kind=? AND id=?').get(kind,key);if((row?.revision??0)!==input.revision)fail('This draft changed. Refresh before editing.',409);
  const revision=(row?.revision??0)+1;let body;
  if(input.action==='content_rollback'){const old=db.prepare('SELECT body FROM world_content_history WHERE kind=? AND id=? AND revision=?').get(kind,key,input.target_revision);if(!old)fail('Published revision not found.');body=JSON.parse(old.body);}
  else body=validate(kind,{...(input.entry??(row?JSON.parse(row.draft):baselines[kind].get(key))),id:key});
  const publish=input.action==='content_publish'||input.action==='content_rollback';if(publish)checkReferences(kind,body);
  const encoded=JSON.stringify(body);db.prepare('INSERT INTO world_content VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,draft=excluded.draft,published=excluded.published').run(kind,key,revision,encoded,publish?encoded:row?.published??null);
  if(publish)db.prepare('INSERT INTO world_content_history VALUES (?,?,?,?,?,?)').run(kind,key,revision,encoded,actor,now());cache=null;return entry(kind,key);
 }
 function view(){const live=published();return {revision:live.revision,enabled:live.enabled,npcs:rows().filter(r=>r.kind==='npc').map(r=>entry('npc',r.id)),quests:[...new Set([...baselines.quest.keys(),...rows().filter(r=>r.kind==='quest').map(r=>r.id)])].map(key=>entry('quest',key)),questCatalog:{objectiveTypes,stateFields,questStats},monsters:[...new Set([...baselines.monster.keys(),...rows().filter(r=>r.kind==='monster').map(r=>r.id)])].map(key=>entry('monster',key)),zones:[...routes.keys()].map(key=>entry('zone',key)),compiledSprites:[...compiledSprites],spells:Object.keys(spells),equipment:Object.entries(equipment).map(([id,v])=>({id,name:v.name})),assets:db.prepare('SELECT id,frames,width,height FROM world_assets').all()};}
 function resolve(data){ // Preserve route-specific shipped stats until a DM publishes an override for that monster ID.
  const out=clone(data),live=published(),zone=out.config.zone_id??'dive-quarters',t=live.zones[zone];
  out.enemies={...clone(live.monsters),...out.enemies}; // A pool may select any published or shipped monster, including another route's defaults.
  for(const enemy of Object.values(out.enemies))if(defeatEquipment[enemy.enemy_id])enemy.defeat_equipment=clone(defeatEquipment[enemy.enemy_id]);
  for(const row of rows().filter(r=>r.kind==='monster'&&r.published))out.enemies[row.id]=JSON.parse(row.published);
  for(const key of Object.keys(out.enemies))out.enemies[key]=effective(out.enemies[key]);
  if(t){Object.assign(out.config,{enemies_per_room:t.spawning?t.enemies_per_room:0,enemy_respawn_seconds:t.enemy_respawn_seconds,boss_respawn_seconds:t.boss_respawn_seconds,pursuit_steps:t.pursuit_steps,spawning:t.spawning,roaming:t.enemies_roam!==false,static:t.static??!!out.config.static});if(t.boss_enemy_id)out.config.boss_enemy_id=t.boss_enemy_id;out.enemy_types=t.pool.map(e=>({...e,chance:e.weight}));}
  out.contentRevision=live.revision;return out;
 }
 function putAsset({png,frames=1}){
  if(typeof png!=='string'||png.length>1200000||!/^[A-Za-z0-9+/]+={0,2}$/.test(png))fail('Upload a bounded PNG.');const bytes=Buffer.from(png,'base64');
  if(bytes.length<33||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR')fail('Upload a PNG image.');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(![1,36].includes(frames)||height<1||height>512||width<1||width>4096||width%frames||width/frames>512)fail('Use a portrait or a 36-frame horizontal sprite strip.');
  validateWorldPng(bytes,width,height);
  const key='managed-'+createHash('sha256').update(bytes).update(String(frames)).digest('hex');db.prepare('INSERT OR IGNORE INTO world_assets VALUES (?,?,?,?,?,?)').run(key,png,frames,width,height,now());return {id:key,frames,width,height};
 }
 function asset(key){const row=db.prepare('SELECT id,png,frames,width,height FROM world_assets WHERE id=?').get(key??'')??compiledArtwork[key];if(!row)fail('Artwork not found.',404);return row;}
 function once(input,actor,work){ // Receipts and mutations share the caller's transaction, including audit recording.
  if(typeof input.request_id!=='string'||! /^[A-Za-z0-9_-]{8,100}$/.test(input.request_id))fail('A request ID is required.');const fingerprint=JSON.stringify(input),prior=db.prepare('SELECT * FROM world_commands WHERE actor=? AND id=?').get(actor,input.request_id);
  if(prior){if(prior.fingerprint!==fingerprint)fail('Request ID was already used.',409);return JSON.parse(prior.result);}const result=work();db.prepare('INSERT INTO world_commands VALUES (?,?,?,?)').run(actor,input.request_id,fingerprint,JSON.stringify(result));return result;
 }
 let referenceCheck=null;
 registerQuestPack(questPack); // Before any caller reads published(), so the first snapshot already carries the pack.
 return {mapReady:null,questEvent:null,placementPositions:null,setReferenceCheck(fn){referenceCheck=fn;},register,registerQuestPack,published,entry,change,view,resolve,putAsset,asset,assetRef,once,invalidate(){cache=null;}}; // Placements share the editor's compiled/immutable artwork validation.
}
