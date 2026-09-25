import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,autumnalPlainsData,AUTUMNAL_PLAINS_ZONE,ARCADIA_ZONE} from '../server/zones.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {addSouthTrail,openExitGaps} from '../server/wilderness-links.mjs';
import {pathTo} from '../server/dive-generation.mjs';
import {hubCatalog,hubRooms,wildernessGates,dungeonPortals,hubPortals,hubData} from '../server/hubs.mjs';
import {districtData,generateDistrict,reachableDistrict,SERVICE_KINDS} from '../server/hub-districts.mjs';

// Arcadia (2026-09-24): the fifth hub, a 60x60 steampunk industrial city of bigs below the Plains' south wall. Its streets
// are the `industrial` style: factory blocks, soot alleys, one rail line, gravel smokestack yards and the Foundry Square.
// Its three rooms are the Boarding House (beds), the Rail Depot (dives: no pads until Arcadia has its own dungeon) and the
// Clockmakers' Guildhall (tower: cauldron, reagents and the city's pay toilet). There are no changing stations anywhere.
const arcadia=districtData.districts.find(d=>d.hub===ARCADIA_ZONE);
const covers=(p,x,y)=>x>=p.x&&y>=p.y&&x<p.x+(p.span_w??1)&&y<p.y+(p.span_h??1);

test('Arcadia is a 60x60 industrial lobby town with a north gate onto the Plains, a rail line and smokestack yards every month',()=>{
 const root=hubCatalog.find(h=>h.id===ARCADIA_ZONE);
 assert.equal(root.name,'Arcadia');assert.equal(root.hub,'arcadia');assert.equal(root.town,true);assert.equal(root.width,60);assert.equal(root.height,60);
 assert.deepEqual(wildernessGates(ARCADIA_ZONE).map(g=>[g.target,g.side]),[[AUTUMNAL_PLAINS_ZONE,'top']]); // The only road out runs north into the Autumnal Plains.
 assert.deepEqual(hubRooms.filter(r=>r.parent===ARCADIA_ZONE).map(r=>[r.kind,r.name]),[['beds','Boarding House'],['dives','Rail Depot'],['tower',"Clockmakers' Guildhall"],['temple','The Iron Chapel of Orthain']]);
 const layouts=new Set();
 for(const month of ['2026-09','2026-10','2026-11','2027-01']){
  const f=generateDistrict(arcadia,{edition:month,ends:0});assert.ok(reachableDistrict(f));layouts.add(JSON.stringify(f.walls));
  assert.equal(f.district.model,'factory-blocks');
  assert.ok(f.blocks.filter(b=>b.kind==='factory_block').length>=6,'solid factory blocks between the streets');
  assert.equal(f.rooms.filter(r=>r.kind==='stack_yard').length,arcadia.layout.yard_count,'gravel smokestack yards');
  assert.ok(f.floors[f.rail.y].filter(t=>t===3).length>=30,'the rail line runs across the city');
  let plate=0;for(let y=23;y<=37;y++)for(let x=23;x<=37;x++)if(f.floors[y][x]===8)plate++;assert.ok(plate>=30,'the Foundry Square survives street carving (civic paving rings the four buildings)');
  assert.equal(f.walls[0][29]+f.walls[0][30],0,'the north gate is open');
  assert.equal(f.fixtures.filter(x=>x.kind==='changer').length,0,'bigs do not do changing stations');
  for(const s of f.fixtures.filter(x=>SERVICE_KINDS.includes(x.kind))){const beside=[[0,-1],[0,1],[-1,0],[1,0]].some(([dx,dy])=>{const x=s.x+dx,y=s.y+dy;return !f.walls[y]?.[x]&&!f.fixtures.some(o=>o.solid&&covers(o,x,y));});assert.ok(beside||s.span_h>1||s.span_w>1,s.id+' can be reached');}
 }
 assert.equal(layouts.size,4,'every month is a new street plan');
});

test('the Boarding House, Rail Depot and Guildhall are authored rooms; the depot waits for its dungeon',()=>{
 const rooms=Object.fromEntries(hubRooms.filter(r=>r.parent===ARCADIA_ZONE).map(r=>[r.kind,r]));
 for(const r of Object.values(rooms)){assert.equal(r.authored,true);assert.ok(!r.fixtures.some(f=>f.kind==='changer'),r.id);}
 assert.equal(rooms.beds.fixtures.filter(f=>f.kind==='bed').length,hubData.beds.length);
 assert.deepEqual(dungeonPortals(ARCADIA_ZONE),[],'no pads until Arcadia has a dungeon of its own');
 assert.ok(rooms.tower.fixtures.some(f=>f.kind==='cauldron'));
 assert.deepEqual(rooms.tower.fixtures.filter(f=>f.kind==='toilet').map(f=>f.style),['paytoilet']);
 assert.ok(hubPortals(ARCADIA_ZONE).some(p=>p.target===AUTUMNAL_PLAINS_ZONE));
});

test('the Plains gain a south trail to Arcadia without rerolling their content',()=>{
 for(let n=0;n<20;n++){
  const f=generateDesert(autumnalPlainsData,'plains-'+n),before=structuredClone(f);
  assert.equal(addSouthTrail(f,{zone_id:ARCADIA_ZONE,name:'Arcadia'}),true);assert.equal(addSouthTrail(f,{zone_id:ARCADIA_ZONE,name:'Arcadia'}),false); // Idempotent.
  openExitGaps(f);assert.ok(validateDesert(f));assert.deepEqual(f.chests,before.chests);assert.deepEqual(f.pickups,before.pickups);
  const south=f.exits.find(e=>e.zone===ARCADIA_ZONE);assert.equal(south.side,'bottom');assert.ok(pathTo(f,f.entrance,south));
 }
});

test('walking to Arcadia: Honeydew -> Plains -> south trail in, doorsteps into all three rooms, the north gate back out',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),c;
 const options={now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:()=>{},diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}},desertOptions:{log:()=>{}},autumnalPlainsOptions:{log:()=>{}}};
 const api=createQuestZones(db,options);
 const act=(action,extra={})=>{time+=350;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const divePlace=(x,y)=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);s.dive.position={x,y};s.dive.safeUntil=time+600000;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);place(x,y);};
 const zoneOf=s=>s.zones.find(z=>z.id===s.zone);
 try{
  act('create',{name:'Alice'});
  act('enter',{zone:'honeydew-lantern',loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[]}});
  const southGate=wildernessGates('honeydew-lantern').find(g=>g.target===AUTUMNAL_PLAINS_ZONE);place(southGate.x,southGate.y-1);
  const plains=act('move',{direction:'south',world_step:true});assert.equal(plains.zone,AUTUMNAL_PLAINS_ZONE);
  const trail=zoneOf(plains).exits.find(e=>e.zone===ARCADIA_ZONE);assert.ok(trail,'the Plains have their south trail');divePlace(trail.x,trail.y-1);
  const city=act('dive_exit',{zone:ARCADIA_ZONE});assert.equal(city.zone,ARCADIA_ZONE);assert.ok(city.position.y<=2,'arrivals from the Plains stand inside the north gate');
  const def=zoneOf(city);assert.equal(def.name,'Arcadia');assert.equal(def.width,60);
  assert.ok(Buffer.byteLength(JSON.stringify(city))<262144,'the city fits the gateway response budget');
  for(const kind of ['beds','dives','tower']){
   const door=def.portals.find(p=>p.target===ARCADIA_ZONE+'-'+kind);place(door.x,door.y); // Stand on the doorstep, as the client does.
   const room=act('hub_visit',{zone:ARCADIA_ZONE+'-'+kind});assert.equal(room.zone,ARCADIA_ZONE+'-'+kind);
   const exit=zoneOf(room).exit;place(exit.x+1,exit.y);const out=act('move',{direction:'west',world_step:true});assert.equal(out.zone,ARCADIA_ZONE,kind+' walks back out');
  }
  const gate=wildernessGates(ARCADIA_ZONE)[0];place(gate.x,gate.y+1);
  const back=act('move',{direction:'north',world_step:true});assert.equal(back.zone,AUTUMNAL_PLAINS_ZONE);assert.equal(c.dive.gate,true);assert.equal(c.dive.returnZone,ARCADIA_ZONE);
  assert.ok(back.position.y>=77,'arrivals from Arcadia stand at the bottom of the Plains');
  const home=act('dive_exit');assert.equal(home.zone,ARCADIA_ZONE,'escaping a Plains entered from Arcadia goes home to Arcadia');assert.ok(home.position.y<=2);
 }finally{api.close();db.close();}
});
