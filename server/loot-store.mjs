// Live, gamemaster-editable overrides for the Adjective + Item + Rarity loot table.
//
// The shipped table arrives inside dive-data.json as `loot`, exported from the
// campaign's datafiles/generation/loot_affixes.json. That file stays the baseline
// and is never written to at runtime. This module layers database overrides on top,
// exactly the way enchantment-store.mjs does for curses and blessings:
//
//   * tuning values a gamemaster has retuned in the /gm panel (rarity rows, luck
//     profiles, level curve, over-cap bonuses, route levels, legendary titles)
//   * shipped affixes a gamemaster has edited or retired
//   * brand new affixes a gamemaster has written
//
// Everything is validated on the way IN, so a malformed affix is refused at the
// panel rather than reaching the roller. The roller re-reads through revision(),
// which changes whenever any override does, so an edit lands on the next chest
// without restarting the service. Already-claimed loot keeps the roll it was given.

import {LOOT_SLOTS,LOOT_STAT_KEYS,RARITY_ORDER} from './loot.mjs';

const CONTROL=/[\x00-\x1f\x7f]/g; // Stripped from every stored string, exactly as the moderation tools do.
const ID=/^[a-z][a-z0-9_]{2,47}$/; // Ids are referenced by save data (item.loot.prefix.id), so keep them boring and stable.
const HEX=/^#[0-9a-f]{6}$/;
const clean=(value,max)=>String(value??'').replace(CONTROL,' ').trim().slice(0,max);
const fail=(message,code='gm_invalid_loot')=>{throw Object.assign(Error(message),{status:400,code});};

const number=(value,{min,max,label,integer=false})=>{
 const n=typeof value==='number'?value:Number(String(value??'').trim());
 if(!Number.isFinite(n))fail(`${label} must be a number.`);
 if(integer&&!Number.isInteger(n))fail(`${label} must be a whole number.`);
 if(n<min||n>max)fail(`${label} must be between ${min} and ${max}.`);
 return n;
};

// Bounds exist so a slip of the keyboard cannot make the game unplayable: a level
// curve of x50, a 900-affix tier or a 400% crit chance are all refused.
const SCALAR_BOUNDS={
 level_growth:[0,0.25],ilvl_jitter_min:[-5,0],ilvl_jitter_max:[0,5],ilvl_cap:[1,100],level_cap:[1,100],stat_cap:[1,100],
 legendary_cha_gate:[0,100],value_level_growth:[0,0.5],enemy_drop_chance:[0,100],boss_drop_chance:[0,100],
 elite_chance:[0,100],elite_hp_mult:[1,5],elite_level_bonus:[0,10],boss_level_bonus:[0,10],
};
const RARITY_BOUNDS={weight:[0,1000],affixes:[0,6],budget_mult:[0.5,5],value_mult:[0,50],bless_mult:[0,10],curse_mult:[0,10]};
const OVERCAP_STATS=['str','def','dex','int','cha'];
const TUNING_KEYS=Object.freeze([...Object.keys(SCALAR_BOUNDS),'rarity','luck_profiles','overcap','zone_levels','route_levels','legendary_titles']);

function validateRarityRows(rows){
 if(!rows||typeof rows!=='object'||Array.isArray(rows))fail('Rarity rows must be an object keyed by tier.');
 const out={};
 for(const tier of RARITY_ORDER){
  const row=rows[tier];
  if(!row||typeof row!=='object')fail(`Rarity row for ${tier} is missing.`);
  const clean_row={};
  for(const [key,[min,max]] of Object.entries(RARITY_BOUNDS))clean_row[key]=number(row[key],{min,max,label:`${tier} ${key}`,integer:key==='affixes'});
  clean_row.suffix=row.suffix===true;
  clean_row.force_blessing=row.force_blessing===true;
  const colour=clean(row.colour,7).toLowerCase();
  if(!HEX.test(colour))fail(`${tier} colour must look like #rrggbb.`);
  clean_row.colour=colour;
  out[tier]=clean_row;
 }
 return out;
}

function validateLuck(profiles){
 if(!profiles||typeof profiles!=='object'||Array.isArray(profiles))fail('Luck profiles must be an object keyed by profile name.');
 const out={};
 for(const [name,row] of Object.entries(profiles)){
  const key=clean(name,24).toLowerCase();
  if(!ID.test(key))fail(`Luck profile name '${name}' must be 3-24 lowercase letters, digits or underscores.`);
  if(!row||typeof row!=='object')fail(`Luck profile ${key} must be an object of tier multipliers.`);
  const clean_row={};
  for(const tier of RARITY_ORDER.slice(1))clean_row[tier]=number(row[tier]??1,{min:0,max:20,label:`${key} ${tier}`});
  out[key]=clean_row;
 }
 if(!Object.keys(out).length)fail('Keep at least one luck profile.');
 return out;
}

function validateOvercap(rows){
 if(!rows||typeof rows!=='object'||Array.isArray(rows))fail('Over-cap bonuses must be an object keyed by stat.');
 const out={};
 for(const stat of OVERCAP_STATS){
  const row=rows[stat];
  if(!row||typeof row!=='object')fail(`Over-cap row for ${stat} is missing.`);
  out[stat]={per_point:number(row.per_point,{min:0,max:5,label:`${stat} per point`}),ceiling:number(row.ceiling,{min:0,max:100,label:`${stat} ceiling`}),effect:clean(row.effect,40)||'bonus_percent'};
 }
 return out;
}

function validateBands(rows,label,fields){
 if(!rows||typeof rows!=='object'||Array.isArray(rows))fail(`${label} must be an object keyed by name.`);
 const out={};
 for(const [name,row] of Object.entries(rows)){
  const key=clean(name,40).toLowerCase();
  if(!/^[a-z][a-z0-9_-]{0,39}$/.test(key))fail(`${label} key '${name}' must be lowercase letters, digits, underscores or dashes.`);
  if(!row||typeof row!=='object')fail(`${label} ${key} must be an object.`);
  const clean_row={};
  for(const [field,[min,max]] of Object.entries(fields))clean_row[field]=number(row[field],{min,max,label:`${key} ${field}`,integer:true});
  if('min' in clean_row&&clean_row.min>clean_row.max)fail(`${key} min cannot be above max.`);
  out[key]=clean_row;
 }
 return out;
}

export function validateTuning(patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))fail('Send the tuning values to change.');
 const out={};
 for(const [key,value] of Object.entries(patch)){
  if(Object.hasOwn(SCALAR_BOUNDS,key)){const [min,max]=SCALAR_BOUNDS[key];out[key]=number(value,{min,max,label:key,integer:['ilvl_jitter_min','ilvl_jitter_max','ilvl_cap','level_cap','stat_cap','elite_level_bonus','boss_level_bonus'].includes(key)});continue;}
  if(key==='rarity'){out.rarity=validateRarityRows(value);continue;}
  if(key==='luck_profiles'){out.luck_profiles=validateLuck(value);continue;}
  if(key==='overcap'){out.overcap=validateOvercap(value);continue;}
  if(key==='zone_levels'){out.zone_levels=validateBands(value,'Zone levels',{min:[1,100],max:[1,100]});continue;}
  if(key==='route_levels'){out.route_levels=validateBands(value,'Route levels',{base:[1,100],per_floor:[0,10]});continue;}
  if(key==='legendary_titles'){
   if(!Array.isArray(value))fail('Legendary titles must be a list.');
   const titles=[...new Set(value.map(t=>clean(t,40)).filter(Boolean))].slice(0,200);
   if(!titles.length)fail('Keep at least one legendary title.');
   out.legendary_titles=titles;continue;
  }
  fail(`Unknown tuning value: ${key}`);
 }
 if(!Object.keys(out).length)fail('Send at least one tuning value.');
 return out;
} // The rarity order itself stays authored content: reordering tiers would scramble every saved item.

export function validateAffix(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Send an affix to save.');
 const id=clean(input.id,48).toLowerCase();
 if(!ID.test(id))fail('Id must be 3-48 characters: a lowercase letter, then letters, digits or underscores.');
 const adjective=clean(input.adjective,40),suffix=clean(input.suffix_title,48),bonusOnly=input.bonus_only===true;
 if(!adjective&&!suffix&&!bonusOnly)fail('Give the affix an adjective, an "of the ..." title, or mark it bonus-only.');

 const slots=Array.isArray(input.slots)?[...new Set(input.slots.map(s=>clean(s,32)))]:[];
 if(!slots.length)fail('Pick at least one slot, or nothing can ever roll this.');
 for(const slot of slots){
  if(slot==='dress')fail("Use torso and pants instead of dress: a dress rolls both.");
  if(slot!=='*'&&!LOOT_SLOTS.includes(slot))fail(`'${slot}' is not an equipment slot.`);
 }

 const minRarity=clean(input.min_rarity,16).toLowerCase()||'uncommon';
 if(!RARITY_ORDER.includes(minRarity))fail(`'${minRarity}' is not a rarity tier.`);

 const tags=Array.isArray(input.tags)?[...new Set(input.tags.map(t=>clean(t,24).toLowerCase()).filter(Boolean))].slice(0,8):[];

 const lines=Array.isArray(input.stats)?input.stats:[];
 if(!lines.length||lines.length>4)fail('An affix carries one to four stat lines.');
 const stats=[];
 for(const line of lines){
  const key=clean(line?.key,32);
  if(key==='is_diaper')fail('is_diaper can never be an affix: diaper is identity, not a stat.');
  if(!LOOT_STAT_KEYS.includes(key))fail(`'${key}' is not a stat an affix may change.`);
  const min=number(line.min,{min:-20,max:20,label:`${key} min`,integer:true});
  const max=number(line.max,{min:-20,max:20,label:`${key} max`,integer:true});
  if(min>max)fail(`${key} min cannot be above max.`);
  stats.push({key,min,max,per_level_min:number(line.per_level_min??0,{min:0,max:1,label:`${key} per level min`}),per_level_max:number(line.per_level_max??0,{min:0,max:1,label:`${key} per level max`})});
 }
 if(stats.every(s=>s.min===0&&s.max===0&&s.per_level_max===0))fail('An affix whose every line rolls zero would do nothing.');

 return {
  id,adjective:adjective||null,suffix_title:suffix||null,bonus_only:bonusOnly,
  slots,weight:number(input.weight??10,{min:0.1,max:1000,label:'Weight'}),
  min_rarity:minRarity,tags,stats,
  flavour:clean(input.flavour,240),
  enabled:input.enabled!==false,
 };
}

export function createLootStore(db,{now=Date.now}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS gm_loot_tuning(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS gm_loot_affixes(id TEXT PRIMARY KEY,payload TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');`);

 // A cheap fingerprint of every override, so the roller can cache itself and rebuild
 // only when a gamemaster has actually changed something.
 const revision=()=>{
  const t=db.prepare('SELECT COUNT(*) AS n,COALESCE(MAX(updated),0) AS at FROM gm_loot_tuning').get();
  const a=db.prepare('SELECT COUNT(*) AS n,COALESCE(MAX(updated),0) AS at FROM gm_loot_affixes').get();
  return `${t.n}:${t.at}:${a.n}:${a.at}`;
 };

 const tuningRows=()=>Object.fromEntries(db.prepare('SELECT key,value FROM gm_loot_tuning').all().map(r=>[r.key,JSON.parse(r.value)]));
 const affixRows=()=>db.prepare('SELECT * FROM gm_loot_affixes').all();

 function apply(base){ // Merge the shipped table with every live override.
  const overrides=tuningRows();
  const titles=overrides.legendary_titles??base?.legendary_titles??[];
  delete overrides.legendary_titles;
  const table={tuning:{...(base?.tuning??{}),...overrides},affixes:[...(base?.affixes??[])],legendary_titles:[...titles]};
  for(const row of affixRows()){
   const i=table.affixes.findIndex(a=>a.id===row.id);
   if(i>=0)table.affixes.splice(i,1); // drop the shipped copy first
   if(row.retired)continue;           // retired shipped affixes simply do not come back
   table.affixes.push(JSON.parse(row.payload));
  }
  return table;
 }

 function list(base){ // What the panel shows: shipped, edited, custom and retired, in one roster.
  const shipped=new Map((base?.affixes??[]).map(a=>[a.id,a]));
  const out=[],seen=new Set();
  for(const row of affixRows()){
   seen.add(row.id);
   out.push({...JSON.parse(row.payload),source:shipped.has(row.id)?'edited':'custom',retired:Boolean(row.retired),updated:row.updated,actor:row.actor});
  }
  for(const [id,affix] of shipped)if(!seen.has(id))out.push({...affix,source:'shipped',retired:false,updated:0,actor:''});
  out.sort((a,b)=>a.id.localeCompare(b.id));
  return out;
 }

 function tune(patch,actor=''){
  const values=validateTuning(patch),at=now();
  const write=db.prepare('INSERT INTO gm_loot_tuning(key,value,updated,actor) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated,actor=excluded.actor');
  for(const [key,value] of Object.entries(values))write.run(key,JSON.stringify(value),at,String(actor??''));
  return values;
 }

 function save(input,actor=''){
  const affix=validateAffix(input);
  db.prepare('INSERT INTO gm_loot_affixes(id,payload,retired,updated,actor) VALUES (?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,retired=0,updated=excluded.updated,actor=excluded.actor')
   .run(affix.id,JSON.stringify(affix),now(),String(actor??''));
  return affix;
 }

 function remove(id,base,actor=''){
  const key=clean(id,48).toLowerCase();
  const shipped=(base?.affixes??[]).find(a=>a.id===key);
  const override=db.prepare('SELECT * FROM gm_loot_affixes WHERE id=?').get(key);
  if(!shipped&&!override)fail('That affix does not exist.','gm_unknown_loot');
  if(shipped){
   // A shipped affix cannot be deleted, only retired: the exporter would bring it
   // back on the next content push, and a tombstone survives that.
   db.prepare('INSERT INTO gm_loot_affixes(id,payload,retired,updated,actor) VALUES (?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,retired=1,updated=excluded.updated,actor=excluded.actor')
    .run(key,JSON.stringify({...shipped,enabled:false}),now(),String(actor??''));
   return {id:key,retired:true,source:'shipped'};
  }
  db.prepare('DELETE FROM gm_loot_affixes WHERE id=?').run(key);
  return {id:key,retired:false,source:'custom'};
 }

 function restore(id,actor=''){ // Undo a retirement.
  const key=clean(id,48).toLowerCase();
  const row=db.prepare('SELECT * FROM gm_loot_affixes WHERE id=?').get(key)??fail('That affix is not retired.','gm_unknown_loot');
  if(!row.retired)fail('That affix is already live.','gm_unknown_loot');
  db.prepare('DELETE FROM gm_loot_affixes WHERE id=?').run(key); // dropping the tombstone reveals the shipped affix again
  return {id:key,restored:true,actor:String(actor??'')};
 }

 function reset(scope='all'){ // Fall back to exactly what the last content export shipped.
  const what=String(scope??'all');
  if(what!=='tuning')db.prepare('DELETE FROM gm_loot_affixes').run();
  if(what!=='affixes')db.prepare('DELETE FROM gm_loot_tuning').run();
  return {scope:what};
 }

 return {revision,apply,list,tune,save,remove,restore,reset,
  tuningKeys:TUNING_KEYS,scalarBounds:SCALAR_BOUNDS,rarityBounds:RARITY_BOUNDS,slots:LOOT_SLOTS,statKeys:LOOT_STAT_KEYS,rarityOrder:RARITY_ORDER,overcapStats:OVERCAP_STATS};
}
