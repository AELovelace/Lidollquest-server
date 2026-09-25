import test from 'node:test';
import assert from 'node:assert/strict';
import {districtData,districtZone,generateDistrict,reachableDistrict} from '../server/hub-districts.mjs';
import {addFullDungeonEntrances,fullDungeonLinks} from '../server/full-dungeons.mjs';

test('saved monthly towns gain all full-dungeon doors additively without displaced fixtures or blocked arrivals',()=>{
 for(const def of districtData.districts.filter(d=>fullDungeonLinks(districtZone(d)).length))for(let seed=0;seed<100;seed++){
  const zone=districtZone(def),f=generateDistrict(def,{edition:'entrance-'+seed,ends:0});
  const visitor={x:f.fullDungeonPortals[0].x,y:f.fullDungeonPortals[0].y};delete f.fullDungeonPortals;f.fixtures=f.fixtures.filter(p=>!p.id.startsWith('entrance-dive-'));const before=structuredClone(f);
  assert.equal(addFullDungeonEntrances(f,zone,[visitor]),true);assert.equal(addFullDungeonEntrances(f,zone,[visitor]),false);
  assert.deepEqual(f.walls,before.walls);assert.deepEqual(f.fixtures.slice(0,before.fixtures.length),before.fixtures);
  const seen=reachableDistrict(f);assert.equal(f.fullDungeonPortals.length,fullDungeonLinks(zone).length);
  assert.ok(seen.has(visitor.x+','+visitor.y),'the visitor remains on reachable open terrain');assert.ok(!f.fullDungeonPortals.some(p=>p.x===visitor.x&&p.y===visitor.y),'no new trigger underneath a visitor');
  for(const p of f.fullDungeonPortals){assert.ok(seen.has(p.x+','+p.y));assert.ok(seen.has(p.x+','+(p.y+1)));}
 }
});
