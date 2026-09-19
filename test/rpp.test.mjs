import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createRpp} from '../server/rpp.mjs';
import {importLoadout} from '../server/loadout.mjs';
import {mageScaling,awardExperience} from '../server/combat.mjs';
import {manaCapacity} from '../server/magic-balance.mjs';
import {applyCombatPatch} from '../server/dive-encounters.mjs';

const loadout=(cls='mage')=>({player_info:{class_id:cls,level:8,int:10,str:10,def:5,dex:5,cha:5,shame:1024,playerHealth:90,playerHealthMax:100,stat_points:2},inventory:[],player_spells:['fireball'],player_mp:45,player_mp_max:60});
function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-19T12:00:00Z'),id;
 const options={now:()=>time,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{}};
 const zones=createQuestZones(db,options),rpp=createRpp(db,options);
 const read=()=>zones.read('Alice',id);
 const command=(action,extra={})=>({action,request_id:randomUUID(),controller:'window',character_id:id,revision:read().character?.revision,...extra});
 const raw=cmd=>{time+=250;const s=zones.act('Alice',cmd);id=s.character.id;return s;};
 const act=(action,extra)=>raw(command(action,extra));
 const player=(name,cls='mage')=>{if(id)act('leave');const c=act('create',{name}).character;act('enter',{zone:'princess-rose',loadout:loadout(cls),combat_version:3});return c.id;};
 return {db,rpp,zones,read,act,raw,command,player,close:()=>db.close()};
}
test('RPP gifts are per character, positive, attributable and replay-safe',()=>{
 const f=fixture();try{
  const first=f.player('Writer'),second=f.player('Alt');
  const gift={character_id:first,amount:30,reason:'Wonderful shared scene',request_id:randomUUID()};
  assert.equal(f.rpp.gift(gift,'Staff').balance,30);assert.equal(f.rpp.gift(gift,'Staff').replayed,true);
  assert.equal(f.rpp.balance(first),30);assert.equal(f.rpp.balance(second),0);assert.equal(f.read().rpp.balance,0);
  assert.throws(()=>f.rpp.gift({...gift,amount:40},'Staff'),/different details/);
  assert.throws(()=>f.rpp.gift(gift,'OtherStaff'),/different details/);
  for(const amount of [-1,0,1.5,1000001])assert.throws(()=>f.rpp.gift({...gift,request_id:randomUUID(),amount},'Staff'));
  const rows=f.rpp.journal(first).ledger;assert.equal(rows.length,1);assert.equal(rows[0].actor,'Staff');assert.equal(rows[0].reason,gift.reason);
 }finally{f.close();}
});
test('RPP purchases atomically debit once and remain owned after stale imports and restarts',()=>{
 const f=fixture();try{
  const id=f.player('Writer');f.rpp.gift({character_id:id,amount:40,reason:'Review',request_id:randomUUID()},'Staff');
  const offer=f.read().rpp.catalogue.find(o=>o.id==='frostbite'),cmd=f.command('rpp_buy',{offer:offer.id,rpp_cost:offer.cost});
  let s=f.raw(cmd);assert.equal(s.rpp.balance,40-offer.cost);assert.ok(s.character.loadout.player_spells.includes('frostbite'));
  f.raw(cmd);assert.equal(f.read().rpp.balance,40-offer.cost);assert.equal(f.rpp.journal(id).ledger.length,2);
  assert.throws(()=>f.act('rpp_buy',{offer:'frostbite',rpp_cost:offer.cost}),/already know/);
  assert.throws(()=>f.act('rpp_buy',{offer:'fireball',rpp_cost:f.read().rpp.catalogue.find(o=>o.id==='fireball').cost}),/already know/);
  assert.throws(()=>f.act('rpp_buy',{offer:'deep_reserves',rpp_cost:0}),/price changed/);
  f.act('rpp_buy',{offer:'deep_reserves',rpp_cost:10});s=f.read();assert.equal(s.character.loadout.player_mp_max,160);assert.equal(s.character.loadout.player_mp,45);
  s=f.act('enter',{zone:'princess-rose',loadout:loadout(),combat_version:3});assert.ok(s.character.loadout.player_spells.includes('frostbite'));assert.deepEqual(s.character.loadout.player_info.rpp_abilities,['deep_reserves']);assert.equal(s.character.loadout.player_mp_max,160);
  assert.equal(createRpp(f.db).balance(id),22);assert.equal(f.rpp.journal(id).ledger.filter(r=>r.kind==='purchase').length,2);
 }finally{f.close();}
});
test('unavailable, unaffordable and forged unlocks cannot spend or grant RPP abilities',()=>{
 const f=fixture();try{
  const id=f.player('Writer');assert.throws(()=>f.act('rpp_buy',{offer:'deep_reserves',rpp_cost:10}),/enough RPP/);
  const fake=loadout();fake.player_info.rpp_abilities=['deep_reserves','sure_strike'];f.act('enter',{zone:'princess-rose',loadout:fake,combat_version:3});assert.deepEqual(f.read().character.loadout.player_info.rpp_abilities,[]);
  f.rpp.gift({character_id:id,amount:20,reason:'Review',request_id:randomUUID()},'Staff');
  const low=loadout('diplomat');low.player_info.level=1;f.act('enter',{zone:'princess-rose',loadout:low,combat_version:3});
  assert.throws(()=>f.act('rpp_buy',{offer:'starfall',rpp_cost:12}),/class or level/);assert.equal(f.read().rpp.balance,20);
  const s=f.act('rpp_buy',{offer:'silver_tongue',rpp_cost:8});assert.deepEqual(s.character.loadout.player_info.rpp_abilities,['silver_tongue']);assert.equal(s.rpp.balance,12);
  const l=s.character.loadout,replacement=structuredClone(l.player_info);replacement.rpp_abilities.push('sure_strike');
  const patched=applyCombatPatch(l,[{path:['player_info'],before:l.player_info,after:replacement}]);assert.deepEqual(patched.player_info.rpp_abilities,['silver_tongue']);
 }finally{f.close();}
});
test('mage balance stacks with affinity and fullness, doubles only mage mana, and purchased passives apply',()=>{
 const mage=importLoadout(loadout()),fighter=importLoadout(loadout('fighter')),diplomat=importLoadout(loadout('diplomat'));
 assert.deepEqual(mageScaling(mage),{magic:1.5,physical:0.5,flat:0});assert.deepEqual(mageScaling(fighter),{magic:1,physical:1,flat:0});
 assert.equal(mage.player_mp_max,120);assert.equal(fighter.player_mp_max,60);assert.equal(diplomat.player_mp_max,60);assert.equal(mage.player_mp,45);
 assert.equal(importLoadout(mage).player_mp_max,120,'Re-importing never doubles twice');
 mage.childish=10;mage.player_info.shame=0;mage.player_info.diaper_wet_absorbed=8;mage.player_info.diaper_tum_absorbed=4;
 const m=mageScaling(mage);assert.ok(Math.abs(m.magic-2.4)<1e-9);assert.equal(m.physical,0.2);assert.equal(m.flat,18);
 mage.player_info.rpp_abilities=['arcane_practice','sure_strike','deep_reserves'];const boosted=mageScaling(mage);assert.ok(boosted.magic>m.magic);assert.ok(boosted.physical>m.physical);assert.equal(boosted.flat,19);assert.equal(manaCapacity(mage),160);
});

test('free mage choices accumulate, debit once, preserve RPP and survive stale imports',()=>{
 const f=fixture();try{
  const id=f.player('Scholar'),row=f.db.prepare('SELECT * FROM quest_characters WHERE id=?').get(id),state=JSON.parse(row.state);
  state.run={enemy:{exp:850},hp:90,maxHp:100,log:[]};awardExperience(state,()=>0);state.run=null;
  f.db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),id);
  assert.equal(f.read().rpp.freePicks,2);assert.equal(f.read().rpp.balance,0);
  assert.throws(()=>f.act('mage_pick',{offer:'sure_strike'}),/available mage spell choice/);
  const cmd=f.command('mage_pick',{offer:'frostbite'});let s=f.raw(cmd);assert.equal(s.rpp.freePicks,1);assert.equal(s.rpp.balance,0);
  f.raw(cmd);assert.equal(f.read().rpp.freePicks,1);assert.throws(()=>f.act('mage_pick',{offer:'frostbite'}),/already know/);
  const stale=loadout();stale.mageSpellPicks=999;stale.player_info.mageSpellPicks=999;f.act('enter',{zone:'princess-rose',loadout:stale,combat_version:3});
  assert.equal(f.read().rpp.freePicks,1);assert.ok(f.read().character.loadout.player_spells.includes('frostbite'));
  s=f.act('mage_pick',{offer:'clarity'});assert.equal(s.rpp.freePicks,0);assert.throws(()=>f.act('mage_pick',{offer:'iron_will'}),/available mage spell choice/);
  assert.equal(f.rpp.journal(id).ledger.filter(r=>r.kind==='mage_pick').length,2);
 }finally{f.close();}
});
