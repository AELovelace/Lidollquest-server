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

test('every lobby connects to its shared annexes with 50x50 districts, six beds and eight shops; travel retains inventory',()=>{ // Honeydew Village IS its 50x50 district: its merchants stand in the town and its doorsteps lead into the Inn and the Community Hall. // Honeydew Village IS its 50x50 district: its merchants stand in the town and its doorsteps lead into the Inn and the Community Hall.
 const db=new DatabaseSync(':memory:');let time=1000000;
 const zones=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:()=>{}});
 let c;const act=(action,extra={})=>{time+=1500;const result=zones.act('token',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=result.character;return result;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 try{
  act('create',{name:'Alice'});
  const beside=(g,w,h)=>({left:{x:1,y:g.y+(g.h??1)-1,direction:'west'},right:{x:w-2,y:g.y+(g.h??1)-1,direction:'east'},top:{x:g.x,y:1,direction:'north'},bottom:{x:g.x,y:h-2,direction:'south'}})[g.side]; // Interior tile next to a wall opening, and the step into it.
  for(const lobby of questZones){
   const initial=act('enter',{zone:lobby.id,loadout:{player_info:{playerHealth:20},inventory:[{item_id:'adult_food'}]}});
   const size=[lobby.width??20,lobby.height??12];
   for(const portal of initial.zones.find(z=>z.id===lobby.id).portals){
    if(portal.target.startsWith('dive-')){ // Rose Court's garden wall opens straight onto the Tundra where its Beds door used to be.
     const step=beside(portal,...size);place(step.x,step.y);const crossed=act('move',{direction:step.direction,world_step:true});
     assert.equal(crossed.zone,portal.target);assert.equal(c.loadout.inventory.length,1);assert.equal(c.dive.returnZone,lobby.id);
     const home=act('dive_exit');assert.equal(home.zone,lobby.id);assert.deepEqual(home.position,{x:portal.side==='left'?portal.x+1:portal.x-1,y:portal.y+1}); // Back one tile inside the same lobby-wall gate (Rose: right wall; Honeydew: both walls).
     continue;
    }
    assert.throws(()=>act('hub_visit',{zone:portal.target}),/Stand next/);
    const step=portal.style==='gap'?beside(portal,...size):null;place(step?step.x:portal.x,step?step.y:portal.y+1);
    const room=step?act('move',{direction:step.direction,world_step:true}):act('hub_visit',{zone:portal.target});
    assert.equal(room.zone,portal.target);assert.equal(room.character.loadout.inventory.length,1);
    assert.throws(()=>act('start'),/lobby/);
    const definition=room.zones.find(z=>z.id===portal.target);
    if(definition.kind==='garden'){
     assert.equal(definition.width*definition.height,50*50);assert.equal(definition.exit.style,'gap');
     const fountain=definition.fixtures.find(f=>f.kind==='npc');place(fountain.x,fountain.y+1);assert.throws(()=>act('move',{direction:'north'}),/blocked/);
     place(48,25);assert.equal(act('move',{direction:'west'}).position.x,47); // The extra garden space is playable, not merely painted beyond old movement bounds.
     place(definition.width-2,20);assert.throws(()=>act('move',{direction:'east'}),/blocked/);
     if(lobby.id==='princess-rose'){ // The Castle keeps Rose Court's six beds in a fixed dormitory beside its entrance.
      const beds=definition.fixtures.filter(f=>f.kind==='bed');assert.equal(beds.length,6);assert.ok(beds.every(b=>b.x>=39&&b.x<=47&&b.y>=13&&b.y<=19));
      for(const bed of beds){place(bed.x,bed.y+1);const next=structuredClone(c.loadout);next.player_info.playerHealth=30;act('hub_rest',{fixture:bed.id,loadout:next});assert.equal(c.loadout.player_info.playerHealth,30);}
      place(43,22);assert.equal(act('move',{direction:'north'}).position.y,21);assert.equal(act('move',{direction:'north'}).position.y,20);assert.equal(act('move',{direction:'north'}).position.y,19); // The dormitory doorway leads straight up from the entry area.
     }
    }
    if(definition.kind==='beds'){
     const beds=definition.fixtures.filter(f=>f.kind==='bed');assert.equal(beds.length,6); // The Honeydew Inn also has an innkeeper.
     if(lobby.id==='honeydew-lantern'){assert.equal(portal.style,'door');assert.deepEqual(definition.exit,{x:10,y:18,style:'door'});assert.equal(definition.width*definition.height,400);assert.ok(definition.fixtures.some(f=>f.id==='innkeeper'));} // The Inn is the campaign Room5_Inn, entered from its doorstep on the village square.
     for(const bed of beds){place(bed.x,bed.y+1);const next=structuredClone(c.loadout);next.player_info.playerHealth=30;act('hub_rest',{fixture:bed.id,loadout:next});assert.equal(c.loadout.player_info.playerHealth,30);}
    }
    if(definition.kind==='shops'){
     assert.equal(definition.exit.style,'stairs');
     assert.equal(definition.fixtures.filter(f=>f.kind==='shop').length,8);
     assert.equal(definition.fixtures.filter(f=>f.kind==='bank').length,1);
     for(const merchant of definition.fixtures.filter(f=>f.kind==='shop')){assert.ok(merchant.offers.length);assert.ok(merchant.offers.every(o=>Number.isSafeInteger(o.price)&&o.price>0));}
    }
    if(definition.kind==='dives'&&lobby.id==='honeydew-lantern'){assert.equal(portal.style,'door');assert.deepEqual(definition.exit,{x:10,y:18,style:'door'});assert.deepEqual(definition.portals.map(p=>[p.target,p.style,p.x,p.y]),[['dive-nursery','warp',2,4],['dive-school','warp',5,4],['dive-forest','warp',8,4]]);} // The Community Hall: three pads in the old companion room (top-left), no side gaps.
    else if(definition.kind==='dives'){assert.equal(portal.style,'gap');assert.equal(portal.side,'top');assert.deepEqual(definition.exit,{x:9,y:11,w:2,h:1,style:'gap',side:'bottom'});assert.equal(definition.portals.length,{'littlebig-clockwork':3,'princess-rose':2}[lobby.id]);assert.ok(definition.portals.every(p=>['warp','gap'].includes(p.style)));assert.deepEqual(definition.portals.filter(p=>p.style==='gap').map(p=>p.side+':'+p.target),{'littlebig-clockwork':['left:dive-desert'],'princess-rose':[]}[lobby.id]);} // West-to-east: Rose | Tundra | Lantern | Desert | LittleBig; Rose's Tundra gap is in its garden wall, not its hall.
    const committed=structuredClone(c.loadout);const reconnect=act('enter',{zone:lobby.id,loadout:{player_info:{},inventory:[]}});
    assert.equal(reconnect.zone,portal.target);assert.deepEqual(c.loadout,committed);
    if(definition.exit.style==='gap'){
     const e=beside(definition.exit,definition.width,definition.height);place(e.x,e.y);
     const returned=act('move',{direction:e.direction,world_step:true});
     assert.equal(returned.zone,lobby.id);assert.deepEqual(returned.position,(lobby.id==='princess-rose'?{garden:{x:1,y:13},dives:{x:9,y:1}}:{garden:{x:1,y:6},beds:{x:18,y:6},dives:{x:9,y:1}})[definition.kind]); /* Arrive one tile inside the matching lobby opening; Rose's castle gate is on its left wall. */assert.equal(returned.character.worldTurnDue,undefined);
    }else if(definition.exit.style==='door'){place(10,17);const returned=act('move',{direction:'south',world_step:true});assert.equal(returned.zone,lobby.id);assert.deepEqual(returned.position,{x:portal.x,y:portal.y+1});assert.equal(returned.character.worldTurnDue,undefined);} /* Walking onto the village room's door tile steps back outside, one tile below the doorstep. */
    else {place(10,9);assert.equal(act('hub_visit',{zone:lobby.id}).zone,lobby.id);}
   }
  }
  assert.equal(hubRooms.length,9); // Rose: Castle, market, hall. Honeydew: Inn and Community Hall (the town is its own garden and market). Clockwork: garden, beds, market, hall.
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
  act('alice','enter',{zone:'littlebig-clockwork-garden'});act('bob','enter',{zone:'littlebig-clockwork-garden'});act('carol','enter',{zone:'princess-rose-garden'});
  act('alice','chat',{text:'Hello garden'});
  const bob=zones.read('bob',chars.bob.id),carol=zones.read('carol',chars.carol.id);
  assert.equal(bob.peers.length,2);assert.equal(bob.chat.at(-1).text,'Hello garden');assert.equal(carol.peers.length,1);assert.equal(carol.chat.length,0);
  act('bob','hub_visit',{zone:'littlebig-clockwork'});assert.equal(zones.read('bob',chars.bob.id).chat.length,0);
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
  await act('create',{name:'Shopper'});let snapshot=await act('enter',{zone:'littlebig-clockwork-shops',loadout:{player_info:{},inventory:[]}});
  const merchant=snapshot.zones.find(z=>z.id===snapshot.zone).fixtures[0],offer=merchant.offers[0];
  service.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(merchant.x,merchant.y+1,c.id);
  const buy=command('shop_buy',{fixture:merchant.id,offer:offer.id});let result=await send(buy);assert.equal(result.status,200);c=result.data.character;
  assert.ok(c.pendingPurchase);assert.equal(c.loadout.inventory.length,0);assert.equal(balance,1000-offer.price);
  assert.equal((await send(command('loadout',{loadout:{player_info:{},inventory:[]}}))).status,409);
  await stop();lose=false;await start();result=await send(buy);assert.equal(result.status,200);c=result.data.character;
  assert.equal(c.pendingPurchase,undefined);assert.equal(c.loadout.inventory.length,1);assert.equal(receipts.size,1);assert.equal(balance,1000-offer.price);
  result=await send(buy);assert.equal(result.data.character.loadout.inventory.length,1);assert.equal(receipts.size,1);
  deny=true;await act('shop_buy',{fixture:merchant.id,offer:offer.id});assert.equal(c.loadout.inventory.length,1);assert.match(c.hubNotice,/Not enough/);
  const full={...c.loadout,inventory:Array.from({length:99},()=>({item_id:'iron_dagger',category:'weapon'}))};await act('loadout',{loadout:full});
  const stacks=['food','drink','ammo'],snack=merchant.offers.find(o=>stacks.includes(o.item.category)),gear=merchant.offers.find(o=>!stacks.includes(o.item.category));
  if(snack){result=await send(command('shop_buy',{fixture:merchant.id,offer:snack.id}));assert.equal(result.status,200,'a stackable snack never needs a free slot');c=result.data.character;} // The unit lands once the wallet debit settles, as every purchase does.
  result=await send(command('shop_buy',{fixture:merchant.id,offer:gear.id}));assert.equal(result.status,409);assert.match(result.data.error_description,/Inventory full/);assert.equal(receipts.size,1); /* deny is still set above, so the snack purchase settled as Not enough coins: no new receipt. */
 }finally{await stop();}
});
