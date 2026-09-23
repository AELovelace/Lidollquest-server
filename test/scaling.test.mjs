import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TUNING} from '../server/loot.mjs';
import {validateTuning} from '../server/loot-store.mjs';
import {playerBaseHp,playerHpDelta,defHpDelta,legacyBaseHp,mitigate,expectedPlayerDamage,enemyHpFor,levelEnemy,healScale,routeLevelFor,encounterLevel,staminaBase,staminaDelta,dexStaminaDelta} from '../server/scaling.mjs';

const t=DEFAULT_TUNING;

test('player HP curve: 100 base, +5 to level 40, +3 after, plus 0.6 per DEF; level-ups and DEF points add the difference',()=>{
 assert.equal(playerBaseHp(t,1,0),105);assert.equal(playerBaseHp(t,1,4),107);
 assert.equal(playerBaseHp(t,40,0),300);assert.equal(playerBaseHp(t,41,0),303);assert.equal(playerBaseHp(t,100,0),480);
 assert.equal(playerBaseHp(t,100,100),540);
 assert.equal(playerHpDelta(t,7,8,4),5);assert.equal(playerHpDelta(t,40,41,4),3);assert.equal(playerHpDelta(t,1,3,0),10);
 assert.equal(defHpDelta(t,5,4,5)+defHpDelta(t,5,5,6)+defHpDelta(t,5,6,7)+defHpDelta(t,5,7,8)+defHpDelta(t,5,8,9),3,'five DEF points add three HP with a 0.6 share');
 assert.equal(playerBaseHp(t,1,-20),105,'negative DEF from curses never lowers base HP');
 assert.equal(legacyBaseHp(7),106);
 assert.equal(playerBaseHp({...t,hp_base:'x',hp_per_level:null},1,0),105,'malformed keys fall back to the shipped defaults');
});

test('percentage mitigation keeps every stat meaningful to the cap and never zeroes a hit',()=>{
 assert.equal(mitigate(t,20,0),20);assert.equal(mitigate(t,20,100),10);assert.equal(mitigate(t,200,100),100);assert.equal(mitigate(t,3,1000),1);
 assert.equal(mitigate(t,20,-20),25,'a cursed negative DEF raises damage');assert.equal(mitigate(t,20,-500),40,'but at most doubles it');
 assert.equal(mitigate({...t,def_mitigation_k:50},20,50),10);
});

test('enemy HP follows turns-to-kill against an average build, weighted by authored HP',()=>{
 assert.equal(expectedPlayerDamage(t,1,1),19); // (10 + 0) x 2 = 20, then 100/101.
 assert.equal(enemyHpFor(t,25,1,1,'mob'),32); // 2 turns x 19 x 25/30.
 assert.equal(enemyHpFor(t,30,1,1,'boss'),152); // 8 turns x 19.
 assert.equal(enemyHpFor(t,30,1,1,'elite'),76);
 assert.ok(enemyHpFor(t,30,50,3,'mob')>enemyHpFor(t,30,1,1,'mob')*5,'level 50 mobs take the same two hits from a much harder-hitting build');
 const fairy=levelEnemy(t,{name:'Diaper Fairy',hp:25,str:5,def:1,exp:6},25,{});
 assert.equal(fairy.level,25);assert.equal(fairy.str,Math.round(5*(1+0.08*24)));assert.equal(fairy.maxHp,fairy.hp);assert.equal(fairy.maxHp,enemyHpFor(t,25,25,fairy.def,'mob'));
 assert.equal(levelEnemy(t,fairy,60,{}).level,25,'a levelled struct is never re-levelled');assert.deepEqual(fairy.authored,{hp:25,str:5,def:1},'the designer numbers survive for charm difficulty');
 const elite=levelEnemy(t,{name:'Mimic',hp:35,str:6,def:2},10,{elite:true});assert.equal(elite.level,12);assert.match(elite.name,/^Elite /);assert.equal(elite.elite,true);
 const boss=levelEnemy(t,{name:'Iris',hp:100,str:8,def:3},10,{boss:true});assert.equal(boss.maxHp,enemyHpFor(t,100,10,boss.def,'boss'));
});

test('heals scale with the HP bar, route bands follow depth, and shared fights follow the strongest member',()=>{
 assert.equal(healScale(t,100),1);assert.equal(healScale(t,50),1,'never below one');assert.equal(healScale(t,300),3);
 assert.equal(routeLevelFor(t,'nowhere',1),5);assert.equal(routeLevelFor(t,'nowhere',3),9);
 assert.equal(routeLevelFor({...t,route_levels:{'dive-quarters':{base:12,per_floor:4}}},'dive-quarters',2),16);
 assert.equal(encounterLevel(t,5,[]),5);assert.equal(encounterLevel(t,5,[4,6]),5);assert.equal(encounterLevel(t,5,[60,5]),57,'raised toward the strongest member');assert.equal(encounterLevel(t,20,[1]),4,'a fresh character is not crushed by a high band');assert.equal(encounterLevel(t,5,[200]),100,'capped at level_cap');
});

test('the /gm Loot tab can edit every scaling key inside its bounds',()=>{
 assert.deepEqual(validateTuning({hp_base:120,hp_late_from:35,enemy_ttk_boss:10,def_mitigation_k:150,party_level_slack:5}),{hp_base:120,hp_late_from:35,enemy_ttk_boss:10,def_mitigation_k:150,party_level_slack:5});
 assert.throws(()=>validateTuning({hp_late_from:35.5}),/whole number/);
 assert.throws(()=>validateTuning({def_mitigation_k:5}),/between 10 and 1000/);
 assert.throws(()=>validateTuning({enemy_ttk_mob:0}),/between 0.5 and 20/);
 for(const key of ['hp_base','hp_per_level','hp_per_level_late','hp_late_from','hp_def_share','def_mitigation_k','enemy_hp_reference','enemy_ttk_mob','enemy_ttk_elite','enemy_ttk_boss','avg_str_base','avg_str_per_level','heal_reference_hp','party_level_slack'])assert.ok(key in DEFAULT_TUNING,key+' has a shipped default');
});

test('stamina curve: 100 base, +2 per level, half a point per DEX; level-ups and DEX points add the difference',()=>{
 assert.equal(staminaBase(t,1,0),100);assert.equal(staminaBase(t,1,4),102);assert.equal(staminaBase(t,41,0),180);assert.equal(staminaBase(t,100,100),348);
 assert.equal(staminaDelta(t,7,8,4),2);assert.equal(staminaDelta(t,1,11,0),20);
 assert.equal(dexStaminaDelta(t,5,4,5)+dexStaminaDelta(t,5,5,6),1,'two DEX points add one stamina with a 0.5 share');
 assert.deepEqual(validateTuning({stamina_base:120,stamina_per_level:3,stamina_dex_share:1}),{stamina_base:120,stamina_per_level:3,stamina_dex_share:1});
 assert.throws(()=>validateTuning({stamina_dex_share:9}),/between 0 and 5/);
});
