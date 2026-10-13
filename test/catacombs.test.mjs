import test from 'node:test';
import assert from 'node:assert/strict';
import {fullDungeons,addFullDungeonEntrances} from '../server/full-dungeons.mjs';
import {generateCatacombs,catacombInteract,catacombStep,reconcileCatacombReservations,CATACOMBS} from '../server/catacombs.mjs';
import {upgradeUndergroundFloor,normalizeUndergroundReturn,undergroundLinked} from '../server/underground-links.mjs';
import {walkable,inside} from '../server/dive-generation.mjs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';
const routes=fullDungeons.filter(d=>d.config.catacombs);
const flood=f=>{const q=[f.entrance],seen=new Set();for(let i=0;i<q.length;i++){const p=q[i],k=p.x+','+p.y;if(seen.has(k)||!walkable(f,p.x,p.y))continue;seen.add(k);for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]])q.push({x:p.x+dx,y:p.y+dy});}return seen;};
const key=p=>p.x+','+p.y;
test('100 deterministic editions per floor: loops, independent wings, safe landings, mist, rewards and candle shortcuts',()=>{
 for(const data of routes)for(let i=0;i<100;i++){
  const f=generateCatacombs(data,'audit-'+i);assert.deepEqual(f,generateCatacombs(data,'audit-'+i));assert.equal(f.width,80);assert.equal(f.height,80);assert.equal(f.rooms.length,14);
  assert.ok(f.catacombs.edges.length-12+1>=4);const reached=flood(f);
  for(const p of [...f.exits,...Object.values(f.entries)]){assert.ok(reached.has(key(p)));for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)assert.equal(f.mist.rows[p.y+dy][p.x+dx],'0');}
  assert.equal(f.chests.filter(c=>!c.requires_memorial&&!c.requires_encounter).length,4);assert.equal(f.pickups.length,6);
  for(const p of [...f.enemies,...f.pickups])assert.ok(reached.has(key(p)));
  for(const p of f.enemies)assert.ok(!f.safeRooms.some(r=>inside(r,p.x,p.y)));
  for(let y=0;y<80;y++)for(let x=0;x<80;x++)if(f.mist.rows[y][x]==='1'){assert.ok(walkable(f,x,y));assert.ok(!f.safeRooms.some(r=>inside(r,x,y)));}
  for(const seal of f.catacombs.reserved){assert.ok(!f.exits.some(e=>e.zone===seal.target));assert.ok(!f.entries[seal.target]);assert.ok(!walkable(f,seal.x,seal.y));}
  for(const q of f.catacombs.puzzles){
   const chest=f.chests.find(c=>c.requires_memorial===q.id);assert.ok(!reached.has(key(chest)),'secret is actually sealed');
   const candles=f.fixtures.filter(c=>c.puzzle===q.id&&c.kind==='catacomb_candle');assert.equal(candles.length,4);
   for(const c of candles)assert.ok([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>reached.has((c.x+dx)+','+(c.y+dy))));
   const epitaph=f.fixtures.find(c=>c.id===q.id+'-epitaph').text;assert.ok(epitaph.includes(q.order.map(i=>['Leaf','Bell','Star','Key'][i]).join(', then ')));
   for(const symbol of q.order)catacombInteract(f,candles.find(c=>c.symbol===symbol),f.mechanismRevision);
   assert.ok(q.solved);assert.ok(flood(f).has(key(chest)));for(const p of q.doors)assert.ok(walkable(f,p.x,p.y));
  }
 }
});
test('candle mistakes reset only the unfinished sequence; stale interactions and future seals cannot open doors',()=>{
 const f=generateCatacombs(routes[0],'candles'),q=f.catacombs.puzzles[0],c=i=>f.fixtures.find(v=>v.puzzle===q.id&&v.symbol===i);
 catacombInteract(f,c(q.order[0]),0);assert.equal(q.progress,1);assert.throws(()=>catacombInteract(f,c(q.order[1]),0),/changed/);
 catacombInteract(f,c(q.order[0]),1);assert.equal(q.progress,0);
 for(const i of q.order)catacombInteract(f,c(i),f.mechanismRevision);
 const geometry=JSON.stringify(f.props);catacombInteract(f,c(q.order[0]),f.mechanismRevision);assert.equal(JSON.stringify(f.props),geometry);
 for(const seal of f.fixtures.filter(v=>v.kind==='catacomb_seal'))assert.equal(catacombInteract(f,seal,f.mechanismRevision),'This passage remains sealed.');
 assert.equal(reconcileCatacombReservations(f,()=>false),false);
 const terrain=JSON.stringify(f.walls),chests=JSON.stringify(f.chests),mist=JSON.stringify(f.mist);
 assert.equal(reconcileCatacombReservations(f,target=>target==='dungeon-mana-tunnels'),true);assert.equal(reconcileCatacombReservations(f,()=>false),false);
 assert.equal(JSON.stringify(f.walls),terrain);assert.equal(JSON.stringify(f.chests),chests);assert.equal(JSON.stringify(f.mist),mist);assert.ok(f.entries['dungeon-mana-tunnels']);assert.ok(!f.entries['dungeon-steam-network']);
});
test('personal Grave Chill counts twelve committed steps, cannot refresh and honors wet-only/refuge recovery',()=>{
 const f=generateCatacombs(routes[1],'curse'),personal={},s={loadout:{player_info:{wet:0,tum:0},world:{}},dive:{}},r=f.catacombs.crypts[0],p=s.loadout.player_info;
 catacombStep(f,s,personal,r.cx,r.cy);assert.equal(s.graveChill.steps,12);
 for(let i=0;i<12;i++)catacombStep(f,s,personal,r.cx,r.cy);
 assert.equal(p.wet,24);assert.equal(p.tum,12);assert.ok(!s.graveChill);catacombStep(f,s,personal,r.cx,r.cy);assert.equal(p.wet,24);
 const haunt=f.catacombs.haunts[0];s.loadout.world.wet_only_mode=true;catacombStep(f,s,personal,haunt.x,haunt.y);catacombStep(f,s,personal,haunt.x,haunt.y);assert.equal(p.wet,39);assert.equal(p.tum,12);
 const r2=f.catacombs.crypts[1];catacombStep(f,s,personal,r2.cx,r2.cy);assert.equal(s.graveChill.steps,12);const refuge=f.catacombs.refuges[0];catacombStep(f,s,personal,refuge.cx,refuge.cy);assert.ok(!s.graveChill);
});
test('migration changes only obsolete exit identities and return metadata; future definitions are not traversable',()=>{
 for(const route of ['castle-dungeon','littlebig-sewers']){
  const f={route,walls:[[1,0]],entries:{'arcadia-foundry':{x:3,y:4}},exits:[{zone:'arcadia-foundry',x:3,y:3}],chests:[{id:'claimed'}],enemies:[{id:'fighting',engaged:'battle'}]};const before=structuredClone(f);
  assert.equal(upgradeUndergroundFloor(f,()=>false),false);assert.deepEqual(f,before);assert.equal(upgradeUndergroundFloor(f,()=>true),true);assert.equal(upgradeUndergroundFloor(f,()=>true),false);
  assert.deepEqual(f.walls,before.walls);assert.deepEqual(f.chests,before.chests);assert.deepEqual(f.enemies,before.enemies);assert.deepEqual(f.entries[CATACOMBS],before.entries['arcadia-foundry']);assert.equal(f.exits[0].x,3);
  const s={dive:{route,zone:'dungeon-'+route,returnZone:'arcadia-foundry',origin:'arcadia-foundry',position:{x:14,y:18}},run:{id:'battle'}};normalizeUndergroundReturn(s);assert.deepEqual(s.dive.position,{x:14,y:18});assert.equal(s.run.id,'battle');assert.equal(s.dive.returnZone,route==='castle-dungeon'?'princess-rose-garden':'littlebig-clockwork');
 }
 assert.ok(undergroundLinked(CATACOMBS,'dungeon-castle-dungeon'));assert.ok(undergroundLinked(CATACOMBS,'dungeon-mana-tunnels'));assert.ok(!undergroundLinked(CATACOMBS,'dungeon-steam-network'));assert.ok(!undergroundLinked(CATACOMBS,'arcadia-foundry'));
});
test('guardian locket consistently uses rare accessory scaling without an equipment curse',()=>{
 const data=routes[2],f=generateCatacombs(data,'reward'),chest=f.chests.find(c=>c.id==='keeper-relic'),roll=createDiveLootRoller(data);
 for(let i=0;i<30;i++){const item=roll('reward','player-'+i,chest,{});assert.equal(item.category,'accessory');assert.equal(item.rarity,'rare');assert.ok(item.def>0);assert.ok(item.int_mod>0);assert.ok(!item.curse);}
});
