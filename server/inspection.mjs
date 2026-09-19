import {readFileSync} from 'node:fs';
import {descriptionFields} from './character-description.mjs';
const items=JSON.parse(readFileSync(new URL('./profile-items.json',import.meta.url),'utf8'));
export const gearSlots=['weapon','head','mouth','torso','pants','panties','plug','socks','shoes','gloves','bra','diaper_cover','special','accessory_1','accessory_2','accessory_3'];
export function inspectionProjection(c){
 const state=JSON.parse(c.state),p=state.loadout?.player_info??{},out={};
 const defaults={gender:'Female',face_expression:'cheeky',hair_style:1,hair_color:'Brown',has_breasts:false,nipple_style:0,pubes_style:0,penis_style:0,panties_bulk:0,accident_bulk:0,had_wet_accident:false,had_tum_accident:false,diaper_wet_absorbed:0,diaper_tum_absorbed:0,slot_wet_panties:false};
 for(const [k,d] of Object.entries(defaults)){const v=p[k];out[k]=typeof v===typeof d?(typeof v==='number'?Math.max(0,Math.min(10000,Number.isFinite(v)?v:d)):typeof v==='string'?v.slice(0,40):v):d;}
 const shame=Number(p.shame)||0;out.inspection_embarrassment=shame>=769?0:shame>=513?1:shame>=257?2:0; // Match the campaign face renderer, including its authored lowest-shame fallback.
 const equipment=gearSlots.map(slot=>{const id=typeof p['equipped_'+slot]==='string'&&Object.hasOwn(items,p['equipped_'+slot])?p['equipped_'+slot]:'';out['equipped_'+slot]=id;return {slot,item_id:id,name:id?items[id].name:'(empty)'};});
 return {character_id:c.id,account_id:c.owner,name:c.name,...descriptionFields(state),level:Math.max(1,Math.min(1000000,Number(p.level)||1)),class_id:['fighter','mage','diplomat'].includes(p.class_id)?p.class_id:'fighter',revision:c.revision,player_info:out,equipment};
} // Never serialize raw player_info: it contains inventory metadata, companions and private survival fields.
