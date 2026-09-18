import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {combatData,playerSpells,beginRound,readyTurn,combatAction,clearEffects,awardExperience,mageScaling} from '../server/combat.mjs';
import {importLoadout} from '../server/loadout.mjs';
import {createQuestZones,questZones} from '../server/zones.mjs';

const z=questZones[0],zero=()=>0;
function hero(cls='mage'){return importLoadout({player_info:{class_id:cls,playerHealth:80,playerHealthMax:140,str:9,def:4,dex:6,int:8,cha:2,level:7,xp:22,shame:512,wet:70,tum:60,stamina:10,stamina_max:100,stat_points:0,companions:{friend:{hp:12}}},inventory:[{item_id:'potion'}],player_spells:playerSpells,player_mp:200,player_mp_max:200,childish:5});}
function battle(cls='mage'){
 const state={loadout:hero(cls),run:{id:'run',stage:1,phase:'fight',handicaps:[],enemy:{name:'Target',hp:1000,maxHp:1000,turn:0},pot:0,log:[]}};
 beginRound(state,z,zero);readyTurn(state,false,z,zero);return state;
}
function next(state){readyTurn(state,false,z,zero);}

test('every player spell resolves with its campaign MP cost and one enemy turn',()=>{
 for(const id of playerSpells){const s=battle();const mp=s.loadout.player_mp;combatAction(s,{action:'cast',spell:id},z,zero);assert.equal(s.loadout.player_mp,mp-combatData.spells[id].mp_cost,id);assert.equal(s.run.enemy.turn,1,id);assert.equal(s.run.turnReady,false,id);assert.deepEqual(s.loadout.player_info.companions,{friend:{hp:12}},id);}
});
test('mage affinity, physical weakness and absorbed-protection bonus match the base formulas',()=>{
 const s=battle();assert.deepEqual(mageScaling(s.loadout),{magic:1.3,physical:0.7,flat:0});
 combatAction(s,{action:'attack'},z,zero);assert.equal(s.run.enemy.hp,988);assert.equal(s.run.hp,74,'normal attacks use enemy STR-1, not player DEF');
 next(s);s.loadout.player_info.diaper_wet_absorbed=3;s.loadout.player_info.diaper_tum_absorbed=2;
 combatAction(s,{action:'cast',spell:'fireball'},z,zero);assert.equal(s.run.enemy.hp,988-(Math.floor((combatData.spells.fireball.power+24)*1.3)+5));
});
test('healing and cure scaling restore the intended stat and still cost a turn',()=>{
 const s=battle();s.run.hp=10;s.loadout.player_info.playerHealth=10;
 combatAction(s,{action:'cast',spell:'heal_light'},z,zero);assert.equal(s.run.hp,10+Math.floor(41*1.3)-6);
 next(s);combatAction(s,{action:'cast',spell:'calm_bladder'},z,zero);assert.equal(s.loadout.player_info.wet,28);
 next(s);combatAction(s,{action:'cast',spell:'refresh'},z,zero);assert.equal(s.loadout.player_info.stamina,62);
});
test('buffs persist between turns and serialization; expiration and exits restore stats once',()=>{
 let s=battle('fighter');combatAction(s,{action:'cast',spell:'empower'},z,zero);
 const amount=combatData.spells.empower.stat_amount+2;assert.equal(s.loadout.player_info.str,9+amount);
 s=JSON.parse(JSON.stringify(s));
 for(let turn=1;turn<combatData.spells.empower.dot_turns;turn++){next(s);assert.equal(s.loadout.player_info.str,9+amount);combatAction(s,{action:'attack'},z,zero);}
 next(s);assert.equal(s.loadout.player_info.str,9);assert.equal(s.run.buffs.length,0);
 combatAction(s,{action:'cast',spell:'fortify'},z,zero);clearEffects(s);assert.equal(s.loadout.player_info.def,4);clearEffects(s);assert.equal(s.loadout.player_info.def,4);
});
test('DOT kills prevent a counterattack; debuffs restore only the actual clamped reduction',()=>{
 const s=battle();const spell=combatData.spells.poison_cloud;
 const initial=Math.floor((spell.power+24)*1.3),dot=Math.floor((spell.dot_damage+4)*1.3);
 s.run.enemy.hp=initial+dot;assert.equal(combatAction(s,{action:'cast',spell:'poison_cloud'},z,zero),'win');assert.equal(s.run.enemy.turn,0);assert.equal(s.run.hp,80);
 const d=battle();d.run.enemy.str=3;combatAction(d,{action:'cast',spell:'weaken'},z,zero);assert.equal(d.run.enemy.str,0);assert.equal(d.run.hp,79);
 for(let i=1;i<combatData.spells.weaken.dot_turns;i++){next(d);combatAction(d,{action:'attack'},z,zero);}
 assert.equal(d.run.enemy.str,3,'expiration must not increase an enemy beyond its original STR');
});
test('invalid casts and disallowed class actions fail before spending MP or advancing turns',()=>{
 const s=battle();s.loadout.player_spells=['fireball'];
 for(const spell of ['unknown','heal_light','curse_wet','__proto__']){assert.throws(()=>combatAction(s,{action:'cast',spell},z,zero));assert.equal(s.loadout.player_mp,200);assert.equal(s.run.enemy.turn,0);}
 s.loadout.player_mp=0;assert.throws(()=>combatAction(s,{action:'cast',spell:'fireball'},z,zero));assert.equal(s.run.enemy.turn,0);
 const d=battle('diplomat');assert.throws(()=>combatAction(d,{action:'cast',spell:'fireball'},z,zero));assert.throws(()=>combatAction(d,{action:'attack'},z,zero));
 assert.throws(()=>combatAction(s,{action:'allure'},z,zero));
});
test('diplomat Allure adds INT, failures raise pressure, and ordinary charm can backfire',()=>{
 const d=battle('diplomat');combatAction(d,{action:'allure'},z,zero);assert.equal(d.run.charmPressure,1);assert.equal(d.run.charmFailures,0);
 assert.match(d.run.log[0],/roll 10 vs DC 26/);next(d);combatAction(d,{action:'charm'},z,zero);assert.match(d.run.log[0],/vs DC 28/);
 const f=battle('fighter');assert.equal(combatAction(f,{action:'charm'},z,zero),'charm_backfire');assert.equal(f.run.enemy.turn,0);
 const win=battle('diplomat');win.loadout.player_info.cha=100;assert.equal(combatAction(win,{action:'allure'},z,zero),'win');assert.equal(win.run.enemy.hp,0);assert.equal(win.run.enemy.turn,0);
});
test('enemy magic supports status, stat debuffs and compound effects with persistent timers',()=>{
 for(const id of Object.keys(combatData.spells).filter(id=>combatData.spells[id].enemy_only)){
  const s=battle();s.run.enemy.enemy_spells=[id];s.run.enemy.spell_cast_chance=1;
  combatAction(s,{action:'attack'},z,zero);assert.match(s.run.log.join(' '),/casts/);assert.equal(s.run.enemy.turn,1);assert.ok(Number.isFinite(s.run.hp),id);
 }
 const s=battle();s.run.enemy.enemy_spells=['haunting_urge'];s.run.enemy.spell_cast_chance=1;combatAction(s,{action:'attack'},z,zero);assert.ok(s.loadout.player_info.wet>70);
});
test('level-up gives campaign stat points and mage spell rewards without any currency',()=>{
 const s=battle();s.loadout.player_info.level=2;s.loadout.player_info.xp=99;s.loadout.player_spells=['heal_light'];s.run.enemy.exp=5;
 awardExperience(s,zero);assert.equal(s.loadout.player_info.level,3);assert.equal(s.loadout.player_info.xp,4);assert.equal(s.loadout.player_info.stat_points,3);assert.equal(s.loadout.player_info.playerHealthMax,141);assert.ok(s.loadout.player_spells.includes('heal_medium'));assert.equal(s.loadout.gold,undefined);
});

function service(){
 const db=new DatabaseSync(':memory:');let time=100000,coins=0;
 const api=createQuestZones(db,{now:()=>time,roll:zero,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins}),adjust:(_o,_a,n)=>{coins+=n;}});
 let c;const input=(action,extra={})=>({action,request_id:randomUUID(),controller:'window',character_id:c?.id,revision:c?.revision,...extra});
 const send=req=>{time+=500;const result=api.act('token',req);c=result.character;return result;};
 const act=(action,extra)=>send(input(action,extra));
 act('create',{name:'Hero'});act('enter',{zone:z.id,loadout:hero(),combat_version:2});act('start',{combat_version:2});
 return {db,api,act,input,send,character:()=>c,ready:()=>act('turn_ready',{loadout:c.loadout,forfeit:false})};
}
test('replayed turns, casts and banking never repeat MP, XP, HP, timers or coin awards',()=>{
 const f=service();try{
  assert.throws(()=>f.act('cast',{spell:'fireball'}),/next player turn/);
  const prep=f.input('turn_ready',{loadout:f.character().loadout,forfeit:false});f.send(prep);const prepared=structuredClone(f.character());f.send(prep);assert.deepEqual(f.character(),prepared);
  const cast=f.input('cast',{spell:'fireball'});f.send(cast);assert.equal(f.character().run.phase,'interval');assert.equal(f.character().loadout.player_info.xp,27);
  const won=structuredClone(f.character());f.send(cast);assert.deepEqual(f.character(),won);
  const bank=f.input('cashout');assert.equal(f.send(bank).coins,5);assert.equal(f.send(bank).coins,5);assert.equal(f.character().loadout.player_mp,200-combatData.spells.fireball.mp_cost);
 }finally{f.db.close();}
});
test('failed casts roll back; snapshots and reconnect preserve active spells and spent MP',()=>{
 const f=service();try{
  f.ready();const before=structuredClone(f.character());assert.throws(()=>f.act('cast',{spell:'__proto__'}));assert.deepEqual(f.api.read('token',before.id).character,before);
  f.act('cast',{spell:'fortify'});const saved=structuredClone(f.character());
  f.act('enter',{zone:z.id,loadout:hero(),combat_version:2});assert.deepEqual(f.character().run,saved.run);assert.deepEqual(f.character().loadout,saved.loadout);
  f.ready();f.act('flee');assert.equal(f.character().loadout.player_info.def,4);assert.equal(f.character().lastResult.coins,0);
 }finally{f.db.close();}
});
test('accident forfeits resolve a single enemy turn, and submission clears buffs without payment',()=>{
 const f=service();try{
  const prep=f.input('turn_ready',{loadout:f.character().loadout,forfeit:true});f.send(prep);assert.equal(f.character().run.hp,74);assert.equal(f.character().run.turn,2);f.send(prep);assert.equal(f.character().run.hp,74);
  f.ready();f.act('cast',{spell:'fortify'});f.act('submit');assert.equal(f.character().loadout.player_info.def,4);assert.equal(f.character().lastResult.outcome,'submitted');assert.equal(f.character().lastResult.defeatScene.enemy_id,'');assert.equal(f.character().lastResult.defeatScene.name,'Moss Sprite');assert.equal(f.character().lastResult.coins,0);
 }finally{f.db.close();}
});

test('level-up allocations are validated, persisted and replay-safe, including after banking',()=>{
 const f=service();try{
  let l=structuredClone(f.character().loadout);l.player_info.level=2;l.player_info.xp=99;
  f.act('turn_ready',{loadout:l,forfeit:false});f.act('cast',{spell:'fireball'});assert.equal(f.character().loadout.player_info.stat_points,3);
  const req=f.input('allocate',{stat:'int'});f.send(req);f.send(req);assert.equal(f.character().loadout.player_info.int,9);assert.equal(f.character().loadout.player_info.stat_points,2);assert.equal(f.character().loadout.player_mp_max,55);
  assert.throws(()=>f.act('allocate',{stat:'coins'}));f.act('cashout');f.act('allocate',{stat:'cha'});f.act('allocate',{stat:'dex'});assert.throws(()=>f.act('allocate',{stat:'str'}));
 }finally{f.db.close();}
});
test('defeat restores quarter HP and removes modifiers while eight class wins bank once',()=>{
 const f=service();try{
  const l=structuredClone(f.character().loadout);l.player_info.playerHealth=1;
  f.act('turn_ready',{loadout:l,forfeit:false});f.act('cast',{spell:'fortify'});assert.equal(f.character().run,null);assert.equal(f.character().loadout.player_info.playerHealth,35);assert.equal(f.character().loadout.player_info.def,4);assert.equal(f.character().lastResult.coins,0);
 }finally{f.db.close();}
 const g=service();try{
  for(let round=1;round<=8;round++){
   const l=structuredClone(g.character().loadout);l.player_info.class_id='diplomat';l.player_info.cha=100;
   g.act('turn_ready',{loadout:l,forfeit:false});g.act('allure');if(round<8){assert.equal(g.character().run.phase,'interval');g.act('continue');}
  }
  assert.equal(g.character().run,null);assert.equal(g.character().lastResult.coins,180);assert.equal(g.character().lastResult.rounds,8);
 }finally{g.db.close();}
});
