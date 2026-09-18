import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createQuestZones,questZones} from '../server/zones.mjs';
import {hubRooms,hubData} from '../server/hubs.mjs';
import {diveData} from '../server/dive.mjs';
import {generateFloor,addFood,validateFloor} from '../server/dive-generation.mjs';
import {createQuestService} from '../server/service.mjs';

test('both lobbies connect to four shared annexes with quadruple gardens, six beds and eight shops; travel retains inventory',()=>{
 const db=new DatabaseSync(':memory:');let time=1000000;
 const zones=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:()=>{}});
 let c;const act=(action,extra={})=>{time+=1500;const result=zones.act('token',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=result.character;return result;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 try{
  act('create',{name:'Alice'});
  for(const lobby of questZones){
   const initial=act('enter',{zone:lobby.id,loadout:{player_info:{playerHealth:20},inventory:[{item_id:'adult_food'}]}});
   for(const portal of initial.zones.find(z=>z.id===lobby.id).portals){
    assert.throws(()=>act('hub_visit',{zone:portal.target}),/Stand next/);
    place(portal.style==='gap'?(portal.side==='left'?1:18):portal.x,portal.y+1);
    const room=portal.style==='gap'?act('move',{direction:portal.side==='left'?'west':'east',world_step:true}):act('hub_visit',{zone:portal.target});
    assert.equal(room.zone,portal.target);assert.equal(room.character.loadout.inventory.length,1);
    assert.throws(()=>act('start'),/lobby/);
    const definition=room.zones.find(z=>z.id===portal.target);
    if(definition.kind==='garden'){
     assert.equal(definition.width*definition.height,50*50);assert.equal(definition.exit.style,'gap');
     const fountain=definition.fixtures.find(f=>f.kind==='npc');place(fountain.x,fountain.y+1);assert.throws(()=>act('move',{direction:'north'}),/blocked/);
     place(48,25);assert.equal(act('move',{direction:'west'}).position.x,47); // The extra garden space is playable, not merely painted beyond old movement bounds.
     place(definition.width-2,20);assert.throws(()=>act('move',{direction:'east'}),/blocked/);
    }
    if(definition.kind==='beds'){
     assert.equal(definition.fixtures.length,6);
     for(const bed of definition.fixtures){place(bed.x,bed.y+1);const next=structuredClone(c.loadout);next.player_info.playerHealth=30;act('hub_rest',{fixture:bed.id,loadout:next});assert.equal(c.loadout.player_info.playerHealth,30);}
    }
    if(definition.kind==='shops'){
     assert.equal(definition.exit.style,'stairs');
     assert.equal(definition.fixtures.filter(f=>f.kind==='shop').length,8);
     assert.equal(definition.fixtures.filter(f=>f.kind==='bank').length,1);
     for(const merchant of definition.fixtures.filter(f=>f.kind==='shop')){assert.ok(merchant.offers.length);assert.ok(merchant.offers.every(o=>Number.isSafeInteger(o.price)&&o.price>0));}
    }
    if(definition.kind==='dives'){assert.equal(portal.style,'door');assert.equal(definition.portals.length,{'honeydew-lantern':5,'littlebig-clockwork':3,'princess-rose':3}[lobby.id]);assert.ok(definition.portals.every(p=>p.style==='warp'));}
    const committed=structuredClone(c.loadout);const reconnect=act('enter',{zone:lobby.id,loadout:{player_info:{},inventory:[]}});
    assert.equal(reconnect.zone,portal.target);assert.deepEqual(c.loadout,committed);
    if(definition.exit.style==='gap'){
     const e=definition.exit;place(e.side==='left'?1:definition.width-2,e.y+1);
     const returned=act('move',{direction:e.side==='left'?'west':'east',world_step:true});
     assert.equal(returned.zone,lobby.id);assert.deepEqual(returned.position,{x:definition.kind==='garden'?1:18,y:6});assert.equal(returned.character.worldTurnDue,undefined);
    }else {place(10,9);assert.equal(act('hub_visit',{zone:lobby.id}).zone,lobby.id);}
   }
  }
  assert.equal(hubRooms.length,12);
 }finally{db.close();}
});

test('food is reachable in every non-entry room and upgrading preserves furniture, old pickups and claims IDs',()=>{
 for(let i=0;i<30;i++){
  const floor=generateFloor(diveData,'food-seed-'+i),count=(floor.rooms.length-1)*diveData.config.food_per_room;
  assert.equal(floor.pickups.filter(p=>p.kind==='food').length,count);assert.equal(validateFloor(floor),true);
  const furniture=structuredClone(floor.decorations),old=floor.pickups.filter(p=>p.kind!=='food');floor.pickups=structuredClone(old);delete floor.foodVersion;
  assert.equal(addFood(diveData,floor),true);assert.deepEqual(floor.decorations,furniture);assert.deepEqual(floor.pickups.filter(p=>p.kind!=='food'),old);
  assert.equal(addFood(diveData,floor),false);assert.equal(validateFloor(floor),true);
 }
 assert.ok(diveData.food_pool.every(id=>diveData.items[id]?.category==='food')); // Dive supplies may include authored drinks outside the curated merchant stock.
});

test('annex presence and chat are shared within a room and isolated across rooms and hubs',()=>{
 const db=new DatabaseSync(':memory:');let time=1000000;
 const zones=createQuestZones(db,{now:()=>time,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:50}),adjust:()=>{}});
 const chars={};const act=(owner,action,extra={})=>{time+=100;const c=chars[owner],result=zones.act(owner,{action,controller:owner,request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});chars[owner]=result.character;return result;};
 try{
  for(const owner of ['alice','bob','carol'])act(owner,'create',{name:owner});
  act('alice','enter',{zone:'honeydew-lantern-garden'});act('bob','enter',{zone:'honeydew-lantern-garden'});act('carol','enter',{zone:'littlebig-clockwork-garden'});
  act('alice','chat',{text:'Hello garden'});
  const bob=zones.read('bob',chars.bob.id),carol=zones.read('carol',chars.carol.id);
  assert.equal(bob.peers.length,2);assert.equal(bob.chat.at(-1).text,'Hello garden');assert.equal(carol.peers.length,1);assert.equal(carol.chat.length,0);
  act('bob','hub_visit',{zone:'honeydew-lantern'});assert.equal(zones.read('bob',chars.bob.id).chat.length,0);
  assert.throws(()=>zones.read('carol',chars.alice.id),e=>e.status===404);
 }finally{db.close();}
});

test('shop debit survives lost response and restart; retries grant once, pending purchases lock inventory, full inventories and insufficient funds charge nothing',async()=>{
 mkdirSync('artifacts',{recursive:true});const directory=mkdtempSync(resolve('artifacts/hub-purchase-')),token='a'.repeat(43),owner='b'.repeat(64);
 let time=1000000,balance=1000,lose=true,deny=false,service,url;const receipts=new Map();
 const walletClient={authenticate:async()=>({owner,id:'a',client:'lidollquest',coins:balance}),credit:async(secret,body)=>{
  assert.equal(body.kind,'debit');let result=receipts.get(body.request_id);
  if(!result){if(deny)throw Object.assign(Error('Not enough coins'),{code:'insufficient_balance',status:409});balance-=body.amount;result={balance};receipts.set(body.request_id,result);}
  if(lose)throw Error('Lost response');return result;
 }};
 const start=async()=>{service=createQuestService({filename:resolve(directory,'quest.sqlite'),walletClient,now:()=>time,log:()=>{}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+service.server.address().port;};
 const stop=()=>new Promise(r=>service.server.close(r));let c;
 const send=async body=>{time+=1500;const r=await fetch(url+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const command=(action,extra={})=>({action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});
 const act=async(action,extra={})=>{const r=await send(command(action,extra));assert.equal(r.status,200,JSON.stringify(r.data));c=r.data.character;return r.data;};
 await start();try{
  await act('create',{name:'Shopper'});let snapshot=await act('enter',{zone:'honeydew-lantern-shops',loadout:{player_info:{},inventory:[]}});
  const merchant=snapshot.zones.find(z=>z.id===snapshot.zone).fixtures[0],offer=merchant.offers[0];
  service.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(merchant.x,merchant.y+1,c.id);
  const buy=command('shop_buy',{fixture:merchant.id,offer:offer.id});let result=await send(buy);assert.equal(result.status,200);c=result.data.character;
  assert.ok(c.pendingPurchase);assert.equal(c.loadout.inventory.length,0);assert.equal(balance,1000-offer.price);
  assert.equal((await send(command('loadout',{loadout:{player_info:{},inventory:[]}}))).status,409);
  await stop();lose=false;await start();result=await send(buy);assert.equal(result.status,200);c=result.data.character;
  assert.equal(c.pendingPurchase,undefined);assert.equal(c.loadout.inventory.length,1);assert.equal(receipts.size,1);assert.equal(balance,1000-offer.price);
  result=await send(buy);assert.equal(result.data.character.loadout.inventory.length,1);assert.equal(receipts.size,1);
  deny=true;await act('shop_buy',{fixture:merchant.id,offer:offer.id});assert.equal(c.loadout.inventory.length,1);assert.match(c.hubNotice,/Not enough/);
  const full={...c.loadout,inventory:Array.from({length:99},()=>({item_id:'adult_food'}))};await act('loadout',{loadout:full});
  result=await send(command('shop_buy',{fixture:merchant.id,offer:offer.id}));assert.equal(result.status,409);assert.match(result.data.error_description,/Inventory full/);assert.equal(receipts.size,1);
 }finally{await stop();}
});
