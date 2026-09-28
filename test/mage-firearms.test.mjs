import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {shopOffers,findShop} from '../server/hubs.mjs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';

const guns=['arcane_pistol','star_rifle','mana_cannon'];
const read=name=>JSON.parse(readFileSync(new URL('../server/'+name,import.meta.url),'utf8'));
const baseline=read('dive-data.json');
const routes=[baseline,...read('campaign-dives-data.json').routes,...read('full-dungeons-data.json').routes,
 read('desert-data.json'),read('haunted-woods-data.json'),read('spooky-mansion-data.json')];

test('Grog offers every mage firearm across daily shelf rotations with intact MP mechanics',()=>{
 const grog=findShop('objNPCWeaponsmith');
 for(let day=0;day<10;day++){
  const offers=shopOffers('honeydew-lantern',grog,Date.parse('2026-09-28T12:00:00Z')+day*86400000,10);
  for(const id of guns){
   const offer=offers.find(o=>o.item.item_id===id);
   assert.ok(offer,`${id} missing on day ${day}`);
   assert.equal(offer.item.weapon_class,'gun');
   assert.equal(offer.item.mp_cost,baseline.items[id].mp_cost);
   assert.equal(offer.item.power,baseline.items[id].power);
   assert.ok(offer.price>0);
  }
 }
});

test('all campaign dungeon exports can roll firearms without replacing them with generated clothing',()=>{
 for(const data of routes){
  const pool=data.item_pool??Object.keys(data.items),roll=createDiveLootRoller(data,{lootTable:baseline.loot,lootBases:baseline.bases});
  for(const id of guns){
   assert.ok(pool.includes(id),`${data.config.route}: ${id} excluded from general loot`);
   const item=roll('firearms','mage',{id:'target-'+id,item_id:id},{},1);
   assert.equal(item.item_id,id);
   assert.equal(item.weapon_class,'gun');
   assert.equal(item.mp_cost,baseline.items[id].mp_cost);
   assert.equal(item.power,baseline.items[id].power);
  }
 }
});

test('ordinary unforced chest rolls actually reach all three firearm definitions',()=>{
 const roll=createDiveLootRoller(baseline),seen=new Set();
 for(let n=0;n<20000&&seen.size<guns.length;n++){
  const item=roll('firearms','mage',{id:'natural-'+n},{},1);
  if(guns.includes(item.item_id))seen.add(item.item_id);
 }
 assert.deepEqual([...seen].sort(),[...guns].sort()); // catches registry-only additions absent from the actual loot path
});
