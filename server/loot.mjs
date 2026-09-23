import {seeded} from './dive-generation.mjs';

// Adjective + Item + Rarity loot. The campaign runs the identical maths in
// scripts/scrLootRoll/scrLootRoll.gml; this file is the authoritative copy for
// shared Dive loot, seeded from the chest key so a re-roll of the same chest
// always produces the same gear. Change one, change both, then re-run
// python/export_online_dive.py to ship the table (datafiles/generation/loot_affixes.json
// arrives inside dive-data.json as `loot`).
//
// Every wearable or weapon copy rolls a rarity tier, an item level, level-scaled
// base stats and a handful of affixes (a prefix adjective, an "of the ..." suffix
// from Rare up, bonus lines). A dress fills torso AND pants, so it runs two affix
// passes. The result lives on the item struct as `loot`, next to the name it was
// given, so the client tooltip, saves and inspection all read the same provenance.

// The one source of truth for what a gamemaster may type into the /gm panel and what
// the campaign's editor offers. Keep in step with loot_affix_stat_keys() in scrLootRoll.gml
// and LOOT_SLOT_CHOICES in python/editor/tabs/loot_tabs.py.
export const LOOT_SLOTS=Object.freeze(['weapon','head','mouth','torso','pants','panties','diaper_cover','socks','shoes','gloves','bra','accessory','plug','special']);
export const LOOT_STAT_KEYS=Object.freeze(['atk','def','atk_mod','def_mod','dex_mod','int_mod','cha_mod','hp_max_mod','hp_regen','wet_resist','tum_resist','bulk','bulk_threshold','childish','shame_delta','conceals_panties']);
export const RARITY_ORDER=Object.freeze(['common','uncommon','rare','epic','legendary']);
export const WEARABLE_CATEGORIES=Object.freeze(['weapon','head','mouth','torso','dress','bra','corset','pants','skirt','panties','diaper_cover','socks','shoes','gloves','accessory','plug','special']);
export const SCALED_STATS=Object.freeze(['atk','atk_min','atk_max','def','hp_regen']); // Theme stats (wet_resist, bulk, childish...) only move through affixes.

export const DEFAULT_TUNING=Object.freeze({
 level_growth:0.08,ilvl_jitter_min:-1,ilvl_jitter_max:2,ilvl_cap:100,level_cap:100,stat_cap:100,legendary_cha_gate:10,value_level_growth:0.05,
 rarity:{
  common:{weight:60,affixes:0,suffix:false,budget_mult:1,value_mult:1,colour:'#ffffff',bless_mult:1,curse_mult:1,force_blessing:false},
  uncommon:{weight:25,affixes:1,suffix:false,budget_mult:1.15,value_mult:1.6,colour:'#4fd06b',bless_mult:1,curse_mult:1,force_blessing:false},
  rare:{weight:10,affixes:2,suffix:true,budget_mult:1.35,value_mult:2.8,colour:'#4f9cff',bless_mult:1,curse_mult:1,force_blessing:false},
  epic:{weight:4,affixes:3,suffix:true,budget_mult:1.6,value_mult:5,colour:'#b45fff',bless_mult:2,curse_mult:1,force_blessing:false},
  legendary:{weight:1,affixes:4,suffix:true,budget_mult:2,value_mult:12,colour:'#ff9f1c',bless_mult:1,curse_mult:0,force_blessing:true},
 },
 rarity_order:RARITY_ORDER,
 luck_profiles:{chest:{uncommon:1.2,rare:1.5,epic:1,legendary:0.25}},
 route_levels:{default:{base:5,per_floor:2}},
 // Level scaling (scaling.mjs). hp_base + hp_per_level per level below hp_late_from, hp_per_level_late after, plus DEF x hp_def_share.
 hp_base:100,hp_per_level:5,hp_per_level_late:3,hp_late_from:41,hp_def_share:0.6,
 def_mitigation_k:100, // damage x k/(k+DEF): DEF 100 halves a hit instead of zeroing it.
 enemy_hp_reference:30,enemy_ttk_mob:2,enemy_ttk_elite:4,enemy_ttk_boss:8, // Enemy HP = turns-to-kill x an average build's hit, weighted by authored HP / reference.
 avg_str_base:10,avg_str_per_level:1.2, // The average build the turns-to-kill maths assumes.
 heal_reference_hp:100, // Flat heals were written for a 100 HP bar and scale up with it.
 party_level_slack:3, // Shared fights are levelled to the strongest member minus this.
 // Battle rows and reach weapons (scaling.mjs rows section, scrBattleInit/scrLootRoll on the client).
 row_swap_costs_turn:0,row_back_damage_taken:0.5,row_back_melee_dealt:0.5,row_front_target_weight:3,reach_damage_mult:0.75,
 stack_max:512, // Consumables and ammo stack this high in one bag entry; stacks never count toward the slot cap.
});

const num=(value,fallback=0)=>Number.isFinite(Number(value))&&value!==null&&value!==''&&typeof value!=='boolean'?Number(value):fallback;

export function tierIndex(order,tier){const i=order.indexOf(tier);return i<0?0:i;}

export function rarityConfig(tuning,tier){ // Every field defaulted so callers can read bare, exactly like loot_rarity_cfg() in GML.
 const row=tuning.rarity?.[tier]??{};
 return {
  weight:Math.max(0,num(row.weight,0)),affixes:Math.max(0,Math.floor(num(row.affixes,0))),suffix:row.suffix===true,
  budget_mult:Math.max(0.1,num(row.budget_mult,1)),value_mult:Math.max(0,num(row.value_mult,1)),colour:String(row.colour??'#ffffff'),
  bless_mult:Math.max(0,num(row.bless_mult,1)),curse_mult:Math.max(0,num(row.curse_mult,1)),force_blessing:row.force_blessing===true,
 };
}

export function levelMultiplier(tuning,ilvl){return 1+Math.max(0,num(tuning.level_growth,0.08))*(Math.max(1,ilvl)-1);} // Shared with enemy scaling so both curves match.

export const itemSlots=item=>item.category==='dress'?['torso','pants']:item.category==='corset'?['torso']:item.category==='skirt'?['pants']:[item.category]; // A dress counts as two slots.

export const eligible=item=>!!item&&typeof item==='object'&&!item.quest_item&&!item.loot_locked&&!(item.loot&&item.loot.rolled===true)
 &&typeof item.category==='string'&&WEARABLE_CATEGORIES.includes(item.category);

export function valueFor(tuning,base,tier,ilvl){return Math.round(Math.max(0,num(base,0))*rarityConfig(tuning,tier).value_mult*(1+Math.max(0,num(tuning.value_level_growth,0.05))*(Math.max(1,ilvl)-1)));}

export function buildName(item){ // "Adjective Base of the Suffix", with a quoted Legendary title in front; common keeps its plain name.
 const loot=item.loot,base=String(item.base_name??item.name??'?');
 if(!loot)return base;
 let name=base;
 if(loot.prefix?.adjective)name=loot.prefix.adjective+' '+name;
 if(loot.suffix?.title)name=name+' '+loot.suffix.title;
 if(loot.title)name='"'+loot.title+'" '+name;
 return name;
}

function affixLegal(affix,slot,tier,order,used,want){
 if(!affix||affix.enabled===false)return false;
 const slots=Array.isArray(affix.slots)?affix.slots:[];
 if(!slots.includes('*')&&!slots.includes(slot))return false;
 if(tierIndex(order,affix.min_rarity??'common')>tierIndex(order,tier))return false;
 for(const tag of (Array.isArray(affix.tags)?affix.tags:[]))if(used.has(tag))return false; // no two affixes share a tag
 if(want==='prefix')return typeof affix.adjective==='string'&&affix.adjective!=='';
 if(want==='suffix')return typeof affix.suffix_title==='string'&&affix.suffix_title!=='';
 return true;
}

function weightedPick(entries,weightOf,rnd){ // Same basis as the GML: a 1e-6 grain along the summed weights.
 if(!entries.length)return null;
 const total=entries.reduce((sum,entry)=>sum+Math.max(0,weightOf(entry)),0);
 if(total<=0)return entries[rnd(entries.length)];
 let roll=rnd(1000000)/1000000*total;
 for(const entry of entries){roll-=Math.max(0,weightOf(entry));if(roll<0)return entry;}
 return entries[entries.length-1];
}

const range=(rnd,lo,hi)=>{if(hi<lo)[lo,hi]=[hi,lo];return lo+rnd(hi-lo+1);};

export function createLootRoller(table,bases=null){ // Built from the shipped table plus live overrides; a missing table returns a no-op roller. `bases` adds the style + garment generator.
 const generator=createBaseGenerator(bases);
 const has=!!table&&typeof table==='object';
 const tuning={...DEFAULT_TUNING,...(has?table.tuning??{}:{})};
 const order=Array.isArray(tuning.rarity_order)&&tuning.rarity_order.length?tuning.rarity_order:RARITY_ORDER;
 const affixes=has&&Array.isArray(table.affixes)?table.affixes:[];
 const titles=has&&Array.isArray(table.legendary_titles)?table.legendary_titles.filter(t=>typeof t==='string'&&t):[];
 const ids=new Set();
 for(const affix of affixes){if(!affix?.id||ids.has(affix.id))throw Error('Loot affix ids must be present and unique: '+affix?.id);ids.add(affix.id);}

 function pickRarity(luckName,rnd){
  const luck=tuning.luck_profiles?.[luckName]??{};
  const weights=order.map(tier=>Math.max(0,rarityConfig(tuning,tier).weight*num(luck[tier],1)));
  const total=weights.reduce((a,b)=>a+b,0);
  if(total<=0)return order[0];
  let roll=rnd(1000000)/1000000*total;
  for(let i=0;i<order.length;i++){roll-=weights[i];if(roll<0)return order[i];}
  return order[order.length-1];
 }

 function scaleBase(item,ilvl,tier){
  const mult=levelMultiplier(tuning,ilvl)*rarityConfig(tuning,tier).budget_mult;
  for(const key of SCALED_STATS)if(Number.isFinite(item[key])&&item[key]!==0)item[key]=Math.round(item[key]*mult); // zero stays zero: a sock never gains ATK
  if(Number.isFinite(item.atk_min)&&Number.isFinite(item.atk_max)&&item.atk_max<item.atk_min)item.atk_max=item.atk_min;
 }

 function applyAffix(item,affix,ilvl,rnd){
  const record={id:String(affix.id),stats:{}};
  for(const line of (Array.isArray(affix.stats)?affix.stats:[])){
   const key=String(line?.key??'');
   if(!LOOT_STAT_KEYS.includes(key))continue; // is_diaper is never on the list: diaper is identity, not a stat
   const lo=Math.floor(num(line.min,0)+Math.floor(num(line.per_level_min,0)*(ilvl-1)));
   const hi=Math.floor(num(line.max,0)+Math.floor(num(line.per_level_max,0)*(ilvl-1)));
   const value=range(rnd,lo,hi);
   if(value===0)continue;
   if(key==='conceals_panties')item.conceals_panties=value>0;
   else{
    item[key]=(Number.isFinite(item[key])?item[key]:0)+value;
    if(key==='childish')item.childish=Math.max(0,Math.min(10,item.childish));
    if(key==='bulk'||key==='bulk_threshold')item[key]=Math.max(0,item[key]);
   }
   record.stats[key]=value;
  }
  const flavour=typeof affix.flavour==='string'?affix.flavour:'';
  if(flavour&&typeof item.desc==='string'&&!item.desc.includes(flavour)){
   const desc=item.desc.trim();
   item.desc=((desc&&!'.!?'.includes(desc.slice(-1))?desc+'.':desc)+' '+flavour).trim();
  }
  return record;
 }

 function pickAffix(slot,tier,used,want,rnd){
  const legal=affixes.filter(affix=>affixLegal(affix,slot,tier,order,used,want));
  return weightedPick(legal,affix=>num(affix.weight,1),rnd);
 }

 return {
  tuning,order,titles,
  routeLevel(route,depth=1,override){ // The level a route hands out on a floor: authored base + per-floor growth, or the chest's own override.
   if(Number.isFinite(override))return Math.max(1,Math.min(num(tuning.ilvl_cap,100),Math.floor(override)));
   const rows=tuning.route_levels??{},row=rows[route]??rows.default??{base:5,per_floor:2};
   return Math.max(1,Math.min(num(tuning.ilvl_cap,100),Math.floor(num(row.base,5)+num(row.per_floor,2)*(Math.max(1,depth)-1))));
  },
  enchantMods(item){ // What the curse/blessing roller should do for this copy's tier.
   const cfg=rarityConfig(tuning,item?.loot?.rarity??'common');
   return {curseMult:cfg.curse_mult,blessMult:cfg.bless_mult,force:cfg.force_blessing?'blessing':''};
  },
  generator,
  roll(item,key,{level=1,luck='chest'}={}){ // `key` is the chest's own seed key, so the roll is stable across regeneration. Returns the rolled struct, which may be a generated replacement.
   if(!item||typeof item!=='object')return item;
   if(generator.has&&generator.isTemplate(item)){const gen=generator.generate(item.category,seeded(key+':base'),item.is_diaper===true);if(gen){gen.source_item_id=item.item_id;item=gen;}} // numbered art variant -> style + garment base
   if(item.source_item_id===undefined)item.source_item_id=item.item_id;
   if(item.base_name===undefined)item.base_name=String(item.name??'');
   if(!has||!eligible(item))return item;
   const rnd=seeded(key+':loot');
   const tier=pickRarity(luck,rnd),cfg=rarityConfig(tuning,tier);
   const cap=Math.max(1,Math.floor(num(tuning.ilvl_cap,100)));
   const ilvl=Math.max(1,Math.min(cap,Math.floor(num(level,1))+range(rnd,Math.floor(num(tuning.ilvl_jitter_min,-1)),Math.floor(num(tuning.ilvl_jitter_max,2)))));
   scaleBase(item,ilvl,tier);
   const slots=itemSlots(item),used=new Set();
   const loot={rolled:true,rarity:tier,ilvl,prefix:undefined,suffix:undefined,bonus:[],title:'',seed:String(key),slots};
   for(let p=0;p<slots.length;p++){
    for(let k=0;k<cfg.affixes;k++){
     let want='bonus';
     if(p===0&&k===0)want='prefix';
     else if(cfg.suffix&&!loot.suffix&&((slots.length===1&&k===1)||(slots.length>1&&p===1&&k===0)))want='suffix'; // a dress takes its title from the pants pass
     let affix=pickAffix(slots[p],tier,used,want,rnd);
     if(!affix&&want!=='bonus')affix=pickAffix(slots[p],tier,used,'bonus',rnd);
     if(!affix)continue;
     const record=applyAffix(item,affix,ilvl,rnd);
     for(const tag of (Array.isArray(affix.tags)?affix.tags:[]))used.add(tag);
     if(want==='prefix'&&affix.adjective){record.adjective=affix.adjective;loot.prefix=record;}
     else if(want==='suffix'&&affix.suffix_title){record.title=affix.suffix_title;loot.suffix=record;}
     else loot.bonus.push(record);
    }
   }
   if(tier==='legendary'&&titles.length)loot.title=titles[rnd(titles.length)];
   if(loot.prefix===undefined)delete loot.prefix; // JSON round trips drop undefined anyway; keep the struct stable for deepEqual
   if(loot.suffix===undefined)delete loot.suffix;
   item.loot=loot;
   item.name=buildName(item);
   item.value=valueFor(tuning,item.value,tier,ilvl);
   item.rarity=tier; // the enchantment scorer reads this tier too
   return item;
  },
 };
}

// ── Generated bases: STYLE (words only) + GARMENT (slot and mechanics) ──────────────
// dive-data.json `bases`, exported from datafiles/generation/loot_bases.json. A numbered pool
// item (catalog entry flagged pool_template) is swapped for a generated base before the
// rarity/affix roll, so "Latex Dress #7" becomes "Maid Dress" and then "Crinkly Maid Dress of
// the Nursery". Styles never carry stats; diaper absorbency is a garment tier.
export const GENERATED_CATEGORIES=Object.freeze(['dress','torso','pants','skirt','bra','gloves','shoes','socks','corset','panties','diaper_cover']);
const GARMENT_STAT_KEYS=['atk','atk_min','atk_max','def','hp_regen','value','childish','wet_resist','tum_resist','bulk','bulk_threshold','conceals_panties','is_diaper','is_bloomers','shame_delta','atk_mod','def_mod','dex_mod','int_mod','cha_mod'];

export function createBaseGenerator(bases){
 const has=!!bases&&typeof bases==='object';
 const tuning={generated_categories:GENERATED_CATEGORIES,id_prefix:'gen_',id_separator:'_',name_format:'{style} {garment}',desc_format:'{garment_desc} {style_desc}',...(has?bases.tuning??{}:{})};
 const garments=has&&Array.isArray(bases.garments)?bases.garments:[],styles=has&&Array.isArray(bases.styles)?bases.styles:[];
 const cats=Array.isArray(tuning.generated_categories)?tuning.generated_categories:GENERATED_CATEGORIES;
 const list=style=>Array.isArray(style?.garments)?style.garments:['*'];
 const allows=(style,gid)=>!!style&&style.enabled!==false&&(list(style).includes('*')||list(style).includes(gid));
 const isTemplate=item=>!!item&&typeof item==='object'&&item.pool_template===true&&!item.quest_item&&cats.includes(item.category);
 function build(style,garment){ // Every number comes from the garment; the style contributes words only.
  const sname=String(style.name??style.id),gname=String(garment.name??garment.id);
  const name=String(tuning.name_format).replace('{style}',sname).replace('{garment}',gname);
  const gdesc=String(garment.desc??'').replaceAll('{style_lower}',sname.toLowerCase()).replaceAll('{style}',sname);
  const desc=String(tuning.desc_format).replace('{garment_desc}',gdesc).replace('{style_desc}',String(style.desc??'')).trim();
  const item={item_id:tuning.id_prefix+String(style.id)+tuning.id_separator+String(garment.id),name,base_name:name,category:String(garment.category??'torso'),desc,rarity:'common',generated:{style:String(style.id),garment:String(garment.id)},magical_effects:[]};
  for(const key of GARMENT_STAT_KEYS)if(garment[key]!==undefined)item[key]=garment[key];
  return item;
 }
 const pickGarment=(category,rnd,isDiaper)=>weightedPick(garments.filter(g=>g&&g.enabled!==false&&g.category===category&&(isDiaper===undefined||(g.is_diaper===true)===isDiaper)),g=>num(g.weight,1),rnd); // a diaper template stays a diaper: the per-floor panty cap is decided before generation
 const pickStyle=(gid,rnd)=>weightedPick(styles.filter(s=>allows(s,gid)),s=>num(s.weight,1),rnd);
 function generate(category,rnd,isDiaper){const garment=pickGarment(category,rnd,isDiaper);if(!garment)return null;const style=pickStyle(String(garment.id),rnd);return style?build(style,garment):null;}
 function fromId(id){ // "gen_maid_dress" -> the same base; the longest garment suffix wins ("thick_diaper" over "diaper").
  if(typeof id!=='string'||(tuning.id_prefix&&!id.startsWith(tuning.id_prefix)))return null;
  const rest=id.slice(tuning.id_prefix.length);
  let best=null;
  for(const g of garments){const suffix=tuning.id_separator+String(g.id);if(rest.length>suffix.length&&rest.endsWith(suffix)&&(!best||String(g.id).length>String(best.id).length))best=g;}
  if(!best)return null;
  const style=styles.find(s=>s.id===rest.slice(0,rest.length-String(best.id).length-tuning.id_separator.length));
  return style?build(style,best):null;
 }
 return {has:has&&garments.length>0&&styles.length>0,isTemplate,generate,fromId,build,garments,styles,tuning};
}

export function describeLoot(item){ // "rare - Item Level 14 (Crinkly / of the Nursery)" for inspection and the /gm preview; "" for plain gear.
 const loot=item?.loot;
 if(!loot||loot.rolled!==true)return '';
 const parts=[loot.prefix?.adjective,loot.suffix?.title].filter(Boolean);
 return `${loot.rarity} - Item Level ${loot.ilvl}${parts.length?' ('+parts.join(' / ')+')':''}`;
}
