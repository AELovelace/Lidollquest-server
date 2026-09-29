// Eat and drink from the omo-trainer companion.
// The game applies food and drink itself (client-trusted loadouts), so the companion needs a server copy of the same rules.
// This is a line-for-line port of the "food"/"drink" branch of _inv_use_core_impl (scrInventory.gml) and the helpers it calls:
//   survival_consume_item + tier floors (scrSurvivalSystem.gml), heal_scale/mana_scale (scrLootRoll.gml),
//   accident_reset + accident_unnoticed_settle (scrAccidentSystem.gml), dignity_change (scrSurvivalSystem.gml),
//   player_continence_potion (scrAccidentSystem.gml), alchemy_apply_brew_fields (scrAlchemy.gml), inv_consume (scrInventory.gml).
// Change the GML and this file together. Effect order matches the game exactly.
import {healScale} from './scaling.mjs';
import {DEFAULT_TUNING} from './loot.mjs';
import {dignityTuning,shameMultiplier} from './dignity.mjs';
import {recalculateWetClothing} from './clothing-conditions.mjs';
import {stackTokens,setStackTokens} from './loadout.mjs';

const fail=message=>{throw Object.assign(Error(message),{status:409,code:'consume_conflict'});};
const num=(value,fallback=0)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const has=(item,key)=>item!=null&&Object.prototype.hasOwnProperty.call(item,key)&&item[key]!==undefined;

export const METER_MAX=250; // SURVIVAL_METER_MAX: Hunger and Thirst share a 250-point ceiling.
const FLOOR={snack:125,meal:167,drink:167,potion:125,snackTum:12,mealTum:20,potionWet:12,drinkWet:20}; // SURVIVAL_MIN_* macros.

// ── Classifiers (survival_item_is_*) ──
export const isDrink=item=>item?.category==='drink'||item?.is_drink===true;
export const isPotion=item=>String(item?.item_id??'').toLowerCase().includes('potion');
export const isFood=item=>item?.category==='food'&&!isDrink(item)&&!['baby_wipes','fairy_dust_bottle'].includes(item?.item_id); // Wipes and crafting dust are not meals.
export const isSnack=item=>isFood(item)&&item.is_snack===true;
export const consumable=item=>item?.category==='food'||item?.category==='drink';
const value=(item,field,fallback)=>typeof item?.[field]==='number'&&Number.isFinite(item[field])?item[field]:fallback; // survival_item_value: authored numbers win, explicit zero included.

// ── Effective amounts, the same numbers the game's item card shows ──
export function hungerRestore(item){const authored=value(item,'hunger_restore',0);return isFood(item)?Math.max(isSnack(item)?FLOOR.snack:FLOOR.meal,authored):authored;}
export function thirstRestore(item){const min=isPotion(item)?FLOOR.potion:isDrink(item)?FLOOR.drink:0;return Math.max(min,value(item,'thirst_restore',min));}
export function wetTargetGain(item){const min=isPotion(item)?FLOOR.potionWet:isDrink(item)?FLOOR.drinkWet:0;return Math.max(min,Math.max(0,value(item,'wet_target_gain',min)));}
export function tumTargetGain(item){const min=isSnack(item)?FLOOR.snackTum:isFood(item)?FLOOR.mealTum:0;return Math.max(min,Math.max(0,value(item,'tum_target_gain',min)));}
export function pressureTurns(item){return Math.max(0,Math.floor(value(item,'pressure_turns',isFood(item)||isDrink(item)?4:0)));}
export function wetInstant(item){return value(item,'wet_instant',isDrink(item)?2:0);}
export function tumInstant(item){return value(item,'tum_instant',isFood(item)?2:0);}
export function manaScale(tuning,mpMax){return Math.max(1,num(mpMax,0)/Math.max(1,num(tuning?.mana_reference_mp,DEFAULT_TUNING.mana_reference_mp??100)));} // mana_scale(): MP potions grow with a mage's deep bar.

function ensureSurvival(p){ // survival_ensure_player_fields: backfill and clamp the meters an older save may lack.
 p.hunger_max=METER_MAX;p.thirst_max=METER_MAX;
 p.hunger=clamp(num(p.hunger,METER_MAX),0,METER_MAX);p.thirst=clamp(num(p.thirst,METER_MAX),0,METER_MAX);
 p.hunger_zero_turns=num(p.hunger_zero_turns,0);p.thirst_zero_turns=num(p.thirst_zero_turns,0);
 if(!Array.isArray(p.active_effects))p.active_effects=[];
}

function survivalConsume(p,item,wetOnly,lines){ // survival_consume_item: feed/hydrate now, some pressure now, the rest over a few turns.
 ensureSurvival(p);
 const oldHunger=p.hunger,oldThirst=p.thirst;
 p.hunger=clamp(p.hunger+Math.max(0,hungerRestore(item)),0,p.hunger_max);
 p.thirst=clamp(p.thirst+Math.max(0,thirstRestore(item)),0,p.thirst_max);
 if(p.hunger>0)p.hunger_zero_turns=0;
 if(p.thirst>0)p.thirst_zero_turns=0;
 const wetNow=wetInstant(item),tumNow=tumInstant(item);
 p.wet=clamp(num(p.wet)+Math.max(0,wetNow),0,100);
 if(!wetOnly)p.tum=clamp(num(p.tum)+Math.max(0,tumNow),0,100); // Easy (wet-only) mode keeps the tummy at zero.
 const turns=pressureTurns(item),wetTarget=wetTargetGain(item),tumTarget=tumTargetGain(item);
 const wetNeed=wetTarget>0?Math.ceil(wetTarget/Math.max(1,turns)):0,tumNeed=tumTarget>0?Math.ceil(tumTarget/Math.max(1,turns)):0;
 const wetRate=Math.max(wetNeed,Math.max(0,value(item,'wet_per_turn',wetNeed))),tumRate=Math.max(tumNeed,Math.max(0,value(item,'tum_per_turn',tumNeed)));
 if(turns>0&&((wetTarget>0&&wetRate>0)||(tumTarget>0&&tumRate>0)))p.active_effects.push({source:item.name,turns_until_start:0,duration_remaining:turns,wet_per_turn:wetRate,tum_per_turn:tumRate,
  wet_target_gain:wetTarget,tum_target_gain:tumTarget,wet_applied:0,tum_applied:0,wet_force:false,tum_force:false,inco_set:-1,inco_delta:0,inco_restore:-1,grossout_reset:false,started:false,suppress_proc_popup:true}); // Digestion runs on the game's ordinary per-move effect runner.
 const parts=[];
 if(p.hunger-oldHunger>0)parts.push('Hunger +'+(p.hunger-oldHunger));
 if(p.thirst-oldThirst>0)parts.push('Thirst +'+(p.thirst-oldThirst));
 if(wetNow>0)parts.push('Wet +'+wetNow);
 if(!wetOnly&&tumNow>0)parts.push('Tum +'+tumNow);
 if(parts.length)lines.push(parts.join(', ')+'.');
}

function dignityChange(p,delta,tuning){ // dignity_change: losses are scaled by Shame (the client-scored shame_level), gains are not. Returns the real signed change.
 const before=clamp(num(p.shame,1024),0,1024);
 if(delta<0)delta=-Math.round(-delta*shameMultiplier(p,tuning));
 p.shame=clamp(before+delta,0,1024);
 return p.shame-before;
}
const dignityText=change=>'Dignity '+(change>=0?'+':'')+change;

function unnoticedSettle(p,tuning,zone,lines){ // accident_unnoticed_settle(false): cleaning up is when you find out.
 const wets=Math.max(0,num(p.unnoticed_wet,p.unnoticed_wet===true?1:0)),messes=Math.max(0,num(p.unnoticed_tum,p.unnoticed_tum===true?1:0));
 if(wets+messes<=0)return;
 const t={...DEFAULT_TUNING,...tuning};
 let loss=wets*num(t.unnoticed_wet_dignity,20)+messes*num(t.unnoticed_tum_dignity,32)+Math.round(Math.max(0,num(p.unnoticed_turns))*num(t.unnoticed_per_turn_dignity,1));
 p.unnoticed_wet=0;p.unnoticed_tum=0;p.unnoticed_turns=0;
 if(zone.startsWith('utopia-arcanum')){lines.push("Oh! You'd had an accident and never noticed. In Utopia, nobody minds one bit.");return;} // Padded Pride: no Dignity cost in Utopia.
 if(zone.startsWith('arcadia-foundry'))loss=Math.round(loss*dignityTuning(tuning).arcadiaScrutinyPct/100); // Big Rules: in Arcadia, everyone noticed before you did.
 if(loss<=0)return;
 lines.push('You\'ve been walking around like that without even noticing. How long has everyone else known? '+dignityText(dignityChange(p,-loss,tuning))+'.');
}

function accidentReset(loadout,catalog,tuning,zone,lines){ // accident_reset(false): clear accident state and the bulk it added, dry the underwear.
 const p=loadout.player_info;
 if(num(p.unnoticed_wet,p.unnoticed_wet===true?1:0)+num(p.unnoticed_tum,p.unnoticed_tum===true?1:0)>0){if(loadout.world)loadout.world.pending_popup_turns=0;unnoticedSettle(p,tuning,zone,lines);} // The discovery popup is moot now.
 p.panties_bulk=Math.max(0,num(p.panties_bulk)-num(p.accident_bulk));
 for(const key of ['accident_bulk','had_wet_accident','had_tum_accident','diaper_wet_absorbed','diaper_tum_absorbed','grossout_chance','wet_hold_attempts','tum_hold_attempts'])p[key]=0;
 for(const slot of ['panties','socks','shoes'])if(has(p,'slot_wet_'+slot)){p['slot_wet_'+slot]=false;if(p.clothing_water&&typeof p.clothing_water==='object')delete p.clothing_water[slot];} // set_slot_wet only touches slots the save knows.
 recalculateWetClothing(p,catalog); // apply_wet_clothing_penalty: dry clothes give their stats back.
 lines.push('You cleaned up. Feeling fresh again.');
}

function continencePotion(p,item,catalog,lines){ // player_continence_potion: permanent shifts, or a timed effect that the newest full-control potion replaces.
 if(['temporary_continence_potion','temporary_incontinence_potion'].includes(item.item_id)&&catalog[item.item_id])item={...item,...catalog[item.item_id]}; // Old bottles use the current effect.
 if(!has(item,'continence_delta')&&!has(item,'continence_set'))return;
 const turns=num(item.continence_turns,0);
 if(turns<=0){
  const delta=num(item.continence_delta,0);
  p.incontinence=clamp(num(p.incontinence)+delta,0,1000);
  if(num(p.witch_spell_turns)>0)p.witch_spell_old_inco=clamp(num(p.witch_spell_old_inco)+delta,0,1000);
  if(num(p.forced_inco_turns)>0)p.forced_inco_old_inco=clamp(num(p.forced_inco_old_inco)+delta,0,1000);
  for(const effect of Array.isArray(p.active_effects)?p.active_effects:[])if(num(effect?.inco_restore,-1)>=0)effect.inco_restore=clamp(effect.inco_restore+delta,0,1000); // An older hex must not erase this permanent change when it restores its baseline.
 }else{
  const target=num(item.continence_set,-1),effects=Array.isArray(p.continence_effects)?p.continence_effects:[];
  for(let i=effects.length-1;i>=0;i--){const e=effects[i];if(e?.item_id===item.item_id||(target>=0&&(num(e?.target,-1)>=0||['temporary_continence_potion','temporary_incontinence_potion'].includes(e?.item_id))))effects.splice(i,1);}
  effects.push({item_id:item.item_id,name:item.name,delta:num(item.continence_delta,0),target,turns});
  p.continence_effects=effects; // Drinking either full-control potion replaces the previous one and starts fresh turns.
 }
 const description=num(item.continence_set,-1)>=0?(100-item.continence_set/10)+'% continence':Math.abs(num(item.continence_delta,0))/10+' percentage points';
 lines.push(item.name+': '+description+(turns>0?' for '+turns+' turns.':' permanently.'));
}

function brewFields(p,item,wetOnly,lines){ // alchemy_apply_brew_fields: Relief potions lower the meters safely; Drowsy ones tire you.
 const wr=num(item.wet_relief,0);
 if(wr>0&&num(p.wet)>0){const old=p.wet;p.wet=Math.max(0,p.wet-wr);lines.push('The pressure in your bladder eases. (WET '+Math.round(old)+' -> '+Math.round(p.wet)+')');}
 const tr=num(item.tum_relief,0);
 if(tr>0&&num(p.tum)>0&&!wetOnly){const old=p.tum;p.tum=Math.max(0,p.tum-tr);lines.push('Your tummy settles down. (TUM '+Math.round(old)+' -> '+Math.round(p.tum)+')');}
 const sd=num(item.stamina_drain,0);
 if(sd>0&&has(p,'stamina')){p.stamina=Math.max(0,num(p.stamina)-sd);lines.push('You feel drowsy. Stamina -'+sd+'.');}
}

const incoFlavour=pct=>pct<20?'You feel a faint twinge of worry, but you still have control.':pct<40?'A nervous flutter runs through you. You notice your body feels less reliable.':
 pct<60?'You feel a growing sense of helplessness. Each slip chips away at your confidence.':pct<80?"Your cheeks burn with shame. You can't ignore the changes anymore.":
 pct<100?'You feel overwhelmed, your body betraying you at every turn. Tears threaten to spill.':"You've lost all control. The feeling is both terrifying and strangely freeing.";

const EFFECT_DEFAULTS={source:'',turns_until_start:0,duration_remaining:0,wet_per_turn:0,tum_per_turn:0,wet_force:false,tum_force:false,inco_set:-1,inco_delta:0,inco_restore:-1,grossout_reset:false,started:false}; // Every field the game's effect runner reads.

function consumeAt(inventory,index){ // inv_consume: one unit off the stack (newest resale right first); the entry disappears at zero.
 const item=inventory[index],have=Math.max(1,Math.floor(num(item.quantity,1)));
 if(have<=1){inventory.splice(index,1);return;}
 const tokens=stackTokens(item),price=tokens.length&&Number.isSafeInteger(item.online_sell_price)?new Map([[tokens[0],item.online_sell_price]]):null;
 item.quantity=have-1;setStackTokens(item,tokens.slice(0,item.quantity),price); // The front unit stays sellable.
}

// Apply one food or drink from bag slot `index` to `loadout` (already a private copy). Returns the Action Log lines the game would print.
export function consumeFromBag(loadout,index,itemId,catalog,{tuning=DEFAULT_TUNING,zone='',wetOnly}={}){
 const bag=loadout.inventory,carried=Number.isInteger(index)?bag[index]:null;
 if(!carried||carried.item_id!==itemId)fail('That item changed. Refresh and choose it again.');
 const item={...catalog[itemId],...carried}; // The carried copy wins, exactly as inv_get() hands the game its own struct (brewed potions carry their effects).
 if(!consumable(item))fail('Only food and drinks can be eaten or drunk.');
 const p=loadout.player_info,lines=[],name=String(item.name??itemId);wetOnly??=loadout.world?.wet_only_mode===true; // Easy (wet-only) mode: the caller knows it for cloud saves.
 // HP: -1 = full, -2 = half, a flat heal grows with the HP bar.
 const max=num(p.playerHealthMax,100);let heal=num(item.hp_restore,0);
 if(heal===-1)heal=max;else if(heal===-2)heal=Math.floor(max*0.5);else if(heal>0)heal=Math.floor(heal*healScale(tuning,max));
 if(heal>0){const old=num(p.playerHealth,max);p.playerHealth=Math.min(old+heal,max);const gained=p.playerHealth-old;lines.push('Used '+name+'.'+(gained>0?' Restored '+gained+' HP.':''));}
 else lines.push('Used '+name+'.');
 survivalConsume(p,item,wetOnly,lines);
 const sta=num(item.stamina_restore,0); // Stamina: -1 = full; the HUD bar tells the story, no log line.
 if(sta!==0&&has(p,'stamina')){const cap=num(p.stamina_max,num(p.stamina));p.stamina=Math.min(num(p.stamina)+(sta===-1?cap:sta),cap);}
 const mp=num(item.mp_restore,0); // MP: -1 = full; flat restores grow with the MP bar.
 if(mp!==0){const cap=num(loadout.player_mp_max,0),old=num(loadout.player_mp,0),amount=mp===-1?cap:mp>0?Math.floor(mp*manaScale(tuning,cap)):mp;
  loadout.player_mp=clamp(old+amount,0,cap);lines.push('MP +'+(loadout.player_mp-old)+' → '+loadout.player_mp+'/'+cap);}
 if(item.grossout_reset===true){ // Baby Wipes and a few mystery potions.
  if(num(p.accident_bulk)>0||num(p.had_wet_accident)>0||num(p.had_tum_accident)>0||num(p.grossout_chance)>0)accidentReset(loadout,catalog,tuning,zone,lines);
  else{p.grossout_chance=0;lines.push('The shame melts away completely.');}
 }
 if(has(item,'shame_delta')&&typeof item.shame_delta==='number'){ // Dignity (stored as `shame`).
  const change=dignityChange(p,item.shame_delta,tuning);
  if(change>0)lines.push('You feel cleaner and more grown-up! '+dignityText(change)+'!');
  else if(change<0)lines.push('You feel extra silly and babyish! '+dignityText(change)+'!');
 }
 continencePotion(p,item,catalog,lines);
 brewFields(p,item,wetOnly,lines);
 const inco=num(item.inco_gain,0);
 if(inco!==0){p.incontinence=clamp(num(p.incontinence)+inco,0,1000);const pct=Math.round(p.incontinence*100/1000);lines.push('Incontinence '+(inco>0?'+':'')+inco+' → '+pct+'. '+incoFlavour(pct));}
 if(item.active_effect&&typeof item.active_effect==='object'){ // Timed effects (mystery potions): queued for the game's per-move runner.
  const effect={...EFFECT_DEFAULTS,...structuredClone(item.active_effect)};
  if(num(effect.inco_set,-1)>=0)effect.inco_restore=num(p.incontinence);
  if(!Array.isArray(p.active_effects))p.active_effects=[];p.active_effects.push(effect);
  lines.push(num(effect.turns_until_start)>0?'('+name+' - something feels different... effect in '+effect.turns_until_start+' turns.)':'('+name+' - an effect begins...)');
 }
 consumeAt(bag,index);
 return lines;
}
