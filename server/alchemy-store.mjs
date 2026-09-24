// Live, gamemaster-editable overrides for the alchemy tables (the /gm Alchemy tab, 2026-09-24).
//
// The shipped tables arrive inside dive-data.json (`alchemy`: brewing, chest_loot, colors, traits and the
// ingredient rows), exported from the campaign's datafiles/generation/alchemy.json. That stays the
// baseline and is never written at runtime. A gamemaster overrides whole top-level keys of a section,
// e.g. brewing.mishap or chest_loot.zones; the rest keeps the shipped value.
//
// Every save is validated against the WHOLE merged table, so a bad number, an unknown ingredient or a
// recipe naming a missing adjective is refused at the panel and never reaches a chest or a client.
//
// Where the live table goes:
//   * chest_loot  -> server/dive-loot.mjs rollIngredient (online dive chests), from the next claim.
//   * brewing     -> every zone snapshot carries {revision, brewing: <overridden keys only>}; the client
//                    (scrAlchemy alchemy_brewing) merges those over its own alchemy.json. Brewing runs
//                    on the client, so this is how a /gm edit reaches it.

const CONTROL=/[\x00-\x1f\x7f]/g;
const ID=/^[a-z][a-z0-9_]{1,31}$/;
const RARITIES=['common','uncommon','rare','epic','legendary'];
const fail=message=>{throw Object.assign(Error(message),{status:400,code:'gm_invalid_alchemy'});};
const clean=(value,max)=>String(value??'').replace(CONTROL,' ').trim().slice(0,max);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const num=(v,min,max,label,integer=false)=>{
 const n=typeof v==='number'?v:Number(String(v??'').trim());
 if(!Number.isFinite(n))fail(`${label} must be a number.`);
 if(integer&&!Number.isInteger(n))fail(`${label} must be a whole number.`);
 if(n<min||n>max)fail(`${label} must be between ${min} and ${max}.`);
 return n;
};
const numbers=(v,bounds,label)=>{ // A fixed-shape struct of numbers, e.g. brewing.mishap.
 if(!object(v))fail(`${label} must be an object.`);
 const out={};
 for(const [key,[min,max,integer]] of Object.entries(bounds))out[key]=num(v[key],min,max,`${label}.${key}`,integer);
 for(const key of Object.keys(v))if(!(key in bounds))fail(`${label}.${key} is not a setting.`);
 return out;
};
const pair=(v,min,max,label)=>{if(!Array.isArray(v)||v.length!==2)fail(`${label} must be [low, high].`);const a=num(v[0],min,max,label+' low',true),b=num(v[1],min,max,label+' high',true);if(b<a)fail(`${label} high must not be below low.`);return [a,b];};

// Drink fields a colour, special, adjective or mishap may set (the drink path and alchemy_apply_brew_fields apply them).
const EFFECT_BOUNDS={hp_restore:[-1,1000],mp_restore:[-1,1000],stamina_restore:[-1,1000],thirst_restore:[0,250],shame_delta:[-1000,1000],inco_gain:[-1000,1000],
 wet_relief:[0,100],tum_relief:[0,100],stamina_drain:[0,1000],continence_set:[0,1000],continence_turns:[0,2000],continence_delta:[-1000,1000],
 wet_instant:[0,100],tum_instant:[0,100],pressure_turns:[0,50],wet_per_turn:[0,50],tum_per_turn:[0,50],wet_target_gain:[0,200],tum_target_gain:[0,200]};
const effects=(v,label)=>{
 if(!object(v))fail(`${label} must be an object.`);
 const out={};
 for(const [key,value] of Object.entries(v)){
  if(key==='grossout_reset'){if(typeof value!=='boolean')fail(`${label}.grossout_reset must be true or false.`);out[key]=value;continue;}
  const b=EFFECT_BOUNDS[key]??fail(`${label}.${key} is not an effect the game understands.`);
  out[key]=num(value,b[0],b[1],`${label}.${key}`);
 }
 return out;
};
const ids=(v,known,label,max=80)=>{
 if(!Array.isArray(v)||v.length>max)fail(`${label} must be a list of at most ${max} ids.`);
 const out=[...new Set(v.map(x=>clean(x,40)))];
 for(const id of out)if(!known.has(id))fail(`${label}: ${id} is not a known ingredient.`);
 return out;
};

const BREWING_KEYS=['min_ingredients','max_ingredients','skill','difficulty','quality','rarity_thresholds','rarity_value_mult','potency','adjective_slots','bad_chance','lean_weight','stinky_extra_bad','muddy_share','liquid_pigment_mult','mishap','special','base_value','adjectives','colours','specials','secret_recipes','mishaps'];
const CHEST_KEYS=['chance','qty_min','qty_max','single_from_tier','tier_weights','everywhere','zones','online_zones'];
export const SECTION_KEYS=Object.freeze({brewing:BREWING_KEYS,chest_loot:CHEST_KEYS});

export function validateBrewing(b,{colours,traits,ingredients}){ // colours: Set of colour ids; traits: ingredient lean ids; ingredients: Set of ids.
 const out={};
 out.min_ingredients=num(b.min_ingredients,2,3,'min_ingredients',true);
 out.max_ingredients=num(b.max_ingredients,out.min_ingredients,3,'max_ingredients',true); // the panel has three pot slots
 out.skill=numbers(b.skill,{max_level:[1,100,true],xp_base:[1,100000],xp_per_level:[0,100000],xp_per_difficulty:[0,100],first_brew_mult:[0,10],grey_margin:[0,100],grey_mult:[0,1],mishap_mult:[0,1],hint_colour_from_level:[1,101,true],identify_mystery_from_level:[1,101,true]},'skill');
 out.difficulty=numbers(b.difficulty,{per_tier:[0,50],catalyst_bonus:[0,100],min:[1,100],max:[1,100]},'difficulty');
 if(out.difficulty.max<out.difficulty.min)fail('difficulty.max must not be below difficulty.min.');
 out.quality=numbers(b.quality,{skill_weight:[0,2],tier_weight:[0,50],jitter:[0,50],kit_penalty:[0,100]},'quality');
 if(!Array.isArray(b.rarity_thresholds)||b.rarity_thresholds.length!==5)fail('rarity_thresholds needs the five tiers.');
 out.rarity_thresholds=b.rarity_thresholds.map((t,i)=>{if(t?.name!==RARITIES[i])fail('rarity_thresholds must list common, uncommon, rare, epic, legendary in order.');return {name:t.name,min:num(t.min,0,100,`rarity_thresholds.${t.name}`)};});
 if(out.rarity_thresholds[0].min!==0)fail('Common must start at quality 0.');
 for(let i=1;i<5;i++)if(out.rarity_thresholds[i].min<=out.rarity_thresholds[i-1].min)fail('Each rarity must need more quality than the one before.');
 out.rarity_value_mult=numbers(b.rarity_value_mult,Object.fromEntries(RARITIES.map(r=>[r,[0,1000]])),'rarity_value_mult');
 out.potency=numbers(b.potency,{min:[0.1,5],max:[0.1,5]},'potency');
 if(out.potency.max<out.potency.min)fail('potency.max must not be below potency.min.');
 if(!object(b.adjective_slots))fail('adjective_slots must be an object.');
 out.adjective_slots=Object.fromEntries(RARITIES.map(r=>[r,pair(b.adjective_slots[r],0,5,`adjective_slots.${r}`)]));
 out.bad_chance=numbers(b.bad_chance,{at_skill_1:[0,1],at_skill_100:[0,1],lean_per_point:[0,0.5],kit_penalty:[0,1],min:[0,1],max:[0,1]},'bad_chance');
 if(out.bad_chance.max<out.bad_chance.min)fail('bad_chance.max must not be below bad_chance.min.');
 out.lean_weight=num(b.lean_weight,0,100,'lean_weight');
 out.stinky_extra_bad=pair(b.stinky_extra_bad,0,5,'stinky_extra_bad');
 out.muddy_share=num(b.muddy_share,0,1,'muddy_share');
 out.liquid_pigment_mult=num(b.liquid_pigment_mult,0,2,'liquid_pigment_mult');
 out.mishap=numbers(b.mishap,{base:[0,1],per_point:[0,0.1],min:[0,1],max:[0,1],kit_penalty:[0,1]},'mishap');
 if(out.mishap.max<out.mishap.min)fail('mishap.max must not be below mishap.min.');
 if(!object(b.special)||!RARITIES.includes(b.special.min_rarity))fail('special.min_rarity must be a rarity.');
 out.special={min_rarity:b.special.min_rarity,catalyst_chance:num(b.special.catalyst_chance,0,1,'special.catalyst_chance'),legendary_catalyst_chance:num(b.special.legendary_catalyst_chance,0,1,'special.legendary_catalyst_chance')};
 out.base_value=num(b.base_value,0,100000,'base_value');
 // ── adjectives ──
 if(!object(b.adjectives)||!Object.keys(b.adjectives).length)fail('adjectives must name at least one adjective.');
 out.adjectives={};
 for(const [id,a] of Object.entries(b.adjectives)){
  if(!ID.test(id))fail(`Adjective id ${id} must be lower_snake_case.`);
  if(!object(a))fail(`adjectives.${id} must be an object.`);
  const x={name:clean(a.name,24)||fail(`adjectives.${id} needs a name.`),bad:a.bad===true,weight:num(a.weight,0,1000,`adjectives.${id}.weight`),desc:clean(a.desc,200)};
  if(a.potency_mult!==undefined)x.potency_mult=num(a.potency_mult,0.1,5,`adjectives.${id}.potency_mult`);
  if(a.duration_mult!==undefined)x.duration_mult=num(a.duration_mult,0.1,5,`adjectives.${id}.duration_mult`);
  if(a.pressure_mult!==undefined)x.pressure_mult=num(a.pressure_mult,0,2,`adjectives.${id}.pressure_mult`);
  if(a.cancels_bad!==undefined)x.cancels_bad=num(a.cancels_bad,0,5,`adjectives.${id}.cancels_bad`,true);
  if(a.swap_colour!==undefined)x.swap_colour=a.swap_colour===true;
  if(a.add!==undefined)x.add=effects(a.add,`adjectives.${id}.add`);
  if(a.pressure!==undefined)x.pressure=numbers(a.pressure,Object.fromEntries(Object.keys(a.pressure).map(k=>[k,{pressure_turns:[0,50],wet_per_turn:[0,50],tum_per_turn:[0,50],wet_target_gain:[0,200],tum_target_gain:[0,200]}[k]??fail(`adjectives.${id}.pressure.${k} is not a pressure field.`)])),`adjectives.${id}.pressure`);
  if(a.burst!==undefined)x.burst=numbers(a.burst,{turns_until_start:[0,50,true],duration_remaining:[1,20,true]},`adjectives.${id}.burst`);
  for(const key of Object.keys(a))if(!['name','bad','weight','desc','potency_mult','duration_mult','pressure_mult','cancels_bad','swap_colour','add','pressure','burst'].includes(key))fail(`adjectives.${id}.${key} is not an adjective setting.`);
  out.adjectives[id]=x;
 }
 for(const trait of traits)if(!out.adjectives[trait])fail(`Ingredients lean toward "${trait}", so it must stay an adjective.`);
 // ── colours ──
 if(!object(b.colours))fail('colours must be an object.');
 out.colours={};
 for(const colour of colours){
  const c=b.colours[colour];if(!object(c))fail(`colours.${colour} is missing.`);
  out.colours[colour]={effects:effects(c.effects,`colours.${colour}.effects`),desc:clean(c.desc,200)};
 }
 for(const colour of Object.keys(b.colours))if(!colours.has(colour))fail(`${colour} is not a potion colour.`);
 // ── specials ──
 if(!object(b.specials))fail('specials must be an object.');
 out.specials={};
 for(const [id,s] of Object.entries(b.specials)){
  if(!ID.test(id))fail(`Special id ${id} must be lower_snake_case.`);
  if(!object(s))fail(`specials.${id} must be an object.`);
  const fx=effects(s.effects,`specials.${id}.effects`),scale=Array.isArray(s.scale)?s.scale.map(k=>clean(k,40)):[];
  for(const k of scale)if(!(k in fx))fail(`specials.${id}.scale names ${k}, which it does not set.`);
  out.specials[id]={title:clean(s.title,40)||fail(`specials.${id} needs a title.`),weight:num(s.weight,0,1000,`specials.${id}.weight`),effects:fx,scale,desc:clean(s.desc,200)};
 }
 // ── secret recipes ──
 if(!Array.isArray(b.secret_recipes)||b.secret_recipes.length>50)fail('secret_recipes must be a list of at most 50.');
 const seen=new Set();
 out.secret_recipes=b.secret_recipes.map((r,i)=>{
  const label=`secret_recipes[${i}]`;if(!object(r))fail(`${label} must be an object.`);
  if(!Array.isArray(r.ingredients)||r.ingredients.length<out.min_ingredients||r.ingredients.length>out.max_ingredients)fail(`${label} needs ${out.min_ingredients}-${out.max_ingredients} ingredients.`);
  const list=r.ingredients.map(x=>clean(x,40));for(const id of list)if(!ingredients.has(id))fail(`${label}: ${id} is not a known ingredient.`);
  const key=[...list].sort().join('+');if(seen.has(key))fail(`${label} repeats another recipe's ingredients.`);seen.add(key);
  const x={ingredients:list,min_rarity:RARITIES.includes(r.min_rarity)?r.min_rarity:fail(`${label}.min_rarity must be a rarity.`)};
  if(r.colour!==undefined){if(!colours.has(r.colour))fail(`${label}.colour ${r.colour} is not a colour.`);x.colour=r.colour;}
  if(r.special!==undefined){if(!out.specials[r.special])fail(`${label}.special ${r.special} is not a special.`);x.special=r.special;}
  if(r.force_adjectives!==undefined){if(!Array.isArray(r.force_adjectives))fail(`${label}.force_adjectives must be a list.`);for(const a of r.force_adjectives)if(!out.adjectives[a])fail(`${label} forces ${a}, which is not an adjective.`);x.force_adjectives=[...r.force_adjectives];}
  return x;
 });
 // ── mishaps ──
 if(!Array.isArray(b.mishaps)||!b.mishaps.length||b.mishaps.length>20)fail('mishaps must list 1-20 splashes.');
 out.mishaps=b.mishaps.map((m,i)=>{
  if(!object(m))fail(`mishaps[${i}] must be an object.`);
  const x={text:clean(m.text,300)||fail(`mishaps[${i}] needs text.`)};
  for(const [key,[min,max]] of Object.entries({shame_delta:[-100,100],wet_instant:[0,100],tum_instant:[0,100]}))if(m[key]!==undefined)x[key]=num(m[key],min,max,`mishaps[${i}].${key}`);
  for(const key of Object.keys(m))if(!['text','shame_delta','wet_instant','tum_instant'].includes(key))fail(`mishaps[${i}].${key} is not a mishap setting.`);
  return x;
 });
 return out;
}

export function validateChestLoot(c,{ingredients}){
 const out={};
 out.chance=num(c.chance,0,100,'chance');
 out.qty_min=num(c.qty_min,1,20,'qty_min',true);
 out.qty_max=num(c.qty_max,out.qty_min,50,'qty_max',true);
 out.single_from_tier=num(c.single_from_tier,1,6,'single_from_tier',true);
 out.tier_weights=numbers(c.tier_weights,{1:[0,1000],2:[0,1000],3:[0,1000],4:[0,1000],5:[0,1000]},'tier_weights');
 out.everywhere=ids(c.everywhere,ingredients,'everywhere');
 if(!object(c.zones)||Object.keys(c.zones).length>40)fail('zones must map at most 40 zone keys to ingredient lists.');
 out.zones={};
 for(const [zone,list] of Object.entries(c.zones)){if(!ID.test(zone))fail(`Zone key ${zone} must be lower_snake_case.`);out.zones[zone]=ids(list,ingredients,`zones.${zone}`);}
 if(!object(c.online_zones))fail('online_zones must map dive routes to zone keys.');
 out.online_zones={};
 for(const [route,zone] of Object.entries(c.online_zones)){if(!/^[a-z][a-z0-9-]{1,47}$/.test(route))fail(`Route ${route} is not a zone id.`);if(!out.zones[zone])fail(`online_zones.${route} points at ${zone}, which has no ingredient list.`);out.online_zones[route]=zone;}
 return out;
}

export function createAlchemyStore(db,{now=Date.now}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS gm_alchemy_overrides(section TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '',PRIMARY KEY(section,key));`);
 const revision=()=>{const r=db.prepare('SELECT COUNT(*) AS n,COALESCE(MAX(updated),0) AS at FROM gm_alchemy_overrides').get();return `${r.n}:${r.at}`;}; // Changes whenever any override does.
 const overrides=()=>{
  const out={brewing:{},chest_loot:{}};
  for(const row of db.prepare('SELECT section,key,payload FROM gm_alchemy_overrides').all())if(out[row.section])out[row.section][row.key]=JSON.parse(row.payload);
  return out;
 };
 const context=base=>({ // What a merged table is checked against: the shipped colours, ingredient ids and lean traits.
  colours:new Set((base?.colors??[]).map(c=>c.id)),
  ingredients:new Set(Object.keys(base?.ingredients??{})),
  traits:new Set(Object.values(base?.ingredients??{}).flatMap(i=>Object.keys(i.alchemy?.traits??{}))),
 });
 function apply(base){ // The live table: shipped sections with every override on top.
  if(!base)return base;
  const o=overrides();
  return {...base,brewing:{...(base.brewing??{}),...o.brewing},chest_loot:{...(base.chest_loot??{}),...o.chest_loot}};
 }
 function save(section,patch,base,actor=''){
  if(!SECTION_KEYS[section])fail('Choose brewing or chest_loot.');
  if(!object(patch)||!Object.keys(patch).length)fail('Nothing to save.');
  for(const key of Object.keys(patch))if(!SECTION_KEYS[section].includes(key))fail(`${section}.${key} is not an alchemy setting.`);
  const live=apply(base),next={...live[section],...patch},ctx=context(base);
  const checked=section==='brewing'?validateBrewing(next,ctx):validateChestLoot(next,ctx); // the whole section must stay valid
  const write=db.prepare('INSERT INTO gm_alchemy_overrides(section,key,payload,updated,actor) VALUES (?,?,?,?,?) ON CONFLICT(section,key) DO UPDATE SET payload=excluded.payload,updated=excluded.updated,actor=excluded.actor');
  const at=now();for(const key of Object.keys(patch))write.run(section,key,JSON.stringify(checked[key]),at,clean(actor,64));
  return Object.fromEntries(Object.keys(patch).map(k=>[k,checked[k]]));
 }
 function reset(scope='all',key=null){ // Back to exactly what the last content export shipped: everything, one section, or one key.
  if(scope==='all'){db.prepare('DELETE FROM gm_alchemy_overrides').run();return {scope};}
  if(!SECTION_KEYS[scope])fail('Reset brewing, chest_loot or all.');
  if(key){if(!SECTION_KEYS[scope].includes(key))fail(`${scope}.${key} is not an alchemy setting.`);db.prepare('DELETE FROM gm_alchemy_overrides WHERE section=? AND key=?').run(scope,key);return {scope,key};}
  db.prepare('DELETE FROM gm_alchemy_overrides WHERE section=?').run(scope);return {scope};
 }
 function clientView(){ // Rides in every zone snapshot: tiny unless a gamemaster changed brewing.
  return {revision:revision(),brewing:overrides().brewing};
 }
 function overriddenKeys(){const o=overrides();return {brewing:Object.keys(o.brewing),chest_loot:Object.keys(o.chest_loot)};}
 return {revision,apply,save,reset,clientView,overriddenKeys,sectionKeys:SECTION_KEYS};
}
