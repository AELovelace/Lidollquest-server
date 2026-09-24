import {createHash} from 'node:crypto';
import {gearSlots} from './inspection.mjs';
import {mageScaling} from './combat.mjs';
import {syncCrawl} from './crawl.mjs';
import {importLoadout} from './loadout.mjs';

const fail=message=>{throw Object.assign(Error(message),{status:409,code:'equipment_conflict'});};
const num=value=>Number.isFinite(value)?value:0;
const clamp=(value,max)=>Math.max(0,Math.min(max,value));
export const equipmentSlot=(item,p)=>item.category==='accessory'?(gearSlots.filter(s=>s.startsWith('accessory_')).find(s=>!p['equipped_'+s])??'accessory_1'):
 ({dress:'torso',corset:'torso',skirt:'pants'}[item.category]??(gearSlots.includes(item.category)?item.category:null));
export function equippedItem(p,slot,catalog){
 const id=p['equipped_'+slot],saved=p.equipped_item_data?.[slot];
 return id?{...catalog[id],...(saved?.item_id===id?saved:{}),item_id:id}:null;
} // Keep individual rolled stats and sale identity when the equipped item returns to the bag.
export function equipmentLocked(p,item){
 return item?.cursed===true&&!(item.is_diaper&&num(p.diaper_wet_absorbed)+num(p.diaper_tum_absorbed)>=Math.max(1,num(item.bulk)));
}
export function changeEquipment(loadout,input,catalog,capacity){
 const next=structuredClone(loadout),p=next.player_info,bag=next.inventory;
 p.equipped_item_data??={};
 const forced=input.action==='defeat_equip'; // Internal settlement supplies catalog items; no client equipment command can mint them.
 const carried=forced?catalog[input.item_id]:(input.action==='companion_equip'&&Number.isInteger(input.slot)?bag[input.slot]:null);
 const incoming=carried?{...catalog[carried.item_id],...carried}:null;
 let slot=forced||input.action==='companion_equip'?(incoming&&equipmentSlot(incoming,p)):input.slot;
 if(!gearSlots.includes(slot))fail('Choose wearable equipment.');
 if(incoming&&(incoming.item_id!==input.item_id||!catalog[incoming.item_id]))fail('That carried item changed. Refresh and choose it again.');
 if(input.action==='companion_equip'&&!incoming)fail('Choose an item in your bag.');
 if(!incoming&&p['equipped_'+slot]!==input.item_id)fail('That equipped item changed. Refresh and choose it again.');
 const outgoing=equippedItem(p,slot,catalog);
 if(!incoming&&!outgoing)fail('That slot is empty.');
 if(incoming&&slot==='pants'){
  if(equippedItem(p,'torso',catalog)?.category==='dress')fail('Remove your dress before equipping legwear.');
  if(equippedItem(p,'diaper_cover',catalog)?.is_bloomers)fail('Remove your bloomers before equipping legwear.');
 }
 if(outgoing?.category==='dress')slot='torso';
 const removeSlots=incoming?.category==='dress'?['torso','pants']:[slot];
 const removed=[];
 for(const key of removeSlots){const item=equippedItem(p,key,catalog);if(!item||item.category==='dress'&&key==='pants'&&p.equipped_torso===item.item_id)continue;
  if(forced?item.cursed===true:equipmentLocked(p,item))fail(item.name+' is cursed and cannot be removed.'); // Automatic defeat outfits cannot unlock an existing curse.
  removed.push({slot:key,item,dispose:key==='panties'&&item.is_diaper&&(p.slot_wet_panties||num(p.diaper_wet_absorbed)>0||num(p.diaper_tum_absorbed)>0)});
 }
 if(bag.length-(incoming&&!forced?1:0)+removed.filter(r=>!r.dispose).length>capacity)fail('Inventory full. Make room before changing equipment.');
 function bonuses(item,key,sign){
  const fields=key==='weapon'?[['atk','str']]:key==='mouth'?[['hp_regen','hp_regen']]:key==='plug'?[['tum_resist','tum_resist'],['wet_resist','wet_resist']]:key==='panties'?
   [['wet_resist','wet_resist'],['atk_mod','str'],['def_mod','def'],['dex_mod','dex'],['int_mod','int'],['cha_mod','cha']]:[['def','def']];
  for(const [field,stat] of fields)p[stat]=num(p[stat])+sign*num(item[field]);
  if(key==='plug'||key.startsWith('accessory_'))p.shame=clamp(num(p.shame)+sign*num(item.shame_delta),1024);
 } // Apply the same slot-specific bonuses as campaign inventory use, once per physical item.
 if(incoming&&!forced)bag.splice(input.slot,1); // Forced outfits never consume a pre-existing copy from the player's bag.
 for(const entry of removed){const {item,slot:key,dispose}=entry;bonuses(item,key,-1);
  for(const s of item.category==='dress'?['torso','pants']:[key]){p['equipped_'+s]='';p['slot_wet_'+s]=false;delete p.equipped_item_data[s];}
  if(key==='panties'){
   p.panties_bulk=0;
   if(!incoming&&item.is_diaper){p.wet=0;p.tum=0;}
  }
  if(!dispose)bag.push(item);
 }
 if(incoming){bonuses(incoming,slot,1);
  for(const s of incoming.category==='dress'?['torso','pants']:[slot]){p['equipped_'+s]=incoming.item_id;p.equipped_item_data[s]=structuredClone(incoming);p['slot_wet_'+s]=false;}
  if(slot==='panties')p.panties_bulk=num(incoming.bulk);
 }
 if(slot==='panties'){
  for(const key of ['accident_bulk','had_wet_accident','had_tum_accident','diaper_wet_absorbed','diaper_tum_absorbed','grossout_chance','wet_hold_attempts','tum_hold_attempts'])p[key]=0;
  for(const key of ['panties','socks','shoes'])p['slot_wet_'+key]=false;
 }
 const wet=new Set(['head','torso','pants','panties','socks','shoes'].filter(s=>p['slot_wet_'+s]&&!equippedItem(p,s,catalog)?.is_diaper).map(s=>p['equipped_'+s]).filter(Boolean));
 const penalty=Math.max(0,wet.size-2),delta=penalty-num(p.wet_clothing_penalty);
 for(const key of ['str','def','dex','int','cha'])p[key]=num(p[key])-delta;
 p.wet_clothing_penalty=penalty;
 const worn=gearSlots.filter(s=>s!=='plug'&&!(s==='pants'&&equippedItem(p,s,catalog)?.category==='dress')).map(s=>equippedItem(p,s,catalog)).filter(item=>Number.isFinite(item?.childish));
 next.childish=worn.length?worn.reduce((sum,item)=>sum+item.childish,0)/worn.length:0;
 next.attack=Math.max(1,Math.floor(Math.max(1,p.str*2)*mageScaling(next).physical));syncCrawl(next);
 return next;
} // All checks and edits occur on a copy; the command transaction commits the complete change or nothing.

export function companionSource(db,c,p){
 const state=JSON.parse(c.state);let loadout=state.loadout,source=loadout?'online':null,updatedAt=p?.seen??null,cloud=null;
 if(!p&&!state.run&&!state.worldTurnDue&&!state.dive&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quest_cloud_versions'").get()){
  const row=db.prepare(`SELECT revision,created,json_extract(CAST(data AS TEXT),'$.online_revision') AS online_revision,
   json_object('player_info',json_extract(CAST(data AS TEXT),'$.player_info'),'inventory',json_extract(CAST(data AS TEXT),'$.inventory'),
   'player_mp',json_extract(CAST(data AS TEXT),'$.player_mp'),'player_mp_max',json_extract(CAST(data AS TEXT),'$.player_mp_max'),
   'player_spells',json_extract(CAST(data AS TEXT),'$.player_spells'),'childish',json_extract(CAST(data AS TEXT),'$.childish')) AS loadout
   FROM quest_cloud_versions WHERE character_id=? AND owner=? ORDER BY revision DESC LIMIT 1`).get(c.id,c.owner);
  if(row&&(!loadout||row.online_revision>=(state.loadoutRevision??c.revision))){loadout=JSON.parse(row.loadout);source='cloud';updatedAt=row.created;cloud=row;}
 }
 const version=createHash('sha256').update(JSON.stringify([source,cloud?.revision,c.revision,loadout])).digest('hex');
 return {loadout,source,updatedAt,cloud,version};
} // Read and write use exactly the same source selection; cloud updates also invalidate an open sheet.

export function companionEquipment(db,c,state,p,input,catalog,capacity,now){
 if(state.run)fail('Leave combat before changing equipment.');
 editCompanionLoadout(db,c,state,p,input,now,loadout=>changeEquipment(loadout,input,catalog,capacity));
}
export function editCompanionLoadout(db,c,state,p,input,now,change){ // Apply `change` to whichever loadout the companion sheet shows (online state or latest cloud save) and commit it there.
 const selected=companionSource(db,c,p);
 if(!selected.loadout||input.equipment_version!==selected.version)fail('Your equipment changed. Refresh and choose it again.');
 const next=change(importLoadout(selected.loadout));
 if(selected.cloud){
  const head=db.prepare('SELECT * FROM quest_cloud_heads WHERE character_id=?').get(c.id);
  if(head?.paused)fail('Resume cloud sync in the game before changing saved equipment.');
  if(db.prepare('SELECT 1 FROM quest_cloud_uploads WHERE character_id=?').get(c.id))fail('A game save is uploading. Wait for it to finish and refresh.');
  const row=db.prepare('SELECT data,preview FROM quest_cloud_versions WHERE character_id=? AND revision=?').get(c.id,selected.cloud.revision);
  const save=JSON.parse(Buffer.from(row.data).toString('utf8'));
  save.player_info=next.player_info;save.inventory=next.inventory;save.childish=next.childish;save.online_revision=c.revision+1;
  const data=Buffer.from(JSON.stringify(save)),checksum=createHash('sha1').update(data).digest('hex'),revision=Math.max(head?.revision??0,selected.cloud.revision)+1;
  db.prepare('INSERT INTO quest_cloud_versions VALUES (?,?,?,?,?,?,?,?)').run(c.id,revision,c.owner,'equipment-'+createHash('sha256').update(c.id+input.request_id).digest('hex'),checksum,row.preview,now,data);
  db.prepare('INSERT INTO quest_cloud_heads VALUES (?,?,0) ON CONFLICT(character_id) DO UPDATE SET revision=excluded.revision').run(c.id,revision);
  db.prepare('DELETE FROM quest_cloud_versions WHERE character_id=? AND revision NOT IN (SELECT revision FROM quest_cloud_versions WHERE character_id=? ORDER BY revision DESC LIMIT 3)').run(c.id,c.id);
 } // Preserve the whole campaign and publish a new cloud revision; in-flight uploads cannot overwrite it silently.
 state.loadout=next;
}
