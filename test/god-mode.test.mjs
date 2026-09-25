import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {combatData,playerSpells,beginRound,readyTurn,combatAction,enemyAction,godMode} from '../server/combat.mjs';
import {importLoadout} from '../server/loadout.mjs';
import {createQuestZones,questZones} from '../server/zones.mjs';

const z=questZones[0],zero=()=>0,high=n=>n-1; // zero: every roll lowest; high: every roll highest.
function hero(cls){return importLoadout({player_info:{class_id:cls,playerHealth:80,playerHealthMax:140,str:9,def:4,dex:6,int:8,cha:2,level:7,xp:22,shame:512,wet:70,tum:60,stamina:10,stamina_max:100,stat_points:0},inventory:[],player_spells:playerSpells,player_mp:200,player_mp_max:200,childish:5});}
function battle(cls,god,extra={}){ // One ordinary fight against a 1000 HP target, with or without god mode.
 const state={loadout:hero(cls),...(god?{godMode:true}:{}),run:{id:'run',stage:1,phase:'fight',handicaps:[],enemy:{name:'Target',hp:1000,maxHp:1000,turn:0,str:60},pot:0,log:[],...extra}};
 beginRound(state,z,zero);readyTurn(state,false,z,zero);return state;
}
const spell=type=>playerSpells.find(id=>combatData.spells[id]?.type===type); // First learned player spell of a type.

test('god mode: every attack, offensive spell, debuff and charm kills in one hit',()=>{
 const normal=battle('fighter',false);assert.equal(combatAction(normal,{action:'attack'},z,zero),'continue');assert.ok(normal.run.enemy.hp>0,'without god mode the target survives');
 assert.equal(combatAction(battle('fighter',true),{action:'attack'},z,zero),'win');
 for(const type of ['offense','debuff']){const id=spell(type);if(!id)continue;const s=battle('mage',true);assert.equal(combatAction(s,{action:'cast',spell:id},z,zero),'win',type+' spell kills');}
 const charmed=battle('fighter',true);assert.equal(combatAction(charmed,{action:'charm'},z,zero),'win','a charm simply wins');
 const allured=battle('diplomat',true);assert.equal(combatAction(allured,{action:'allure'},z,zero),'win');
});

test('god mode: support spells stay support spells',()=>{
 const id=spell('heal');const s=battle('mage',true);const before=s.run.hp;
 assert.equal(combatAction(s,{action:'cast',spell:id},{...z,activeTime:true},zero),'continue','healing does not kill the enemy');
 assert.equal(s.run.enemy.hp,1000);assert.ok(s.run.hp>=before);
});

test('god mode: enemies cannot hurt you, but duels are fair fights',()=>{
 const s=battle('fighter',true);const hp=s.run.hp;
 for(let n=0;n<50;n++)assert.equal(enemyAction(s,z,high),'continue');
 assert.equal(s.run.hp,hp,'fifty hard hits later, not a scratch');assert.equal(s.loadout.player_info.playerHealth,hp);
 const plain=battle('fighter',false);enemyAction(plain,z,high);assert.ok(plain.run.hp<hp,'the same hit lands without god mode');
 const duel=battle('fighter',true,{duel:'duel-1'});assert.equal(godMode(duel),false,'PvP ignores god mode');
 enemyAction(duel,z,high);assert.ok(duel.run.hp<hp,'a duel opponent still hurts');
 assert.equal(combatAction(battle('fighter',true,{duel:'duel-1'}),{action:'attack'},z,zero),'continue','and cannot be one-shot');
});

test('gm_god_mode toggles only for gamemasters, shows in the snapshot, and ends when the role is lost',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-25T12:00:00Z'),gm=true,c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest',gamemaster:gm}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=400;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=s.character;return s;}; // One command as the GM's own window.
 try{
  act('create',{name:'Alice'});act('enter',{zone:'honeydew-lantern'});
  assert.equal(api.read('',c.id).godMode,false);
  act('gm_god_mode');assert.equal(api.read('',c.id).godMode,true,'toggled on');
  act('gm_god_mode',{value:true});assert.equal(api.read('',c.id).godMode,true,'explicit on stays on');
  act('gm_god_mode');assert.equal(api.read('',c.id).godMode,false,'toggled off');
  act('gm_god_mode',{value:true});
  gm=false;assert.throws(()=>act('gm_god_mode'),/gamemaster role/,'ordinary accounts cannot toggle it');
  act('move',{direction:'east'});assert.equal(api.read('',c.id).godMode,false,'losing the role ends god mode on the next command');
 }finally{api.close();db.close();}
});

test('peers carry a gm flag so the game can colour gamemaster names',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-25T12:00:00Z'),who='alice';const ids={},revs={};
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:who,id:who,client:'lidollquest',gamemaster:who==='alice'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}}); // Only alice holds the role.
 const act=(name,action,extra={})=>{who=name;time+=400;const s=api.act('',{action,controller:name,request_id:randomUUID(),character_id:ids[name],revision:revs[name],...extra});ids[name]=s.character.id;revs[name]=s.character.revision;return s;};
 try{
  for(const name of ['alice','bob']){act(name,'create',{name});act(name,'enter',{zone:'honeydew-lantern'});}
  who='bob';const seenByBob=api.read('',ids.bob).peers.find(p=>p.id===ids.alice);assert.equal(seenByBob.gm,true,'the GM shows as gm');
  who='alice';const seenByAlice=api.read('',ids.alice).peers.find(p=>p.id===ids.bob);assert.equal(seenByAlice.gm,false,'ordinary players do not');
 }finally{api.close();db.close();}
});
