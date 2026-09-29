import {companionSource,equipmentSlot,equipmentLocked,equippedItem} from './companion-equipment.mjs';
import {readFileSync} from 'node:fs';
import {inspectionProjection} from './inspection.mjs';
import {withGenerated} from './generated-items.mjs';
import {hubData} from './hubs.mjs';
import {currentTuning} from './combat.mjs';
import {rarityConfig} from './loot.mjs';
import {consumable,isDrink,hungerRestore,thirstRestore,wetTargetGain,tumTargetGain,manaScale} from './companion-consume.mjs';
const catalog=JSON.parse(readFileSync(new URL('./companion-items.json',import.meta.url),'utf8'));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const label=(value,max=96)=>typeof value==='string'?value.slice(0,max):'';
const numeric=['playerHealth','playerHealthMax','str','def','dex','int','cha','level','xp','stat_points','stamina','hunger','thirst','wet','tum','shame','excitement','smell','accidents','incontinence','freeze','grossout_chance','panties_bulk','accident_bulk','diaper_wet_absorbed','diaper_tum_absorbed'];
const STAT_LABELS={atk:'ATK',def:'DEF',dex:'DEX',int:'INT',cha:'CHA',str:'STR',hp_regen:'HP Regen',wet_resist:'Wet Resist',tum_resist:'Tum Resist',bulk:'Bulk',bulk_threshold:'Bulk Threshold',childish:'Childish',
 atk_mod:'ATK Mod',def_mod:'DEF Mod',dex_mod:'DEX Mod',int_mod:'INT Mod',cha_mod:'CHA Mod',hp_max_mod:'Max HP',shame_delta:'Dignity',atk_min:'ATK min',atk_max:'ATK max'}; // loot_stat_label() wording.
const signed=value=>(value>=0?'+':'')+value;
const pct=value=>Math.round(Math.abs(value)*100/1000); // _consumable_effect_inco_percent: 1000 internal points = 100%.
function itemDetails(item,ctx){ // The game's item card for the companion modal: inv_item_stat_lines + inv_brew_lines + inv_item_online_effect_lines (scrInventory.gml / scrAlchemy.gml).
 const n=key=>typeof item[key]==='number'&&Number.isFinite(item[key])?item[key]:0,stats=[],effects=[],affixes=[],flags=[];
 const loot=item.loot&&typeof item.loot==='object'?item.loot:null,tier=String(loot?.rarity??item.rarity??'common');
 for(const record of loot?[loot.prefix,loot.suffix,...(Array.isArray(loot.bonus)?loot.bonus:[])]:[])if(record&&typeof record==='object'){ // "Crinkly: Wet Resist +1, Childish +2"
  const parts=Object.entries(record.stats??{}).filter(([,v])=>typeof v==='number').map(([k,v])=>(STAT_LABELS[k]??k)+' '+signed(v));
  affixes.push({label:label(String(record.adjective??record.title??record.id??'?'),48),text:parts.join(', ')});
 }
 const brewed=item.brewed&&typeof item.brewed==='object'?item.brewed:null;
 if(brewed){ // inv_brew_lines: brewed potions are never a mystery.
  stats.push(['Brewed',label(String(brewed.rarity??''),24)+', potency '+(Number(brewed.potency)||0)/10]);
  if(n('wet_relief')>0)stats.push(['Relief','WET -'+n('wet_relief')]);if(n('tum_relief')>0)stats.push(['Relief','TUM -'+n('tum_relief')]);if(n('stamina_drain')>0)stats.push(['Stamina','-'+n('stamina_drain')]);
 }
 if(n('atk'))stats.push(['ATK','+'+n('atk')]);if(n('def'))stats.push(['DEF','+'+n('def')]);if(n('hp_regen'))stats.push(['HP Regen','+'+n('hp_regen')+'/turn']);
 if(n('hp_restore'))stats.push(['HP Restore',n('hp_restore')===-1?'FULL':n('hp_restore')===-2?'HALF':'+'+n('hp_restore')]);
 if(consumable(item)){ // Effective amounts, tier floors included (survival_item_*).
  const hunger=hungerRestore(item),thirst=thirstRestore(item),wetLater=wetTargetGain(item),tumLater=tumTargetGain(item);
  if(hunger>0)stats.push(['Hunger','+'+hunger]);if(thirst>0)stats.push(['Thirst','+'+thirst]);
  if(n('wet_instant')>0)stats.push(['Wet Now','+'+n('wet_instant')]);if(n('tum_instant')>0&&!ctx.wetOnly)stats.push(['Tum Now','+'+n('tum_instant')]);
  if(wetLater>0)stats.push(['Wet Later','+'+wetLater]);if(tumLater>0&&!ctx.wetOnly)stats.push(['Tum Later','+'+tumLater]);
 }
 if(n('tum_resist'))stats.push(['Tum Resist','+'+n('tum_resist')]);if(n('bulk'))stats.push(['Bulk',String(n('bulk'))]);if(n('childish'))stats.push(['Childish',n('childish')+'/10']);
 if(typeof item.value==='number')stats.push(['Value',item.value+'g']);
 for(const key of ['atk_mod','def_mod','dex_mod','int_mod','cha_mod','hp_max_mod'])if(n(key))stats.push([STAT_LABELS[key],signed(n(key))]);
 if(n('stamina_restore'))stats.push(['Stamina',n('stamina_restore')===-1?'FULL':'+'+n('stamina_restore')]);
 if(n('mp_restore'))stats.push(['MP Restore',n('mp_restore')===-1?'FULL':'+'+Math.floor(n('mp_restore')*manaScale(ctx.tuning,ctx.mpMax))]); // Scaled to this character's MP bar, as drinking it will be.
 if(item.is_diaper===true)flags.push('Diaper');if(item.cursed===true)flags.push('Cursed');if(item.blessed===true)flags.push('Blessed');
 if(Array.isArray(item.magical_effects)&&item.magical_effects.length&&item.cursed!==true&&item.blessed!==true)flags.push('Enchanted');
 if(item.enchantment&&typeof item.enchantment==='object')flags.push(label(String(item.enchantment.name??item.enchantment.id??''),48));
 if(consumable(item)){ // Online cards spell out what a potion or drink really does (inv_item_online_effect_lines).
  const turns=n('continence_turns');
  if(typeof item.continence_set==='number'&&item.continence_set>=0)effects.push('Control: '+(100-item.continence_set/10)+'%'+(turns>0?' for '+turns+' turns':''));
  if(n('continence_delta')&&turns<=0)effects.push('Control: '+(n('continence_delta')<0?'+':'-')+pct(n('continence_delta'))+' pts permanent');
  if(n('inco_gain'))effects.push('Control: '+(n('inco_gain')<0?'+':'-')+pct(n('inco_gain'))+' pts now');
  if(item.grossout_reset===true)effects.push('Cleans up any accident');
  if(n('shame_delta'))effects.push('Dignity: '+signed(n('shame_delta'))+(n('shame_delta')<0?' (more when you feel ashamed)':''));
  if(n('pressure_turns')>0&&n('wet_per_turn')>0)effects.push('Wet: +'+n('wet_per_turn')+'/turn for '+n('pressure_turns')+' turns');
  const e=item.active_effect&&typeof item.active_effect==='object'?item.active_effect:null;
  if(e){ // Mystery potion delayed effects, same fields the game's effect runner reads.
   const start=Number(e.turns_until_start)||0,dur=Number(e.duration_remaining)||0,set=typeof e.inco_set==='number'?e.inco_set:-1;
   effects.push('Delayed effect: '+(start>0?'in '+start+' turns':'right away')+(dur>1?', lasts '+dur+' turns':''));
   if(set>=0)effects.push('Control drops to '+(100-Math.round(set/10))+'%, then recovers');
   if(Number(e.inco_delta))effects.push('Control: '+(e.inco_delta<0?'+':'-')+pct(e.inco_delta)+' pts permanent');
   if(e.wet_force===true)effects.push('Forces wet pressure to the limit');if(e.tum_force===true)effects.push('Forces tum pressure to the limit');
   if(e.wet_force!==true&&Number(e.wet_per_turn)>0)effects.push('Wet: +'+e.wet_per_turn+'/turn');if(e.tum_force!==true&&Number(e.tum_per_turn)>0)effects.push('Tum: +'+e.tum_per_turn+'/turn');
   if(e.grossout_reset===true)effects.push('Cleans up any accident');
  }
 }
 return {desc:label(String(item.desc??''),600),rarity:tier,colour:rarityConfig(ctx.tuning,tier).colour,ilvl:loot?.rolled===true?Number(loot.ilvl)||1:null,
  title:loot?.title?label(String(loot.title),64):'',affixes,stats:stats.map(([name,value])=>({label:name,value:String(value)})),effects,flags,
  sell:Number.isSafeInteger(item.online_sell_price)?item.online_sell_price:0};
}
function itemView(item,index,ctx={tuning:currentTuning(),mpMax:0,wetOnly:false}){
 const items=withGenerated(catalog),id=label(item?.item_id,80),full={...items[id],...withGenerated(hubData.equipment)[id],...item},base=items[id]??{},out={index,item_id:id,name:label(item?.name)||base.name||id||'Unknown item',category:label(item?.category,32)||base.category||'item'};
 for(const key of ['atk','def','bulk','bulk_threshold','childish','hp_restore','mp_restore','count','quantity']){
  const value=item?.[key]??base[key];if(finite(value))out[key]=Math.max(-1000000,Math.min(1000000,value));
 }
 out.cursed=item?.cursed===true||base.cursed===true;
 if(item?.is_drink===true||base.is_drink===true)out.is_drink=true; // Bottled "food" belongs on the Drinks tab; without this flag the companion would file it under Food.
 if(consumable(full)){out.consumable=true;out.use_label=isDrink(full)?'Drink':'Eat';} // Eat/Drink button in the row and the modal.
 out.details=itemDetails(full,ctx); // Everything the item detail modal shows.
 return out;
} // Preserve individual rolled items without exporting arbitrary nested inventory payloads.

export function companionSheet(db,c,p){
 const items=withGenerated(catalog); // Rolled gear keeps its generated id; resolve it like any catalog item.
 const state=JSON.parse(c.state),selected=companionSource(db,c,p),{loadout,source,updatedAt}=selected;
 const info=loadout?.player_info??{},sheet=inspectionProjection({...c,state:JSON.stringify({...state,loadout:{player_info:info}})});
 sheet.available=Boolean(loadout);sheet.source=source;sheet.updatedAt=updatedAt;sheet.online=Boolean(p);sheet.equipment_version=selected.version;sheet.equipmentEditable=Boolean(loadout)&&!state.run&&!state.worldTurnDue&&!state.pendingPurchase;
 for(const key of numeric)if(finite(info[key]))sheet.player_info[key]=Math.max(-1000000,Math.min(1000000,info[key]));
 for(const key of ['player_mp','player_mp_max','childish'])if(finite(loadout?.[key]))sheet[key]=loadout[key];
 if(state.run){sheet.player_info.playerHealth=state.run.hp;sheet.player_info.playerHealthMax=state.run.maxHp;}
 const ctx={tuning:currentTuning(),mpMax:Number(loadout?.player_mp_max)||0,wetOnly:selected.wetOnly===true}; // Card numbers scale to this character, as using the item will.
 sheet.inventory=(Array.isArray(loadout?.inventory)?loadout.inventory:[]).slice(0,512).map((item,index)=>({...itemView(item,index,ctx),equippable:Boolean(equipmentSlot({...items[item.item_id],...item},info))}));
 sheet.equipment=sheet.equipment.map(slot=>({...slot,...(slot.item_id?{item:itemView(equippedItem(info,slot.slot,items),0,ctx),locked:equipmentLocked(info,equippedItem(info,slot.slot,items))}:{})}));
 const use=state.companionUse;if(use)sheet.last_use={at:use.at,item_id:label(use.item_id,80),lines:(Array.isArray(use.lines)?use.lines:[]).slice(0,12).map(line=>label(line,300))}; // What the last companion meal did; the page shows it right after an Eat/Drink.
 const underwear=items[info.equipped_panties]??{},wet=Math.max(0,Number(info.diaper_wet_absorbed)||0),mess=Math.max(0,Number(info.diaper_tum_absorbed)||0);
 sheet.tush={item_id:label(info.equipped_panties,80),name:underwear.name??'No undergarment',is_diaper:underwear.is_diaper===true,
  status:!info.equipped_panties?'No undergarment':underwear.is_diaper?(wet&&mess?'Very Used':mess?'Messy':wet?'Damp':'Clean'):(info.slot_wet_panties?'Wet':'Clean'),
  wet_absorbed:wet,mess_absorbed:mess,capacity:Math.max(1,Number(underwear.bulk)||1),bulk:Math.max(0,Number(info.panties_bulk)||0)};
 return sheet;
} // Called only after ownership validation for view=companion; public player inspection stays unchanged.
