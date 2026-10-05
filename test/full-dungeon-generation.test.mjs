import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateFullDungeon,validateFullDungeon,solveDungeonPuzzle} from '../server/full-dungeon-generation.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
const content=JSON.parse(readFileSync(new URL('../server/full-dungeons-data.json',import.meta.url)));

for(const data of content.routes)test(data.config.route+': 100 connected campaign-sized weekly maps',()=>{
 const stamps=new Set();
 for(let seed=0;seed<100;seed++){
  const f=generateFullDungeon(data,'full-port-'+seed);
  assert.deepEqual(generateFullDungeon(data,'full-port-'+seed),f,'same seed reproduces every fixture, encounter and mechanism');
  assert.equal(validateFullDungeon(f),true);
  assert.deepEqual([f.width,f.height],[data.config.width,data.config.height]);
  assert.equal(f.exits.length,data.config.endpoints.length);
  assert.equal(f.fixtures.filter(p=>p.kind==='npc').length,Object.keys(data.npcs).length);
  assert.equal(f.puzzles.length,1,`missing puzzle in seed ${seed}`);
  assert.ok(solveDungeonPuzzle(f,f.puzzles[0])!==null,`unsolvable puzzle in seed ${seed}`);
  stamps.add(f.puzzles[0].stamp);
  for(const type of data.campaign.type_pool??data.campaign.room_types.pool)assert.ok(f.rooms.some(r=>r.type===type),'Missing campaign room '+type);
  assert.ok(f.fixtures.some(p=>p.kind==='bed'));
  assert.ok(f.fixtures.some(p=>p.kind==='toilet'));
  for(const boss of data.config.bosses)assert.equal(f.enemies.filter(e=>e.id==='boss-'+boss.enemy_id).length,1);
  assert.ok(!f.fixtures.some(p=>p.kind==='orb'||p.id==='objNurseryControlDoor'));
  if(seed===0)assert.deepEqual(computeTask('generate',{generator:data.config.generator,data,edition:'full-port-'+seed}),f);
 }
 assert.deepEqual(stamps,new Set(data.puzzle_stamps.map(s=>s.name)),'all authored stamps are represented across these seeds');
});

for(const route of ['auto-nursery','regression-school','regression-hospital'])test(route+': hollow rooms fill the negative space behind one wall tile, with every room guaranteed',()=>{
 const data=content.routes.find(r=>r.config.route===route),s=data.structure,anchor=data.config.theme==='nursery'?'control':data.config.entrance_type;
 for(let seed=0;seed<40;seed++){
  const f=generateFullDungeon(data,'hollow-fill-'+seed),hollow=f.rooms.filter(r=>r.is_hollow);
  assert.ok(hollow.length>=s.hollow_space_min_rooms,`seed ${seed}: only ${hollow.length} hollow rooms`);
  for(const r of hollow){
   assert.ok(r.w>=3&&r.h>=3&&r.w<=r.h*(s.hollow_space_max_aspect??2)&&r.h<=r.w*(s.hollow_space_max_aspect??2),`seed ${seed}: ${r.w}x${r.h} is not room-shaped`);
   for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)assert.equal(f.walls[y][x],0,'hollow rooms are fully open');
   for(const other of f.rooms)if(other!==r)assert.ok(r.x>=other.x+other.w+1||other.x>=r.x+r.w+1||r.y>=other.y+other.h+1||other.y>=r.y+r.h+1,`seed ${seed}: rooms must keep a wall between them`);
  }
  const seen=new Set(),queue=[f.entrance];for(let i=0;i<queue.length;i++){const p=queue[i],k=p.x+','+p.y;if(f.walls[p.y]?.[p.x]!==0||seen.has(k))continue;seen.add(k);queue.push({x:p.x+1,y:p.y},{x:p.x-1,y:p.y},{x:p.x,y:p.y+1},{x:p.x,y:p.y-1});}
  for(const r of f.rooms)assert.ok(seen.has(r.cx+','+r.cy),`seed ${seed}: ${r.type} room unreachable`);
  assert.ok(f.rooms.some(r=>r.type===anchor&&!r.is_hollow),'the '+anchor+' room is present');
  for(const type of data.campaign.type_pool)assert.ok(f.rooms.some(r=>r.type===type),'missing ward '+type);
 }
});
