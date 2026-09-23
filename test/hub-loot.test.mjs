import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {hubData,hubRooms,shopOffers,hubDefinition,configureShopLoot} from '../server/hubs.mjs';
import {createLootStore} from '../server/loot-store.mjs';
import {createLootRoller,WEARABLE_CATEGORIES} from '../server/loot.mjs';

// Hub shopkeepers stock rolled Adjective + Item + Rarity copies: the same table as chests,
// shop luck (never epic or legendary), the hub's level band, and the rolled value as the price.

const loot=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8')).loot;
const shopsHub=hubRooms.find(r=>r.id==='princess-rose-shops');
const merchant=hubData.shops.find(s=>s.id==='objNPCMerchant');
const DAY=86400000;

test('daily stock is deterministic, rolled with shop luck, and priced from the rolled value',()=>{
 configureShopLoot(null);
 const a=shopOffers(shopsHub.id,merchant,5*DAY+1),b=shopOffers(shopsHub.id,merchant,5*DAY+40000);
 assert.deepEqual(a,b,'same day, same stock for everyone');
 assert.notDeepEqual(a.map(o=>o.item.name),shopOffers(shopsHub.id,merchant,6*DAY+1).map(o=>o.item.name),'the next day re-rolls');
 const tiers=new Set();
 for(let day=0;day<60;day++)for(const offer of shopOffers(shopsHub.id,merchant,day*DAY+1)){
  const item=offer.item;
  assert.equal(offer.price,Math.max(1,Math.ceil(item.value*hubData.config.coin_price_multiplier)),'price follows the rolled value');
  if(!WEARABLE_CATEGORIES.includes(item.category)){assert.equal(item.loot,undefined,'meals and potions never roll');continue;}
  assert.equal(item.loot.rolled,true);
  tiers.add(item.loot.rarity);
  assert.ok(!['epic','legendary'].includes(item.loot.rarity),'shop luck never hands out '+item.loot.rarity);
  assert.ok(item.loot.ilvl>=7&&item.loot.ilvl<=10,'Rose Court shops sit in the princess-rose band');
 }
 assert.ok(tiers.has('uncommon')||tiers.has('rare'),'some stock carries an adjective');
 const definition=hubDefinition(shopsHub,5*DAY+1);
 assert.deepEqual(definition.fixtures.find(f=>f.id===merchant.id).offers,a,'the snapshot fixture carries the rolled offers');
});

test('a gamemaster retune reaches the next day of stock without a restart',()=>{
 const store=createLootStore(new DatabaseSync(':memory:'),{now:()=>1700000000000});
 configureShopLoot(store);
 const before=shopOffers(shopsHub.id,merchant,9*DAY+1);
 const rarity=structuredClone(loot.tuning.rarity);
 for(const tier of ['uncommon','rare','epic','legendary'])rarity[tier].weight=0;
 store.tune({rarity},'gm');
 const after=shopOffers(shopsHub.id,merchant,9*DAY+1);
 assert.ok(after.every(o=>!o.item.loot||o.item.loot.rarity==='common'),'everything common after the retune');
 assert.notDeepEqual(before,after);
 configureShopLoot(null);
 assert.deepEqual(shopOffers(shopsHub.id,merchant,9*DAY+1),before,'the shipped table is back');
 assert.equal(createLootRoller(loot).routeLevel('littlebig-clockwork',1),60,'city shops sell level 60 gear');
});
