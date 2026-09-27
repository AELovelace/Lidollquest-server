import test from 'node:test';
import assert from 'node:assert/strict';
import {districtData,districtZone,generateDistrict,reachableDistrict,gateTargets} from '../server/hub-districts.mjs';
import {addFullDungeonEntrances,fullDungeonLinks} from '../server/full-dungeons.mjs';

test('saved monthly towns gain all full-dungeon doors additively without displaced fixtures or blocked arrivals',()=>{
 for(const def of districtData.districts.filter(d=>fullDungeonLinks(districtZone(d)).some(l=>!gateTargets(d).includes(l.target))))for(let seed=0;seed<100;seed++){
  const zone=districtZone(def),f=generateDistrict(def,{edition:'entrance-'+seed,ends:0}),gated=gateTargets(def),links=fullDungeonLinks(zone).filter(l=>!gated.includes(l.target));
  const visitor={x:f.fullDungeonPortals[0].x,y:f.fullDungeonPortals[0].y};delete f.fullDungeonPortals;f.fixtures=f.fixtures.filter(p=>!p.id.startsWith('entrance-dive-'));const before=structuredClone(f);
  assert.equal(addFullDungeonEntrances(f,zone,[visitor],gated),true);assert.equal(addFullDungeonEntrances(f,zone,[visitor],gated),false);
  assert.deepEqual(f.walls,before.walls);assert.deepEqual(f.fixtures.slice(0,before.fixtures.length),before.fixtures);
  const seen=reachableDistrict(f);assert.equal(f.fullDungeonPortals.length,links.length);
  assert.ok(seen.has(visitor.x+','+visitor.y),'the visitor remains on reachable open terrain');assert.ok(!f.fullDungeonPortals.some(p=>p.x===visitor.x&&p.y===visitor.y),'no new trigger underneath a visitor');
  for(const p of f.fullDungeonPortals){assert.ok(seen.has(p.x+','+p.y));assert.ok(seen.has(p.x+','+(p.y+1)));}
 }
});

test('Utopia reaches the Hospital and the Auto-Nursery through its side walls: no entrance buildings, and saved months lose the old ones',()=>{
 const def=districtData.districts.find(d=>d.hub==='utopia-arcanum'),gated=gateTargets(def);
 assert.deepEqual(gated,['dungeon-regression-hospital','dungeon-auto-nursery']);
 const f=generateDistrict(def,{edition:'gates-1',ends:0}),cy=Math.floor(f.height/2);
 assert.deepEqual(f.fullDungeonPortals??[],[]);assert.ok(!f.fixtures.some(x=>x.id.startsWith('entrance-dungeon-')),'no entrance buildings'); // The paths replace the buildings.
 for(const y of [cy-1,cy]){assert.equal(f.walls[y][0],0,'west gate open');assert.equal(f.walls[y][f.width-1],0,'east gate open');}
 const seen=reachableDistrict(f);assert.ok(seen.has('1,'+cy)&&seen.has((f.width-2)+','+cy),'both paths join the town');
 const old=structuredClone(f);addFullDungeonEntrances(old,'utopia-arcanum',[]); // A month saved before the gates had both buildings...
 assert.equal(old.fullDungeonPortals.length,2);assert.ok(old.fixtures.some(x=>x.id==='entrance-dungeon-auto-nursery'));
 assert.equal(addFullDungeonEntrances(old,'utopia-arcanum',[],gated),true); // ...and loses them on upgrade.
 assert.deepEqual(old.fullDungeonPortals,[]);assert.ok(!old.fixtures.some(x=>x.id.startsWith('entrance-dungeon-')));
 assert.equal(addFullDungeonEntrances(old,'utopia-arcanum',[],gated),false);
});
