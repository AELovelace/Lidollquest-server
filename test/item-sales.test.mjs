import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {DAILY_COIN_CAP} from '../server/hubs.mjs';
import {createItemOrigins} from '../server/item-origins.mjs';
import {createQuestService} from '../server/service.mjs';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.UTC(2026,8,16),c,owner='alice';const paid=[];
 const zones=createQuestZones(db,{grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:(...args)=>paid.push(args),now:()=>time,diveOptions:{log:()=>{}}});
 const body=(action,extra={})=>({action,character_id:c?.id,revision:c?.revision,request_id:randomUUID(),controller:owner,...extra});
 const send=input=>{time+=1500;const result=zones.act('token',input);c=result.character;return result;};
 const act=(action,extra)=>send(body(action,extra));
 act('create',{name:'Seller'});const snapshot=act('enter',{zone:'princess-rose-shops',loadout:{player_info:{},inventory:[{item_id:'offline',value:999999}]}});
 const merchant=snapshot.zones.find(z=>z.id===snapshot.zone).fixtures[0];
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 place(merchant.x,merchant.y+1);
 const refresh=()=>{c=zones.read('token',c.id).character;return c;};
 const buy=()=>{act('shop_buy',{fixture:merchant.id,offer:merchant.offers[0].id});zones.completePurchase(c.pendingPurchase,true);refresh();return c.loadout.inventory.at(-1);};
 return {db,zones,act,send,body,buy,refresh,place,merchant,paid,get c(){return c;},nextDay(){time+=86400000;},owner(value){owner=value;}};
}

test('sales require server-issued rights, ignore forged prices, replay once and leave capped items unsold',()=>{
 const f=fixture();try{
  assert.throws(()=>f.act('shop_sell',{fixture:f.merchant.id,slot:0,item_instance:'fake'}),/tracked online/);
  const item=f.buy();assert.ok(item.online_item);assert.ok(item.online_sell_price>0);
  const modified=structuredClone(f.c.loadout);modified.inventory.at(-1).value=999999;modified.inventory.at(-1).online_sell_price=999999;
  modified.inventory.push(structuredClone(modified.inventory.at(-1)));f.act('loadout',{loadout:modified});
  assert.equal(f.c.loadout.inventory.filter(i=>i.online_item).length,1);
  assert.equal(f.c.loadout.inventory[1].online_sell_price,item.online_sell_price);
  const command=f.body('shop_sell',{fixture:f.merchant.id,slot:1,item_instance:item.online_item});f.send(command);f.send(command);
  assert.equal(f.paid.length,1);assert.equal(f.paid[0][2],item.online_sell_price);
  f.act('loadout',{loadout:modified});assert.equal(f.c.loadout.inventory.some(i=>i.online_item),false,'sold rights cannot be imported again');
  const second=f.buy();f.db.prepare('UPDATE quest_reward_days SET coins=? WHERE owner=?').run(DAILY_COIN_CAP,'alice');
  assert.throws(()=>f.act('shop_sell',{fixture:f.merchant.id,slot:f.c.loadout.inventory.length-1,item_instance:second.online_item}),/Daily coin limit/);
  assert.equal(f.refresh().loadout.inventory.at(-1).online_item,second.online_item);assert.equal(f.paid.length,1);
  f.nextDay();f.act('enter',{zone:'princess-rose-shops'});f.place(f.merchant.x,f.merchant.y+1);
  f.act('shop_sell',{fixture:f.merchant.id,slot:f.c.loadout.inventory.length-1,item_instance:second.online_item});assert.equal(f.paid.length,2);
 }finally{f.db.close();}
});

test('bank rights survive transfers; imported bank copies and consumed/cross-character rights cannot sell',()=>{
 const f=fixture();try{
  const item=f.buy(),copy=structuredClone(f.c.loadout);f.place(29,20);f.act('bank_deposit',{fixture:'bank',slot:1});
  f.act('loadout',{loadout:copy});assert.equal(f.c.loadout.inventory[1].online_item,undefined,'a banked token cannot be imported into the backpack');
  const bank=f.zones.read('token',f.c.id).bank.items[0];f.act('bank_withdraw',{fixture:'bank',bank_item:bank.id});
  assert.equal(f.c.loadout.inventory.at(-1).online_item,item.online_item);
  const consumed=structuredClone(f.c.loadout);consumed.inventory.pop();f.act('loadout',{loadout:consumed});
  f.act('loadout',{loadout:copy});assert.equal(f.c.loadout.inventory[1].online_item,undefined);
  f.place(f.merchant.x,f.merchant.y+1);const another=f.buy();
  f.owner('bob');f.act('create',{name:'Other owner'});f.act('enter',{zone:'princess-rose-shops',loadout:{player_info:{},inventory:[another]}});
  assert.equal(f.c.loadout.inventory[0].online_item,undefined);
 }finally{f.db.close();}
});

test('the companion reads its own bank anywhere, pages without moving the in-game drawer, and needs no game session',()=>{
 const f=fixture();try{
  const item=f.buy();f.place(29,20);f.act('bank_deposit',{fixture:'bank',slot:1});
  const stored=f.zones.read('token',f.c.id).bank.items[0];
  f.place(1,1); // Walk away from the bank fixture.
  const ingame=f.zones.read('token',f.c.id).bank;
  assert.equal(ingame.available,false);assert.equal(ingame.count,1);assert.deepEqual(ingame.items,[],'an ordinary client still loses the payload away from a bank');
  const companion=f.zones.read('token',f.c.id,{companion:true}).bank;
  assert.equal(companion.available,false);assert.equal(companion.companion,true);assert.equal(companion.count,1);
  assert.deepEqual(companion.items.map(entry=>entry.id),[stored.id]);
  assert.equal(companion.items[0].item.online_sell_price,item.online_sell_price,'sale prices travel with the companion listing');
  f.db.prepare('DELETE FROM quest_presence WHERE character_id=?').run(f.c.id); // No zone, no controller lease: exactly what a companion request looks like.
  assert.equal(f.zones.read('token',f.c.id,{companion:true}).bank.count,1);
  const sheet=f.zones.read('token',f.c.id,{companion:true}).sheet; // The character half must not need a presence row either.
  assert.equal(sheet.character_id,f.c.id);assert.ok(sheet.level>=1);assert.ok(['fighter','mage','diplomat'].includes(sheet.class_id));
  assert.ok(sheet.equipment.length>0);assert.equal(sheet.player_info.inventory,undefined,'the companion sheet never carries raw inventory');
  assert.equal(f.zones.read('token',f.c.id).sheet,undefined,'an ordinary read still sends no sheet');
  const paged=f.zones.read('token',f.c.id,{companion:true,bankPage:5}).bank;
  assert.equal(paged.page,0,'an out-of-range companion page clamps to the last page');
  assert.equal(JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.c.id).state).bankPage??0,0,'companion paging never writes the stored bank page');
 }finally{f.db.close();}
});

test('bank sales pay once from anywhere, respect the daily cap, and reject forged or foreign tokens',()=>{
 const f=fixture();try{
  const item=f.buy();f.place(29,20);f.act('bank_deposit',{fixture:'bank',slot:1});
  const stored=f.zones.read('token',f.c.id).bank.items[0];
  f.place(1,1);f.db.prepare('DELETE FROM quest_presence WHERE character_id=?').run(f.c.id);
  assert.throws(()=>f.act('bank_sell',{bank_item:stored.id,item_instance:'fake'}),/tracked online/);
  assert.throws(()=>f.act('bank_sell',{bank_item:'missing',item_instance:item.online_item}),/no longer in your bank/);
  const day=Math.floor(Date.UTC(2026,8,16)/86400000),spend=amount=>f.db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=excluded.coins').run('alice',day,amount);
  spend(DAILY_COIN_CAP); // Nothing has been earned today yet, so the allowance row has to be created.
  assert.throws(()=>f.act('bank_sell',{bank_item:stored.id,item_instance:item.online_item}),/Daily coin limit/);
  assert.equal(f.zones.read('token',f.c.id,{companion:true}).bank.count,1,'a capped sale leaves the item in storage');
  assert.equal(f.paid.length,0);
  spend(0);
  const command=f.body('bank_sell',{bank_item:stored.id,item_instance:item.online_item});
  const sale=f.send(command);f.send(command); // The same request ID must never pay twice.
  assert.equal(f.paid.length,1);assert.equal(f.paid[0][2],item.online_sell_price);
  assert.equal(f.paid[0][3],'sale-'+item.online_item);
  assert.match(sale.character.hubNotice,/from your bank/);
  assert.equal(f.zones.read('token',f.c.id,{companion:true}).bank.count,0);
  assert.equal(f.db.prepare('SELECT coins FROM quest_reward_days WHERE owner=?').get('alice').coins,item.online_sell_price);
  assert.equal(f.db.prepare('SELECT status FROM quest_item_origins WHERE id=?').get(item.online_item).status,'sold');
 }finally{f.db.close();}
});

test('discounted purchases cannot resell above their paid price; quest and zero-value grants have no sale right',()=>{
 const f=fixture();try{
  const origins=createItemOrigins(f.db);
  assert.equal(origins.mint(f.c.id,{item_id:'discount',value:50},2).online_sell_price,2);
  assert.equal(origins.mint(f.c.id,{item_id:'quest',category:'quest_item',value:50}).online_item,undefined);
  assert.equal(origins.mint(f.c.id,{item_id:'zero',value:0}).online_item,undefined);
 }finally{f.db.close();}
});

test('equipment identity survives equip, identical-item swap, unequip and dress mirroring without minting rights',()=>{
 const f=fixture();try{
  const origins=createItemOrigins(f.db),state=JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.c.id).state);
  const first=origins.mint(f.c.id,{item_id:'test_dress',category:'dress',value:20}),second=origins.mint(f.c.id,{item_id:'test_dress',category:'dress',value:20});
  state.loadout.inventory=[first,second];f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),f.c.id);f.refresh();
  let next=structuredClone(f.c.loadout);next.inventory.shift();next.player_info.equipped_torso='test_dress';next.player_info.equipped_pants='test_dress';f.act('loadout',{loadout:next});
  assert.equal(f.c.equipmentOrigins.equipped_torso,first.online_item);
  next=structuredClone(f.c.loadout);next.inventory=[{item_id:'test_dress',category:'dress',value:999}];f.act('loadout',{loadout:next});
  assert.equal(f.c.equipmentOrigins.equipped_torso,second.online_item);assert.equal(f.c.loadout.inventory[0].online_item,first.online_item);
  next=structuredClone(f.c.loadout);next.player_info.equipped_torso='';next.player_info.equipped_pants='';next.inventory.push({item_id:'test_dress',category:'dress'});f.act('loadout',{loadout:next});
  assert.deepEqual(new Set(f.c.loadout.inventory.map(i=>i.online_item)),new Set([first.online_item,second.online_item]));assert.equal(f.c.equipmentOrigins,undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM quest_item_origins').get().n,2);
 }finally{f.db.close();}
});

test('sale payout retries after a lost wallet response and service restart without returning or duplicating the item',async()=>{
 mkdirSync('artifacts',{recursive:true});const directory=mkdtempSync(resolve('artifacts/item-sale-')),token='a'.repeat(43),owner='b'.repeat(64),receipts=new Map();
 let service,url,c,balance=1000,time=Date.UTC(2026,8,16),lost=true;
 const walletClient={authenticate:async()=>({owner,id:'owner',client:'lidollquest',coins:balance}),credit:async(_,body)=>{
  let receipt=receipts.get(body.request_id);if(!receipt){balance+=body.kind==='debit'?-body.amount:body.amount;receipt={balance};receipts.set(body.request_id,receipt);}
  if(body.kind==='credit'&&lost)throw Error('Lost successful response');return receipt;
 }};
 const start=async()=>{service=createQuestService({filename:resolve(directory,'quest.sqlite'),walletClient,now:()=>time});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+service.server.address().port;};
 const stop=()=>new Promise(r=>service.server.close(r));
 const command=(action,extra={})=>({action,controller:'owner',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});
 const send=async body=>{time+=1500;const response=await fetch(url+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));c=data.character;return data;};
 await start();try{
  await send(command('create',{name:'Seller'}));let snapshot=await send(command('enter',{zone:'princess-rose-shops',loadout:{player_info:{},inventory:[]}}));
  const merchant=snapshot.zones.find(z=>z.id===snapshot.zone).fixtures[0];service.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(merchant.x,merchant.y+1,c.id);
  await send(command('shop_buy',{fixture:merchant.id,offer:merchant.offers[0].id}));const item=c.loadout.inventory[0];
  const sale=command('shop_sell',{fixture:merchant.id,slot:0,item_instance:item.online_item});snapshot=await send(sale);
  assert.equal(c.loadout.inventory.length,0);assert.equal(snapshot.pendingCoins,item.online_sell_price);const paidBalance=balance;
  await stop();lost=false;await start();snapshot=await send(sale);
  assert.equal(snapshot.pendingCoins,0);assert.equal(c.loadout.inventory.length,0);assert.equal(balance,paidBalance);assert.equal(receipts.size,2);
  assert.equal(service.db.prepare('SELECT status FROM quest_item_origins WHERE id=?').get(item.online_item).status,'sold');
 }finally{await stop();}
});
