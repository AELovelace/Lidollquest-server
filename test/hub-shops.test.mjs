import test from 'node:test';
import assert from 'node:assert/strict';
import {hubRooms,villageRooms} from '../server/hubs.mjs';

// Merchant shelves (2026-09-24): 16 wares each, arrows always at Grog's, and Bramble the reagent seller
// with a small rotating shelf beside every hub cauldron. Its own file: the shop roller keeps module state.
test('shelves hold 16, Grog always has arrows, and Bramble rotates a small reagent shelf beside every cauldron',async()=>{
 const {shopOffers,findShop,hubData}=await import('../server/hubs.mjs');
 const {generateDistrict:gen,districtData:dd}=await import('../server/hub-districts.mjs');
 const day=86400000,t=Date.parse('2026-09-24T12:00:00Z');
 assert.equal(hubData.config.stock_size,16,'every merchant shows 16 wares');
 for(let d=0;d<10;d++){
  const grog=shopOffers('honeydew-lantern',findShop('objNPCWeaponsmith'),t+d*day,5).map(o=>o.item.item_id);
  assert.equal(grog[0],'arrows','Grog always stocks arrows first');
 }
 assert.equal(shopOffers('honeydew-lantern',findShop('objNPCMerchant'),t,5).length,16);
 const bramble=findShop('objNPCReagentVendor');
 assert.ok(bramble&&!hubData.shops.includes(bramble),'Bramble is her own shop, never in Market Halls or storefronts');
 assert.ok(bramble.pool.every(id=>hubData.items[id]&&(hubData.items[id].category==='ingredient'||id==='alchemy_kit')),'reagents and the kit only');
 assert.ok(!bramble.pool.some(id=>(hubData.items[id].alchemy?.tier??0)>=4),'tier 4-5 treasures stay in chests');
 const seen=new Set();
 for(let d=0;d<7;d++){const shelf=shopOffers('honeydew-lantern-dives',bramble,t+d*day,5);assert.equal(shelf.length,bramble.stock_size);assert.ok(shelf.length<bramble.pool.length/4,'never most of the range at once');shelf.forEach(o=>seen.add(o.item.item_id));}
 assert.ok(seen.size>bramble.stock_size,'the shelf rotates day to day');
 const beside=(fixtures)=>{const pot=fixtures.find(f=>f.kind==='cauldron'),b=fixtures.find(f=>f.id==='objNPCReagentVendor');return pot&&b&&Math.abs(pot.x-b.x)+Math.abs(pot.y-b.y)<=3;};
 assert.ok(beside(villageRooms.dives.fixtures),'Community Hall');
 assert.ok(beside(hubRooms.find(z=>z.id==='littlebig-clockwork-beds').fixtures),'LittleBig Inn');
 for(const edition of ['2026-09','2027-03']){const f=gen(dd.districts.find(x=>x.hub==='princess-rose'),{edition,ends:0});assert.ok(beside(f.fixtures),'Castle dormitory '+edition);}
});
