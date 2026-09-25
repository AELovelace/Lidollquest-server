import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {hubCatalog,hubRooms,hubPortals,dungeonPortals,wildernessGates,INN_BEDS,hubData} from '../server/hubs.mjs';
import {districtData,districtZone,generateDistrict,reachableDistrict} from '../server/hub-districts.mjs';
import {createWorldContent} from '../server/world-content.mjs';

// Honeydew Village (2026-09-23): the honeydew-lantern lobby is the 50x50 monthly town itself. Its west wall opens onto
// Frostveil Tundra and its east wall onto Dustbreak Desert; the Community Hall and Inn facades stand on the village
// square and their doorsteps lead into the campaign Room5_CommunityHall (Dive pads) and Room5_Inn (six beds).
const town=districtData.districts.find(d=>d.hub==='honeydew-lantern');
const covers=(p,x,y)=>x>=p.x&&y>=p.y&&x<p.x+(p.span_w??1)&&y<p.y+(p.span_h??1);

test('Honeydew Village is its own 50x50 lobby: gates in both walls, doorsteps into the hall and inn, merchants spread through the clearings',()=>{
 assert.equal(districtZone(town),'honeydew-lantern');assert.equal(hubCatalog.find(h=>h.id==='honeydew-lantern').name,'Honeydew Village');
 assert.deepEqual(hubRooms.filter(r=>r.parent==='honeydew-lantern').map(r=>[r.id,r.name]),[['honeydew-lantern-beds','Honeydew Inn'],['honeydew-lantern-dives','Community Hall'],['honeydew-lantern-temple',"Orin's Unbound Hearth"]]); // No garden or market annex: the town is both. Orin's temple stands on the square.
 assert.deepEqual(hubPortals('honeydew-lantern').map(p=>[p.target,p.style,p.x,p.y]),[['overworld-tundra','gap',0,24],['overworld-desert','gap',49,24],['overworld-haunted-woods','gap',24,0],['overworld-autumnal-plains','gap',24,49],['honeydew-lantern-dives','door',25,24],['honeydew-lantern-beds','door',29,27],['honeydew-lantern-temple','door',22,26]]); // Orin's temple doorstep.
 assert.deepEqual(wildernessGates('honeydew-lantern').map(g=>g.target),['overworld-tundra','overworld-desert','overworld-haunted-woods','overworld-autumnal-plains']); // West, east, the north gate into the Haunted Woods and the south gate into the Autumnal Plains.
 assert.deepEqual(dungeonPortals('honeydew-lantern').map(p=>[p.target,p.x,p.y]),[['dive-nursery',2,4],['dive-school',5,4],['dive-forest',8,4]]); // Pads sit in the hall's old companion room (top-left); no side gaps.
 for(let n=0;n<40;n++){
  const f=generateDistrict(town,{edition:'village-'+n,ends:0}),seen=reachableDistrict(f);
  assert.deepEqual(f.spawn,{x:25,y:26});assert.deepEqual(f.exit,{x:2,y:22,style:'stairs'});assert.equal(f.district.lobby,true);
  assert.equal(f.walls[24][0]+f.walls[25][0]+f.walls[24][49]+f.walls[25][49],0,'both gates are open');assert.equal(f.walls[23][0]+f.walls[26][0],2,'solid wall around the west gate');
  for(const [x,y] of [[1,24],[1,25],[48,24],[48,25],[25,24],[25,25],[25,26],[29,27],[29,28],[2,22]])assert.ok(seen.has(x+','+y),`tile ${x},${y} is open and reachable in edition ${n}`); // Gate insides, doorsteps, arrival tiles, spawn and campaign stairs.
  const facades=f.fixtures.filter(p=>['community-hall','inn'].includes(p.id));
  assert.deepEqual(facades.map(p=>[p.sprite,p.x,p.y,p.span_w,p.span_h,p.solid]),[['sprCommunityCenter',24,21,3,3,true],['sprInn',28,24,3,3,true]]);
  const shops=f.fixtures.filter(p=>p.kind==='shop');assert.equal(shops.length,8);assert.deepEqual(new Set(shops.map(s=>s.id)),new Set(hubData.shops.map(s=>s.id)));
  for(const kind of ['bank','dumpster'])assert.equal(f.fixtures.filter(p=>p.kind===kind).length,1);
  assert.ok(f.fixtures.some(p=>p.id==='curse-remover'&&p.kind==='npc'&&p.service==='curse_remove'));
  for(const s of f.fixtures.filter(p=>['shop','bank','dumpster','npc'].includes(p.kind)))assert.ok([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen.has((s.x+dx)+','+(s.y+dy))),s.id+' can be approached');
  assert.ok(!f.fixtures.some(p=>p.kind!=='scenery'&&p.x<=7&&p.y>=22&&p.y<=27),'nobody stands in the west entry strip');
  assert.ok(!f.fixtures.some(p=>p.solid!==false&&!facades.includes(p)&&[[25,24],[25,25],[29,27],[29,28],[25,26],[2,22]].some(([x,y])=>covers(p,x,y))),'doorsteps, arrivals, spawn and stairs stay clear of props and people');
  assert.ok(new Set(shops.map(s=>Math.floor(s.x/12)+','+Math.floor(s.y/12))).size>=3,'merchants are spread around the town rather than bunched together');
  assert.equal(f.fixtures.filter(p=>p.kind==='npc').length,town.npcs.length+1,'four greeters, four wanderers and the Cursebreaker');
  if(n===0)assert.deepEqual(f,generateDistrict(town,{edition:'village-0',ends:0}),'the village is deterministic per edition');
 }
});

test('the Community Hall and Inn are the campaign rooms: authored tiles, a door exit, pads in the companion room and beds in the bedrooms',()=>{
 const hall=hubRooms.find(r=>r.id==='honeydew-lantern-dives'),inn=hubRooms.find(r=>r.id==='honeydew-lantern-beds');
 for(const room of [hall,inn]){
  assert.equal(room.width,20);assert.equal(room.height,20);assert.deepEqual(room.spawn,{x:10,y:17});assert.deepEqual(room.exit,{x:10,y:18,style:'door'});
  assert.deepEqual(room.tilesets,{wall:'tileTown',floor:'tileTown',decor:'tileTown'});assert.equal(room.authored,true);
  assert.ok(room.walls[0].every(v=>v===1)&&room.walls[19].every(v=>v===1)&&room.walls.every(row=>row[0]===1&&row[19]===1),'fully walled');
  assert.ok(room.decorTiles.flat().some(t=>t>0)&&room.floors.flat().some(t=>t>0)&&room.wallTiles.flat().some(t=>t>0),'the IDE tile layers came across');
  assert.equal(room.walls[18][10],0,'the door tile is floor');
 }
 assert.equal(hall.walls[9][4],0);assert.equal(hall.walls[9][9],1); // The companion room's doorway (3-6,9) opens south; its east wall is solid.
 assert.deepEqual(hall.fixtures.map(f=>[f.kind,f.x,f.y]),[['cauldron',14,2],['shop',16,2]]); // Honeydew's brewing cauldron and Bramble the reagent seller, in the quiet north-east room
 assert.deepEqual(inn.fixtures.filter(f=>f.kind==='bed').map(b=>[b.id,b.x,b.y]),hubData.beds.map((b,i)=>[b.id,INN_BEDS[i].x,INN_BEDS[i].y]));
 assert.equal(inn.fixtures.find(f=>f.id==='innkeeper').avatar,'objNPCInnkeeper');
 for(const bed of INN_BEDS)assert.equal(inn.walls[bed.y][bed.x],0,'beds stand on floor');
});

test('walking the village: doorsteps enter the hall and inn, beds rest, pads dive, gates cross both ways and retired annexes migrate',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-23T12:00:00Z'),c;
 const options={now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:()=>{},diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}},desertOptions:{log:()=>{}}};
 let api=createQuestZones(db,options);
 const act=(action,extra={})=>{time+=350;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const divePlace=(x,y)=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);s.dive.position={x,y};s.dive.safeUntil=time+600000;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);place(x,y);}; // Stand on a wilderness tile the way the browser fixtures do.
 const zoneOf=s=>s.zones.find(z=>z.id===s.zone);
 try{
  act('create',{name:'Alice'});
  const lobby=act('enter',{zone:'honeydew-lantern',loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[{item_id:'adult_food'}]}});
  assert.deepEqual(lobby.position,{x:25,y:26});const def=zoneOf(lobby);assert.equal(def.name,'Honeydew Village');assert.equal(def.width,50);assert.equal(def.district.lobby,true);assert.equal(def.walls.length,50);
  assert.ok(def.fixtures.filter(f=>f.kind==='shop').every(f=>f.offers.length>0),'village merchants carry daily stock');
  assert.ok(Buffer.byteLength(JSON.stringify(lobby))<262144,'the town fits the gateway response budget');
  place(24,24);assert.throws(()=>act('move',{direction:'north'}),/blocked/); // The Community Hall facade is solid.
  place(25,25);const hall=act('move',{direction:'north',world_step:true}); // Stepping onto the doorstep walks inside.
  assert.equal(hall.zone,'honeydew-lantern-dives');assert.deepEqual(hall.position,{x:10,y:17});assert.equal(c.hubVisit,'honeydew-lantern-dives');assert.equal(c.worldTurnDue,undefined);assert.equal(c.loadout.inventory.length,1);
  assert.deepEqual(zoneOf(hall).portals.map(p=>p.target),['dive-nursery','dive-school','dive-forest']);
  place(2,4);const dive=act('dive_enter',{zone:'dive-nursery'});assert.equal(dive.zone,'dive-nursery');assert.equal(c.dive.returnZone,'honeydew-lantern-dives');
  const back=act('dive_exit');assert.equal(back.zone,'honeydew-lantern-dives');assert.deepEqual(back.position,{x:2,y:5}); // Beside the pad, inside the companion room.
  place(10,17);const outside=act('move',{direction:'south',world_step:true}); // Walking onto the door tile steps back out.
  assert.equal(outside.zone,'honeydew-lantern');assert.deepEqual(outside.position,{x:25,y:25});assert.equal(c.hubVisit,undefined);
  place(29,28);const inn=act('hub_visit',{zone:'honeydew-lantern-beds'}); // The client sends hub_visit when a walker or an E press reaches a doorstep.
  assert.equal(inn.zone,'honeydew-lantern-beds');assert.deepEqual(inn.position,{x:10,y:17});
  const beds=zoneOf(inn).fixtures.filter(f=>f.kind==='bed');assert.equal(beds.length,6);
  for(const bed of beds){time+=1000;place(bed.x,bed.y+1);const next=structuredClone(c.loadout);next.player_info.playerHealth=40;act('hub_rest',{fixture:bed.id,loadout:next});assert.equal(c.loadout.player_info.playerHealth,40);}
  place(12,16);act('hub_talk',{fixture:'innkeeper'});assert.match(c.hubNotice,/Honeydew Inn/);
  place(10,17);const fromInn=act('move',{direction:'south',world_step:true});assert.equal(fromInn.zone,'honeydew-lantern');assert.deepEqual(fromInn.position,{x:29,y:28});
  place(1,25);const tundra=act('move',{direction:'west',world_step:true});assert.equal(tundra.zone,'overworld-tundra');assert.equal(c.dive.gate,true);assert.equal(c.dive.returnZone,'honeydew-lantern');
  const home=act('dive_exit');assert.equal(home.zone,'honeydew-lantern');assert.deepEqual(home.position,{x:1,y:25}); // Escape lands one tile inside the same gate.
  place(48,25);const desert=act('move',{direction:'east',world_step:true});assert.equal(desert.zone,'overworld-desert');
  const eastExit=zoneOf(desert).exits.find(e=>e.zone==='littlebig-clockwork');divePlace(eastExit.x-1,eastExit.y);
  const crossed=act('dive_exit',{zone:'littlebig-clockwork'});assert.equal(crossed.zone,'littlebig-clockwork');assert.deepEqual(crossed.position,{x:1,y:30}); // Eastbound walkers step into LittleBigCity beside its west gate.
  place(1,30);assert.equal(act('move',{direction:'west',world_step:true}).zone,'overworld-desert');
  const westExit=zoneOf(api.read('',c.id)).exits.find(e=>e.zone==='honeydew-lantern');divePlace(westExit.x+1,westExit.y);
  const village=act('dive_exit',{zone:'honeydew-lantern'});assert.equal(village.zone,'honeydew-lantern');assert.deepEqual(village.position,{x:48,y:25});assert.equal(c.hubVisit,undefined); // Westbound walkers step into the village beside its Desert gate.
  assert.ok(act('start').character.run,'the village is still the arena lobby');act('flee');
  const merchant=zoneOf(api.read('',c.id)).fixtures.find(f=>f.kind==='shop');place(merchant.x,merchant.y+1);
  act('shop_buy',{fixture:merchant.id,offer:merchant.offers[0].id});api.completePurchase(c.pendingPurchase,true);
  assert.equal(api.read('',c.id).character.loadout.inventory.length,2,'a village merchant sells like a Market Hall one');
  db.prepare('UPDATE quest_presence SET zone=?,x=3,y=4 WHERE character_id=?').run('honeydew-lantern-shops',c.id); // A database from before the redesign: parked in the retired Market Hall with a stale annex visit.
  db.prepare("UPDATE quest_characters SET state=json_set(state,'$.hubVisit','honeydew-lantern-garden') WHERE id=?").run(c.id);
  api.close();api=createQuestZones(db,options);
  const parked=db.prepare('SELECT zone,x,y FROM quest_presence WHERE character_id=?').get(c.id);assert.deepEqual([parked.zone,parked.x,parked.y],['honeydew-lantern',25,26]);
  c=api.read('',c.id).character;const resumed=act('enter',{zone:'honeydew-lantern'});assert.equal(resumed.zone,'honeydew-lantern');assert.equal(c.hubVisit,undefined);
 }finally{api.close();db.close();}
});

test('saved quests that named Market Square residents now point at the village',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE world_content(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,draft TEXT NOT NULL,published TEXT,PRIMARY KEY(kind,id))');
  const old={givers:['honeydew-lantern-garden:market-taster'],turn_in:{npc:'princess-rose-garden:castle-page'}};
  db.prepare("INSERT INTO world_content VALUES ('quest','old',1,?,?)").run(JSON.stringify(old),JSON.stringify(old));
  createWorldContent(db,{});
  const row=db.prepare('SELECT draft,published FROM world_content').get();
  for(const body of [JSON.parse(row.draft),JSON.parse(row.published)]){assert.equal(body.givers[0],'honeydew-lantern:market-taster');assert.equal(body.turn_in.npc,'princess-rose-garden:castle-page');} // Only Honeydew's prefix changes; The Castle keeps its annex ID.
 }finally{db.close();}
});

test('a month saved before the north gate existed gains it in place: same layout key, nobody moved, road joins the town',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {districtData,createHubDistricts,districtBlocked}=await import('../server/hub-districts.mjs');
 const db=new DatabaseSync(':memory:');const now=Date.parse('2026-09-24T12:00:00Z');
 db.exec('CREATE TABLE quest_presence(zone TEXT,x INTEGER,y INTEGER,moved INTEGER,seen INTEGER)');
 try{
  const old=structuredClone(districtData),town=old.districts.find(d=>d.hub==='honeydew-lantern');delete town.lobby.gates.north; // What September was generated from.
  const before=structuredClone(createHubDistricts(db,{now:()=>now,data:old}).resolve({id:'honeydew-lantern'}));
  assert.equal(before.walls[0][24],1);assert.equal(before.walls[0][25],1); // The bug: a solid north wall.
  db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?)').run('honeydew-lantern',30,30,123,now);
  const after=createHubDistricts(db,{now:()=>now}).resolve({id:'honeydew-lantern'});
  assert.equal(after.district.layoutKey,before.district.layoutKey); // Same month; nothing regenerated.
  assert.equal(after.walls[0][24],0);assert.equal(after.walls[0][25],0);
  assert.deepEqual({...db.prepare('SELECT x,y,moved FROM quest_presence').get()},{x:30,y:30,moved:123}); // Nobody sent back to the entrance.
  for(let y=0;y<50;y++)for(let x=0;x<50;x++)if(!before.walls[y][x])assert.equal(after.walls[y][x],0); // Only opens tiles.
  const seen=new Set(['24,1']),queue=[{x:24,y:1}]; // Walk from inside the gate to the spawn.
  for(let i=0;i<queue.length;i++)for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const x=queue[i].x+dx,y=queue[i].y+dy;if(!districtBlocked(after,x,y)&&!seen.has(x+','+y)){seen.add(x+','+y);queue.push({x,y});}}
  assert.ok(seen.has(after.spawn.x+','+after.spawn.y),'the north gate reaches the village spawn');
  assert.equal(createHubDistricts(db,{now:()=>now}).resolve({id:'honeydew-lantern'}).walls[0][24],0); // Persisted across restarts.
 }finally{db.close();}
});
