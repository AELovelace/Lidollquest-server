// Level scaling: player max HP, enemy HP by turns-to-kill, percentage damage mitigation, healing
// that grows with the HP bar, and the level an encounter fights at. Every number is read from the
// loot tuning block (loot_affixes.json -> /gm Loot tab), so the campaign client (scrLootRoll.gml),
// the Python editor (python/loot_roll.py) and this service all run one set of formulas. Change
// a formula here and mirror it in those two files, exactly as the loot roller does.
import {DEFAULT_TUNING,levelMultiplier} from './loot.mjs';

const num=(value,fallback)=>Number.isFinite(Number(value))&&value!==null&&value!==''&&typeof value!=='boolean'?Number(value):fallback; // Same lenient number reader as loot.mjs.
const get=(tuning,key)=>num(tuning?.[key],DEFAULT_TUNING[key]); // A missing or malformed key falls back to the shipped default, never to zero.
const level=value=>Math.max(1,Math.floor(num(value,1))); // Levels are whole numbers from 1.

export function playerBaseHp(tuning,lv,def){ // hp_base + hp_per_level up to hp_late_from-1, hp_per_level_late after, plus a share of DEF.
 const L=level(lv),late=Math.max(1,Math.floor(get(tuning,'hp_late_from')));
 const early=Math.min(L,late-1),lateLevels=Math.max(0,L-(late-1)); // Levels 1..late-1 grow fast; late.. grow slowly.
 return Math.max(1,Math.floor(get(tuning,'hp_base')+early*get(tuning,'hp_per_level')+lateLevels*get(tuning,'hp_per_level_late')+Math.max(0,num(def,0))*get(tuning,'hp_def_share')));
}
export function playerHpDelta(tuning,fromLevel,toLevel,def){return playerBaseHp(tuning,toLevel,def)-playerBaseHp(tuning,fromLevel,def);} // What one or more level-ups add to the cap; gear and curse bonuses ride along untouched.
export function defHpDelta(tuning,lv,fromDef,toDef){return playerBaseHp(tuning,lv,toDef)-playerBaseHp(tuning,lv,fromDef);} // What allocating DEF adds to the cap (0 or 1 with the default 0.6 share).
export function legacyBaseHp(lv){return 100+(level(lv)-1);} // What the old "+1 per level from 100" rule handed out; a migration subtracts this to find gear/curse bonuses.

export function mitigate(tuning,raw,def){ // damage * k / (k + DEF): DEF never zeroes a hit and never stops mattering at the stat cap.
 const k=Math.max(1,get(tuning,'def_mitigation_k')),d=Math.max(-k/2,num(def,0)); // Negative DEF (curses) raises damage, at most x2.
 return Math.max(1,Math.floor(Math.max(0,num(raw,0))*k/(k+d)));
}
export function expectedPlayerDamage(tuning,lv,enemyDef){ // The damage an average build of this level deals per basic attack.
 const L=level(lv);
 return mitigate(tuning,(get(tuning,'avg_str_base')+get(tuning,'avg_str_per_level')*(L-1))*2,enemyDef);
}
export function enemyHpFor(tuning,baseHp,lv,enemyDef,tier='mob'){ // Turns-to-kill for the tier x expected damage, weighted by the authored HP against the reference so a 25 HP fairy stays weaker than a 35 HP mimic.
 const ttk=get(tuning,tier==='boss'?'enemy_ttk_boss':tier==='elite'?'enemy_ttk_elite':'enemy_ttk_mob');
 const weight=Math.max(0.05,num(baseHp,get(tuning,'enemy_hp_reference')))/Math.max(1,get(tuning,'enemy_hp_reference'));
 return Math.max(1,Math.round(ttk*expectedPlayerDamage(tuning,lv,enemyDef)*weight));
}
export function levelEnemy(tuning,enemy,lv,{elite=false,boss=false}={}){ // Scale one enemy struct in place: str/def/exp by the loot level curve, HP by turns-to-kill. A struct that already carries a level is left alone.
 if(!enemy||typeof enemy!=='object'||Number.isFinite(enemy.level))return enemy;
 const cap=Math.max(1,Math.floor(num(tuning?.level_cap,100)));
 let L=Math.min(cap,level(lv));
 if(elite)L=Math.min(cap,L+Math.max(0,Math.floor(num(tuning?.elite_level_bonus,2)))); // Elites sit a little above the band, as on the client.
 const mult=levelMultiplier(tuning??{},L);
 enemy.authored={hp:num(enemy.maxHp,num(enemy.hp,0)),str:num(enemy.str,0),def:num(enemy.def,0)}; // The designer's numbers survive scaling: charm difficulty and tests read them.
 for(const key of ['str','def','exp'])if(Number.isFinite(enemy[key]))enemy[key]=Math.max(1,Math.round(enemy[key]*mult)); // Same keys and rounding as enemy_level_apply() in scrLootRoll.gml.
 const baseHp=num(enemy.maxHp,num(enemy.hp,get(tuning,'enemy_hp_reference')));
 enemy.maxHp=enemyHpFor(tuning,baseHp,L,enemy.def??0,boss?'boss':elite?'elite':'mob');enemy.hp=enemy.maxHp;
 if(elite)enemy.name='Elite '+(enemy.name??'Enemy');
 enemy.level=L;enemy.elite=elite===true;
 return enemy;
}
export function healScale(tuning,maxHp){return Math.max(1,num(maxHp,0)/Math.max(1,get(tuning,'heal_reference_hp')));} // Flat heals were written for a 100 HP bar; a 300 HP bar heals three times as much from the same spell or snack.
export function routeLevelFor(tuning,route,depth=1){ // Same table the loot roller's routeLevel() reads: authored base + per-floor growth, capped at ilvl_cap.
 const rows=tuning?.route_levels??{},row=rows[route]??rows.default??{base:5,per_floor:2};
 return Math.max(1,Math.min(num(tuning?.ilvl_cap,100),Math.floor(num(row.base,5)+num(row.per_floor,2)*(Math.max(1,depth)-1))));
}
export function encounterLevel(tuning,bandLevel,partyLevels=[]){ // The floor's band, kept within party_level_slack of the strongest fighter: a high-level friend cannot carry a party through trivial enemies, and a fresh character is not crushed by a high band.
 const cap=Math.max(1,Math.floor(num(tuning?.level_cap,100))),slack=Math.max(0,Math.floor(get(tuning,'party_level_slack')));
 if(!partyLevels.length)return Math.max(1,Math.min(cap,level(bandLevel)));
 const top=Math.max(...partyLevels.map(l=>level(l)));
 return Math.max(1,Math.min(cap,Math.min(top+slack,Math.max(top-slack,level(bandLevel)))));
}

// ── Battle rows (party only) and reach weapons ──────────────────────────────────────────────
export function rowSwapCostsTurn(tuning){return get(tuning,'row_swap_costs_turn')>=1;} // 0: a free change once per turn (FF style); 1: the change spends the turn.
export function rowDamageTaken(tuning,row,alone=false){return row==='back'&&!alone?Math.max(0.1,get(tuning,'row_back_damage_taken')):1;} // Back row halves physical hits unless nobody is holding the front.
export function rowMeleeDealt(tuning,row,reach=false){return row==='back'&&!reach?Math.max(0.1,get(tuning,'row_back_melee_dealt')):1;} // Back-row melee is halved; reach weapons and spells are not.
export function pickTarget(tuning,actors,roll,rowOf=a=>a.row){ // Weighted pick: front-row weight vs 1 for the back row; an empty front row promotes everyone.
 if(!actors.length)return null;
 const front=Math.max(1,Math.floor(get(tuning,'row_front_target_weight'))),anyFront=actors.some(a=>rowOf(a)!=='back');
 const weights=actors.map(a=>anyFront&&rowOf(a)==='back'?1:front),total=weights.reduce((s,w)=>s+w,0);
 let pick=roll(total);for(let i=0;i<actors.length;i++){pick-=weights[i];if(pick<0)return actors[i];}
 return actors.at(-1);
}
export function weaponProfile(loadout){ // What the equipped weapon is: melee (default), bow (arrows, reach, reduced), wand (reach, reduced) or gun (mage only, MP, spell damage).
 const item=loadout?.player_info?.equipped_item_data?.weapon,cls=String(item?.weapon_class??'melee');
 const known=['bow','gun','wand'].includes(cls)?cls:'melee';
 return {cls:known,reach:known!=='melee'||item?.reach===true,item:item??null};
}
export const isArrow=item=>!!item&&(item.item_id==='arrows'||item.category==='ammo'&&(item.ammo??'arrow')==='arrow'); // The bow's ammunition stack.
