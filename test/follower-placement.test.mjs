import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createFollowers,followerData} from '../server/followers.mjs';
import {diveData} from '../server/dive.mjs';
import {campaignDives} from '../server/hubs.mjs';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {generateFloor,pathTo,walkable} from '../server/dive-generation.mjs';
import {generateFullDungeon} from '../server/full-dungeon-generation.mjs';
import {generateMansion} from '../server/mansion-generation.mjs';

test('every companion recruits on a reachable tile just inside its dungeon entrance across regenerated maps',()=>{
 const db=new DatabaseSync(':memory:');try{
  const followers=createFollowers(db),mansion=JSON.parse(readFileSync(new URL('../server/spooky-mansion-data.json',import.meta.url)));
  for(const [id,npc] of Object.entries(followerData)){
   const zone=npc.online.home_zone,data=[diveData,...campaignDives,...fullDungeons,mansion].find(d=>(d.config.zone_id??'dive-quarters')===zone);assert.ok(data,zone);
   const generate=data===mansion?generateMansion:data.config.full_dungeon_version?generateFullDungeon:generateFloor;
   for(const edition of ['2026-09-21','2026-09-28','2026-10-05']){
    const floor=generate(data,edition),at=followers.placement(id,zone,floor);assert.ok(at,id+' '+edition);
    assert.ok(walkable(floor,at.x,at.y));assert.ok(pathTo(floor,floor.entrance,at,8));
    assert.ok(Math.abs(at.x-floor.entrance.x)+Math.abs(at.y-floor.entrance.y)<=3,id+' stays beside the entrance');
    assert.ok(![floor.entrance,...(floor.exits??[])].some(p=>p.x===at.x&&p.y===at.y));
    assert.deepEqual(followers.placement(id,zone,floor),at,'Snapshots and hiring agree on the same spot');
   }
  }
 }finally{db.close();}
});

test('recruiters avoid furniture and portal pads, and companions sharing a home do not overlap',()=>{
 const db=new DatabaseSync(':memory:');try{
  const catalog=structuredClone(followerData);for(const npc of Object.values(catalog))npc.online.home_zone='dungeon-test';
  const followers=createFollowers(db,{catalog}),floor={width:15,height:15,entrance:{x:7,y:7},walls:Array.from({length:15},()=>Array(15).fill(0)),props:Array.from({length:15},()=>Array(15).fill(0)),exits:[{x:6,y:7}],managedOccupancy:[{x:8,y:7}],fixtures:[]};floor.props[6][7]=1;
  const points=Object.keys(catalog).map(id=>followers.placement(id,'dungeon-test',floor));assert.equal(new Set(points.map(p=>p.x+','+p.y)).size,7);
  for(const p of points){assert.ok(walkable(floor,p.x,p.y));assert.notDeepEqual(p,{x:6,y:7});assert.ok(pathTo(floor,floor.entrance,p,8));}
 }finally{db.close();}
});
