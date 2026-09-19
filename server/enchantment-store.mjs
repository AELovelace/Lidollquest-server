// Live, gamemaster-editable overrides for the shared curse / blessing table.
//
// The shipped table arrives inside dive-data.json, exported from the campaign's
// datafiles/generation/enchantments.json. That file stays the baseline and is
// never written to at runtime. This module layers database overrides on top:
//
//   * tuning values a gamemaster has retuned in the /gm panel
//   * shipped entries a gamemaster has edited or retired
//   * brand new entries a gamemaster has written
//
// Everything is validated on the way IN, so a malformed entry is refused at the
// panel rather than reaching the roller. The roller re-reads through revision(),
// which changes whenever any override does, so an edit takes effect on the next
// chest without restarting the service.
//
// Overrides never rewrite already-claimed loot: dive-loot caches each chest's
// roll in the visit's own receipts, and those are returned untouched.

import {SLOT_CATEGORIES,STAT_DELTA_KEYS,TUNING_KEYS} from './enchantment.mjs';

const CONTROL=/[\x00-\x1f\x7f]/g; // Stripped from every stored string, exactly as the moderation tools do.
const ID=/^[a-z][a-z0-9_]{2,47}$/; // Ids are referenced by save data, so keep them boring and stable.
const clean=(value,max)=>String(value??'').replace(CONTROL,' ').trim().slice(0,max);
const fail=(message,code='gm_invalid_enchantment')=>{throw Object.assign(Error(message),{status:400,code});};

const number=(value,{min,max,label,integer=false})=>{
 const n=typeof value==='number'?value:Number(String(value??'').trim());
 if(!Number.isFinite(n))fail(`${label} must be a number.`);
 if(integer&&!Number.isInteger(n))fail(`${label} must be a whole number.`);
 if(n<min||n>max)fail(`${label} must be between ${min} and ${max}.`);
 return n;
};

// Bounds exist so a slip of the keyboard cannot make the game unplayable: a proc
// every 2 steps, a +9000 shame hit or a lock nobody can escape are all refused.
const TUNING_BOUNDS={
 curse_chance_low_rarity:[0,60],curse_chance_high_rarity:[0,60],
 bless_chance_low_rarity:[0,60],bless_chance_high_rarity:[0,60],
 value_weight:[0,1],stat_weight:[0,1],
 value_soft_cap:[1,100000],stat_soft_cap:[1,10000],
 authored_rarity_weight:[0,1],bias_multiplier:[1,10],proc_jitter:[0,120],
};

export function validateTuning(patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))fail('Send the tuning values to change.');
 const out={};
 for(const [key,value] of Object.entries(patch)){
  if(!Object.hasOwn(TUNING_BOUNDS,key))fail(`Unknown tuning value: ${key}`);
  const [min,max]=TUNING_BOUNDS[key];
  out[key]=number(value,{min,max,label:key});
 }
 if(!Object.keys(out).length)fail('Send at least one tuning value.');
 return out;
} // Only the numeric knobs are editable here; the rarity tier table stays authored content.

export function validateEntry(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Send an enchantment to save.');
 const id=clean(input.id,48).toLowerCase();
 if(!ID.test(id))fail('Id must be 3-48 characters: a lowercase letter, then letters, digits or underscores.');
 const alignment=clean(input.alignment,16);
 if(alignment!=='curse'&&alignment!=='blessing')fail('Alignment must be curse or blessing.');

 const slots=Array.isArray(input.slots)?[...new Set(input.slots.map(s=>clean(s,32)))]:[];
 if(!slots.length)fail('Pick at least one slot, or nothing can ever roll this.');
 for(const slot of slots)if(!SLOT_CATEGORIES.includes(slot))fail(`'${slot}' is not an item category.`);

 const min=number(input.min_score??0,{min:0,max:1,label:'Min rarity'});
 const max=number(input.max_score??1,{min:0,max:1,label:'Max rarity'});
 if(min>max)fail('Min rarity cannot be above max rarity.');

 const fx=input.effect&&typeof input.effect==='object'&&!Array.isArray(input.effect)?input.effect:{};
 const procMin=number(fx.proc_min??120,{min:30,max:100000,label:'Proc min',integer:true}); // faster than 30 steps spams the player
 const procMax=number(fx.proc_max??procMin,{min:procMin,max:200000,label:'Proc max',integer:true});

 const lines=Array.isArray(fx.popup_lines)?fx.popup_lines.map(line=>clean(line,400)).filter(Boolean).slice(0,8):[];
 const delta={};
 if(fx.stat_delta&&typeof fx.stat_delta==='object'&&!Array.isArray(fx.stat_delta)){
  for(const [key,value] of Object.entries(fx.stat_delta)){
   if(!STAT_DELTA_KEYS.includes(key))fail(`'${key}' is not a stat the effect engine applies.`);
   const n=number(value,{min:-200,max:200,label:key});
   if(n!==0)delta[key]=n; // a zero delta is the same as not authoring one
  }
 }

 const movementLock=fx.movement_lock===true;
 const title=clean(fx.popup_title,80),log=clean(fx.log_text,240);
 if(!movementLock&&!lines.length&&!log&&!Object.keys(delta).length)
  fail('An effect with no popup, no log line and no stat change would do nothing.');

 const lockPromptMin=number(fx.lock_prompt_min??4,{min:1,max:120,label:'Lock prompt min',integer:true});
 const effect={
  effect_id:id,                                                   // the client keys tooltips and saves off this
  enabled:input.enabled!==false,
  trigger_mode:clean(fx.trigger_mode,8)==='time'?'time':'step',
  proc_min:procMin,proc_max:procMax,
  chance_percent:number(fx.chance_percent??85,{min:0,max:100,label:'Proc chance'}),
  cooldown:number(fx.cooldown??0,{min:0,max:100000,label:'Cooldown',integer:true}),
  popup_title:title,popup_text:'',popup_lines:lines,             // popup_text is always sourced from popup_lines
  log_text:log,
  narrative_chunk:clean(fx.narrative_chunk,120),
  movement_lock:movementLock,
  lock_prompt_min:lockPromptMin,
  lock_prompt_max:number(fx.lock_prompt_max??Math.max(lockPromptMin,8),{min:lockPromptMin,max:240,label:'Lock prompt max',integer:true}),
  // A lock the player can never escape would strand them, so the floor is 5%.
  lock_release_chance:number(fx.lock_release_chance??35,{min:5,max:100,label:'Lock release chance'}),
  lock_title:clean(fx.lock_title,80)||'Constricted!',
  lock_text:clean(fx.lock_text,400)||'You struggle against {item}...',
 };
 if(Object.keys(delta).length)effect.stat_delta=delta;

 return {
  id,alignment,
  name:clean(input.name,60)||id.replace(/_/g,' '),
  family:clean(input.family,24)||'CUSTOM',                        // grouping label for the editor lists
  slots,weight:number(input.weight??10,{min:0.1,max:1000,label:'Weight'}),
  min_score:min,max_score:max,
  sticky:input.sticky===true&&alignment==='curse',                // a sticky blessing would trap the player in a buff
  desc_hint:clean(input.desc_hint,240),
  enabled:input.enabled!==false,
  effect,
 };
}

export function createEnchantmentStore(db,{now=Date.now}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS gm_enchant_tuning(key TEXT PRIMARY KEY,value REAL NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS gm_enchant_entries(id TEXT PRIMARY KEY,alignment TEXT NOT NULL,payload TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');`);

 // A cheap fingerprint of every override, so the roller can cache its enchanter
 // and rebuild only when a gamemaster has actually changed something.
 const revision=()=>{
  const t=db.prepare('SELECT COUNT(*) AS n,COALESCE(MAX(updated),0) AS at FROM gm_enchant_tuning').get();
  const e=db.prepare('SELECT COUNT(*) AS n,COALESCE(MAX(updated),0) AS at FROM gm_enchant_entries').get();
  return `${t.n}:${t.at}:${e.n}:${e.at}`;
 };

 const tuningRows=()=>Object.fromEntries(db.prepare('SELECT key,value FROM gm_enchant_tuning').all().map(r=>[r.key,r.value]));
 const entryRows=()=>db.prepare('SELECT * FROM gm_enchant_entries').all();

 function apply(base){ // Merge the shipped table with every live override.
  const table={
   tuning:{...(base?.tuning??{}),...tuningRows()},
   curses:[...(base?.curses??[])],
   blessings:[...(base?.blessings??[])],
  };
  for(const row of entryRows()){
   const shipped=[table.curses,table.blessings].map(list=>list.findIndex(e=>e.id===row.id));
   for(let i=0;i<2;i++)if(shipped[i]>=0)(i?table.blessings:table.curses).splice(shipped[i],1); // drop the shipped copy first
   if(row.retired)continue;                                        // retired shipped entries simply do not come back
   const entry=JSON.parse(row.payload);
   (entry.alignment==='curse'?table.curses:table.blessings).push(entry); // an edit may also move it between tables
  }
  return table;
 }

 function list(base){ // What the panel shows: shipped, edited, custom and retired, in one roster.
  const shipped=new Map();
  for(const entry of [...(base?.curses??[]),...(base?.blessings??[])])shipped.set(entry.id,entry);
  const out=[];
  const seen=new Set();
  for(const row of entryRows()){
   seen.add(row.id);
   const entry=JSON.parse(row.payload);
   out.push({...entry,source:shipped.has(row.id)?'edited':'custom',retired:Boolean(row.retired),updated:row.updated,actor:row.actor});
  }
  for(const [id,entry] of shipped)if(!seen.has(id))out.push({...entry,source:'shipped',retired:false,updated:0,actor:''});
  out.sort((a,b)=>a.alignment===b.alignment?a.id.localeCompare(b.id):a.alignment.localeCompare(b.alignment));
  return out;
 }

 function tune(patch,actor=''){
  const values=validateTuning(patch),at=now();
  const write=db.prepare('INSERT INTO gm_enchant_tuning(key,value,updated,actor) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated,actor=excluded.actor');
  for(const [key,value] of Object.entries(values))write.run(key,value,at,String(actor??''));
  return values;
 }

 function save(input,actor=''){
  const entry=validateEntry(input);
  db.prepare('INSERT INTO gm_enchant_entries(id,alignment,payload,retired,updated,actor) VALUES (?,?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET alignment=excluded.alignment,payload=excluded.payload,retired=0,updated=excluded.updated,actor=excluded.actor')
   .run(entry.id,entry.alignment,JSON.stringify(entry),now(),String(actor??''));
  return entry;
 }

 function remove(id,base,actor=''){
  const key=clean(id,48).toLowerCase();
  const shipped=[...(base?.curses??[]),...(base?.blessings??[])].find(e=>e.id===key);
  const override=db.prepare('SELECT * FROM gm_enchant_entries WHERE id=?').get(key);
  if(!shipped&&!override)fail('That enchantment does not exist.','gm_unknown_enchantment');
  if(shipped){
   // A shipped entry cannot be deleted, only retired: the exporter would bring
   // it back on the next content push, and a tombstone survives that.
   const payload=JSON.stringify({...shipped,enabled:false});
   db.prepare('INSERT INTO gm_enchant_entries(id,alignment,payload,retired,updated,actor) VALUES (?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,retired=1,updated=excluded.updated,actor=excluded.actor')
    .run(key,shipped.alignment,payload,now(),String(actor??''));
   return {id:key,retired:true,source:'shipped'};
  }
  db.prepare('DELETE FROM gm_enchant_entries WHERE id=?').run(key);
  return {id:key,retired:false,source:'custom'};
 }

 function restore(id,actor=''){ // Undo a retirement, or bring a disabled custom entry back.
  const key=clean(id,48).toLowerCase();
  const row=db.prepare('SELECT * FROM gm_enchant_entries WHERE id=?').get(key)??fail('That enchantment is not retired.','gm_unknown_enchantment');
  if(!row.retired)fail('That enchantment is already live.','gm_unknown_enchantment');
  db.prepare('DELETE FROM gm_enchant_entries WHERE id=?').run(key); // dropping the tombstone reveals the shipped entry again
  return {id:key,restored:true,actor:String(actor??'')};
 }

 function reset(scope='all'){ // Fall back to exactly what the last content export shipped.
  const what=String(scope??'all');
  if(what!=='tuning')db.prepare('DELETE FROM gm_enchant_entries').run();
  if(what!=='entries')db.prepare('DELETE FROM gm_enchant_tuning').run();
  return {scope:what};
 }

 return {revision,apply,list,tune,save,remove,restore,reset,
  tuningKeys:TUNING_KEYS,slots:SLOT_CATEGORIES,statKeys:STAT_DELTA_KEYS,bounds:TUNING_BOUNDS};
}
