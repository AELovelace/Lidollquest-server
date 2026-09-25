import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {hubWallGrid,hubTileBlocked} from '../server/zones.mjs';
import {hubCatalog,hubRooms} from '../server/hubs.mjs';
import {createHubDistricts} from '../server/hub-districts.mjs';

// hubWallGrid (2026-09-25 perf pass) replaced per-tile blocked() calls that rescanned every fixture for
// every tile of a 50x50 town on each snapshot. It must give exactly the same grid, tile for tile.
const brute=z=>Array.from({length:z.height??12},(_,y)=>Array.from({length:z.width??20},(_,x)=>hubTileBlocked(z,x,y)?1:0)); // The old per-tile build.

test('hubWallGrid matches per-tile blocked() for every hub room, every monthly town and awkward fixtures',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-25T12:00:00Z');
 try{
  db.exec('CREATE TABLE quest_presence(owner TEXT PRIMARY KEY,character_id TEXT,zone TEXT,x INTEGER,y INTEGER,seen INTEGER,moved INTEGER)'); // Districts ask who is standing where before placing residents.
  const districts=createHubDistricts(db,{now:()=>now}); // Real resolved towns, with their residents, stalls and buildings.
  const rooms=[...hubCatalog,...hubRooms].map(z=>districts.resolve(z));
  const odd={id:'odd',width:12,height:9,theme:'clockwork',fixtures:[{x:-1,y:-1,span_w:3,span_h:3},{x:10,y:7,span_w:5,span_h:5},{x:4,y:4,solid:false},{x:6,y:2,span_w:2}]}; // Off-map spans, a walk-through fixture and the clockwork counter row.
  for(const z of [...rooms,odd,{...odd,parent:'x'},{...odd,fixtures:[]}])assert.deepEqual(hubWallGrid(z),brute(z),z.id);
 }finally{db.close();}
});
