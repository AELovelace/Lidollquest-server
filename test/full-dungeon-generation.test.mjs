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
