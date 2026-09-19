import {seeded} from './dive-generation.mjs';

// Rolled curse / blessing system. The campaign runs the identical maths in
// scripts/scrEnchantments/scrEnchantments.gml; this file is the authoritative
// copy for shared loot, seeded from the chest key so a re-roll of the same
// chest always produces the same enchantment. Change one, change both, then
// re-run python/export_online_dive.py to ship the table.
//
// The roll lands on ONE COPY of an item, never on the item id, so two Latex
// Dresses from the same floor can be one cursed, one blessed and one plain.
// The stamped struct rides along in the character's inventory and
// player_info.equipped_item_data, which is what the client reads back through
// player_equipment_item().

// The one source of truth for what a gamemaster may type into the /gm panel, and
// what the campaign's editor offers. Keep these in step with SLOT_CHOICES in
// python/editor/tabs/enchantment_tabs.py and the deltas _magical_effect_apply_delta() applies.
export const SLOT_CATEGORIES=Object.freeze(['head','mouth','torso','dress','bra','corset','pants','skirt','panties','diaper_cover','socks','shoes','gloves','accessory','weapon','plug','special']);
export const STAT_DELTA_KEYS=Object.freeze(['shame','wet','tum','health','incontinence','excitement','stamina']);
export const TUNING_KEYS=Object.freeze(['curse_chance_low_rarity','curse_chance_high_rarity','bless_chance_low_rarity','bless_chance_high_rarity','value_weight','stat_weight','value_soft_cap','stat_soft_cap','authored_rarity_weight','bias_multiplier','proc_jitter']);

const number=value=>Number.isFinite(value)?Math.abs(value):0;
// Curses and blessings own separate chance ramps indexed by the item's rarity
// score: the curse ramp falls as rarity rises, the blessing ramp climbs. Scavenged
// junk is mostly cursed; treasure is mostly a boon. One roll picks between them.
const DEFAULTS={curse_chance_low_rarity:14,curse_chance_high_rarity:2,bless_chance_low_rarity:1,bless_chance_high_rarity:18,value_weight:0.6,stat_weight:0.4,value_soft_cap:120,stat_soft_cap:12,authored_rarity_weight:0.5,bias_multiplier:2.5,proc_jitter:15,rarity_scores:{},rarity_tiers:[{name:'common',min_score:0}]};

export function statPower(item){ // Raw stats count once, modifiers double, regen double again: it never stops paying.
 return number(item.atk)+number(item.def)
  +2*(number(item.atk_mod)+number(item.def_mod)+number(item.dex_mod)+number(item.int_mod)+number(item.cha_mod))
  +number(item.wet_resist)+number(item.tum_resist)+2*number(item.hp_regen);
}

export function derivedScore(item,tuning){ // Live 0-1 rarity score from coin value and stat power; sqrt keeps cheap gear off a flat zero.
 const value=Number.isFinite(item.value)&&item.value>0?item.value:0;
 const v=Math.sqrt(Math.min(1,value/Math.max(1,tuning.value_soft_cap)));
 const s=Math.sqrt(Math.min(1,statPower(item)/Math.max(1,tuning.stat_soft_cap)));
 return Math.max(0,Math.min(1,tuning.value_weight*v+tuning.stat_weight*s));
}

export function itemScore(item,tuning){ // An authored `rarity` tier steers the score without discarding the item's real stats.
 const derived=derivedScore(item,tuning),authored=tuning.rarity_scores?.[item.rarity];
 if(!Number.isFinite(authored))return derived;
 const w=Math.max(0,Math.min(1,tuning.authored_rarity_weight));
 return Math.max(0,Math.min(1,w*authored+(1-w)*derived));
}

export function scoreTier(score,tuning){ // Tiers are authored low to high; the last one cleared wins.
 let name=tuning.rarity_tiers[0]?.name??'common';
 for(const tier of tuning.rarity_tiers)if(score>=(tier.min_score??0))name=tier.name??name;
 return name;
}

const biasScale=(item,alignment,tuning)=>{ // enchant_bias scales its favoured ramp up and the other down.
 if(typeof item.enchant_bias!=='string'||!item.enchant_bias)return 1;
 const mult=Math.max(1,tuning.bias_multiplier); // never below 1, or a bias would invert itself
 return item.enchant_bias===alignment?mult:1/mult;
};

export function curseChancePercent(item,score,tuning){ // Descending ramp: cheap scavenged junk is what turns on you.
 const raw=tuning.curse_chance_low_rarity+(tuning.curse_chance_high_rarity-tuning.curse_chance_low_rarity)*score;
 return Math.max(0,Math.min(100,raw*biasScale(item,'curse',tuning)));
}

export function blessChancePercent(item,score,tuning){ // Ascending ramp: treasure is mostly a boon.
 const raw=tuning.bless_chance_low_rarity+(tuning.bless_chance_high_rarity-tuning.bless_chance_low_rarity)*score;
 return Math.max(0,Math.min(100,raw*biasScale(item,'blessing',tuning)));
}

export function chancePercent(item,score,tuning){ // Odds of ANY enchantment; used by inspection and the editor preview.
 return Math.min(100,curseChancePercent(item,score,tuning)+blessChancePercent(item,score,tuning));
}

const eligible=item=>!item.quest_item&&item.category!=='quest_item'&&!item.cursed&&!item.blessed&&!item.enchantment
 &&!(Array.isArray(item.magical_effects)&&item.magical_effects.length)&&typeof item.category==='string'&&item.category!=='';
// Quest gear, permanently flagged story gear (Nanny Mabel matches those by id) and
// hand-authored enchantments are all left exactly as the catalog defines them.

const legal=(pool,category,score)=>pool.filter(entry=>entry.enabled!==false&&Array.isArray(entry.slots)
 &&entry.slots.includes(category)&&score>=(entry.min_score??0)&&score<=(entry.max_score??1));
// The garment gate: a HEAD curse only lands on a head item, and the score band
// stops a five-coin sock from rolling a movement lock.

function pick(entries,rnd){ // Weighted pick in basis points, so movement locks stay a surprise rather than the norm.
 const total=entries.reduce((sum,entry)=>sum+Math.max(0,entry.weight??1),0);
 if(!entries.length)return null;
 if(total<=0)return entries[rnd(entries.length)];
 let roll=rnd(Math.max(1,Math.round(total*1000)))/1000;
 for(const entry of entries){roll-=Math.max(0,entry.weight??1);if(roll<=0)return entry;}
 return entries[entries.length-1];
}

export function createEnchanter(table){ // Built once at boot from the exported table; returns a no-op roller when none shipped.
 const tuning={...DEFAULTS,...(table?.tuning??{})};
 const curses=Array.isArray(table?.curses)?table.curses:[],blessings=Array.isArray(table?.blessings)?table.blessings:[];
 const ids=new Set();
 for(const entry of [...curses,...blessings]){
  if(!entry?.id||ids.has(entry.id))throw Error('Enchantment ids must be present and unique: '+entry?.id);
  ids.add(entry.id);
 } // A duplicate id would make save-time lookups ambiguous between the two tables.

 function apply(item,entry,rnd){
  const effect=structuredClone(entry.effect); // Deep copy: two drops must never share one proc struct.
  if(!effect||typeof effect!=='object')return false;
  const jitter=Math.max(0,tuning.proc_jitter);
  if(jitter>0){ // Per-instance cadence jitter so two copies of the same enchantment desync.
   const min=Math.max(30,(effect.proc_min??120)+rnd(jitter*2+1)-jitter);
   effect.proc_min=min;effect.proc_max=Math.max(min+20,(effect.proc_max??240)+rnd(jitter*2+1)-jitter);
  }
  item.magical_effects=[effect];
  if(entry.alignment==='curse'){if(entry.sticky)item.cursed=true;} // Non-sticky curses are "haunted": nasty, but they still come off by hand.
  else item.blessed=true; // Blessed panties also creep incontinence, which is deliberate.
  const hint=typeof entry.desc_hint==='string'?entry.desc_hint:'';
  if(hint&&typeof item.desc==='string'&&!item.desc.includes(hint)){
   const desc=item.desc.trim();
   item.desc=(desc&&!'.!?'.includes(desc.slice(-1))?desc+'.':desc)+' '+hint; // Tidy punctuation before appending the in-fiction tell.
   item.desc=item.desc.trim();
  }
  item.enchantment={id:entry.id,name:entry.name??'',alignment:entry.alignment,sticky:entry.sticky===true,rolled:true};
  return true;
 }

 return function enchant(item,key){ // `key` is the chest's own seed key, so the roll is stable across regeneration.
  if(!ids.size||!eligible(item))return item;
  const score=itemScore(item,tuning),rnd=seeded(key+':enchant');
  const curseOdds=curseChancePercent(item,score,tuning)*100,blessOdds=blessChancePercent(item,score,tuning)*100;
  // ONE roll across both bands in basis points, so a copy is never cursed AND
  // blessed, and the two chances add up to exactly the odds of being enchanted.
  const roll=rnd(10000),wantCurse=roll<curseOdds;
  if(!wantCurse&&roll>=curseOdds+blessOdds)return item; // The usual outcome: plain gear.
  let entries=legal(wantCurse?curses:blessings,item.category,score);
  if(!entries.length)entries=legal(wantCurse?blessings:curses,item.category,score); // That family has none for this slot; try the other alignment.
  const entry=pick(entries,rnd);
  if(entry)apply(item,entry,rnd);
  return item;
 };
}

export function describeItem(item,table){ // "rare - Clinging Ribbons (curse, sticky)". Used by inspection and the /gm panel.
 const tuning={...DEFAULTS,...(table?.tuning??{})},tier=scoreTier(itemScore(item,tuning),tuning);
 if(!item.enchantment)return tier;
 return `${tier} - ${item.enchantment.name||item.enchantment.id} (${item.enchantment.alignment}${item.enchantment.sticky?', sticky':''})`;
}
