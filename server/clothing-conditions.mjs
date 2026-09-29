export const clothingSlots=['head','torso','pants','panties','socks','shoes','gloves','bra','diaper_cover','special','accessory_1','accessory_2','accessory_3'];
export function clothingItem(p,slot,catalog={}){return p.equipped_item_data?.[slot]??catalog[p['equipped_'+slot]]??{};} // Generated equipment keeps its own name and category.
export function wetGarments(p,catalog={}){
 const rows=[];
 for(const slot of clothingSlots){const id=p['equipped_'+slot],item=clothingItem(p,slot,catalog);if(!id||!p['slot_wet_'+slot])continue;
  if(slot==='pants'&&id===p.equipped_torso&&item.category==='dress'&&p.slot_wet_torso)continue; // Only a shared dress merges two occupied slots; identical accessories remain separate.
  rows.push({slot,id,item});
 }
 return rows;
}
export function recalculateWetClothing(p,catalog={}){
 const count=wetGarments(p,catalog).filter(r=>!r.item.is_diaper).length,penalty=Math.max(0,count-2),delta=penalty-(Number(p.wet_clothing_penalty)||0);
 for(const key of ['str','def','dex','int','cha'])p[key]=(Number(p[key])||0)-delta;
 p.wet_clothing_penalty=penalty;return penalty;
} // Apply only the delta, so retries and repeated exposure cannot stack the same penalty.
export function exposeClothing(p,slots,catalog={}){
 p.clothing_water??={};
 for(const slot of slots){if(!clothingSlots.includes(slot)||!p['equipped_'+slot])continue;
  const targets=clothingItem(p,slot,catalog).category==='dress'&&['torso','pants'].includes(slot)?['torso','pants']:[slot];
  for(const target of targets){if(!p['slot_wet_'+target])p.clothing_water[target]=p['equipped_'+target];p['slot_wet_'+target]=true;} // Never relabel an already ambiguous/soiled garment as pure seawater.
 }
 recalculateWetClothing(p,catalog);
}
