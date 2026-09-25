import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,ARCADIA_ZONE} from '../server/zones.mjs';
import {hubData} from '../server/hubs.mjs';
import {districtData,generateDistrict} from '../server/hub-districts.mjs';
import {arcadiaLook,littleTax,taxedPrice,inArcadia} from '../server/arcadia-rules.mjs';
import {DEFAULT_TUNING} from '../server/loot.mjs';

// Arcadia's Big Rules (2026-09-24), server side: the little tax on shop prices (and refusing visibly wet or messy
// customers), coin-turnstile pay toilets settled through the durable purchase path, and the smog and shift whistle
// data the client reads. Scrutiny (extra Dignity and Shame) is client-side; see python tests/test_arcadia_client.py.
const items=hubData.equipment,arcadia=districtData.districts.find(d=>d.hub===ARCADIA_ZONE);
const grownUp={player_info:{equipped_torso:'leather_vest',equipped_pants:'blue_jeans'},inventory:[]};
const padded={player_info:{equipped_torso:'leather_vest',equipped_pants:'blue_jeans',equipped_panties:'diaper',panties_bulk:3},inventory:[]}; // Jeans hide nothing thicker than bulk 1.
const soggy={player_info:{...padded.player_info,diaper_wet_absorbed:1},inventory:[]};

test('the little tax: grown-ups pay list price, visible padding or a childish outfit pays more, a soggy customer is refused',()=>{
 assert.ok(inArcadia('arcadia-foundry')&&inArcadia('arcadia-foundry-tower')&&!inArcadia('utopia-arcanum'));
 const adult=arcadiaLook(grownUp,items);assert.equal(adult.showing,false);assert.ok(adult.childish<5);
 assert.deepEqual(littleTax(adult,DEFAULT_TUNING),{refuse:false,percent:0,reason:''});
 const little=littleTax(arcadiaLook(padded,items),DEFAULT_TUNING);assert.equal(little.percent,50);assert.equal(little.reason,'visible padding');
 assert.equal(taxedPrice(10,little),15);assert.equal(taxedPrice(1,little),2);assert.equal(taxedPrice(10,{percent:0}),10); // Rounded up, never below list.
 const cute=littleTax(arcadiaLook({player_info:{equipped_torso:'overalls',equipped_pants:'skirtP1'}},items),DEFAULT_TUNING);assert.equal(cute.reason,'a childish outfit'); // No padding at all, but dressed like a little.
 assert.equal(littleTax(arcadiaLook(soggy,items),DEFAULT_TUNING).refuse,true);
 assert.equal(littleTax(arcadiaLook({player_info:{...grownUp.player_info,had_wet_accident:1}},items),DEFAULT_TUNING).refuse,true); // Wet jeans are plain to see too.
 assert.equal(littleTax(arcadiaLook(padded,items),{...DEFAULT_TUNING,arcadia_little_tax_percent:0}).percent,0); // A GM can switch the tax off.
});

test('smog patches sit on the smokestack yards and the whistle schedule rides on the floor',()=>{
 const f=generateDistrict(arcadia,{edition:'2026-09',ends:0});
 assert.equal(f.smog.patches.length,arcadia.layout.yard_count);
 for(const patch of f.smog.patches)assert.ok(f.rooms.some(r=>r.kind==='stack_yard'&&r.cx===patch.x&&r.cy===patch.y));
 assert.deepEqual(f.whistle,arcadia.features.whistle);
 assert.equal(f.fixtures.filter(x=>x.kind==='toilet'&&x.style==='paytoilet').length,arcadia.lobby.pay_toilets,'street pay toilets');
 assert.equal(generateDistrict(districtData.districts.find(d=>d.hub==='utopia-arcanum'),{edition:'2026-09',ends:0}).smog,undefined,'only Arcadia chokes');
});

test('in Arcadia: shops show and charge the little tax, refuse soggy customers, and the pay toilet settles through the wallet',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:()=>{},diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=350;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const zoneOf=s=>s.zones.find(z=>z.id===s.zone);
 const wear=loadout=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);s.loadout.player_info={...s.loadout.player_info,...loadout.player_info};db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);};
 try{
  act('create',{name:'Alice'});
  let city=act('enter',{zone:ARCADIA_ZONE,loadout:{player_info:{playerHealth:50,playerHealthMax:50,level:10},inventory:[]}});
  wear(grownUp);city=api.read('',c.id);
  const shop=zoneOf(city).fixtures.find(f=>f.kind==='shop'),list=shop.offers[0].price;assert.equal(shop.little_tax.percent,0);
  wear(padded);city=api.read('',c.id);
  const taxed=zoneOf(city).fixtures.find(f=>f.id===shop.id);assert.equal(taxed.little_tax.reason,'visible padding');assert.equal(taxed.offers[0].price,Math.max(1,Math.ceil(list*1.5)),'the client is shown the taxed price');
  place(shop.x,shop.y+1);act('shop_buy',{fixture:shop.id,offer:shop.offers[0].id});
  assert.equal(db.prepare('SELECT price FROM hub_purchases WHERE id=?').get(c.pendingPurchase).price,taxed.offers[0].price,'and charged exactly that');
  api.completePurchase(c.pendingPurchase,true);c=api.read('',c.id).character;assert.match(c.hubNotice,/little tax \+50% for visible padding/);
  wear(soggy);assert.throws(()=>act('shop_buy',{fixture:shop.id,offer:shop.offers[0].id}),/Not in that state/);
  wear({player_info:{diaper_wet_absorbed:0}});
  const door=zoneOf(api.read('',c.id)).portals.find(p=>p.target===ARCADIA_ZONE+'-tower');place(door.x,door.y);
  const hall=act('hub_visit',{zone:ARCADIA_ZONE+'-tower'}),loo=zoneOf(hall).fixtures.find(f=>f.style==='paytoilet');
  place(1,7);assert.throws(()=>act('pay_toilet',{fixture:loo.id}),/Stand next to the pay toilet/);
  place(loo.x,loo.y+2);act('pay_toilet',{fixture:loo.id}); // Beside the lower half of the 1x2 cubicle.
  assert.equal(db.prepare('SELECT price FROM hub_purchases WHERE id=?').get(c.pendingPurchase).price,DEFAULT_TUNING.arcadia_toilet_price);
  api.completePurchase(c.pendingPurchase,false);c=api.read('',c.id).character;assert.equal(c.toiletPaid,undefined);assert.match(c.hubNotice,/turnstile will not budge/); // Broke: still waiting outside.
  act('pay_toilet',{fixture:loo.id});api.completePurchase(c.pendingPurchase,true);c=api.read('',c.id).character;
  assert.equal(c.toiletPaid.fixture,loo.id);assert.ok(c.toiletPaid.at>0);assert.match(c.hubNotice,/turnstile clunks round/);
  assert.throws(()=>act('pay_toilet',{fixture:'cauldron'}),/not a pay toilet/);
 }finally{api.close();db.close();}
});
