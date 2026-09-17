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
 out.cursed=item?.cursed===true||base.cursed===true;return out;
} // Preserve individual rolled items without exporting arbitrary nested inventory payloads.

export function companionSheet(db,c,p){
 const state=JSON.parse(c.state);let loadout=state.loadout,source=loadout?'online':null,updatedAt=p?.seen??null;
 if(!p&&!state.run&&!state.worldTurnDue&&!state.dive&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quest_cloud_versions'").get()){
  const saved=db.prepare(`SELECT revision,created,json_extract(CAST(data AS TEXT),'$.online_revision') AS online_revision,
   json_object('player_info',json_extract(CAST(data AS TEXT),'$.player_info'),'inventory',json_extract(CAST(data AS TEXT),'$.inventory'),
   'player_mp',json_extract(CAST(data AS TEXT),'$.player_mp'),'player_mp_max',json_extract(CAST(data AS TEXT),'$.player_mp_max'),
   'childish',json_extract(CAST(data AS TEXT),'$.childish')) AS loadout
   FROM quest_cloud_versions WHERE character_id=? AND owner=? ORDER BY revision DESC LIMIT 1`).get(c.id,c.owner);
  if(saved&&(!loadout||saved.online_revision>=(state.loadoutRevision??c.revision))){loadout=JSON.parse(saved.loadout);source='cloud';updatedAt=saved.created;}
 } // Prefer active gameplay; only a cloud save at least as current as committed online inventory may replace its preview.
 const info=loadout?.player_info??{},sheet=inspectionProjection({...c,state:JSON.stringify({...state,loadout:{player_info:info}})});
 sheet.available=Boolean(loadout);sheet.source=source;sheet.updatedAt=updatedAt;sheet.online=Boolean(p);
 for(const key of numeric)if(finite(info[key]))sheet.player_info[key]=Math.max(-1000000,Math.min(1000000,info[key]));
 for(const key of ['player_mp','player_mp_max','childish'])if(finite(loadout?.[key]))sheet[key]=loadout[key];
 if(state.run){sheet.player_info.playerHealth=state.run.hp;sheet.player_info.playerHealthMax=state.run.maxHp;}
 sheet.inventory=(Array.isArray(loadout?.inventory)?loadout.inventory:[]).slice(0,512).map(itemView);
 sheet.equipment=sheet.equipment.map(slot=>({...slot,...(slot.item_id?{item:itemView({item_id:slot.item_id},0)}:{})}));
 const underwear=items[info.equipped_panties]??{},wet=Math.max(0,Number(info.diaper_wet_absorbed)||0),mess=Math.max(0,Number(info.diaper_tum_absorbed)||0);
 sheet.tush={item_id:label(info.equipped_panties,80),name:underwear.name??'No undergarment',is_diaper:underwear.is_diaper===true,
  status:!info.equipped_panties?'No undergarment':underwear.is_diaper?(wet&&mess?'Very Used':mess?'Messy':wet?'Damp':'Clean'):(info.slot_wet_panties?'Wet':'Clean'),
  wet_absorbed:wet,mess_absorbed:mess,capacity:Math.max(1,Number(underwear.bulk)||1),bulk:Math.max(0,Number(info.panties_bulk)||0)};
 return sheet;
} // Called only after ownership validation for view=companion; public player inspection stays unchanged.
