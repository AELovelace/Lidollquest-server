import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {pathTo} from '../server/dive-generation.mjs';
import {DEFAULT_TUNING} from '../server/loot.mjs';
import {pickTarget,rowDamageTaken,rowMeleeDealt,weaponProfile,isArrow} from '../server/scaling.mjs';
import {stackable,slotsUsed,addToInventory,takeFromStack,importLoadout} from '../server/loadout.mjs';
import {combatAction,readyTurn,beginRound} from '../server/combat.mjs';

const t=DEFAULT_TUNING;

test('row helpers: front draws fire 3:1, an all-back party is front, back row halves hits and melee but not reach',()=>{
 const actors=[{row:'front'},{row:'back'}];
 assert.equal(pickTarget(t,actors,()=>0),actors[0]);assert.equal(pickTarget(t,actors,()=>2),actors[0]);assert.equal(pickTarget(t,actors,()=>3),actors[1]);
 assert.equal(pickTarget(t,[{row:'back'},{row:'back'}],()=>1).row,'back','everyone in back counts as front: equal weights');
 assert.equal(pickTarget(t,[],()=>0),null);
 assert.equal(rowDamageTaken(t,'back'),0.5);assert.equal(rowDamageTaken(t,'back',true),1,'nobody holds the front');assert.equal(rowDamageTaken(t,'front'),1);
 assert.equal(rowMeleeDealt(t,'back'),0.5);assert.equal(rowMeleeDealt(t,'back',true),1,'reach weapons ignore the row');
 assert.deepEqual(weaponProfile({player_info:{}}),{cls:'melee',reach:false,item:null});
 assert.equal(weaponProfile({player_info:{equipped_item_data:{weapon:{weapon_class:'bow'}}}}).reach,true);
 assert.ok(isArrow({item_id:'arrows'}));assert.ok(isArrow({item_id:'x',category:'ammo'}));assert.ok(!isArrow({item_id:'sword',category:'weapon'}));
});

test('stacks: consumables and ammo merge into one entry up to stack_max and never use a slot',()=>{
 const bag=[];
 addToInventory(bag,{item_id:'arrows',category:'ammo'});addToInventory(bag,{item_id:'arrows',category:'ammo',quantity:5});
 assert.equal(bag.length,1);assert.equal(bag[0].quantity,6);
 addToInventory(bag,{item_id:'iron_dagger',category:'weapon'});addToInventory(bag,{item_id:'iron_dagger',category:'weapon'});
 assert.equal(bag.length,3,'gear never stacks');assert.equal(slotsUsed(bag),2,'the arrow stack is free');
 addToInventory(bag,{item_id:'arrows',category:'ammo',quantity:510},512);assert.equal(bag.length,4,'a full stack starts a new one');
 assert.ok(takeFromStack(bag,isArrow,4));assert.equal(bag[0].quantity,2);
 assert.ok(takeFromStack(bag,isArrow,2));assert.equal(bag.some(i=>i.quantity===510),true,'an emptied stack disappears');
 assert.equal(takeFromStack(bag,i=>i.item_id==='none',1),false);
 assert.ok(stackable({category:'food'}));assert.ok(stackable({category:'weapon',stackable:true}));assert.ok(!stackable({category:'torso'}));
});

function solo(weapon,extra={}){ // A solo arena-style run through combat.mjs with a chosen weapon in the paperdoll.
 const loadout=importLoadout({player_info:{class_id:'fighter',playerHealth:100,playerHealthMax:100,str:10,def:4,dex:5,int:12,cha:2,level:5,xp:0,equipped_weapon:weapon?.item_id??'',equipped_item_data:weapon?{weapon}:{},...(extra.info??{})},inventory:extra.inventory??[],player_spells:[],player_mp:extra.mp??0,player_mp_max:extra.mp??0});
 const state={loadout,run:{id:'r',zone:'z',stage:1,phase:'fight',hp:100,maxHp:100,heals:0,pot:0,handicaps:[],enemy:{name:'Dummy',hp:1000,maxHp:1000,str:6,def:0,exp:1,turn:0},acted:0,log:[]}};
 const z={attack:0,theme:'plain'};beginRound(state,z,()=>0,{name:'Dummy',hp:1000,maxHp:1000,str:6,def:0,exp:1});readyTurn(state,false,z,()=>0);
 return {state,z};
}

test('bows spend an arrow for a reduced reach shot, swing as a club when empty; guns are mage-only and cost MP',()=>{
 const bow={item_id:'short_bow',category:'weapon',weapon_class:'bow',atk:0};
 let {state,z}=solo(bow,{inventory:[{item_id:'arrows',category:'ammo',quantity:2}]});
 combatAction(state,{action:'attack'},z,()=>0);
 assert.equal(state.loadout.inventory[0].quantity,1);assert.equal(state.run.enemy.hp,1000-15,'20 x 0.75 reach multiplier');assert.match(state.run.log[0],/shoot/);
 readyTurn(state,false,z,()=>0);combatAction(state,{action:'attack'},z,()=>0);assert.equal(state.loadout.inventory.length,0,'the last arrow empties the stack');
 readyTurn(state,false,z,()=>0);combatAction(state,{action:'attack'},z,()=>0);assert.equal(state.run.enemy.hp,1000-15-15-20,'no arrows: a full-strength club swing');assert.match(state.run.log.join(' '),/No arrows left/);
 const gun={item_id:'arcane_pistol',category:'weapon',weapon_class:'gun',mp_cost:4,power:20,atk:0};
 ({state,z}=solo(gun,{mp:10}));assert.throws(()=>combatAction(state,{action:'attack'},z,()=>0),/Only a mage/);
 ({state,z}=solo(gun,{mp:10,info:{class_id:'mage'}}));combatAction(state,{action:'attack'},z,()=>0);
 assert.equal(state.loadout.player_mp,6,'four MP per shot');assert.ok(state.run.enemy.hp<1000-20,'spell-level damage: (power + INT x 3) x mage magic');assert.match(state.run.log[0],/fire at/);
 ({state,z}=solo(gun,{mp:2,info:{class_id:'mage'}}));assert.throws(()=>combatAction(state,{action:'attack'},z,()=>0),/Not enough MP/);
 ({state,z}=solo(null));assert.throws(()=>combatAction(state,{action:'row'},z,()=>0),/alone you always fight in front/);
});

function party(){ // Two party members on one shared Dive floor, as parties.test.mjs drives it.
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z');const ids={};
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,grant:secret=>({id:secret,owner:secret,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const loadout=()=>({player_info:{class_id:'fighter',playerHealth:500,playerHealthMax:500,str:100,def:8,dex:8,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:[],player_mp:0,player_mp_max:0});
 const snap=name=>zones.read(name,ids[name]);
 function command(name,action,extra={}){const s=snap(name);return {action,request_id:randomUUID(),controller:'window',character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...(s.encounter?{battle:s.encounter.id,cycle:s.character.run.cycle}:{}),...extra};}
 function act(name,action,extra={}){time++;return zones.act(name,command(name,action,extra));}
 function player(name){const s=zones.act(name,{action:'create',name,controller:'window',request_id:randomUUID()});ids[name]=s.character.id;return act(name,'enter',{zone:'princess-rose',combat_version:3,loadout:loadout()});}
 function join(name){act('alice','party_invite',{member:ids[name]});return act(name,'party_accept',{invitation:snap(name).partyInvitations[0].id});}
 function place(name,x,y){const id=ids[name],s=snap(name).character;delete s.id;delete s.name;delete s.revision;if(s.dive){s.dive.position={x,y};s.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),id);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(x,y,time,id);}
 function engage(name='alice',encounter='iris'){const s=snap(name),foe=s.dive.enemies.find(e=>e.id===encounter),f=s.zones.find(z=>z.id===s.zone),path=pathTo(f,f.entrance,foe),p=path.at(-2);place(name,p.x,p.y);return act(name,'dive_engage',{encounter:foe.id});}
 return {db,ids,snap,act,player,join,engage,advance:ms=>{time+=ms;zones.tick();},zones,close:()=>db.close()};
}

test('shared fights: rows are per member, a free change once per cycle, alone means front, and the front row draws every roll-zero hit',()=>{
 const f=party();try{
  f.player('alice');f.player('bob');f.join('bob');f.act('alice','dive_enter',{zone:'dive-quarters'});f.engage();
  assert.deepEqual(f.snap('alice').encounter.players.map(p=>p.row),['front','front']);
  assert.equal(f.snap('alice').combatRules.rowSwapCostsTurn,false);
  f.act('bob','row');assert.deepEqual(f.snap('alice').encounter.players.map(p=>p.row),['front','back']);assert.equal(f.snap('bob').character.run.row,'back');
  assert.throws(()=>f.act('bob','row'),/already changed rows/);
  const before=f.snap('bob').character.run.hp;for(let i=0;i<8;i++){f.advance(3000);f.act('alice','heartbeat');f.act('bob','heartbeat');} // Enemy gauges fill while both leases stay fresh; roll() is always 0, so the front-row member is picked.
  assert.equal(f.snap('bob').character.run.hp,before,'the back-row member was not targeted');
  const events=f.snap('bob').encounter.events.map(ev=>ev.text);assert.ok(events.some(text=>/\(alice\)$/.test(text)),'the enemy acted against alice in front');assert.ok(!events.some(text=>/\(bob\)$/.test(text)),'never against bob in back');
  f.act('bob','turn_ready',{patch:[],forfeit:false});f.act('bob','attack',{target:f.snap('bob').encounter.enemies[0].id});
  f.act('bob','row');assert.equal(f.snap('bob').character.run.row,'front','a new cycle allows another change');
  f.act('bob','flee');assert.throws(()=>f.act('alice','row'),/alone you always fight in front/);
 }finally{f.close();}
});
