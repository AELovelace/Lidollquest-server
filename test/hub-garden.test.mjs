import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {hubCatalog,hubRooms,hubPortals,dungeonPortals,wildernessGates,routeHome,returnSource,hubArrival,hubDefinition} from '../server/hubs.mjs';
import {roseCourtyard,validateCourtyard,GARDEN_PORTALS,DEFAULT_DECORATIONS} from '../server/hub-garden.mjs';
import {generateDistrict,districtData} from '../server/hub-districts.mjs';

test('Rose Court is a walled 20x20 garden with the castle gate and Tundra gap on its right wall',()=>{
 const rose=hubCatalog.find(h=>h.id==='princess-rose');
 assert.equal(rose.width,20);assert.equal(rose.height,20);assert.equal(rose.walls.length,20);assert.ok(rose.walls.every(row=>row.length===20));
 assert.deepEqual(rose.tilesets,{wall:'tilePrincessQuarters',floor:'tileTown',trees:'tileTown'});
 for(let i=0;i<20;i++){assert.equal(rose.walls[0][i]+rose.walls[19][i]+rose.walls[i][0]+rose.walls[i][19]>0,true,'boundary cells are walls or openings');}
 const portals=hubPortals('princess-rose');
 assert.deepEqual(portals.map(p=>[p.target,p.style,p.side??'']),[['princess-rose-garden','gap','right'],['dive-tundra','gap','right'],['princess-rose-shops','stairs',''],['princess-rose-dives','gap','top']]);
 assert.equal(portals[0].name,'The Castle');assert.deepEqual([portals[1].x,portals[1].y,portals[1].h],[19,5,2]); // The Tundra took the old Beds door position.
 for(const p of portals.filter(p=>p.style==='gap'))for(let dy=0;dy<(p.h??1);dy++)for(let dx=0;dx<(p.w??1);dx++)assert.equal(rose.walls[p.y+dy][p.x+dx],0);
 assert.equal(rose.walls[4][19],1);assert.equal(rose.walls[7][19],1);assert.equal(rose.walls[11][19],1);assert.equal(rose.walls[14][19],1); // Solid wall between and around the two right-wall openings.
 assert.ok(rose.treeTiles.flat().some(t=>t>=34&&t<=37),'tree clumps use the Honeydew woodland tiles');
 assert.ok(rose.floors.flat().includes(9)&&rose.floors.flat().includes(3)&&rose.floors.flat().includes(1),'grass, flowers and cobbles are all present');
 assert.ok(rose.fixtures.some(f=>f.sprite.startsWith('sprPQ'))&&rose.fixtures.some(f=>f.sprite.startsWith('sprTownEnv')),'props mix the Princess Quarters and Honeydew palettes');
 assert.ok(!hubRooms.some(r=>r.id==='princess-rose-beds'));assert.ok(hubRooms.some(r=>r.id==='honeydew-lantern-beds'));
 assert.deepEqual(dungeonPortals('princess-rose').map(p=>p.target),['dive-quarters','dive-dungeon']); // The hall's east wall is closed.
 assert.deepEqual(wildernessGates('princess-rose').map(g=>g.target),['dive-tundra']);assert.deepEqual(wildernessGates('honeydew-lantern'),[]);
 assert.equal(routeHome('princess-rose','dive-tundra'),'princess-rose');assert.equal(routeHome('honeydew-lantern','dive-tundra'),'honeydew-lantern-dives');
 assert.equal(returnSource('princess-rose','dive-tundra'),'dive-tundra');assert.equal(returnSource('honeydew-lantern','dive-tundra'),'honeydew-lantern-dives');assert.equal(returnSource('honeydew-lantern-dives','dive-taiga'),'dive-taiga');
 assert.deepEqual(hubArrival(rose,'dive-tundra'),{x:18,y:6});assert.deepEqual(hubArrival(rose,'princess-rose-garden'),{x:18,y:13});assert.deepEqual(hubArrival(rose,'princess-rose-dives'),{x:9,y:1});
 assert.deepEqual(hubDefinition(rose,0).spawn,{x:10,y:12});
});

test('the courtyard validator rejects props that seal an opening or sit on a wall',()=>{
 assert.ok(roseCourtyard(DEFAULT_DECORATIONS));
 assert.throws(()=>roseCourtyard([{id:'bad',sprite:'sprTownEnvBench',x:0,y:5,span_w:1,span_h:1}]),/overlaps a wall/);
 assert.throws(()=>roseCourtyard([{id:'plug-a',sprite:'sprTownEnvBench',x:18,y:5,span_w:1,span_h:1},{id:'plug-b',sprite:'sprTownEnvBench',x:18,y:6,span_w:1,span_h:1}]),/unreachable|not reachable/); // Blocking the two tiles inside the Tundra gap.
 assert.throws(()=>roseCourtyard([{id:'spawn',sprite:'sprTownEnvBench',x:10,y:12,span_w:1,span_h:1}]),/spawn is blocked/);
 const g=roseCourtyard([{id:'rug',sprite:'sprPQDetailLaceRug',x:18,y:5,span_w:1,span_h:2,solid:false}]);assert.ok(validateCourtyard(g,GARDEN_PORTALS)); // Rugs never block.
});

test('walking into the garden Tundra gap enters Frostveil, crossings land in the right room, and the castle dormitory rests',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=350;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const divePlace=(x,y)=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);s.dive.position={x,y};s.dive.safeUntil=time+600000;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);place(x,y);}; // Stand on a Tundra tile the way the browser fixtures do.
 const exitOf=(snapshot,hub)=>snapshot.zones.find(z=>z.id==='dive-tundra').exits.find(e=>e.zone===hub);
 try{
  act('create',{name:'Alice'});
  const lobby=act('enter',{zone:'princess-rose',loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[{item_id:'adult_food'}]}});
  assert.deepEqual(lobby.position,{x:10,y:12});const def=lobby.zones.find(z=>z.id==='princess-rose');
  assert.equal(def.walls[9][9],0,'the fountain footprint is floor, not wall');assert.equal(def.fixtures.find(f=>f.id==='fountain').span_w,2);
  place(9,8);assert.throws(()=>act('move',{direction:'south'}),/blocked/); // Props block like district scenery.
  place(4,2);assert.throws(()=>act('move',{direction:'west'}),/blocked/); // Tree clumps are solid.
  place(18,4);assert.throws(()=>act('move',{direction:'east'}),/blocked/); // Wall beside the Tundra gap.
  place(18,6);const tundra=act('move',{direction:'east',world_step:true});
  assert.equal(tundra.zone,'dive-tundra');assert.equal(c.dive.origin,'princess-rose');assert.equal(c.dive.returnZone,'princess-rose');assert.equal(c.worldTurnDue,undefined);
  const home=act('dive_exit');assert.equal(home.zone,'princess-rose');assert.deepEqual(home.position,{x:18,y:6});assert.equal(c.hubVisit,undefined);
  place(18,6);const again=act('move',{direction:'east',world_step:true});assert.equal(c.dive.zone,'dive-tundra');assert.equal(c.dive.gate,true);
  const eastExit=exitOf(again,'honeydew-lantern');divePlace(eastExit.x-1,eastExit.y);
  const east=act('dive_exit',{zone:'honeydew-lantern'});assert.equal(east.zone,'honeydew-lantern-dives'); // A gate walker who crosses east arrives in Lantern's Dive Hall, which hosts that side's opening.
  place(1,6);const back=act('move',{direction:'west',world_step:true});assert.equal(back.zone,'dive-tundra');assert.equal(c.dive.gate,false);
  const westExit=exitOf(back,'princess-rose');divePlace(westExit.x+1,westExit.y);
  const west=act('dive_exit',{zone:'princess-rose'});assert.equal(west.zone,'princess-rose');assert.deepEqual(west.position,{x:18,y:6}); // Crossing west lands in the garden beside its gate.
  place(9,0);const hall=act('hub_visit',{zone:'princess-rose-dives'});assert.ok(!hall.zones.find(z=>z.id==='princess-rose-dives').portals.some(p=>p.target==='dive-tundra'));
  place(18,6);assert.throws(()=>act('move',{direction:'east'}),/blocked/); // The hall's old east gap is sealed.
  place(9,10);act('move',{direction:'south',world_step:true});assert.equal(c.hubVisit,undefined);
  place(18,13);const castle=act('move',{direction:'east',world_step:true});assert.equal(castle.zone,'princess-rose-garden');
  const beds=castle.zones.find(z=>z.id==='princess-rose-garden').fixtures.filter(f=>f.kind==='bed');assert.equal(beds.length,6);
  place(beds[0].x,beds[0].y+1);const next=structuredClone(c.loadout);next.player_info.playerHealth=40;act('hub_rest',{fixture:beds[0].id,loadout:next});assert.equal(c.loadout.player_info.playerHealth,40);
  place(1,1);assert.throws(()=>act('hub_rest',{fixture:beds[0].id,loadout:next}),/Stand next/);
 }finally{db.close();}
});

test('the Castle dormitory is carved, protected and reachable in every monthly edition',()=>{
 const def=districtData.districts.find(d=>d.hub==='princess-rose');assert.deepEqual(def.dormitory,{x:39,y:13,w:9,h:7,door:{x:43}});
 for(let n=0;n<40;n++){
  const f=generateDistrict(def,{edition:'2030-'+String(n+1).padStart(2,'0'),ends:0});
  const beds=f.fixtures.filter(p=>p.kind==='bed');assert.equal(beds.length,6);
  assert.ok(f.rooms.some(r=>r.kind==='dormitory'));
  for(let y=13;y<20;y++)for(let x=39;x<48;x++)assert.equal(f.walls[y][x],0,'dormitory floor stays open');
  assert.equal(f.walls[20][43]+f.walls[21][43],0,'doorway to the entry area');
  assert.ok(!f.fixtures.some(p=>p.kind==='scenery'&&p.x<48&&p.x+p.span_w>39&&p.y<20&&p.y+p.span_h>13),'no scenery lands in the dormitory');
  assert.deepEqual(beds.map(b=>b.x),[40,43,46,40,43,46],'beds sit three tiles apart so labels stay readable');
 }
});
