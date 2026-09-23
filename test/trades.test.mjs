import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

function fixture(){ // Two players in one hub room, driven exactly as the client drives the gateway.
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-23T12:00:00Z');const ids={},awards=[];
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,grant:secret=>({id:secret,owner:secret,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:(owner,asset,n,id,reason)=>awards.push({owner,n,reason}),diveOptions:{log:()=>{}}});
 const snap=name=>zones.read(name,ids[name]);
 function command(name,action,extra={}){const s=snap(name);return {action,request_id:randomUUID(),controller:'window',character_id:ids[name],revision:s.character.revision,...extra};}
 function act(name,action,extra={}){time+=100;return zones.act(name,command(name,action,extra));}
 function player(name,inventory=[]){const s=zones.act(name,{action:'create',name,controller:'window',request_id:randomUUID()});ids[name]=s.character.id;const r=act(name,'enter',{zone:'princess-rose',combat_version:3,loadout:{player_info:{class_id:'fighter',playerHealth:100,playerHealthMax:100,str:10,def:2,dex:8,int:5,cha:5,level:10,xp:0,stat_points:0},inventory,player_spells:[],player_mp:0,player_mp_max:0}});db.prepare('UPDATE quest_presence SET x=5,y=5 WHERE character_id=?').run(ids[name]);return r;}
 function settleCoins(name,paid=true){const id=snap(name).character.pendingPurchase;assert.ok(id,'a coin escrow is pending');zones.completePurchase(id,paid);}
 const bag=name=>snap(name).character.loadout.inventory;
 return {db,ids,awards,snap,act,player,settleCoins,bag,advance:ms=>{time+=ms;zones.tick();},zones,close:()=>db.close()};
}

test('items for coins: offer, accept, table, confirm on both sides, swap with resale rights, notices',()=>{
 const f=fixture();try{
  f.player('alice',[{item_id:'iron_dagger',category:'weapon',name:'Iron Dagger'},{item_id:'arrows',category:'ammo',name:'Arrows',quantity:20}]);
  f.player('bob',[{item_id:'plush_hammer',category:'weapon',name:'Plush Hammer'}]);
  f.db.prepare("INSERT INTO quest_item_origins VALUES (?,?,?,?,?)").run('right-1',f.ids.alice,JSON.stringify({item_id:'iron_dagger'}),7,'held');
  f.db.prepare("UPDATE quest_characters SET state=json_set(state,'$.loadout.inventory[0].online_item','right-1') WHERE id=?").run(f.ids.alice); // Alice's dagger carries a server-issued resale right.
  f.act('alice','trade_offer',{target:f.ids.bob});
  let view=f.snap('bob').trade;assert.equal(view.phase,'proposed');assert.equal(view.mine,1);assert.equal(view.sides[0].name,'alice');
  assert.throws(()=>f.act('alice','trade_accept'),/offered the trade/);
  assert.throws(()=>f.act('alice','trade_offer',{target:f.ids.bob}),/already have a trade/);
  f.act('bob','trade_accept');assert.equal(f.snap('alice').trade.phase,'open');
  f.act('alice','trade_add',{kind:'item',index:0});assert.equal(f.bag('alice').length,1);assert.equal(f.snap('bob').trade.sides[0].items[0].name,'Iron Dagger');
  f.act('alice','trade_add',{kind:'item',index:0});assert.equal(f.snap('bob').trade.sides[0].items[1].quantity,20);
  f.act('bob','trade_add',{kind:'coins',amount:40});assert.equal(f.snap('bob').trade.sides[1].pending,true);
  assert.throws(()=>f.act('bob','trade_confirm'),/still settling/);
  f.settleCoins('bob');assert.equal(f.snap('alice').trade.sides[1].coins,40);
  f.act('alice','trade_confirm');assert.equal(f.snap('bob').trade.sides[0].confirmed,true);
  f.act('bob','trade_add',{kind:'item',index:0});assert.equal(f.snap('alice').trade.sides[0].confirmed,false,'changing the table resets confirmations');
  f.act('bob','trade_remove');assert.equal(f.bag('bob').length,1,'items come back');assert.deepEqual(f.awards,[{owner:'bob',n:40,reason:'Trade coins returned'}],'coins come back too');
  f.act('bob','trade_add',{kind:'coins',amount:40});f.settleCoins('bob');
  f.act('alice','trade_confirm');f.act('bob','trade_confirm');
  assert.equal(f.snap('alice').trade,null);assert.equal(f.snap('bob').trade,null);
  assert.deepEqual(f.bag('bob').map(i=>i.item_id).sort(),['arrows','iron_dagger','plush_hammer']);assert.equal(f.bag('alice').length,0);
  assert.deepEqual(f.awards.at(-1),{owner:'alice',n:40,reason:'Trade with bob'});
  assert.equal(f.db.prepare("SELECT character_id FROM quest_item_origins WHERE id='right-1'").get().character_id,f.ids.bob,'resale rights follow the item');
  assert.match(f.snap('alice').character.hubNotice,/40 coins from bob/);assert.match(f.snap('bob').character.hubNotice,/Iron Dagger, Arrows x20 from alice/);
 }finally{f.close();}
});

test('decline, cancel and expiry give everything back; full bags block the swap; duels and trades exclude each other',()=>{
 const f=fixture();try{
  f.player('alice',[{item_id:'iron_dagger',category:'weapon',name:'Iron Dagger'}]);f.player('bob');
  f.act('alice','trade_offer',{target:f.ids.bob});f.act('bob','trade_decline');assert.equal(f.snap('alice').trade,null);
  f.act('alice','trade_offer',{target:f.ids.bob});f.act('bob','trade_accept');
  f.act('alice','trade_add',{kind:'item',index:0});f.act('alice','trade_add',{kind:'coins',amount:15});f.settleCoins('alice');
  assert.throws(()=>f.act('alice','duel_challenge',{target:f.ids.bob}),/Finish what you are doing/);
  f.act('bob','trade_cancel');
  assert.equal(f.bag('alice')[0].item_id,'iron_dagger');assert.deepEqual(f.awards,[{owner:'alice',n:15,reason:'Trade coins returned'}]);
  f.act('alice','trade_offer',{target:f.ids.bob});f.advance(11*60000);assert.equal(f.snap('alice').trade,null,'stale offers expire');
  for(const n of ['alice','bob']){f.act(n,'enter',{zone:'princess-rose',combat_version:3});f.db.prepare('UPDATE quest_presence SET x=5,y=5 WHERE character_id=?').run(f.ids[n]);}
  f.db.prepare("UPDATE quest_characters SET state=json_set(state,'$.loadout.inventory',json(?)) WHERE id=?").run(JSON.stringify(Array.from({length:99},()=>({item_id:'wooden_spoon',category:'weapon',name:'Spoon'}))),f.ids.bob);
  f.act('alice','trade_offer',{target:f.ids.bob});f.act('bob','trade_accept');f.act('alice','trade_add',{kind:'item',index:0});f.act('alice','trade_confirm');
  f.act('bob','trade_confirm');assert.match(f.snap('bob').character.hubNotice,/needs 1 free bag slot/);
  assert.equal(f.snap('alice').trade.sides[0].confirmed,false,'a refused swap needs both to confirm again');
  f.act('alice','trade_cancel');assert.equal(f.bag('alice')[0].item_id,'iron_dagger');
  f.act('alice','duel_challenge',{target:f.ids.bob});assert.throws(()=>f.act('alice','trade_offer',{target:f.ids.bob}),/Finish what you are doing/);
 }finally{f.close();}
});
