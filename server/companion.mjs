import {companionSource,equipmentSlot,equipmentLocked,equippedItem} from './companion-equipment.mjs';
import {readFileSync} from 'node:fs';
import {inspectionProjection} from './inspection.mjs';
const items=JSON.parse(readFileSync(new URL('./companion-items.json',import.meta.url),'utf8'));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const label=(value,max=96)=>typeof value==='string'?value.slice(0,max):'';
const numeric=['playerHealth','playerHealthMax','str','def','dex','int','cha','level','xp','stat_points','stamina','hunger','thirst','wet','tum','shame','excitement','smell','accidents','incontinence','freeze','grossout_chance','panties_bulk','accident_bulk','diaper_wet_absorbed','diaper_tum_absorbed'];
function itemView(item,index){
 const id=label(item?.item_id,80),base=items[id]??{},out={index,item_id:id,name:label(item?.name)||base.name||id||'Unknown item',category:label(item?.category,32)||base.category||'item'};
 for(const key of ['atk','def','bulk','bulk_threshold','childish','hp_restore','mp_restore','count','quantity']){
  const value=item?.[key]??base[key];if(finite(value))out[key]=Math.max(-1000000,Math.min(1000000,value));
 }
 out.cursed=item?.cursed===true||base.cursed===true;
 if(item?.is_drink===true||base.is_drink===true)out.is_drink=true; // Bottled "food" belongs on the Drinks tab; without this flag the companion would file it under Food.
 return out;
} // Preserve individual rolled items without exporting arbitrary nested inventory payloads.

export function companionSheet(db,c,p){
 const state=JSON.parse(c.state),selected=companionSource(db,c,p),{loadout,source,updatedAt}=selected;
 const info=loadout?.player_info??{},sheet=inspectionProjection({...c,state:JSON.stringify({...state,loadout:{player_info:info}})});
 sheet.available=Boolean(loadout);sheet.source=source;sheet.updatedAt=updatedAt;sheet.online=Boolean(p);sheet.equipment_version=selected.version;sheet.equipmentEditable=Boolean(loadout)&&!state.run&&!state.worldTurnDue&&!state.pendingPurchase;
 for(const key of numeric)if(finite(info[key]))sheet.player_info[key]=Math.max(-1000000,Math.min(1000000,info[key]));
 for(const key of ['player_mp','player_mp_max','childish'])if(finite(loadout?.[key]))sheet[key]=loadout[key];
 if(state.run){sheet.player_info.playerHealth=state.run.hp;sheet.player_info.playerHealthMax=state.run.maxHp;}
 sheet.inventory=(Array.isArray(loadout?.inventory)?loadout.inventory:[]).slice(0,512).map((item,index)=>({...itemView(item,index),equippable:Boolean(equipmentSlot({...items[item.item_id],...item},info))}));
 sheet.equipment=sheet.equipment.map(slot=>({...slot,...(slot.item_id?{item:itemView(equippedItem(info,slot.slot,items),0),locked:equipmentLocked(info,equippedItem(info,slot.slot,items))}:{})}));
 const underwear=items[info.equipped_panties]??{},wet=Math.max(0,Number(info.diaper_wet_absorbed)||0),mess=Math.max(0,Number(info.diaper_tum_absorbed)||0);
 sheet.tush={item_id:label(info.equipped_panties,80),name:underwear.name??'No undergarment',is_diaper:underwear.is_diaper===true,
  status:!info.equipped_panties?'No undergarment':underwear.is_diaper?(wet&&mess?'Very Used':mess?'Messy':wet?'Damp':'Clean'):(info.slot_wet_panties?'Wet':'Clean'),
  wet_absorbed:wet,mess_absorbed:mess,capacity:Math.max(1,Number(underwear.bulk)||1),bulk:Math.max(0,Number(info.panties_bulk)||0)};
 return sheet;
} // Called only after ownership validation for view=companion; public player inspection stays unchanged.
