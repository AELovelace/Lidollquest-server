import {combatAction,combatData,currentTuning} from './combat.mjs';
import {mitigate,healScale,rowMeleeDealt} from './scaling.mjs';
import {syncRunHealth} from './loadout.mjs';
import {changeEquipment,equippedItem} from './companion-equipment.mjs';
import {hubData} from './hubs.mjs';
import {loseDignity} from './dignity.mjs';

const dirty=p=>(p.diaper_wet_absorbed??0)+(p.diaper_tum_absorbed??0)+(p.had_wet_accident??0)+(p.had_tum_accident??0)>0;
function cleanProtection(p){
 p.panties_bulk=Math.max(0,(p.panties_bulk??0)-(p.accident_bulk??0));
 for(const key of ['accident_bulk','had_wet_accident','had_tum_accident','diaper_wet_absorbed','diaper_tum_absorbed','diaper_wet_leaked','diaper_tum_leaked','grossout_chance','wet_hold_attempts','tum_hold_attempts'])p[key]=0;
 for(const slot of ['panties','socks','shoes'])p['slot_wet_'+slot]=false;
 const wet=new Set(['head','torso','pants'].filter(slot=>p['slot_wet_'+slot]).map(slot=>p['equipped_'+slot]).filter(Boolean));
 const penalty=Math.max(0,wet.size-2),delta=penalty-(p.wet_clothing_penalty??0);
 for(const key of ['str','def','dex','int','cha'])p[key]=(p[key]??0)-delta;
 p.wet_clothing_penalty=penalty;p.online_change_seq=(p.online_change_seq??0)+1;
} // Mirror the native silent cleanup, including accumulated bulk and wet-clothing penalties.

export function followerAction(row,rows,enemy,z,roll,def){
 const {a,s}=row,r=a.run,p=s.loadout.player_info,owner=rows.find(v=>v.a.id===a.hirer&&v.a.status==='active');
 if(!owner)return;
 const allies=rows.filter(v=>v.a.status==='active'),hurt=[...allies].sort((x,y)=>x.a.run.hp/x.a.run.maxHp-y.a.run.hp/y.a.run.maxHp)[0];
 const spells=s.loadout.player_spells.map(id=>combatData.spells[id]?{...combatData.spells[id],id}:null).filter(spell=>spell&&spell.mp_cost<=s.loadout.player_mp);
 const skill=def.combat.special_skill,type=skill.type,op=owner.s.loadout.player_info;
 const cast=(spell,target=row)=>combatAction(s,{action:'cast',spell:spell.id},z,roll,target.s);
 const heal=(target,n,scaled)=>{target.a.run.hp=Math.min(target.a.run.maxHp,target.a.run.hp+Math.floor(n*(scaled?healScale(currentTuning(),target.a.run.maxHp):1)));syncRunHealth(target.s,target.a.run);r.log.push(skill.name+' restores '+target.a.name+'.');};
 for(const priority of def.online.combat_priorities){
  if(priority==='heal'&&hurt.a.run.hp<hurt.a.run.maxHp*.5){
   if(['emergency_treatment','open_shop'].includes(type)&&owner.a.run.hp<owner.a.run.maxHp*.5){heal(owner,type==='emergency_treatment'?30+Math.floor(p.int*2.5):15+Math.floor(p.int*1.5),type==='open_shop');return;}
   const spell=spells.filter(v=>v.type==='heal').sort((a,b)=>b.power-a.power)[0];if(spell){cast(spell,hurt);return;}
  }
  if(priority==='recovery'){
   if(['purify_padding','matron_change'].includes(type)&&op.equipped_panties&&dirty(op)&&(type!=='matron_change'||equippedItem(op,'panties',hubData.equipment)?.is_diaper)){
    cleanProtection(op);
    if(type==='matron_change'){
     try{if(op.equipped_mouth!=='pacifier')owner.s.loadout=changeEquipment(owner.s.loadout,{action:'defeat_equip',item_id:'pacifier'},{...hubData.equipment,...combatData.defeat_items},hubData.config.inventory_capacity);}catch{/* Cursed gear and full bags retain their normal protections. */}
     loseDignity(owner.s.loadout.player_info,15,currentTuning());
    }r.log.push(skill.name+' cleans '+owner.a.name+'\'s protection.');return;
   }
   const spell=spells.find(v=>v.type==='cure'&&allies.some(t=>v.stat_effect==='stamina'?t.s.loadout.player_info.stamina<t.s.loadout.player_info.stamina_max*.5:(t.s.loadout.player_info[v.stat_effect]??0)>50));
   if(spell){const target=allies.find(t=>spell.stat_effect==='stamina'?t.s.loadout.player_info.stamina<t.s.loadout.player_info.stamina_max*.5:(t.s.loadout.player_info[spell.stat_effect]??0)>50);cast(spell,target);return;}
  }
  if(priority==='buff'){
   const spell=spells.find(v=>v.type==='buff'&&!owner.a.run.buffs.some(b=>b.spell_id===v.id));if(spell){cast(spell,owner);return;}
  }
  if(priority==='offense'){
   if(type==='iron_fist'){const raw=(p.str+15+(def.combat.weapon_bonus??0))*2,damage=mitigate(currentTuning(),raw,enemy.data.def);enemy.data.hp=Math.max(0,enemy.data.hp-damage);r.log.push(skill.name+' deals '+damage+' damage.');return;}
   const spell=spells.filter(v=>v.type==='offense').sort((a,b)=>b.power-a.power)[0];if(spell){cast(spell);return;}
   const debuff=spells.find(v=>v.type==='debuff'&&!enemy.debuffs.some(b=>b.spell_id===v.id));if(debuff){cast(debuff);return;}
  }
  if(priority==='attack'){
   const raw=p.str+(def.combat.weapon_bonus??0)+(def.combat.passive_atk_bonus??0),crit=roll(100)<Math.min(60,p.dex*2)?3:0;
   const damage=mitigate(currentTuning(),Math.floor(raw*rowMeleeDealt(currentTuning(),a.row??'front',false)),enemy.data.def)+crit;enemy.data.hp=Math.max(0,enemy.data.hp-damage);r.log.push(a.name+' strikes '+enemy.data.name+' for '+damage+' damage.');return;
  }
 }
} // Deterministic priorities choose legal actions; language models never control battle state.

export function guardianTarget(target,active,catalog){
 return active.find(v=>v.a.npc&&v.a.hirer===target.a.id&&catalog[v.a.npc].combat.special_skill.type==='cover_low_hp'&&target.a.run.hp/target.a.run.maxHp*100<=catalog[v.a.npc].combat.special_skill.cover_threshold_pct)??target;
} // Elowen intercepts attacks on her low-health hirer while her own actor remains active.
