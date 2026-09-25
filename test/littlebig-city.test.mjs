import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {hubCatalog,hubRooms,hubPortals,dungeonPortals,wildernessGates,hubData,STORE} from '../server/hubs.mjs';
import {districtData,districtZone,generateDistrict,reachableDistrict,storeSlug} from '../server/hub-districts.mjs';

// LittleBigCity (2026-09-23): the littlebig-clockwork lobby is the 60x60 monthly city itself. Its west wall opens onto
// Dustbreak Desert; the LittleBig Inn and the Clockwork Coliseum stand on the central plaza; every merchant has a
// storefront on a city-block facade whose sidewalk doorstep leads into a store room of their own. Blocks change
// monthly, so the store doors move with them while the plaza pair stays put.
const city=districtData.districts.find(d=>d.hub==='littlebig-clockwork');
const covers=(p,x,y)=>x>=p.x&&y>=p.y&&x<p.x+(p.span_w??1)&&y<p.y+(p.span_h??1);

test('LittleBigCity is a 60x60 lobby with a west Desert gate, plaza doorsteps and eight storefronts that follow the street plan',()=>{
 assert.equal(districtZone(city),'littlebig-clockwork');assert.equal(hubCatalog.find(h=>h.id==='littlebig-clockwork').name,'LittleBigCity');
 assert.deepEqual(hubRooms.filter(r=>r.parent==='littlebig-clockwork').map(r=>r.id),['littlebig-clockwork-beds','littlebig-clockwork-dives','littlebig-clockwork-temple',...hubData.shops.map(s=>'littlebig-clockwork-store-'+storeSlug(s))]);
 assert.deepEqual(hubPortals('littlebig-clockwork').map(p=>[p.target,p.style,p.x,p.y]),[['dive-desert','gap',0,29],['dive-seafoam-coast','gap',29,59],['littlebig-clockwork-beds','door',28,28],['littlebig-clockwork-dives','door',33,28],['littlebig-clockwork-temple','door',28,33]]); // Nyx's temple too. Without a resolved map only the fixed openings are known.
 assert.deepEqual(wildernessGates('littlebig-clockwork').map(g=>g.target),['dive-desert','dive-seafoam-coast']); // West onto the Desert, south onto the Seafoam Coast.assert.deepEqual(dungeonPortals('littlebig-clockwork').map(p=>p.target),['dive-mansion','dive-hospital']);
 const doors=new Set();
 for(let n=0;n<30;n++){
  const f=generateDistrict(city,{edition:'city-'+n,ends:0}),seen=reachableDistrict(f);
  assert.equal(f.width,60);assert.equal(f.height,60);assert.deepEqual(f.spawn,{x:30,y:32});assert.deepEqual(f.exit,{x:2,y:27,style:'stairs'});
  assert.equal(f.walls[29][0]+f.walls[30][0],0,'west gate open');assert.equal(f.walls[29][59]+f.walls[30][59],2,'no east gate: LittleBig is the east end of the world');
  for(const [x,y] of [[1,29],[1,30],[28,28],[28,29],[33,28],[33,29],[30,32],[2,27]])assert.ok(seen.has(x+','+y),`tile ${x},${y} reachable in edition ${n}`);
  assert.deepEqual(f.fixtures.filter(p=>['inn','coliseum'].includes(p.id)).map(p=>[p.sprite,p.x,p.y]),[['sprCityFacadeApartment',27,25],['sprCityFacadeMed1',32,26]]);
  assert.equal(f.doorsteps.length,8);assert.deepEqual(f.doorsteps.map(d=>d.target),hubData.shops.map(s=>'littlebig-clockwork-store-'+storeSlug(s)));
  for(const d of f.doorsteps){
   assert.ok(seen.has(d.x+','+d.y),'doorstep '+d.name+' is on reachable street');assert.equal(d.style,'door');assert.equal(d.threshold,true);
   const facade=f.fixtures.find(p=>p.id==='store-'+storeSlug({name:d.name.split("'")[0]}));assert.ok(facade&&facade.sprite==='sprCityFacadeStorefront','each doorstep has its storefront');
   assert.ok(Math.abs(facade.y+(d.y>facade.y?facade.span_h-1:0)-d.y)===1&&d.x>=facade.x&&d.x<facade.x+facade.span_w,'the doorstep touches its facade');
   assert.ok(!f.fixtures.some(p=>p.solid!==false&&covers(p,d.x,d.y)),'nothing stands on a doorstep');
   doors.add(d.x+','+d.y);
  }
  assert.equal(f.fixtures.filter(p=>p.kind==='shop').length,0,'merchants are inside their stores, not on the street');
  for(const kind of ['bank','dumpster'])assert.equal(f.fixtures.filter(p=>p.kind===kind).length,1);
  assert.ok(f.fixtures.some(p=>p.id==='curse-remover'));
  if(n===0)assert.deepEqual(f,generateDistrict(city,{edition:'city-0',ends:0}));
 }
 assert.ok(doors.size>8,'store doors move with the monthly street plan');
});

test('every store is a tiny shop room with the keeper behind a planter counter and a door back to the sidewalk',()=>{
 for(const shop of hubData.shops){
  const room=hubRooms.find(r=>r.id==='littlebig-clockwork-store-'+storeSlug(shop));
  assert.equal(room.kind,'shops');assert.equal(room.store,true);assert.equal(room.name,shop.name+"'s Store");
  assert.deepEqual([room.width,room.height,room.spawn,room.exit],[STORE.width,STORE.height,STORE.spawn,STORE.exit]);
  const keeper=room.fixtures.find(f=>f.kind==='shop');assert.deepEqual([keeper.id,keeper.x,keeper.y],[shop.id,STORE.keeper.x,STORE.keeper.y]);
  assert.equal(room.fixtures.filter(f=>f.kind==='scenery').length,STORE.width-3,'a counter row with one gap');
  assert.ok(!room.fixtures.some(f=>f.x===STORE.counter.gap&&f.y===STORE.counter.y),'the gap is open');
 }
});

test('walking the city: storefront doorsteps enter and leave stores, purchases work, the plaza doorsteps open the Inn and Coliseum, the Desert gate crosses to Honeydew and back',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-23T12:00:00Z'),c;
 const options={now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:{log:()=>{}}};
 let api=createQuestZones(db,options);
 const act=(action,extra={})=>{time+=350;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const divePlace=(x,y)=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);s.dive.position={x,y};s.dive.safeUntil=time+600000;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);place(x,y);};
 const zoneOf=s=>s.zones.find(z=>z.id===s.zone);
 try{
  act('create',{name:'Alice'});
  const lobby=act('enter',{zone:'littlebig-clockwork',loadout:{player_info:{playerHealth:50,playerHealthMax:50,level:50},inventory:[{item_id:'adult_food'}]}});
  assert.deepEqual(lobby.position,{x:30,y:32});const def=zoneOf(lobby);assert.equal(def.name,'LittleBigCity');assert.equal(def.width,60);assert.equal(def.district.lobby,true);
  assert.equal(def.portals.filter(p=>p.target.startsWith('littlebig-clockwork-')||['dive-desert','dive-seafoam-coast'].includes(p.target)).length,13,'two gates (Desert west, Seafoam Coast south), three plaza doorsteps (Inn, Coliseum, temple) and eight storefront doorsteps'); // Counted by kind, so other entrances on the plaza don't change it.assert.ok(Buffer.byteLength(JSON.stringify(lobby))<262144,'the city fits the gateway response budget');
  const doorstep=def.portals.find(p=>p.target==='littlebig-clockwork-store-mira');
  const beside=def.walls[doorstep.y+1]?.[doorstep.x]===0&&!def.fixtures.some(f=>f.solid!==false&&covers(f,doorstep.x,doorstep.y+1))?{x:doorstep.x,y:doorstep.y+1,direction:'north'}:{x:doorstep.x,y:doorstep.y-1,direction:'south'}; // Stand on the street tile next to the mat and walk onto it.
  place(beside.x,beside.y);const store=act('move',{direction:beside.direction,world_step:true});
  assert.equal(store.zone,'littlebig-clockwork-store-mira');assert.deepEqual(store.position,{x:5,y:6});assert.equal(c.worldTurnDue,undefined);assert.equal(c.loadout.inventory.length,1);
  const room=zoneOf(store),keeper=room.fixtures.find(f=>f.kind==='shop');assert.equal(keeper.id,'objNPCMerchant');assert.ok(keeper.offers.length);
  assert.ok(keeper.offers.filter(o=>o.item.loot).every(o=>o.item.loot.ilvl>=49&&o.item.loot.ilvl<=52),'a level 50 shopper sees level 50 stock inside the city band');
  place(6,5);assert.throws(()=>act('move',{direction:'north'}),/blocked/); // The planter counter.
  place(5,3);act('shop_buy',{fixture:keeper.id,offer:keeper.offers[0].id});api.completePurchase(c.pendingPurchase,true);
  c=api.read('',c.id).character;assert.equal(c.loadout.inventory.length,2,'a store sells like a Market Hall');
  place(5,6);const out=act('move',{direction:'south',world_step:true});assert.equal(out.zone,'littlebig-clockwork');assert.equal(c.hubVisit,undefined);
  assert.ok(Math.abs(out.position.x-doorstep.x)+Math.abs(out.position.y-doorstep.y)===1,'back on the sidewalk beside the store door');
  place(28,29);const inn=act('hub_visit',{zone:'littlebig-clockwork-beds'});assert.equal(inn.zone,'littlebig-clockwork-beds');
  const beds=zoneOf(inn).fixtures.filter(f=>f.kind==='bed');assert.equal(beds.length,6);
  time+=1000;place(beds[0].x,beds[0].y+1);const next=structuredClone(c.loadout);next.player_info.playerHealth=40;act('hub_rest',{fixture:beds[0].id,loadout:next});assert.equal(c.loadout.player_info.playerHealth,40);
  place(1,12);const fromInn=act('move',{direction:'west',world_step:true}); // The remodelled Inn's exit is the lobby's left-wall gap (y=11-12).assert.equal(fromInn.zone,'littlebig-clockwork');assert.deepEqual(fromInn.position,{x:28,y:29}); // The Inn's left-wall gap lands below its plaza doorstep.
  place(33,29);const hall=act('move',{direction:'north',world_step:true});assert.equal(hall.zone,'littlebig-clockwork-dives');assert.deepEqual(zoneOf(hall).portals.map(p=>p.target),['dive-mansion','dive-hospital']);
  place(9,10);const fromHall=act('move',{direction:'south',world_step:true});assert.equal(fromHall.zone,'littlebig-clockwork');assert.deepEqual(fromHall.position,{x:33,y:29});
  place(1,30);const desert=act('move',{direction:'west',world_step:true});assert.equal(desert.zone,'dive-desert');assert.equal(c.dive.gate,true);assert.equal(c.dive.returnZone,'littlebig-clockwork');
  const home=act('dive_exit');assert.equal(home.zone,'littlebig-clockwork');assert.deepEqual(home.position,{x:1,y:30});
  place(1,30);act('move',{direction:'west',world_step:true});
  const westExit=zoneOf(api.read('',c.id)).exits.find(e=>e.zone==='honeydew-lantern');divePlace(westExit.x+1,westExit.y);
  const village=act('dive_exit',{zone:'honeydew-lantern'});assert.equal(village.zone,'honeydew-lantern');assert.deepEqual(village.position,{x:48,y:25});
  place(48,25);act('move',{direction:'east',world_step:true});const eastExit=zoneOf(api.read('',c.id)).exits.find(e=>e.zone==='littlebig-clockwork');divePlace(eastExit.x-1,eastExit.y);
  const back=act('dive_exit',{zone:'littlebig-clockwork'});assert.equal(back.zone,'littlebig-clockwork');assert.deepEqual(back.position,{x:1,y:30}); // Eastbound walkers step into the city beside its Desert gate.
  assert.ok(act('start').character.run,'the city is still the arena lobby');act('flee');
  db.prepare('UPDATE quest_presence SET zone=?,x=3,y=4 WHERE character_id=?').run('littlebig-clockwork-shops',c.id); // A database from before the redesign: parked in the retired Market Hall with a stale annex visit.
  db.prepare("UPDATE quest_characters SET state=json_set(state,'$.hubVisit','littlebig-clockwork-garden') WHERE id=?").run(c.id);
  api.close();api=createQuestZones(db,options);
  const parked=db.prepare('SELECT zone,x,y FROM quest_presence WHERE character_id=?').get(c.id);assert.deepEqual([parked.zone,parked.x,parked.y],['littlebig-clockwork',30,32]);
  c=api.read('',c.id).character;const resumed=act('enter',{zone:'littlebig-clockwork'});assert.equal(resumed.zone,'littlebig-clockwork');assert.equal(c.hubVisit,undefined);
 }finally{api.close();db.close();}
});
