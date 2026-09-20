import {isCrawling,syncCrawl,standBlockReason,setCrawling} from './crawl.mjs';
import {readFileSync} from 'node:fs';
import {applyRunLoadout,syncRunHealth} from './loadout.mjs';
import {mageBalance,hasAbility,manaCapacity,refreshMana} from './magic-balance.mjs';
import {resolvedDefeat} from './defeat-scenes.mjs';

export const combatData=JSON.parse(readFileSync(new URL('./combat-data.json',import.meta.url),'utf8'));
const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const num=(n,d=0)=>Number.isFinite(n)?n:d;
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'combat_action_failed'});};
const playerTypes=new Set(['heal','cure','buff','offense','debuff']);
export const playerSpells=Object.keys(combatData.spells).filter(id=>!combatData.spells[id].enemy_only&&playerTypes.has(combatData.spells[id].type));

export function defeatPresentation(run,outcome){ // Preserve the settled opponent before the run is discarded; polling/retries keep one stable scene ID.
 if(!['defeat','charm_backfire','submit','submitted'].includes(outcome))return {};
 return {defeatScene:{id:run.id,enemy_id:['dive','hub_event'].includes(run.kind)?(run.enemy.enemy_id??''):'',name:run.enemy.name,...(run.enemy.defeat?{content:resolvedDefeat(run.enemy.defeat,run.id,outcome)}:{})}};
} // Arena templates have no campaign identity; never mislabel their placeholder goblin stats as authored goblin scenes.

export function classId(loadout){return ['fighter','mage','diplomat'].includes(loadout.player_info.class_id)?loadout.player_info.class_id:'fighter';} // Older saves without a class retain the original fighter actions.
export function mageScaling(loadout){ // Match scrSpellSystem's childish/shame affinity and absorbed-protection bonus.
 const p=loadout.player_info,mage=classId(loadout)==='mage';
 const affinity=mage?0.3*clamp(num(loadout.childish)/10,0,1)+0.3*clamp(1-num(p.shame,1024)/1024,0,1):0;
 const practice=hasAbility(loadout,'arcane_practice')?1.1:1,magicBase=mage?mageBalance.magic:1;
 return {magic:magicBase*(1+affinity)*practice,physical:(mage?mageBalance.physical*Math.max(0.4,1-affinity):1)*(hasAbility(loadout,'sure_strike')?1.1:1),flat:mage?Math.floor((Math.max(0,num(p.diaper_wet_absorbed))+Math.max(0,num(p.diaper_tum_absorbed)))*magicBase*practice):0}; // The base magic boost also multiplies absorbed fullness; affinity keeps its existing shape.
}

export function beginRound(state,z,roll,authoredEnemy=null){ // Arena rounds and authored dungeon encounters share turn/effect initialization.
 syncCrawl(state.loadout); // A crawling entrant retains the normal first player action.
 const r=state.run;r.combatVersion=2;r.turn=(r.turn??0)+1;r.turnReady=false;r.buffs=[];r.debuffs=[];r.dots=[];
 r.charmFailures=0;r.charmLimit=1+roll(5);r.charmPressure=0;
 Object.assign(r.enemy,authoredEnemy??{str:z.attack+r.stage+1,def:Math.floor((r.stage-1)/2),exp:r.stage*5,enemy_id:'goblin',enemy_spells:r.stage>=3?[z.theme==='clockwork'?'assessment_scan':'haunting_urge']:[],spell_cast_chance:0.35});
 applyRunLoadout(r,state.loadout);
}

export function clearEffects(state){ // Remove temporary player modifiers on every victory, escape, submission and defeat.
 const r=state.run,p=state.loadout.player_info;
 for(const b of r.buffs??[]){p[b.stat_key]=Math.max(0,num(p[b.stat_key])-b.amount);if(b.stat_key==='int')refreshIntMana(state.loadout);}
 r.buffs=[];r.debuffs=[];r.dots=[];
}

function tick(effects,expire){ // Timers advance on resolved turns, never polling, menu navigation or retries.
 for(let i=effects.length-1;i>=0;i--)if(--effects[i].turns_left<=0){expire(effects[i]);effects.splice(i,1);}
}
function refreshIntMana(loadout){loadout.player_mp_max=manaCapacity(loadout);refreshMana(loadout);} // Temporary INT alters capacity for every class without restoring MP.
function addBuff(r,p,spell,amount){ // Preserve the actual clamped change so a debuff cannot inflate stats when it expires.
 const key=spell.stat_effect,before=num(p[key]);p[key]=spell.enemy_only?Math.max(0,before+amount):before+amount;
 r.buffs.push({spell_id:spell.spell_id,stat_key:key,amount:p[key]-before,turns_left:spell.dot_turns});
}
function statEffect(p,key,amount){
 const cap={wet:100,tum:100,shame:1024,excitement:9999,incontinence:1000,stamina:num(p.stamina_max,100)};
 if(Object.hasOwn(cap,key))p[key]=clamp(num(p[key])+amount,0,cap[key]);
}

export function readyTurn(state,forfeit,z,roll){ // The shared game routine supplies trusted accident/status changes; only the server advances combat.
 const r=state.run;if(r.phase!=='fight'||r.turnReady)fail('This turn is already prepared.');
 r.turnReady=true;
 tick(r.buffs,b=>{state.loadout.player_info[b.stat_key]=Math.max(0,num(state.loadout.player_info[b.stat_key])-b.amount);if(b.stat_key==='int')refreshIntMana(state.loadout);r.log.push(b.spell_id+' expired.');});
 applyRunLoadout(r,state.loadout);
 if(forfeit){r.log=['Too distracted to act.'];return finishTurn(state,z,roll);}
 return 'ready';
}

function cast(state,id,target=state){ // Support spells use the caster's scaling and MP while applying effects to the selected ally.
 const r=state.run,l=state.loadout,p=l.player_info,s=combatData.spells[id];
 if(classId(l)==='diplomat'||!playerSpells.includes(id)||!l.player_spells.includes(id))fail('Choose a learned player spell.');
 if(l.player_mp<s.mp_cost)fail('Not enough MP.');
 l.player_mp-=s.mp_cost;const intelligence=p.int,m=mageScaling(l);r.log.push('You cast '+s.name+'.');
 if(s.type==='heal'){const n=Math.floor((s.power+intelligence*2)*m.magic)+m.flat;target.run.hp=clamp(target.run.hp+n,0,target.run.maxHp);r.log.push('Restored '+n+' HP.');}
 if(s.type==='cure'){const n=Math.abs(s.stat_amount)+Math.floor(intelligence*1.5);statEffect(target.loadout.player_info,s.stat_effect,s.stat_effect==='stamina'?n:-n);}
 if(s.type==='buff'){addBuff(target.run,target.loadout.player_info,s,s.stat_amount+Math.floor(intelligence/3));if(s.stat_effect==='int')refreshIntMana(target.loadout);}
 if(s.type==='offense'){
  const n=Math.max(1,Math.floor((s.power+intelligence*3)*m.magic)+m.flat-r.enemy.def);r.enemy.hp=Math.max(0,r.enemy.hp-n);r.log.push(r.enemy.name+' takes '+n+' damage.');
  if(s.dot_turns>0&&s.dot_damage>0)r.dots.push({spell_id:id,damage:Math.floor((s.dot_damage+Math.floor(intelligence/2))*m.magic)+m.flat,turns_left:s.dot_turns});
 }
 if(s.type==='debuff'){
  const key=s.stat_effect,before=r.enemy[key];r.enemy[key]=Math.max(0,before+s.stat_amount-Math.floor(intelligence/4));
  r.debuffs.push({spell_id:id,stat_key:key,amount:r.enemy[key]-before,turns_left:s.dot_turns});
 }
 syncRunHealth(state,r);
 if(target!==state)syncRunHealth(target,target.run);
}

function charm(state,action,roll){
 const r=state.run,l=state.loadout,p=l.player_info,diplomat=classId(l)==='diplomat',cute=num(l.childish),shame=num(p.shame,1024);
 if(action==='allure'&&!diplomat)fail('Allure is a diplomat skill.');
 const profile=combatData.charms[r.enemy.enemy_id]??{},pref=profile.cute_preference;
 const bonus=(shame>=683?0:shame>=342?1:2)+(cute>=7?2:cute>=4?1:0)+((pref==='high'&&cute>=7)||(pref==='low'&&cute<=3)?2:0);
 const total=1+roll(20)+p.cha+bonus+(action==='allure'?Math.floor(p.int/2)+1:0)+(hasAbility(l,'silver_tongue')?2:0);
 const dc=(profile.dc_override??clamp(8+Math.floor((r.enemy.maxHp+r.enemy.str+r.enemy.def)/10),10,22))+(diplomat?3+2*r.charmPressure:0)+(p.level<=3?4:p.level<=6?2:p.level<=9?1:0);
 r.log.push((action==='allure'?'Allure':'Charm')+' roll '+total+' vs DC '+dc+'.');
 if(total>=dc){r.enemy.hp=0;r.log.push(profile.success_log??r.enemy.name+' is charmed and leaves the fight.');return 'win';}
 r.log.push(r.enemy.name+' resists.');
 if(diplomat)r.charmPressure++;
 else if(++r.charmFailures>=r.charmLimit){r.log.push('Your failed charm backfires.');return 'charm_backfire';}
 return 'continue';
}

function enemySpell(state,s){ // Enemy spell effects share the player's serialized modifier timers.
 const r=state.run,p=state.loadout.player_info,defense=p.def-r.handicaps.filter(h=>h==='Reduced armor').length;r.log.push(r.enemy.name+' casts '+s.name+'.');
 if(s.type==='enemy_stat'&&s.stat_effect==='crawling'){if(s.stat_amount>0){setCrawling(state.loadout,true);r.log.push('Knocked down! Physical damage -25%; Stand Up costs one action.');}}
 else if(s.type==='enemy_stat')statEffect(p,s.stat_effect,s.stat_amount);
 if(s.type==='enemy_damage')r.hp=Math.max(0,r.hp-Math.max(1,s.power-defense));
 if(s.type==='enemy_debuff')addBuff(r,p,s,s.stat_amount);
 if(s.type==='enemy_combo')for(const e of s.combo_effects??[]){
  if(e.type==='damage')r.hp=Math.max(0,r.hp-Math.max(1,e.power-defense));
  else if(e.type==='debuff')addBuff(r,p,{...s,stat_effect:e.stat,dot_turns:e.turns},e.amount);
  else if(e.type==='crawling'&&e.amount>0){setCrawling(state.loadout,true);r.log.push('Knocked down! Stand Up costs one action.');}
  else statEffect(p,e.type,e.amount);
 }
}

export function enemyAction(state,z,roll){ // One enemy acts independently in shared Dives; legacy rounds call the same authored attack routine.
 syncCrawl(state.loadout);
 const r=state.run;r.enemy.turn++;
 const spells=(r.enemy.enemy_spells??[]).filter(id=>combatData.spells[id]?.enemy_only);
 if(spells.length&&roll(10000)<r.enemy.spell_cast_chance*10000)enemySpell(state,combatData.spells[spells[roll(spells.length)]]);
 else{let hit=Math.max(1,r.enemy.str-1);if(z.theme==='clockwork'&&r.enemy.turn%3===0)hit+=5;r.hp=Math.max(0,r.hp-hit);r.log.push(r.enemy.name+' dealt '+hit+' damage.');}
 syncRunHealth(state,r);
 return r.hp<=0?'defeat':'continue';
}

export function tickEnemyEffects(r){ // Enemy DOTs and debuffs advance on that enemy's own action cycle.
 for(const dot of r.dots){r.enemy.hp=Math.max(0,r.enemy.hp-dot.damage);r.log.push(r.enemy.name+' takes '+dot.damage+' ongoing damage.');}
 tick(r.dots,()=>{});tick(r.debuffs,d=>{r.enemy[d.stat_key]-=d.amount;});
}

export function finishTurn(state,z,roll){ // Resolve DOTs, enemy debuffs, one enemy response and the next turn atomically.
 const r=state.run;
 if(r.enemy.hp<=0)return 'win';
 for(const dot of r.dots){r.enemy.hp=Math.max(0,r.enemy.hp-dot.damage);r.log.push(r.enemy.name+' takes '+dot.damage+' ongoing damage.');}
 tick(r.dots,()=>{});tick(r.debuffs,d=>{r.enemy[d.stat_key]-=d.amount;});
 if(r.enemy.hp<=0)return 'win';
 if(enemyAction(state,z,roll)==='defeat')return 'defeat';
 r.turn++;r.turnReady=false;return 'continue';
}

export function combatAction(state,input,z,roll,supportTarget=state){
 const r=state.run;if(r.phase!=='fight'||!r.turnReady)fail('Wait for the next player turn.');
 r.log=[];
 if(input.action==='attack'){
  if(classId(state.loadout)==='diplomat')fail('Diplomats use Allure.');
  const weakened=r.handicaps.filter(h=>h==='Weakened strikes').length;
  const base=Math.max(1,Math.floor(Math.max(1,state.loadout.player_info.str*2-r.enemy.def)*mageScaling(state.loadout).physical)-weakened);
  const damage=isCrawling(state.loadout)?Math.max(1,Math.floor(base*0.75)):base; // Match campaign rounding and preserve minimum damage.
  r.enemy.hp=Math.max(0,r.enemy.hp-damage);r.log.push('You slap '+r.enemy.name+' for '+damage+' damage.');
 }else if(input.action==='stand'){
  if(!isCrawling(state.loadout))fail('You are already standing.');
  const reason=standBlockReason(state.loadout);if(reason)fail(reason);
  setCrawling(state.loadout,false);r.log.push('You spend your action standing up.');
 }else if(input.action==='cast')cast(state,input.spell,supportTarget);
 else if(['charm','allure'].includes(input.action)){const result=charm(state,input.action,roll);if(result!=='continue')return result;}
 else if(input.action==='use_item')r.log.push('Used campaign inventory.');
 else fail('Choose a class action.');
 return z.activeTime?(r.enemy.hp<=0?'win':'continue'):finishTurn(state,z,roll); // Live gauges schedule the enemy separately.
}

export function awardExperience(state,roll){ // Arena XP follows the campaign level curve; coins still come only from zone settlement.
 const r=state.run,l=state.loadout,p=l.player_info;p.xp+=r.enemy.exp;r.log.push('Gained '+r.enemy.exp+' XP.');
 while(p.xp>=50*p.level){
  p.xp-=50*p.level;p.level++;p.stat_points=num(p.stat_points)+3;p.playerHealthMax++;r.maxHp++;r.hp++;p.shame=clamp(num(p.shame,1024)+15,0,1024);r.log.push('Level '+p.level+'! +3 stat points, +1 maximum HP.');
  if(classId(l)==='mage'){
   state.mageSpellPicks=(state.mageSpellPicks??0)+1;r.log.push('Earned a free spell choice! Open Magic to choose now or save it for later.'); // Server state keeps unspent choices separate from imported campaign stats.
  }
 }
 syncRunHealth(state,r);
}
