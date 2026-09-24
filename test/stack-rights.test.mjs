import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {addToInventory,mergeStacks,takeFromStack,removeUnit,stackTokens,importLoadout} from '../server/loadout.mjs';

// Identical consumables share one bag entry even when every unit was bought separately: each purchase's
// resale right rides inside the stack (online_items), the front right is what sells next, and rights that
// no longer have a unit behind them are retired by reconcile().

test('stacks merge across resale rights and keep every right in order',()=>{
 const bag=[];
 addToInventory(bag,{item_id:'adult_food',category:'food',online_item:'a',online_sell_price:5});
 addToInventory(bag,{item_id:'adult_food',category:'food',online_item:'b',online_sell_price:7});
 addToInventory(bag,{item_id:'adult_food',category:'food'});
 assert.equal(bag.length,1);assert.equal(bag[0].quantity,3);assert.deepEqual(bag[0].online_items,['a','b']);assert.equal(bag[0].online_item,'a');assert.equal(bag[0].online_sell_price,5,'the front unit keeps its own price');
 assert.equal(removeUnit(bag[0],'a'),2);assert.deepEqual(bag[0].online_items,['b']);assert.equal(bag[0].online_item,'b');assert.equal(bag[0].online_sell_price,undefined,'the next unit is priced by reconcile');
 assert.ok(takeFromStack(bag,i=>i.item_id==='adult_food',1));assert.equal(bag[0].quantity,1);assert.deepEqual(stackTokens(bag[0]),['b'],'eating keeps the front right while a unit remains');
 assert.ok(takeFromStack(bag,i=>i.item_id==='adult_food',1));assert.equal(bag.length,0);
 const dupes=[{item_id:'arrows',category:'ammo',quantity:2,online_item:'x'},{item_id:'iron_dagger',category:'weapon'},{item_id:'arrows',category:'ammo',quantity:3},{item_id:'arrows',category:'ammo',online_items:['y','z']}];
 mergeStacks(dupes);assert.deepEqual(dupes.map(i=>[i.item_id,i.quantity??1]),[['arrows',6],['iron_dagger',1]]);assert.deepEqual(dupes[0].online_items,['x','y','z']);
 const imported=importLoadout({player_info:{},inventory:[{item_id:'adult_food',category:'food'},{item_id:'adult_food',category:'food'},{item_id:'adult_food',category:'food',quantity:2}]});
 assert.equal(imported.inventory.length,1);assert.equal(imported.inventory[0].quantity,4,'duplicate rows from an old save become one stack on import');
});

test('two purchases become one stack; units sell one at a time; rights follow the units through bank, sale and forgery',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.UTC(2026,8,23),c,owner='alice';const paid=[];
 const zones=createQuestZones(db,{grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:(...args)=>paid.push(args),now:()=>time,diveOptions:{log:()=>{}}});
 const body=(action,extra={})=>({action,character_id:c?.id,revision:c?.revision,request_id:randomUUID(),controller:owner,...extra});
 const send=input=>{time+=1500;const result=zones.act('token',input);c=result.character;return result;};
 const act=(action,extra)=>send(body(action,extra));
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const refresh=()=>{c=zones.read('token',c.id).character;return c;};
 const bag=()=>c.loadout.inventory;
 try{
  act('create',{name:'Snacker'});const snapshot=act('enter',{zone:'princess-rose-shops',loadout:{player_info:{level:50},inventory:[]}});
  const room=snapshot.zones.find(z=>z.id===snapshot.zone),merchant=room.fixtures.find(f=>f.id==='objNPCMerchant'),snack=merchant.offers.find(o=>o.item.category==='food');
  place(merchant.x,merchant.y+1);
  const buy=()=>{act('shop_buy',{fixture:merchant.id,offer:snack.id});zones.completePurchase(c.pendingPurchase,true);refresh();};
  buy();buy();buy();
  assert.equal(bag().length,1,'three purchases of the same snack are one row');
  const stack=bag()[0];assert.equal(stack.quantity,3);assert.equal(stack.online_items.length,3);assert.equal(stack.online_item,stack.online_items[0]);assert.equal(stack.online_sell_price,snack.price>1?Math.max(1,Math.floor(snack.item.value*0.5)):1);
  const [first,second,third]=stack.online_items;
  act('shop_sell',{fixture:merchant.id,slot:0,item_instance:first});
  assert.equal(bag()[0].quantity,2);assert.deepEqual(bag()[0].online_items,[second,third]);assert.equal(bag()[0].online_item,second);assert.ok(bag()[0].online_sell_price>0,'reconcile prices the next unit');assert.equal(paid.length,1);
  assert.throws(()=>act('shop_sell',{fixture:merchant.id,slot:0,item_instance:first}),/Only tracked/,'a sold right cannot sell again');
  act('shop_sell',{fixture:merchant.id,slot:0,item_instance:third});
  assert.equal(bag()[0].quantity,1);assert.deepEqual(bag()[0].online_items,[second]);assert.equal(paid.length,2,'any right the stack carries can be the one sold');
  buy();assert.equal(bag().length,1);assert.equal(bag()[0].quantity,2);assert.equal(bag()[0].online_items.length,2);
  const eaten=structuredClone(c.loadout);eaten.inventory[0].quantity=1; // The client ate one unit: the stack still lists both rights.
  act('loadout',{loadout:eaten});
  assert.equal(bag()[0].quantity,1);assert.deepEqual(bag()[0].online_items,[second],'a right without a unit behind it is retired');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quest_item_origins WHERE character_id=? AND status='spent'").get(c.id).n,1);
  const forged=structuredClone(c.loadout);forged.inventory[0].quantity=5;forged.inventory[0].online_items=[second,'made-up',first];
  act('loadout',{loadout:forged});
  assert.deepEqual(bag()[0].online_items,[second],'forged and sold rights are stripped, the real one survives');assert.equal(bag()[0].quantity,5,'campaign quantities stay client-trusted');
  const bankRoom=room.fixtures.find(f=>f.kind==='bank');place(bankRoom.x,bankRoom.y+1);
  act('bank_deposit',{fixture:'bank',slot:0});assert.equal(bag().length,0);
  let stored=zones.read('token',c.id).bank.items[0];assert.deepEqual(stored.item.online_items,[second]);assert.equal(stored.item.quantity,5);
  act('bank_sell',{bank_item:stored.id,item_instance:second});
  stored=zones.read('token',c.id).bank.items[0];assert.equal(stored.item.quantity,4,'a bank sale takes one unit');assert.equal(stored.item.online_items,undefined);assert.equal(paid.length,3);
  place(merchant.x,merchant.y+1);buy();place(bankRoom.x,bankRoom.y+1);
  act('bank_withdraw',{fixture:'bank',bank_item:stored.id});
  assert.equal(bag().length,1);assert.equal(bag()[0].quantity,5,'a withdrawal rejoins the stack in the bag');assert.equal(bag()[0].online_items.length,1);
  const dumpster=room.fixtures.find(f=>f.kind==='dumpster');place(dumpster.x,dumpster.y+1);
  act('item_discard',{fixture:'dumpster',slot:0,item_id:'adult_food',item_instance:bag()[0].online_item});
  assert.equal(bag().length,0,'the dumpster takes the whole stack');
 }finally{db.close();}
});
