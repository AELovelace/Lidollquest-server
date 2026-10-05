// Live, gamemaster-editable floor traps, layered over the shipped registry.
//
// The baseline arrives in traps-data.json, exported from the campaign's
// datafiles/generation/traps.json by python/export_online_traps.py (the full-dungeon
// exporter refreshes it too). That file is never written at runtime. This module keeps
// database overrides on top of it:
//
//   * shipped traps a gamemaster has edited or retired
//   * brand new custom traps
//
// Everything is validated on the way IN, so a malformed entry is refused at the /gm
// Traps tab rather than reaching a floor. Consumers (full-dungeon route pools in
// full-dungeon-rules.mjs, Map Editor trap placements in placed-traps.mjs) read through
// registry()/pool(), which re-merge only when revision() changes.
import {readFileSync} from 'node:fs';

const CONTROL=/[\x00-\x1f\x7f]/g;
const ID=/^[a-z0-9_]{2,64}$/; // trap_id is the registry key and the client's lookup key; keep it boring.
export const TRAP_TYPES=Object.freeze(['damage','heal','wet','tum','wet_tum','str_drain','stamina_drain','stamina_heal','inco_up','excitement','spawn_enemy','civic_reward','dud']);
export const TRAP_STATS=Object.freeze(['STR','DEX','DEF','INT','CHA']); // dungeonSkillCheck reads player_info[stat.toLowerCase()].
export const TRAP_CHECKS=Object.freeze(['avoid_check','detect_check','resist_check']);
const MODIFIER_STATES=Object.freeze(['childish_score','childish','low_stamina','stamina_pct','crawling','concealed','panties_concealed','visible_accident']); // plus flag:<key> and plain player_info fields
const clean=(value,max)=>String(value??'').replace(CONTROL,' ').trim().slice(0,max);
const fail=(message,code='gm_invalid_trap')=>{throw Object.assign(Error(message),{status:400,code});};
const number=(value,{min,max,label,integer=false})=>{
 const n=typeof value==='number'?value:Number(String(value??'').trim());
 if(String(value??'').trim()===''||!Number.isFinite(n))fail(`${label} must be a number.`);
 if(integer&&!Number.isInteger(n))fail(`${label} must be a whole number.`);
 if(n<min||n>max)fail(`${label} must be between ${min} and ${max}.`);
 return n;
};
const has=(o,k)=>o[k]!==undefined&&o[k]!==null&&o[k]!=='';

function validateCheck(input,label){
 if(!input||typeof input!=='object'||Array.isArray(input))fail(`${label} must be an object.`);
 const extra=Object.keys(input).filter(k=>!['label','stat','difficulty','partial_text','success_text','state_modifiers'].includes(k));if(extra.length)fail(`${label} has unknown fields: ${extra.join(', ')}.`);
 const stat=clean(input.stat,8).toUpperCase();if(!TRAP_STATS.includes(stat))fail(`${label} stat must be one of ${TRAP_STATS.join(', ')}.`);
 const out={label:clean(input.label,120)||fail(`${label} needs a label.`),stat,difficulty:number(input.difficulty,{min:1,max:40,label:label+' difficulty',integer:true})};
 for(const k of ['partial_text','success_text'])if(has(input,k))out[k]=clean(input[k],400);
 if(input.state_modifiers!==undefined){
  if(!Array.isArray(input.state_modifiers)||input.state_modifiers.length>12)fail(`${label} state_modifiers must be a list of up to 12 modifiers.`);
  out.state_modifiers=input.state_modifiers.map(m=>{
   if(!m||typeof m!=='object'||Array.isArray(m))fail(`${label} has a malformed state modifier.`);
   const state=clean(m.state??m.when,64);if(!state||!(MODIFIER_STATES.includes(state)||/^flag:[A-Za-z0-9_:.-]{1,80}$/.test(state)||/^[a-z_]{2,40}$/.test(state)))fail(`${label} modifier needs a state (e.g. crawling or flag:key).`);
   const mod={state,bonus:number(m.bonus,{min:-20,max:20,label:label+' modifier bonus'})};
   for(const k of ['min','max'])if(m[k]!==undefined)mod[k]=number(m[k],{min:-1000000,max:1000000,label:label+' modifier '+k});
   for(const k of ['equals','not'])if(m[k]!==undefined){if(!['number','string','boolean'].includes(typeof m[k]))fail(`${label} modifier ${k} must be a number, text or true/false.`);mod[k]=m[k];}
   if(m.present!==undefined)mod.present=m.present===true;
   return mod;
  });
 }
 return out;
} // Shapes dungeonSkillCheck() understands; nothing else is stored.

const TRAP_FIELDS=new Set(['id','trap_id','name','type','weight','zones','message','narrative_chunk','min','max','amount','trigger_style','archetype','tutorial_label','struggle_threshold','wait_threshold','lingering_turns','lingering_delay','lingering_wet','lingering_tum','force_safe_room_only','enemy_id',...TRAP_CHECKS]);
export function validateTrap(input,{zoneKeys=[],triggerStyles=[],narratives={}}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Send a trap to save.');
 const extra=Object.keys(input).filter(k=>!TRAP_FIELDS.has(k));if(extra.length)fail('Unknown trap fields: '+extra.join(', ')+'.');
 const id=clean(input.trap_id??input.id,64).toLowerCase();
 if(!ID.test(id))fail('Trap id must be 2-64 characters of a-z, 0-9 and _.');
 const type=clean(input.type,24);if(!TRAP_TYPES.includes(type))fail('Type must be one of '+TRAP_TYPES.join(', ')+'.');
 const name=clean(input.name,80);if(!name)fail('Give the trap a name.');
 const message=clean(input.message,400);if(!message)fail('Write the message the player sees ({value}, {name}, {trigger} and {zone} are filled in).');
 const zones=Array.isArray(input.zones)?[...new Set(input.zones.map(z=>clean(z,32)))].filter(Boolean):[];
 if(!zones.length)fail('Pick at least one zone, or nothing can ever roll this trap.');
 for(const z of zones)if(z!=='any'&&!zoneKeys.includes(z))fail(`'${z}' is not a trap zone (${['any',...zoneKeys].join(', ')}).`);
 const trap={trap_id:id,name,type,weight:number(input.weight??1,{min:1,max:1000,label:'Weight',integer:true}),zones,message}; // Whole numbers: roll() is crypto.randomInt, which refuses a fractional range.
 const chunk=clean(input.narrative_chunk,120);
 if(chunk){if(!Object.hasOwn(narratives,chunk))fail(`Narrative '${chunk}' is not one of the shipped trap narratives.`);trap.narrative_chunk=chunk;}
 if(has(input,'amount'))trap.amount=number(input.amount,{min:0,max:1000,label:'Amount',integer:true});
 if(has(input,'min')||has(input,'max')){
  if(!has(input,'min')||!has(input,'max'))fail('Give both min and max, or neither.');
  trap.min=number(input.min,{min:0,max:1000,label:'Min',integer:true});trap.max=number(input.max,{min:0,max:1000,label:'Max',integer:true});
  if(trap.min>trap.max)fail('Min cannot be above max.');
 }
 if(has(input,'trigger_style')){const style=clean(input.trigger_style,16);if(!triggerStyles.includes(style))fail('Trigger style must be one of '+triggerStyles.join(', ')+'.');trap.trigger_style=style;}
 for(const k of ['archetype','tutorial_label'])if(has(input,k))trap[k]=clean(input[k],60);
 for(const k of ['struggle_threshold','wait_threshold','lingering_turns','lingering_delay'])if(has(input,k))trap[k]=number(input[k],{min:0,max:50,label:k,integer:true});
 for(const k of ['lingering_wet','lingering_tum'])if(has(input,k))trap[k]=number(input[k],{min:0,max:100,label:k});
 if((trap.lingering_wet||trap.lingering_tum)&&!trap.lingering_turns)fail('Lingering wet/tum needs lingering_turns.');
 if(input.force_safe_room_only===true)trap.force_safe_room_only=true;
 if(has(input,'enemy_id')){if(type!=='spawn_enemy')fail('enemy_id only applies to spawn_enemy traps.');const enemy=clean(input.enemy_id,64);if(!/^[a-z0-9_]+$/.test(enemy))fail('enemy_id must be a monster id.');trap.enemy_id=enemy;}
 for(const k of TRAP_CHECKS)if(input[k]!==undefined&&input[k]!==null)trap[k]=validateCheck(input[k],k);
 return trap;
}

export const shippedTraps=()=>JSON.parse(readFileSync(new URL('./traps-data.json',import.meta.url),'utf8'));

export function createTrapStore(db,{now=Date.now,base=null}={}){
 const shipped=base??shippedTraps();
 const vocabulary={zoneKeys:shipped.zone_keys??String(shipped._zone_keys??'').split(',').map(s=>s.trim()).filter(Boolean),triggerStyles:shipped.trigger_styles??String(shipped._trigger_styles??'').split(',').map(s=>s.trim()).filter(Boolean),narratives:shipped.narratives??{}};
 db.exec(`CREATE TABLE IF NOT EXISTS gm_trap_entries(id TEXT PRIMARY KEY,payload TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS gm_trap_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);`); // payload '' marks a retired shipped trap without edits.
 const revisionQuery=db.prepare("SELECT value FROM gm_trap_meta WHERE key='revision'");
 const bump=()=>db.prepare("INSERT INTO gm_trap_meta VALUES ('revision',1) ON CONFLICT(key) DO UPDATE SET value=value+1").run(); // Written lazily: read-only snapshot workers construct this store too.
 const revision=()=>revisionQuery.get()?.value??0; // A monotonic counter: every save/retire/restore/reset moves it, so caches can never mistake two states for one.
 const rows=()=>db.prepare('SELECT * FROM gm_trap_entries ORDER BY id').all();
 let cache={revision:-1,registry:null};
 function registry(){ // The effective registry: shipped order first (route pools stay identical with no overrides), custom traps after.
  const at=revision();if(cache.revision===at)return cache.registry;
  const out={...shipped.traps},overrides=rows();
  for(const row of overrides){if(row.retired)delete out[row.id];else out[row.id]=JSON.parse(row.payload);}
  cache={revision:at,registry:Object.freeze(out)};return cache.registry;
 }
 const pool=keys=>{const want=new Set(keys);return Object.values(registry()).filter(t=>t.zones.some(z=>want.has(z)));}; // Same zone rule the exporter used for route.traps.
 const narrative=id=>vocabulary.narratives[id]??null;
 function status(id){const row=db.prepare('SELECT * FROM gm_trap_entries WHERE id=?').get(id),base=Object.hasOwn(shipped.traps,id);if(!row)return base?'shipped':null;if(row.retired)return 'retired';return base?'edited':'custom';}
 function list(){
  const live=registry(),ids=[...new Set([...Object.keys(shipped.traps),...rows().map(r=>r.id)])];
  return ids.map(id=>{const row=db.prepare('SELECT * FROM gm_trap_entries WHERE id=?').get(id),payload=row?.payload?JSON.parse(row.payload):null;return {id,status:status(id),source:Object.hasOwn(shipped.traps,id)?'shipped':'custom',trap:live[id]??payload??shipped.traps[id],baseline:shipped.traps[id]??null,updated:row?.updated??0,actor:row?.actor??''};});
 }
 function save(input,actor=''){
  const trap=validateTrap(input,vocabulary);
  db.prepare('INSERT INTO gm_trap_entries(id,payload,retired,updated,actor) VALUES (?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,retired=0,updated=excluded.updated,actor=excluded.actor').run(trap.trap_id,JSON.stringify(trap),now(),String(actor??''));
  bump();return {trap,status:status(trap.trap_id)};
 }
 function retire(id,actor=''){
  const key=clean(id,64).toLowerCase(),row=db.prepare('SELECT * FROM gm_trap_entries WHERE id=?').get(key);
  if(!row&&!Object.hasOwn(shipped.traps,key))fail('That trap does not exist.','gm_unknown_trap');
  if(row?.retired)fail('That trap is already retired.','gm_unknown_trap');
  db.prepare('INSERT INTO gm_trap_entries(id,payload,retired,updated,actor) VALUES (?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET retired=1,updated=excluded.updated,actor=excluded.actor').run(key,row?.payload??'',now(),String(actor??'')); // Shipped traps are tombstoned, not deleted: the next export would bring them back.
  bump();return {id:key,status:'retired'};
 }
 function restore(id,actor=''){ // Retired -> live again (keeping any edits); edited shipped -> exactly the shipped trap.
  const key=clean(id,64).toLowerCase(),row=db.prepare('SELECT * FROM gm_trap_entries WHERE id=?').get(key),base=Object.hasOwn(shipped.traps,key);
  if(!row)fail(base?'That trap already matches the shipped registry.':'That trap does not exist.','gm_unknown_trap');
  if(row.retired&&row.payload)db.prepare('UPDATE gm_trap_entries SET retired=0,updated=?,actor=? WHERE id=?').run(now(),String(actor??''),key);
  else if(base)db.prepare('DELETE FROM gm_trap_entries WHERE id=?').run(key);
  else fail('That custom trap has nothing to restore.','gm_unknown_trap');
  bump();return {id:key,status:status(key)};
 }
 function reset(){db.prepare('DELETE FROM gm_trap_entries').run();bump();return {reset:true};} // Back to exactly what the last export shipped.
 function clientFile(){ // The effective registry in the client's datafiles/generation/traps.json shape, for singleplayer.
  return {_comment:shipped._comment??'',_zone_keys:shipped._zone_keys??vocabulary.zoneKeys.join(', '),_trigger_styles:shipped._trigger_styles??vocabulary.triggerStyles.join(', '),traps:structuredClone(registry())};
 }
 return {revision,registry,pool,narrative,list,status,save,retire,restore,reset,clientFile,zoneKeys:vocabulary.zoneKeys,triggerStyles:vocabulary.triggerStyles,narrativeIds:()=>Object.keys(vocabulary.narratives),types:TRAP_TYPES,stats:TRAP_STATS};
}

export function trapZoneKeys(zoneId,{fullDungeons=[],category=''}={}){ // Which registry zones a Map Editor "Random" trap draws from in an online zone; 'any' always applies.
 const full=fullDungeons.find(d=>d.config.zone_id===zoneId);
 if(full)return full.trap_zones??(full.config.event_zone?['any',full.config.event_zone]:[]);
 const id=String(zoneId??''),rules=[[/littlebig/,'littlebig_city'],[/nursery/,'nursery'],[/school/,'school'],[/hospital/,'hospital'],[/mansion/,'mansion'],[/desert|gulch|caldera/,'desert'],[/woods|taiga|forest/,'forest'],[/^dive-quarters$/,'bsp']];
 const hit=rules.find(([re])=>re.test(id));if(hit)return ['any',hit[1]];
 return category==='safe'?['any','town']:['any'];
}
