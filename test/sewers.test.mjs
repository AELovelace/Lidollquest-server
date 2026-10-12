import test from 'node:test';
import assert from 'node:assert/strict';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {generateSewers,sewerValve,sewerLow,sewerStep,sewerStance,sewerDelay} from '../server/sewers.mjs';
import {validateFullDungeon,dungeonReachable} from '../server/full-dungeon-generation.mjs';
import {isCrawling,setCrawling,standBlockReason} from '../server/crawl.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {pathTo} from '../server/dive-generation.mjs';

const data=fullDungeons.find(d=>d.config.theme==='sewer');
test('100 sewer seeds retain circular chambers, standing routes, hazards and deterministic workers',()=>{
 for(let i=0;i<100;i++){
  const f=generateSewers(data,'sewer-'+i);assert.deepEqual(f,generateSewers(data,'sewer-'+i));
  assert.equal(f.rooms.length,18);assert.equal(f.sewer.lights.length,18);assert.equal(f.enemies.length,8);assert.equal(f.chests.length,8);
  for(const p of f.chests.filter(p=>p.id.startsWith('treasure-')))assert.equal([[1,0],[-1,0],[0,1],[0,-1]].filter(([dx,dy])=>f.walls[p.y+dy]?.[p.x+dx]===0).length,2,'treasure sits at the tip of a two-wide dead end');
  const standing={...f,props:f.props.map((r,y)=>r.map((v,x)=>v||sewerLow(f,x,y)?1:0))},seen=dungeonReachable(standing);
  for(const e of f.exits)assert.ok(seen.has(e.x+','+e.y),'standing exit');
  assert.ok(pathTo(standing,f.entrance,f.exits[1]).length<300,'cross links offer a shorter standing journey than the old single tube');
  assert.equal(f.sewer.crossings.length,8);
  for(const crossing of f.sewer.crossings){
   const [a,b]=crossing.rooms.map(i=>f.rooms[i]),midY=(a.cy+b.cy)/2;
   assert.ok(crossing.cells.every(p=>!sewerLow(f,p.x,p.y)),'cross links never force crawling');
   const cut={...standing,props:standing.props.map(r=>[...r])};
   for(const p of crossing.cells)if(p.y===midY)cut.props[p.y][p.x]=1; // Sever both lanes in the shaft so a two-wide corridor cannot masquerade as a loop.
   const around=dungeonReachable(cut,{x:a.cx+8,y:midY-1});
   assert.ok(around.has((a.cx+8)+','+(midY+1)),'each shaft has an independent standing route around its cut');
   for(const r of f.rooms)assert.ok(around.has(r.cx+','+r.cy),'all junctions remain accessible when any cross link is cut');
  }
  for(const r of f.rooms){assert.ok(seen.has(r.cx+','+r.cy));for(const p of r.cells)assert.ok((p.x-r.cx)**2+(p.y-r.cy)**2<=r.radius**2);}
  const controlled=new Set(f.sewer.branches.flatMap(b=>b.paths.flat().map(p=>p.x+','+p.y)));let eligible=0,mist=0;
  for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)if(f.walls[y][x]===0&&!controlled.has(x+','+y)&&!f.safeRooms.some(r=>x>=r.x&&y>=r.y&&x<r.x+r.w&&y<r.y+r.h)){eligible++;mist+=f.mist.rows[y][x]==='1';}
  assert.ok(mist/eligible>=.75,'common mist');
  const walls=JSON.stringify(f.walls),props=JSON.stringify(f.props);
  for(let combination=0;combination<8;combination++){
   for(let b=0;b<3;b++)if(f.sewer.branches[b].state!==((combination>>b)&1))sewerValve(f,f.fixtures.find(v=>v.branch===b),f.mechanismRevision);
   assert.ok(validateFullDungeon(f));assert.equal(JSON.stringify(f.walls),walls);assert.equal(JSON.stringify(f.props),props);
   for(const r of f.safeRooms)for(const p of r.cells)assert.equal(f.mist.rows[p.y][p.x],'0');
  }
 }
 assert.deepEqual(computeTask('generate',{generator:'sewers',data,edition:'worker'}),generateSewers(data,'worker'));
});
test('editor boundary radii and pipe lengths keep a standing path and minimum mist coverage',()=>{
 for(const radius of [3,6])for(const low_length of [6,12])for(const cross_links of [4,5,8])for(let seed=0;seed<10;seed++){
  const d=structuredClone(data);Object.assign(d.structure,{radius_min:radius,radius_max:radius,low_length,cross_links});d.config.sewer.mist_coverage=.75;
  const f=generateSewers(d,'boundary-'+seed),standing={...f,props:f.props.map((r,y)=>r.map((v,x)=>v||sewerLow(f,x,y)?1:0))};
  assert.ok(dungeonReachable(standing).has(f.exits[1].x+','+f.exits[1].y));
  assert.equal(f.sewer.crossings.length,cross_links);
  for(const row of [14,46])assert.ok(f.sewer.crossings.filter(c=>f.rooms[c.rooms[0]].cy===row).length>=2,'both row gaps have multiple crossings');
  for(const p of f.chests.filter(p=>p.id.startsWith('treasure-')))assert.equal([[1,0],[-1,0],[0,1],[0,-1]].filter(([dx,dy])=>f.walls[p.y+dy]?.[p.x+dx]===0).length,2,'crossings preserve treasure alcoves at editor limits');
  for(const b of f.sewer.branches)for(const y of new Set(b.paths[1].map(p=>p.y))){const cells=b.paths[1].filter(p=>p.y===y&&sewerLow(f,p.x,p.y));assert.ok(cells.length>=6&&cells.length<=12,'each pipe row spans six to twelve cells');}
 }
});
test('shared valves reject stale revision without changing hazards',()=>{
 const f=generateSewers(data,'valves'),fix=f.fixtures[0];sewerValve(f,fix,0);const saved=structuredClone(f);
 assert.throws(()=>sewerValve(f,fix,0),/changed/);assert.deepEqual(f,saved);assert.deepEqual(JSON.parse(JSON.stringify(f)),f);
});
test('pipe stance restores voluntary choice and water exposure is persistent and idempotent',()=>{
 const f=generateSewers(data,'stance'),p=f.sewer.branches[0].paths[1].find(p=>sewerLow(f,p.x,p.y)),s={loadout:{world:{crawling:false},player_info:{stamina:10,str:10,def:10,dex:10,int:10,cha:10,equipped_socks:'socks',equipped_shoes:'shoes',equipped_pants:'dress',equipped_torso:'dress'}}},items={dress:{category:'dress'}};
 assert.ok(sewerDelay(f,s,p.x-1,p.y,p.x,p.y)>=475);sewerStep(f,s,p.x,p.y,items);assert.ok(isCrawling(s.loadout));assert.match(standBlockReason(s.loadout),/pipes/);
 assert.equal(s.loadout.player_info.wet_clothing_penalty,1);assert.equal(s.loadout.player_info.clothing_water_source.torso,'sewer water');sewerStep(f,s,p.x,p.y,items);assert.equal(s.loadout.player_info.str,9);
 sewerStance({},s,0,0);assert.equal(isCrawling(s.loadout),false);setCrawling(s.loadout,true);sewerStance(f,s,p.x,p.y);sewerStance({},s,0,0);assert.equal(isCrawling(s.loadout),true);
 setCrawling(s.loadout,false);s.loadout.player_info.stamina=0;sewerStance(f,s,p.x,p.y);sewerStance({},s,0,0);assert.equal(isCrawling(s.loadout),true,'leaving pipes cannot defeat exhaustion');
 s.loadout.player_info.stamina=10;setCrawling(s.loadout,true);sewerStance(f,s,p.x,p.y);sewerStance({},s,0,0);assert.equal(isCrawling(s.loadout),true,'combat knockdown survives pipe exit');
 const combat={run:{},loadout:{world:{crawling:false},player_info:{stamina:10,equipped_shoes:'shoes'}}};sewerStep(f,combat,p.x,p.y,items);assert.equal(combat.loadout.player_info.slot_wet_shoes,undefined,'no combat exposure');
});
