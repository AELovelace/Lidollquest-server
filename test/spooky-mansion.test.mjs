import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,hauntedWoodsData,spookyMansionData,HAUNTED_WOODS_ZONE,SPOOKY_MANSION_ZONE,WILDERNESS_LINKS} from '../server/zones.mjs';
import {generateMansion,mansionRoomContains} from '../server/mansion-generation.mjs';
import {generateForest} from '../server/forest-generation.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {pathTo,walkable,inside} from '../server/dive-generation.mjs';
import {addLandmark,openExitGaps} from '../server/wilderness-links.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {routeLevelFor} from '../server/scaling.mjs';
import {readFileSync} from 'node:fs';

const HONEYDEW='honeydew-lantern',landmark=hauntedWoodsData.config.landmark;

test('20 Spooky Mansion editions reuse the campaign mansion: 60x80, seeded, connected, typed rooms, one foyer pad',()=>{
 let wedges=0,hollows=0;
 for(let n=0;n<20;n++){
  const f=generateMansion(spookyMansionData,'mansion-'+n);assert.ok(validateDesert(f));assert.deepEqual(f,generateMansion(spookyMansionData,'mansion-'+n)); // Same week, same house.
  assert.deepEqual([f.width,f.height,f.theme],[60,80,'mansion']); // Room7_SpookyMansion is 1920x2560 px.
  assert.equal(f.exits.length,1);assert.deepEqual([f.exits[0].zone,f.exits[0].style],[HAUNTED_WOODS_ZONE,'warp']);
  const foyer=f.rooms[0];assert.equal(foyer.type,'foyer');assert.equal(f.rooms.at(-1).type,'sanctum');assert.ok(inside({x:foyer.x-1,y:foyer.y-1,w:foyer.w+2,h:foyer.h+2},f.exits[0].x,f.exits[0].y)); // The pad sits in the foyer.
  assert.ok(new Set(f.rooms.map(r=>r.type)).size>=7);
  for(const e of [...f.enemies,...f.chests,...f.pickups])assert.ok(!f.safeRooms.some(r=>inside(r,e.x,e.y)),'nothing spawns in the foyer');
  for(const e of f.enemies)assert.equal(e.roaming,e.type!=='chest_mimic'); // The mimic waits in place, as in the campaign.
  assert.ok(f.enemies.length>=12&&f.enemies.length<=60,'campaign spawn chances keep the house busy but not packed');
  for(const r of f.rooms.filter(r=>r.is_wedge))for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)if(mansionRoomContains(r,x,y))assert.equal(f.walls[y][x],0); // Wedge interiors are open floor.
  wedges+=f.rooms.filter(r=>r.is_wedge).length;hollows+=f.rooms.filter(r=>r.is_hollow&&!r.is_wedge).length;
  assert.ok(f.decorations.some(p=>(spookyMansionData.room_props[f.rooms.find(r=>p.x>=r.x&&p.x<r.x+r.w&&p.y>=r.y&&p.y<r.y+r.h)?.type]??[]).includes(p.sprite)),'rooms carry their own furniture');
 }
 assert.ok(wedges>=20&&hollows>=20,'hollow and wedge rooms are carved like the campaign');
 assert.deepEqual(computeTask('generate',{generator:'mansion',data:spookyMansionData,edition:'mansion-1'}),generateMansion(spookyMansionData,'mansion-1'));
});

test('the Woods gain a haunted house at their centre whose door is a warp pad, without moving any content',()=>{
 assert.ok(WILDERNESS_LINKS.some(([a,b])=>a===HAUNTED_WOODS_ZONE&&b===SPOOKY_MANSION_ZONE));
 for(let n=0;n<30;n++){
  const f=generateForest(hauntedWoodsData,'woods-'+n),before=structuredClone(f);
  assert.equal(addLandmark(f,landmark),true);assert.equal(addLandmark(f,landmark),false);openExitGaps(f); // Idempotent; gap conversion leaves the pad alone.
  assert.deepEqual(f.chests,before.chests);assert.deepEqual(f.enemies,before.enemies);assert.deepEqual(f.pickups,before.pickups);
  const pad=f.exits.find(e=>e.zone===SPOOKY_MANSION_ZONE),house=f.decorations.find(d=>d.sprite==='sprHauntedHouse');
  assert.equal(pad.style,'warp');assert.ok(house);assert.deepEqual([pad.x,pad.y],[house.x+landmark.door_x,house.y+landmark.span_h]); // Pad right below the door.
  assert.ok(Math.abs(house.x+2-40)<=7&&Math.abs(house.y+2-40)<=7,'near the middle of the Woods');
  for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++)assert.equal(f.props[house.y+dy][house.x+dx],1);
  assert.ok(pathTo(f,f.entrance,f.entries[SPOOKY_MANSION_ZONE]));assert.ok(validateDesert(f));
  for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)if(walkable(before,x,y)&&!(x>=house.x&&x<house.x+4&&y>=house.y&&y<house.y+4))assert.ok(walkable(f,x,y));
 }
});

test('the Spooky Mansion band sits just above the Woods',()=>{
 const tuning=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8')).loot.tuning;
 assert.ok(routeLevelFor(tuning,'spooky-mansion')>routeLevelFor(tuning,'haunted-woods'));
});

test('walk Honeydew -> Woods -> haunted house pad -> Spooky Mansion -> foyer pad -> back beside the house',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z');const ids={};
 const still=generate=>(...args)=>{const f=generate(...args);f.enemies.forEach(e=>e.roaming=false);return f;},quiet={log:()=>{},generate:still(generateDesert)};
 const api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:quiet,tundraOptions:quiet,taigaOptions:quiet,highDesertOptions:quiet,hauntedWoodsOptions:{log:()=>{},generate:still(generateForest)},spookyMansionOptions:{log:()=>{},generate:still(generateMansion)}});
 const snap=()=>api.read('a',ids.a),floor=()=>{const s=snap();return s.zones.find(z=>z.id===s.zone);};
 const act=(action,extra={})=>{time+=350;const s=snap();return api.act('a',{action,controller:'w',request_id:randomUUID(),character_id:ids.a,revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra});};
 const place=p=>{const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids.a),state=JSON.parse(row.state);if(state.dive){state.dive.position={...p};state.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids.a);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids.a);};
 try{
  ids.a=api.act('a',{action:'create',name:'Alice',controller:'w',request_id:randomUUID()}).character.id;
  act('enter',{zone:HONEYDEW,combat_version:3,content_version:1,quest_version:1,loadout:{player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:50,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100}});
  assert.throws(()=>act('dive_enter',{zone:SPOOKY_MANSION_ZONE}),/portal|unavailable|pad|trail/i); // No hub pad leads in; only the house.
  place({x:24,y:1});act('move',{direction:'north',world_step:true});assert.equal(snap().zone,HAUNTED_WOODS_ZONE);
  const pad=floor().exits.find(e=>e.zone===SPOOKY_MANSION_ZONE);assert.equal(pad.style,'warp');assert.equal(pad.name,'Spooky Mansion');
  assert.ok(floor().decorations.some(d=>d.sprite==='sprHauntedHouse'));
  place({x:pad.x,y:pad.y+1});act('move',{direction:'north',world_step:true}); // Step onto the glowing pad at the door.
  assert.equal(snap().zone,SPOOKY_MANSION_ZONE);const mansion=floor();assert.deepEqual([mansion.width,mansion.height,mansion.theme],[60,80,'mansion']);
  assert.ok(mansion.rooms.some(r=>r.type==='sanctum'));
  const back=mansion.exits[0];place({x:back.x,y:back.y+1});act('dive_exit',{zone:HAUNTED_WOODS_ZONE});
  assert.equal(snap().zone,HAUNTED_WOODS_ZONE);assert.deepEqual(snap().dive.position??{x:snap().position?.x,y:snap().position?.y},{x:pad.x,y:pad.y+1}); // Back on the porch, one tile south of the pad.
 }finally{api.close();db.close();}
});
