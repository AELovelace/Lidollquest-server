import test from 'node:test';
import assert from 'node:assert/strict';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {generateManaCaves,manaInteract,manaStep,MANA_CAVES} from '../server/mana-caves.mjs';
import {dungeonReachable} from '../server/full-dungeon-generation.mjs';
import {walkable,inside} from '../server/dive-generation.mjs';
import {generateCatacombs,reconcileCatacombReservations,CATACOMBS} from '../server/catacombs.mjs';
import {undergroundLinked} from '../server/underground-links.mjs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';
import {combatData} from '../server/combat.mjs';
const data=fullDungeons.find(d=>d.config.zone_id===MANA_CAVES),key=p=>p.x+','+p.y;

test('100 deterministic editions: northwest/southeast exits, six loops, reachable puzzles and protected mist-free arrivals',()=>{
 for(let seed=0;seed<100;seed++){
  const f=generateManaCaves(data,'audit-'+seed);assert.deepEqual(f,generateManaCaves(data,'audit-'+seed));assert.equal(f.rooms.length,16);
  assert.equal(f.manaCaves.edges.length-12+1,6);const reachable=dungeonReachable(f),utopia=f.exits[0],cat=f.exits[1];
  assert.equal(utopia.zone,'utopia-arcanum');assert.ok(utopia.x<20&&utopia.y<20);assert.equal(cat.zone,CATACOMBS);assert.ok(cat.x>60&&cat.y>60);
  for(const p of [...f.exits,...Object.values(f.entries)]){assert.ok(reachable.has(key(p)));for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)assert.equal(f.mist.rows[p.y+dy][p.x+dx],'0');}
  assert.equal(f.chests.length,10);assert.equal(f.pickups.length,8);assert.equal(f.enemies.length,17);
  for(const e of f.enemies){assert.ok(reachable.has(key(e)));assert.ok(!f.safeRooms.some(r=>inside(r,e.x,e.y)));}
  let mist=0,eligible=0;
  for(let y=1;y<79;y++)for(let x=1;x<79;x++){
   const safe=f.safeRooms.some(r=>inside(r,x,y)),near=[...f.exits,...Object.values(f.entries)].some(p=>Math.max(Math.abs(p.x-x),Math.abs(p.y-y))<=3),interact=f.fixtures.some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=1);
   if(walkable(f,x,y)&&!safe&&!near&&!interact)eligible++;
   if(f.mist.rows[y][x]==='1'){mist++;assert.ok(walkable(f,x,y)&&!safe&&!near&&!interact);}
  }
  assert.equal(mist,Math.ceil(eligible*.25));assert.equal(mist,f.mist.tiles);
  for(const q of f.manaCaves.puzzles){
   const chest=f.chests.find(c=>c.requires_resonance===q.id);assert.ok(!reachable.has(key(chest)),'cache must really be sealed');
   const crystals=f.fixtures.filter(v=>v.puzzle===q.id&&v.kind==='mana_crystal');
   for(const v of crystals)assert.ok([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>reachable.has((v.x+dx)+','+(v.y+dy))));
   const clue=f.fixtures.find(v=>v.id===q.id+'-inscription').text;assert.ok(clue.includes(q.order.map(i=>data.config.mana_caves.symbols[i]).join(', then ')));
   for(const symbol of q.order)manaInteract(f,crystals.find(v=>v.symbol===symbol),f.mechanismRevision);
   assert.ok(q.solved);assert.ok(dungeonReachable(f).has(key(chest)));for(const p of q.doors)assert.ok(walkable(f,p.x,p.y));
  }
 }
});

test('incorrect/stale resonance inputs cannot punish players or close solved passages',()=>{
 const f=generateManaCaves(data,'mistakes'),q=f.manaCaves.puzzles[0],crystal=i=>f.fixtures.find(v=>v.puzzle===q.id&&v.symbol===i);
 manaInteract(f,crystal(q.order[0]),0);assert.equal(q.progress,1);assert.throws(()=>manaInteract(f,crystal(q.order[1]),0),/changed/);
 manaInteract(f,crystal(q.order[0]),1);assert.equal(q.progress,0);assert.equal(f.geometryVersion,1);
 for(const symbol of q.order)manaInteract(f,crystal(symbol),f.mechanismRevision);
 const before=structuredClone(f);manaInteract(f,crystal(q.order[0]),f.mechanismRevision);assert.deepEqual(f,before);
});

test('seams are personal, once per edition, wet-only aware, and suppressed during combat/scenes',()=>{
 const f=generateManaCaves(data,'seams'),h=f.manaCaves.seams[0],personal={},s={dive:{},loadout:{player_info:{wet:0,tum:0},world:{wet_only_mode:true}}};
 manaStep(f,s,personal,h.x,h.y);manaStep(f,s,personal,h.x,h.y);assert.equal(s.loadout.player_info.wet,12);assert.equal(s.loadout.player_info.tum,0);
 const other={};s.loadout.world.wet_only_mode=false;manaStep(f,s,other,h.x,h.y);assert.equal(s.loadout.player_info.wet,24);assert.equal(s.loadout.player_info.tum,6);
 for(const flag of ['run','dungeonScene','pendingDefeat']){s[flag]={};manaStep(f,s,{},h.x,h.y);delete s[flag];assert.equal(s.loadout.player_info.wet,24);}
});

test('activation preserves Catacombs geometry, mist, rewards and encounters; Steam stays reserved',()=>{
 const f=generateCatacombs(fullDungeons.find(d=>d.config.zone_id===CATACOMBS),'migration'),before=structuredClone(f);
 assert.ok(undergroundLinked(CATACOMBS,MANA_CAVES));assert.ok(!undergroundLinked(CATACOMBS,'dungeon-steam-network'));
 assert.ok(!reconcileCatacombReservations(f,()=>false));assert.ok(reconcileCatacombReservations(f,t=>t===MANA_CAVES));assert.ok(!reconcileCatacombReservations(f,t=>t===MANA_CAVES));
 for(const field of ['walls','enemies','chests','pickups','mist'])assert.deepEqual(f[field],before[field]);
 assert.ok(f.entries[MANA_CAVES]);assert.ok(!f.entries['dungeon-steam-network']);
});

test('pendant scales as a rare uncursed accessory and every spell uses an existing enemy action',()=>{
 const f=generateManaCaves(data,'reward'),chest=f.chests.find(c=>c.requires_encounter),roll=createDiveLootRoller(data);
 for(let i=0;i<20;i++){const item=roll('reward','player-'+i,chest,{});assert.equal(item.rarity,'rare');assert.equal(item.category,'accessory');assert.ok(item.int_mod>0&&item.def>0);assert.ok(!item.curse);}
 for(const e of Object.values(data.enemies))for(const id of e.enemy_spells)assert.ok(combatData.spells[id]?.enemy_only);
});
