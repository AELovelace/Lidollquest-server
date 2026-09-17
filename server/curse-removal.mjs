import {mageScaling} from './combat.mjs';
export const curseSlots=['weapon','head','mouth','torso','pants','panties','socks','shoes','plug','gloves','bra','diaper_cover','special','accessory_1','accessory_2','accessory_3'];
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'hub_conflict'});};
const number=value=>Number.isFinite(value)?value:0;

export function removeCursedGear(loadout,slot,itemId,catalog,capacity){
 const next=structuredClone(loadout),p=next.player_info,item=catalog[itemId];
 if(!curseSlots.includes(slot)||!item?.cursed||p['equipped_'+slot]!==itemId)fail('Choose a currently equipped cursed item.');
 if(slot==='pants'&&item.category==='dress'&&p.equipped_torso===itemId)slot='torso'; // A dress occupies two slots but is one paid removal.
 const dispose=slot==='panties'&&item.is_diaper&&(p.slot_wet_panties||p.diaper_wet_absorbed>0||p.diaper_tum_absorbed>0);
 if(!dispose&&next.inventory.length>=capacity)fail('Inventory full. Make room before removing this item. No coins were charged.');
 for(const [field,stat] of [['atk','str'],['def','def'],['atk_mod','str'],['def_mod','def'],['dex_mod','dex'],['int_mod','int'],['cha_mod','cha'],['wet_resist','wet_resist'],['tum_resist','tum_resist'],['hp_regen','hp_regen']])if(item[field])p[stat]=number(p[stat])-number(item[field]);
 if(item.shame_delta)p.shame=Math.max(0,Math.min(1024,number(p.shame)-item.shame_delta));
 p['equipped_'+slot]='';p['slot_wet_'+slot]=false;
 if(slot==='torso'&&item.category==='dress'&&p.equipped_pants===itemId){p.equipped_pants='';p.slot_wet_pants=false;}
 if(slot==='panties'){
  p.panties_bulk=Math.max(0,number(p.panties_bulk)-number(item.bulk)-number(p.accident_bulk));
  for(const key of ['accident_bulk','had_wet_accident','had_tum_accident','diaper_wet_absorbed','diaper_tum_absorbed','grossout_chance','wet_hold_attempts','tum_hold_attempts'])p[key]=0;
  for(const key of ['panties','socks','shoes'])p['slot_wet_'+key]=false; // Match the existing forced-removal cleanup rules.
 }
 const wet=new Set(['head','torso','pants','panties','socks','shoes'].map(s=>p['slot_wet_'+s]?p['equipped_'+s]:null).filter(id=>id&&!catalog[id]?.is_diaper));
 const penalty=Math.max(0,wet.size-2),delta=penalty-number(p.wet_clothing_penalty);
 for(const key of ['str','def','dex','int','cha'])p[key]=number(p[key])-delta;
 p.wet_clothing_penalty=penalty;
 const worn=[...new Set(curseSlots.filter(s=>s!=='plug').map(s=>p['equipped_'+s]).filter(Boolean))].map(id=>catalog[id]).filter(item=>Number.isFinite(item?.childish));
 next.childish=worn.length?worn.reduce((sum,item)=>sum+item.childish,0)/worn.length:0;
 next.attack=Math.max(1,Math.floor(Math.max(1,p.str*2)*mageScaling(next).physical));
 if(!dispose)next.inventory.push(structuredClone(item)); // The item remains cursed in the bag; this service releases it rather than enchanting it.
 return {loadout:next,dispose,item,slot};
} // Projection runs before reserving payment, so invalid selections and full bags never charge coins.
