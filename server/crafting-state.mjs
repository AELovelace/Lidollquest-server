import {resolveCraftItem} from './crafting.mjs';
import {stackTokens} from './loadout.mjs';

export const craftingStateKeys=['smithing_level','smithing_xp','tailoring_level','tailoring_xp','cooking_level','cooking_xp','alchemy_level','alchemy_xp','crafting_journal','alchemy_journal','meal_buff'];
export function preserveCraftingState(before,after,{consume=false}={}){
 const old=before?.player_info??{},next=after?.player_info;if(!next)return after;
 for(const key of craftingStateKeys){if(old[key]===undefined)delete next[key];else next[key]=structuredClone(old[key]);}
 if(consume){
  const remaining=new Set((after.inventory??[]).flatMap(stackTokens));
  const eaten=(before.inventory??[]).filter(row=>row.item_id?.startsWith('cooked__')&&stackTokens(row).some(token=>!remaining.has(token)));
  if(eaten.length===1){const item=resolveCraftItem(eaten[0].item_id);if(item?.meal_buff)next.meal_buff=structuredClone(item.meal_buff);}
 }
 return after;
} // Client inventory operations cannot overwrite skills; one consumed, previously owned meal may replace the buff.
