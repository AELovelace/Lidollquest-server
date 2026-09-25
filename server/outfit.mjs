// Shared outfit reading for rules that judge what a character is wearing: Arcadia's little tax (arcadia-rules.mjs) and
// the gods' uniforms (faith.mjs). Mirrors the client's get_player_childish() and are_panties_concealed() (scrInventory.gml).
const num=v=>Number.isFinite(Number(v))?Number(v):0;

export const OUTFIT_SLOTS=Object.freeze(['equipped_weapon','equipped_head','equipped_mouth','equipped_torso','equipped_pants','equipped_panties','equipped_socks','equipped_shoes',
 'equipped_gloves','equipped_bra','equipped_diaper_cover','equipped_special','equipped_accessory_1','equipped_accessory_2','equipped_accessory_3']); // Same slots, same order, as get_player_childish.

export function wornItems(p,items){ // Each equipped item once (a dress fills torso and pants), with its catalog entry.
 const seen=new Set(),out=[];
 for(const slot of OUTFIT_SLOTS){const id=p?.[slot];if(!id||seen.has(id))continue;seen.add(id);out.push({slot,id,item:items[id]??null});}
 return out;
}

export function bottomHidden(p,items){ // Do pants (or a dress) hide whatever is underneath? Thick padding pokes past a garment's bulk_threshold.
 const bulk=num(p.panties_bulk??items[p.equipped_panties]?.bulk);
 if(!p.equipped_pants){
  const torso=items[p.equipped_torso];
  if(torso?.category==='dress')return torso.bulk_threshold===undefined?true:bulk<torso.bulk_threshold; // A dress covers too.
  return false; // No pants, no dress: on show for the whole street.
 }
 const pants=items[p.equipped_pants];
 if(!pants?.conceals_panties)return false; // Ultra-short skirts and chaps hide nothing.
 return pants.bulk_threshold===undefined?true:bulk<pants.bulk_threshold;
}

export function outfitLook(loadout,items){ // Everything the bigs and the gods care about, in one reading.
 const p=loadout?.player_info??{},worn=wornItems(p,items);let total=0,count=0;
 for(const {item} of worn)if(item&&Number.isFinite(item.childish)){total+=item.childish;count++;}
 const panties=items[p.equipped_panties],padded=panties?.is_diaper===true;
 const hidden=!p.equipped_panties||bottomHidden(p,items),showing=padded&&!hidden; // Mirrors are_panties_concealed(): nothing underneath counts as concealed.
 const soiled=num(p.had_wet_accident)>0||num(p.had_tum_accident)>0; // Wet or messy clothes are plain to see.
 const used=soiled||(showing&&(p.slot_wet_panties===true||num(p.diaper_wet_absorbed)>0||num(p.diaper_tum_absorbed)>0)); // A soggy diaper only counts when it shows.
 return {
  childish:count?total/count:0,padded,showing,used,
  bottomHidden:bottomHidden(p,items), // pants or a dress actually cover the underwear layer
  chestCovered:!!p.equipped_torso, // a top or a dress
  chestBare:!p.equipped_torso&&!p.equipped_bra,
  worn, // [{slot,id,item}] for per-garment rules
  incontinence:num(p.incontinence)
 };
}

export function cursedWorn(loadout,items){ // Any equipped piece that is cursed (Orin's followers suffer while locked in).
 return wornItems(loadout?.player_info??{},items).some(({item})=>item?.cursed===true);
}
