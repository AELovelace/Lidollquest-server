// Dignity and Shame, online.
// Dignity (stored as player_info.shame for save/content compatibility) runs 1024 (adult-minded) down to 0 (fully regressed).
// Shame (player_info.shame_level, 0-100) is how humiliating your predicament is right now: plugged, wet or messy, paci/gag in,
// locked into childish clothes, dressed cute. The client scores it (scrOnlineRoom dignity_shame_refresh) with these same weights;
// high Dignity makes Shame climb faster, low Dignity dulls it. Shame then multiplies every one-way Dignity loss.
// Every number lives in the loot tuning (live on the /gm Loot tab) and ships to the client as `dignityTuning`.
import {DEFAULT_TUNING} from './loot.mjs';

export const DIGNITY_TUNING_KEYS=Object.freeze(['defeat_dignity_loss','defeat_dignity_childish_extra','witnessed_wet_dignity','witnessed_tum_dignity','smell_dignity_per_mess','smell_dignity_max','arcadia_scrutiny_percent','arcadia_visible_padding_pts','arcadia_childish_shame_percent','arcadia_little_childish','arcadia_little_tax_percent','arcadia_toilet_price','utopia_pod_dignity','utopia_padding_shame_pts','utopia_adult_clothes_shame_pts','utopia_smell_percent',
 'shame_pts_plug','shame_pts_wet','shame_pts_mess','shame_pts_mouth','shame_pts_locked','shame_pts_per_cute','shame_sensitivity_low','shame_sensitivity_high','shame_mult_low','shame_mult_high']);
export const READ_DIGNITY_ABILITY='read_the_room'; // RPP passive that lets an inspection show the other player's Dignity and Shame.

const count=value=>typeof value==='boolean'?Number(value):Number.isFinite(Number(value))&&value!==null&&value!==''?Math.max(0,Number(value)):0; // Counters older saves stored as bools still count as 0/1.

export function dignityTuning(tuning=null){ // Every amount, each falling back to the shipped default when a key is missing or malformed.
 const read=(key,max=1024)=>{const v=Number(tuning?.[key]);return Number.isFinite(v)&&v>=0?Math.min(max,v):DEFAULT_TUNING[key];};
 return {defeatLoss:read('defeat_dignity_loss'),defeatChildishExtra:read('defeat_dignity_childish_extra'),witnessedWet:read('witnessed_wet_dignity'),witnessedTum:read('witnessed_tum_dignity'),exposedWet:read('exposed_wet_dignity'),exposedTum:read('exposed_tum_dignity'),exposedWitnessPct:read('exposed_witness_percent',1000),coverWitnessPct:read('cover_witness_percent',1000),rainPct:read('rain_dignity_percent',1000),unnoticedBelow:read('unnoticed_continence_below',100),unnoticedChance:read('unnoticed_chance_percent',100),unnoticedMin:read('unnoticed_turns_min',500),unnoticedMax:read('unnoticed_turns_max',500),unnoticedWet:read('unnoticed_wet_dignity',1024),unnoticedTum:read('unnoticed_tum_dignity',1024),unnoticedPerTurn:read('unnoticed_per_turn_dignity',100),
  smellPerMess:read('smell_dignity_per_mess'),smellMax:read('smell_dignity_max'),
  arcadiaScrutinyPct:read('arcadia_scrutiny_percent',1000),arcadiaPaddingPts:read('arcadia_visible_padding_pts',100),arcadiaChildishPct:read('arcadia_childish_shame_percent',1000),arcadiaLittleChildish:read('arcadia_little_childish',10),arcadiaLittleTaxPct:read('arcadia_little_tax_percent',1000),arcadiaToiletPrice:read('arcadia_toilet_price',1000), // Arcadia's Big Rules.
  utopiaPodDignity:read('utopia_pod_dignity'),utopiaPaddingPts:read('utopia_padding_shame_pts',100),utopiaAdultPts:read('utopia_adult_clothes_shame_pts',100),utopiaSmellPct:read('utopia_smell_percent',1000), // Utopia's Padded Pride rules.
  ptsPlug:read('shame_pts_plug',100),ptsWet:read('shame_pts_wet',100),ptsMess:read('shame_pts_mess',100),ptsMouth:read('shame_pts_mouth',100),ptsLocked:read('shame_pts_locked',100),ptsPerCute:read('shame_pts_per_cute',10),
  sensitivityLow:read('shame_sensitivity_low',5),sensitivityHigh:read('shame_sensitivity_high',5),multLow:read('shame_mult_low',5),multHigh:read('shame_mult_high',5)};
} // Same shape the client reads from the snapshot.

export function smellOf(p){ // Messes a character is still wearing: absorbed in the diaper plus soiled clothes. Same sum as the client and the HUD "Smell".
 return count(p?.diaper_tum_absorbed)+count(p?.had_tum_accident);
}

export const dignityOf=p=>Math.max(0,Math.min(1024,Number.isFinite(Number(p?.shame))?Math.round(Number(p.shame)):1024)); // Missing reads as a fresh adult.
export const shameOf=p=>Math.max(0,Math.min(100,Math.round(count(p?.shame_level)))); // The client-scored predicament, trusted like the rest of player_info.

export function shameMultiplier(p,tuning=null){ // 0 Shame -> multLow (0.5), 100 Shame -> multHigh (2.0), straight line between.
 const t=dignityTuning(tuning);return t.multLow+(t.multHigh-t.multLow)*shameOf(p)/100;
}

export function loseDignity(p,amount,tuning=null){ // One-way Dignity loss scaled by Shame; returns what was actually taken (after the 0 floor).
 if(!(amount>0))return 0;
 const before=dignityOf(p);p.shame=Math.max(0,before-Math.round(amount*shameMultiplier(p,tuning)));
 return before-p.shame;
}

export function dignityReading(p){ // What Read the Room reveals: Dignity with the campaign face tiers, plus current Shame.
 const dignity=dignityOf(p);
 return {dignity,label:dignity>=769?'Composed':dignity>=513?'Flustered':dignity>=257?'Embarrassed':'Mortified',shame:shameOf(p)};
}
