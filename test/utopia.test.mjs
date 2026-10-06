import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,taigaData,TAIGA_ZONE,UTOPIA_ZONE} from '../server/zones.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {addSideTrail,addNorthTrail,openExitGaps} from '../server/wilderness-links.mjs';
import {pathTo} from '../server/dive-generation.mjs';
import {hubCatalog,hubRooms,wildernessGates,dungeonPortals,hubPortals,hubData} from '../server/hubs.mjs';
import {districtData,generateDistrict,reachableDistrict,addDistrictBuildings,SERVICE_KINDS} from '../server/hub-districts.mjs';
import {UTOPIA_PADS} from '../server/utopia-rooms.mjs';

// Utopia (2026-09-24): the fourth hub, a 60x60 magitek city of littles above the Taiga's north wall. No toilets anywhere:
// Auto-Changing Stations (kind 'changer') stand in the streets and in every interior. Its three rooms are the Nap Pods
// (beds, nap_pods restores Dignity client-side), the Artificer's Workshop (pads into the Auto-Nursery and Regression School)
// and Arcanum Tower (archive, registrar and the city's cauldron).
const utopia=districtData.districts.find(d=>d.hub===UTOPIA_ZONE);
const covers=(p,x,y)=>x>=p.x&&y>=p.y&&x<p.x+(p.span_w??1)&&y<p.y+(p.span_h??1);

test('Utopia is a 60x60 magitek lobby town with a south gate to the Taiga and five reachable changers every month',()=>{
 const root=hubCatalog.find(h=>h.id===UTOPIA_ZONE);
 assert.equal(root.name,'Utopia');assert.equal(root.hub,'utopia');assert.equal(root.town,true);assert.equal(root.width,60);assert.equal(root.height,60);
 assert.deepEqual(wildernessGates(UTOPIA_ZONE).map(g=>[g.target,g.side]),[['dungeon-regression-hospital','left'],['dungeon-auto-nursery','right'],[TAIGA_ZONE,'bottom']]); // South into the Frostveil Taiga; since 2026-09-27 the west path leads to the Regression Research Hospital and the east path to the Auto-Nursery (no entrance buildings).
 assert.deepEqual(hubRooms.filter(r=>r.parent===UTOPIA_ZONE).map(r=>[r.kind,r.name]),[['beds','Nap Pods'],['dives',"Artificer's Workshop"],['tower','Arcanum Tower'],['temple',"Sula's Cradle"]]);
 for(const month of ['2026-09','2026-10','2026-11','2027-01']){
  const f=generateDistrict(utopia,{edition:month,ends:0});assert.ok(reachableDistrict(f));
  const changers=f.fixtures.filter(x=>x.kind==='changer');assert.equal(changers.length,utopia.lobby.changers);
  assert.equal(f.fixtures.filter(x=>x.kind==='toilet').length,0,'Utopia has no potties');
  for(const a of changers){assert.equal(a.sprite,'sprUtopiaChanger');for(const b of changers)if(a!==b)assert.ok(Math.abs(a.x-b.x)+Math.abs(a.y-b.y)>=14,'changers spread across the city');}
  for(const ch of changers)for(let dy=0;dy<ch.span_h;dy++)for(let dx=0;dx<ch.span_w;dx++)assert.equal(f.walls[ch.y+dy][ch.x+dx],0);
  const services=f.fixtures.filter(x=>SERVICE_KINDS.includes(x.kind));
  for(const s of services){const beside=[[0,-1],[0,1],[-1,0],[1,0]].some(([dx,dy])=>{const x=s.x+dx,y=s.y+dy;return !f.walls[y]?.[x]&&!f.fixtures.some(o=>o.solid&&covers(o,x,y));});assert.ok(beside||s.span_h>1||s.span_w>1,s.id+' can be reached');}
 }
});

test('Utopia hollows its leftover tower mass into walk-in buildings: rooms behind street doors, furnished, every tile reachable',()=>{ // 2026-10-06: the solid blocks between the avenues become usable space.
 const plain={...utopia};delete plain.buildings;const floorCount=f=>f.walls.flat().filter(v=>v===0).length;
 for(const month of ['2026-10','2026-11','2027-03']){
  const before=generateDistrict(plain,{edition:month,ends:0}),f=generateDistrict(utopia,{edition:month,ends:0}),seen=reachableDistrict(f),cfg=utopia.buildings;
  assert.ok(floorCount(f)>=floorCount(before)*1.4,month+' gains at least 40% more floor');assert.ok(f.buildings.length>=6,month);
  for(const b of f.buildings){
   assert.ok(b.doors.length>=1&&b.doors.length<=2);
   for(const d of b.doors){assert.equal(f.walls[d.y][d.x],0);assert.ok(seen.has(d.x+','+d.y),'door '+d.x+','+d.y+' is reachable');}
   const tints=new Set();for(let y=b.y;y<b.y+b.h;y++)for(let x=b.x;x<b.x+b.w;x++)if(f.walls[y][x])tints.add(f.wallTiles[y][x]);assert.equal(tints.size,1,'one facade colour per building, junctions included');assert.ok(cfg.wall_tiles.includes([...tints][0]));
  }
  const rooms=f.rooms.filter(r=>r.building!==undefined);assert.ok(rooms.length>=f.buildings.length);
  for(const r of rooms){assert.ok(r.w>=cfg.min_room&&r.h>=cfg.min_room);const kind=cfg.rooms.find(k=>k.kind===r.kind);assert.ok(kind,r.kind);assert.equal(f.floors[r.cy][r.cx],kind.floor);for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)assert.equal(f.walls[y][x],0);}
  assert.ok(f.fixtures.some(p=>p.id.startsWith('building-')),'rooms are furnished');
 }
});

test('a saved Utopia month gains its buildings in place: streets, scenery and residents stay put, GM-painted cells are left alone',()=>{
 const plain={...utopia};delete plain.buildings;const saved=generateDistrict(plain,{edition:'2026-09',ends:0});
 const painted={x:-1,y:-1};for(let y=2;y<58&&painted.x<0;y++)for(let x=2;x<58;x++)if([[0,0],[1,0],[-1,0],[0,1],[0,-1]].every(([dx,dy])=>saved.walls[y+dy][x+dx]===1)){painted.x=x;painted.y=y;break;} // A deep wall cell a GM repainted (floor-patches undo log).
 saved.patchUndo={cells:[{x:painted.x,y:painted.y,wall:1}],fixturesRemoved:[]};
 const f=structuredClone(saved);assert.equal(addDistrictBuildings(f,utopia),true);assert.equal(addDistrictBuildings(f,utopia),false,'idempotent once applied');
 for(let y=0;y<60;y++)for(let x=0;x<60;x++)if(saved.walls[y][x]===0){assert.equal(f.walls[y][x],0);assert.equal(f.floors[y][x],saved.floors[y][x]);}
 assert.deepEqual(f.fixtures.slice(0,saved.fixtures.length),saved.fixtures);assert.equal(f.walls[painted.y][painted.x],1);assert.equal(f.wallTiles[painted.y][painted.x],saved.wallTiles[painted.y][painted.x]);
 const solid=new Set(f.fixtures.filter(p=>p.solid!==false).flatMap(p=>Array.from({length:p.span_w*p.span_h},(_,i)=>(p.x+i%p.span_w)+','+(p.y+Math.floor(i/p.span_w)))));
 assert.equal(reachableDistrict(f).size,f.walls.flat().filter(v=>v===0).length-solid.size,'every new room is reachable');
 assert.equal(addDistrictBuildings(structuredClone(saved),plain),false,'towns without def.buildings are untouched');
});

test('the Nap Pods, Workshop and Tower are authored rooms, each with a changer and no toilet',()=>{
 const rooms=Object.fromEntries(hubRooms.filter(r=>r.parent===UTOPIA_ZONE).map(r=>[r.kind,r]));
 for(const r of Object.values(rooms)){assert.equal(r.authored,true);assert.ok(r.fixtures.some(f=>f.kind==='changer'),r.id);assert.ok(!r.fixtures.some(f=>f.kind==='toilet'),r.id);}
 assert.equal(rooms.beds.nap_pods,true);assert.equal(rooms.beds.fixtures.filter(f=>f.kind==='bed').length,hubData.beds.length);
 assert.deepEqual(dungeonPortals(UTOPIA_ZONE).map(p=>[p.x,p.y,p.target]),UTOPIA_PADS.map(p=>[p.x,p.y,p.zone]));
 assert.ok(rooms.tower.fixtures.some(f=>f.kind==='cauldron'));assert.ok(rooms.tower.fixtures.some(f=>f.kind==='shop'||f.kind==='npc'));
 assert.ok(hubPortals(UTOPIA_ZONE).some(p=>p.target===TAIGA_ZONE));
});

test('the Taiga gains a north trail to Utopia without rerolling its content',()=>{
 for(let n=0;n<20;n++){
  const f=generateDesert(taigaData,'taiga-'+n),before=structuredClone(f);
  assert.equal(addNorthTrail(f,{zone_id:UTOPIA_ZONE,name:'Utopia'}),true);assert.equal(addNorthTrail(f,{zone_id:UTOPIA_ZONE,name:'Utopia'}),false); // Idempotent.
  openExitGaps(f);assert.ok(validateDesert(f));assert.deepEqual(f.chests,before.chests);assert.deepEqual(f.pickups,before.pickups);
  const north=f.exits.find(e=>e.zone===UTOPIA_ZONE);assert.equal(north.side,'top');assert.ok(pathTo(f,f.entrance,north));
 }
});

test('walking to Utopia: Taiga north trail in, doorsteps into all three rooms, the south gate back out',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),c;
 const options={now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:()=>{},diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}},desertOptions:{log:()=>{}},taigaOptions:{log:()=>{}}};
 const api=createQuestZones(db,options);
 const act=(action,extra={})=>{time+=350;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const zoneOf=s=>s.zones.find(z=>z.id===s.zone);
 try{
  act('create',{name:'Alice'});
  const lobby=act('enter',{zone:UTOPIA_ZONE,loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[]}});
  const def=zoneOf(lobby);assert.equal(def.name,'Utopia');assert.equal(def.width,60);assert.equal(def.fixtures.filter(f=>f.kind==='changer').length,5);
  assert.ok(Buffer.byteLength(JSON.stringify(lobby))<1048576,'the city fits the gateway response budget'); // 1048576 = the tracker quest-proxy responseLimit for zone routes (omo-trainer server/quest-proxy.mjs); raised from 256 KB on 2026-09-30.
  for(const kind of ['beds','dives','tower']){
   const door=def.portals.find(p=>p.target===UTOPIA_ZONE+'-'+kind);place(door.x,door.y); // Stand on the doorstep, as the client does.
   const room=act('hub_visit',{zone:UTOPIA_ZONE+'-'+kind});assert.equal(room.zone,UTOPIA_ZONE+'-'+kind);
   const exit=zoneOf(room).exit;place(exit.x+1,exit.y);const out=act('move',{direction:'west',world_step:true});assert.equal(out.zone,UTOPIA_ZONE,kind+' walks back out');
  }
  const gate=wildernessGates(UTOPIA_ZONE).find(g=>g.target===TAIGA_ZONE);place(gate.x,gate.y-1);
  const taiga=act('move',{direction:'south',world_step:true});assert.equal(taiga.zone,TAIGA_ZONE);assert.equal(c.dive.gate,true);assert.equal(c.dive.returnZone,UTOPIA_ZONE);
  const north=zoneOf(taiga).exits.find(e=>e.zone===UTOPIA_ZONE);assert.ok(north,'the Taiga has its north trail');
  assert.ok(Math.abs(taiga.position.x-north.x)<=2&&taiga.position.y<=3,'arrivals from Utopia stand at the top of the Taiga');
  const home=act('dive_exit',{zone:UTOPIA_ZONE});assert.equal(home.zone,UTOPIA_ZONE);assert.ok(home.position.y>=57,'back beside the south gate');
 }finally{api.close();db.close();}
});
