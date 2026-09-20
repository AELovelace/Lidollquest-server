import {combatData} from './combat.mjs';
import {changeEquipment} from './companion-equipment.mjs';
import {hubData} from './hubs.mjs';

const catalog={...hubData.equipment,...combatData.defeat_items};
const defeats=new Set(['defeat','submit','submitted','charm_backfire']);

export function applyDefeatEquipment(state,run,outcome){
 if(!['dive','hub_event'].includes(run.kind)||!defeats.has(outcome)||!state.loadout||state.defeatEquipmentReceipt===run.id)return;
 const enemy=run.enemy.enemy_id,kit=run.enemy.defeat_equipment??combatData.defeat_equipment?.[enemy]??(run.enemy.defeat&&!run.enemy.defeat_inherited?{first:[],repeat:[]}:null);
 if(!kit)return; // Arena templates and enemies with no authored outfit do not invent equipment rewards.
 const p=state.loadout.player_info,timers=p.enemy_loss_effect_turns??{};
 const worn=Object.entries(p).filter(([key,value])=>key.startsWith('equipped_')&&typeof value==='string').map(([,value])=>value);
 const repeat=!!(run.enemy.defeat&&!run.enemy.defeat_inherited&&state.worldDefeats?.[enemy])||kit.repeat.some(id=>worn.includes(id))||(timers[enemy]??0)>0||(['goblin','goblin_brute'].includes(enemy)&&Math.max(timers.goblin??0,timers.goblin_brute??0)>0);
 const changes=[];
 for(const id of repeat?kit.repeat:kit.first){
  if(!catalog[id]){changes.push({item:id,equipped:false,reason:'Item is unavailable.'});run.log.push('Outfit piece unavailable: '+id+'.');continue;} // A retired item ID cannot suppress the remaining authored kit.
  try{
   state.loadout=changeEquipment(state.loadout,{action:'defeat_equip',item_id:id},catalog,hubData.config.inventory_capacity);
   if(catalog[id].is_diaper)state.loadout.player_info.online_change_seq=(state.loadout.player_info.online_change_seq??0)+1;
   changes.push({item:id,equipped:true});run.log.push('Forced outfit change: '+catalog[id].name+'.');
  }catch(error){
   if(error.code!=='equipment_conflict')throw error;
   changes.push({item:id,equipped:false,reason:error.message});run.log.push('Outfit change blocked: '+error.message);
  } // A locked slot or full bag skips that piece without losing the old gear or blocking battle settlement.
 }
 const next=state.loadout.player_info;
 next.enemy_loss_effect_turns={...timers,[enemy]:Math.max(timers[enemy]??0,repeat?28:18)};
 next.enemy_loss_last_variant={...next.enemy_loss_last_variant,[enemy]:repeat?'repeat':'first'};
 if(run.enemy.defeat)state.worldDefeats={...state.worldDefeats,[enemy]:true};
 state.defeatEquipmentReceipt=run.id; // Durable per-character receipt prevents polling/reconnect from duplicating equipment or bonuses.
 return {enemy,variant:repeat?'repeat':'first',changes};
}
