import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldCast,INCOMING_CAP} from '../server/field-magic.mjs';
import {applyFieldBuffs,clearEffects,combatData} from '../server/combat.mjs';

const onScreen=(a,b)=>Math.abs(a.x-b.x)<=15&&Math.abs(a.y-b.y)<=10; // the default area-chat rectangle

function loadout(extra={}){ // A small mage-free fighter loadout; the spells are known so only the rules under test can fail.
 return {player_info:{class_id:'fighter',int:4,str:5,def:3,dex:2,cha:1,playerHealth:40,playerHealthMax:100,wet:60,tum:20,stamina:10,stamina_max:100,shame:1024,...extra},inventory:[],player_spells:['heal_light','calm_bladder','fortify','fireball'],player_mp:30,player_mp_max:30};
}
function pair(over={}){ // Alice casts on Bea; both in party p1, same zone, a few tiles apart.
 const alice={id:'alice',name:'Alice',state:{run:null,loadout:loadout()},pos:{zone:'honeydew-lantern',x:10,y:10},connected:true,partyId:'p1'};
 const bea={id:'bea',name:'Bea',state:{run:null,loadout:loadout()},pos:{zone:'honeydew-lantern',x:14,y:12},connected:true,partyId:'p1'};
 return {alice:{...alice,...over.alice},bea:{...bea,...over.bea}};
}

test('a heal on a nearby party member spends the caster MP and queues HP for the target',()=>{
 const {alice,bea}=pair();
 const entry=fieldCast(alice,bea,'heal_light',{onScreen});
 assert.equal(entry.kind,'heal');assert.equal(entry.stat,'hp');assert.ok(entry.amount>0);
 assert.equal(entry.from_name,'Alice');
 assert.equal(alice.state.loadout.player_mp,30-combatData.spells.heal_light.mp_cost);
 assert.deepEqual(bea.state.loadout.player_info.incoming_spells,[entry]);
 assert.equal(bea.state.loadout.player_info.playerHealth,40); // the target's own game applies it
});

test('cures and buffs scale with the caster INT',()=>{
 const {alice,bea}=pair();
 const cure=fieldCast(alice,bea,'calm_bladder',{onScreen});
 assert.equal(cure.stat,'wet');assert.equal(cure.amount,Math.abs(combatData.spells.calm_bladder.stat_amount)+Math.floor(4*1.5));
 const buff=fieldCast(alice,bea,'fortify',{onScreen});
 assert.equal(buff.kind,'buff');assert.equal(buff.stat,'def');assert.equal(buff.amount,combatData.spells.fortify.stat_amount+Math.floor(4/3));
});

test('field casts are refused for bad targets, and a refusal never spends MP',()=>{
 const cases=[
  [{bea:{pos:{zone:'honeydew-lantern',x:40,y:10}}},/too far away/],
  [{bea:{pos:{zone:'princess-rose',x:10,y:10}}},/not in this area/],
  [{bea:{partyId:'p2'}},/not in your party/],
  [{bea:{connected:false}},/not in this area/],
  [{bea:{state:{run:null,dive:{edition:'2026-09-28'},loadout:loadout()}}},/not in this area/], // another dungeon instance of the same zone
  [{bea:{state:{run:{phase:'fight'},loadout:loadout()}}},/in a fight/],
  [{bea:{state:{run:null,pendingDefeat:{},loadout:loadout()}}},/knocked out/],
  [{alice:{state:{run:{phase:'fight'},loadout:loadout()}}},/Finish what you are doing/],
 ];
 for(const [over,message] of cases){
  const {alice,bea}=pair(over);
  assert.throws(()=>fieldCast(alice,bea,'heal_light',{onScreen}),message);
  assert.equal(alice.state.loadout.player_mp,30);assert.equal(bea.state.loadout.player_info.incoming_spells,undefined);
 }
 const {alice,bea}=pair();
 assert.throws(()=>fieldCast(alice,alice,'heal_light',{onScreen}),/another party member/);
 assert.throws(()=>fieldCast(alice,bea,'fireball',{onScreen}),/only be cast during battle/);
 assert.throws(()=>fieldCast(alice,bea,'moonwell',{onScreen}),/have learned/);
 alice.state.loadout.player_mp=1;assert.throws(()=>fieldCast(alice,bea,'heal_light',{onScreen}),/Not enough MP/);
 const dip=pair({alice:{state:{run:null,loadout:loadout({class_id:'diplomat'})}}});
 assert.throws(()=>fieldCast(dip.alice,dip.bea,'heal_light',{onScreen}),/Diplomats/);
});

test('the incoming queue is capped',()=>{
 const {alice,bea}=pair();alice.state.loadout.player_mp=999;
 bea.state.loadout.player_info.incoming_spells=Array.from({length:INCOMING_CAP},()=>({kind:'heal'}));
 assert.throws(()=>fieldCast(alice,bea,'heal_light',{onScreen}),/waiting to land/);
 assert.equal(alice.state.loadout.player_mp,999);
});

test('a primed buff starts with the next fight and is reverted when it ends',()=>{
 const state={loadout:loadout({def:3,field_buffs:[{spell_id:'fortify',stat_key:'def',amount:4,turns:3}]}),run:{buffs:[],debuffs:[],dots:[],log:[]}};
 applyFieldBuffs(state);
 assert.equal(state.loadout.player_info.def,7);
 assert.equal(state.run.buffs.length,1);assert.equal(state.run.buffs[0].turns_left,3);
 assert.deepEqual(state.loadout.player_info.field_buffs,[]); // used up
 assert.match(state.run.log[0],/Fortify kicks in/);
 clearEffects(state);
 assert.equal(state.loadout.player_info.def,3);
 const junk={loadout:loadout({field_buffs:[{spell_id:'x',stat_key:'wet',amount:50},{spell_id:'y',stat_key:'str',amount:-3}]}),run:{buffs:[],log:[]}};
 applyFieldBuffs(junk);assert.equal(junk.run.buffs.length,0);assert.equal(junk.loadout.player_info.str,5); // only positive primary-stat buffs
});
