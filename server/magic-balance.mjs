import {readFileSync} from 'node:fs';
const tree=JSON.parse(readFileSync(new URL('./combat-data.json',import.meta.url),'utf8')).magic_tree;
export const mageBalance={physical:tree.mage_physical_multiplier??0.5,magic:tree.mage_magic_multiplier??1.5,mp:tree.mage_mp_multiplier??2};
export const hasAbility=(loadout,id)=>Array.isArray(loadout?.player_info?.rpp_abilities)&&loadout.player_info.rpp_abilities.includes(id);
export function manaCapacity(loadout){
 const p=loadout.player_info;return Math.max(0,Math.floor((10+Number(p.int??0)*5+(hasAbility(loadout,'deep_reserves')?20:0))*(p.class_id==='mage'?mageBalance.mp:1)));
} // Capacity derives from INT and owned abilities; reconnecting never doubles an already doubled value.
export function refreshMana(loadout){
 if(!loadout?.player_info)return;
 if(loadout.player_info.class_id==='mage'||hasAbility(loadout,'deep_reserves'))loadout.player_mp_max=manaCapacity(loadout);
 loadout.player_mp=Math.max(0,Math.min(loadout.player_mp??0,loadout.player_mp_max??0));
} // Keep current MP on migration/purchase instead of creating a free refill.
