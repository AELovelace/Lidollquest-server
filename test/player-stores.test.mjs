import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createPlayerStores,validateShopAppearance} from '../server/player-stores.mjs';
import {createItemOrigins} from '../server/item-origins.mjs';
import {createHubPurchases} from '../server/hubs.mjs';
import {addToInventory} from '../server/loadout.mjs';
import {craftCatalog} from '../server/crafting.mjs';

const appearance={version:1,slots:{base:'piko_base',hair:'piko_hair',torso:'piko_dress'},facing:0};
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,name TEXT,state TEXT,revision INTEGER);');
 const origins=createItemOrigins(db),credits=[];let stores;
 const base={id:'town',kind:'hub',width:20,height:20,spawn:{x:1,y:1},walls:Array.from({length:20},()=>Array(20).fill(0)),fixtures:[]};
 const hooks={},purchases=createHubPurchases(db,{now:()=>1000,origins,hooks});stores=createPlayerStores(db,{origins,adjust:(...a)=>credits.push(a),zone:()=>stores.decorate(base)});hooks.playerStore=stores.settle;
 const chars={};for(const id of ['owner','buyer','visitor']){const c={id,owner:id,name:id},s={loadout:{player_info:{level:1},inventory:[]}};db.prepare('INSERT INTO quest_characters VALUES (?,?,?,?,0)').run(id,id,id,JSON.stringify(s));chars[id]=c;}
 const state=id=>JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id).state);
 function act(id,action,extra={},p={zone:'town',x:6,y:5}){const c=chars[id],s=state(id);db.exec('BEGIN');try{stores.act(c,s,{request_id:randomUUID(),action,...extra},p);db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),id);db.exec('COMMIT');return s;}catch(e){db.exec('ROLLBACK');throw e;}}
 function mint(id,item,count=1){const s=state(id);for(let i=0;i<count;i++)addToInventory(s.loadout.inventory,origins.mint(id,structuredClone(item)));db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),id);}
 function open(){const s=act('owner','store_create',{x:5,y:5,name:'Test shop',appearance});purchases.complete(s.pendingPurchase,true);return stores.view(chars.owner,{zone:'town'}).mine;}
 return {db,origins,credits,stores,purchases,chars,state,act,mint,open};
}
test('one character owns one paid shop and its appearance uses registered layers',()=>{
 const f=fixture();try{const s=f.open();assert.equal(s.name,'Test shop');assert.equal(s.appearance.slots.base,'piko_base');assert.throws(()=>f.act('owner','store_create',{x:8,y:8,appearance}),/already owns/);assert.throws(()=>validateShopAppearance({...appearance,slots:{base:'arbitrary_url'}}),/Unsupported/);}finally{f.db.close();}
});
test('reserved stock cannot be oversold; wallet replay transfers one copy and pays once',()=>{
 const f=fixture();try{const shop=f.open();f.mint('owner',craftCatalog.steel,2);f.act('owner','store_deposit',{index:0,amount:2});const row=f.stores.view(f.chars.owner,{zone:'town'}).mine.stock[0];f.act('owner','store_list',{offer:row.id,price:25});
 const pending=f.act('buyer','store_buy',{shop:shop.id,offer:row.id,amount:2,price:25});assert.throws(()=>f.act('visitor','store_buy',{shop:shop.id,offer:row.id,amount:1,price:25}),/changed/);
 f.purchases.complete(pending.pendingPurchase,true);f.purchases.complete(pending.pendingPurchase,true);assert.equal(f.state('buyer').loadout.inventory[0].quantity,2);assert.equal(f.credits.length,1);assert.equal(f.credits[0][2],50);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM quest_item_origins WHERE character_id='buyer' AND status='held'").get().n,2);
 }finally{f.db.close();}
});
test('declined purchase restores stock and funded buy orders spend only their escrow',()=>{
 const f=fixture();try{const shop=f.open();f.mint('owner',craftCatalog.iron);f.act('owner','store_deposit',{index:0,amount:1});const row=f.stores.view(f.chars.owner,{zone:'town'}).mine.stock[0];f.act('owner','store_list',{offer:row.id,price:10});const buy=f.act('buyer','store_buy',{shop:shop.id,offer:row.id,amount:1,price:10});f.purchases.complete(buy.pendingPurchase,false);assert.equal(f.stores.view(f.chars.owner,{zone:'town'}).mine.stock[0].quantity,1);
 const order=f.act('owner','store_order',{item_id:'steel',amount:3,price:7});f.purchases.complete(order.pendingPurchase,true);const o=f.stores.view(f.chars.owner,{zone:'town'}).mine.orders[0];f.mint('buyer',craftCatalog.steel,2);f.act('buyer','store_sell',{shop:shop.id,offer:o.id,index:0,amount:2,price:7});assert.equal(f.credits.at(-1)[2],14);assert.equal(f.stores.view(f.chars.owner,{zone:'town'}).mine.orders[0].funds,7);f.act('owner','store_cancel_order',{offer:o.id});assert.equal(f.credits.at(-1)[2],7);
 }finally{f.db.close();}
});
test('partial listings retain unlisted stock and public cards never expose ownership tokens',()=>{
 const f=fixture();try{f.open();f.mint('owner',craftCatalog.wood,5);f.act('owner','store_deposit',{index:0,amount:5});const row=f.stores.view(f.chars.owner,{zone:'town'}).mine.stock[0];
  f.act('owner','store_list',{offer:row.id,amount:2,price:9});const view=f.stores.view(f.chars.owner,{zone:'town'});assert.equal(view.mine.stock.find(r=>!r.price).quantity,3);assert.equal(view.stores[0].listings[0].quantity,2);assert.equal(view.stores[0].listings[0].item.online_item,undefined);
  f.act('owner','store_withdraw',{offer:row.id,amount:3});assert.equal(f.state('owner').loadout.inventory[0].quantity,3);assert.equal(f.stores.view(f.chars.owner,{zone:'town'}).mine.stock[0].quantity,2);
 }finally{f.db.close();}
});
