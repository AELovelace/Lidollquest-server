import test from 'node:test';
import assert from 'node:assert/strict';
import {desertData,tundraData,taigaData,highDesertData} from '../server/zones.mjs';
import {generateDesert} from '../server/desert-generation.mjs';
import {pathTo,walkable,inside} from '../server/dive-generation.mjs';
import {addNorthTrail,openExitGaps,inExit,nearExit} from '../server/wilderness-links.mjs';

const routes=[['desert',desertData,highDesertData],['tundra',tundraData,taigaData],['taiga',taigaData,null],['high desert',highDesertData,null]]; // [label, route data, north branch it links to]

test('every overworld exit becomes a two-tile boundary gap reachable from each entry',()=>{
 for(const [label,data,branch] of routes)for(let n=0;n<30;n++){
  const f=generateDesert(data,'gap-'+n),before=structuredClone(f);
  if(branch)addNorthTrail(f,branch.config); // Parents also carry the north trail to their branch.
  assert.equal(openExitGaps(f),true,label);assert.equal(openExitGaps(f),false,label+' is idempotent');
  assert.deepEqual(f.chests,before.chests);assert.deepEqual(f.pickups,before.pickups);assert.deepEqual(f.enemies.map(e=>[e.id,e.x,e.y]),before.enemies.map(e=>[e.id,e.x,e.y])); // Content never moves.
  for(const exit of f.exits){
   assert.equal(exit.style,'gap');assert.equal((exit.w??1)*(exit.h??1),2,label);
   const onBoundary={left:exit.x===0,right:exit.x===f.width-1,top:exit.y===0,bottom:exit.y===f.height-1}[exit.side];assert.ok(onBoundary,label+' '+exit.side);
   for(let dy=0;dy<exit.h;dy++)for(let dx=0;dx<exit.w;dx++)assert.ok(walkable(f,exit.x+dx,exit.y+dy),label+' gap tile is open');
   const entry=f.entries[exit.zone];assert.ok(walkable(f,entry.x,entry.y));assert.ok(nearExit(exit,entry.x,entry.y)&&!inExit(exit,entry.x,entry.y),label+' arrives one tile inside');
   assert.ok(f.safeRooms.some(r=>inside(r,entry.x,entry.y)),label+' arrival is safe');
   for(const other of Object.values(f.entries))assert.ok(pathTo(f,other,{x:exit.x,y:exit.y}),label+' gap reachable');
   for(const p of [...f.enemies,...f.chests,...f.pickups])assert.ok(!inExit(exit,p.x,p.y),label+' nothing spawns in the opening');
  }
 }
});
