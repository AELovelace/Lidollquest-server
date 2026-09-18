import test from 'node:test';
import assert from 'node:assert/strict';
import {addPinkMist,mistAt,mistData} from '../server/dive-mist.mjs';
import {generateFloor,inside} from '../server/dive-generation.mjs';
import {generateDesert} from '../server/desert-generation.mjs';
import {diveData} from '../server/dive.mjs';
import {desertData,tundraData} from '../server/zones.mjs';
import {campaignDives} from '../server/hubs.mjs';

test('100 seeds per route preserve geometry, shared deterministic mist, walls and safe entrances',()=>{
 const routes=[diveData,desertData,tundraData,...campaignDives];
 for(const data of routes)for(let seed=0;seed<100;seed++){
  const generate=['desert_dungeon','tundra'].includes(data.config.theme)?generateDesert:generateFloor;
  const floor=generate(data,'mist-seed-'+seed),before=structuredClone(floor),second=structuredClone(floor);
  const policy={...mistData,zone_chances:{...mistData.zone_chances,[floor.theme]:1}};
  assert.equal(addPinkMist(floor,policy),true);addPinkMist(second,policy);assert.deepEqual(floor.mist,second.mist);
  assert.ok(floor.mist.tiles>0);assert.equal(floor.mist.rows.length,floor.height);
  assert.ok(Buffer.byteLength(JSON.stringify(floor.mist))<17500);
  let count=0;const safe=floor.safeRooms??floor.rooms.slice(0,1),entrances=[floor.entrance,...(floor.exits??[])];
  for(let y=0;y<floor.height;y++){
   assert.equal(floor.mist.rows[y].length,floor.width);assert.match(floor.mist.rows[y],/^[01]+$/);
   for(let x=0;x<floor.width;x++)if(mistAt(floor,x,y)){
    count++;assert.equal(floor.walls[y][x],0);assert.equal(safe.some(r=>inside(r,x,y)),false);
    assert.equal(entrances.some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=policy.entrance_radius),false);
   }
  }
  assert.equal(count,floor.mist.tiles);const first=structuredClone(floor.mist);
  assert.equal(addPinkMist(floor,{...policy,enabled:false,version:99}),false);assert.deepEqual(floor.mist,first);
  delete floor.mist;assert.deepEqual(floor,before,'mist installation never regenerates existing content');
 }
});

test('campaign chances, zero-chance outdoor zones and hallway spread stay bounded',()=>{
 assert.equal(mistData.zone_chances.forest,0);assert.equal(mistData.zone_chances.tundra,0);
 const base={route:'test',edition:'one',depth:1,theme:'forest',width:30,height:5,rooms:[{x:1,y:1,w:2,h:3},{x:10,y:1,w:2,h:3}],entrance:{x:1,y:2},walls:Array.from({length:5},(_,y)=>Array.from({length:30},(_,x)=>y===0||y===4||x===0||x===29?1:0))};
 const clear=structuredClone(base);addPinkMist(clear);assert.equal(clear.mist.tiles,0);
 const mist=structuredClone(base);addPinkMist(mist,{...mistData,zone_chances:{forest:1},room_fraction_min:1,room_fraction_max:1,hall_spread:6});
 assert.equal(mistAt(mist,17,2),true);assert.equal(mistAt(mist,18,2),false,'hallway expansion cannot continually reseed its own depth');
 const disabled=structuredClone(base);addPinkMist(disabled,{...mistData,enabled:false,zone_chances:{forest:1}});assert.equal(disabled.mist.tiles,0);
});
