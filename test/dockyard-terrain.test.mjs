import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {generateFullDungeon,repairFullDungeonContent} from '../server/full-dungeon-generation.mjs';

const data=fullDungeons.find(d=>d.config.theme==='arcadia_dockyard');
const panel=readFileSync(new URL('../server/gm-world-panel.js',import.meta.url),'utf8');
const colour=runInNewContext(panel.slice(0,panel.indexOf('let contentData='))+'\nworldTerrainColour;'); // Exercise the actual live-map colour selection without requiring a DOM.

test('dockyard building markers upgrade existing editions without changing collision or progress',()=>{
 const f=generateFullDungeon(data,'dockyard-wall-upgrade');
 for(const r of f.rooms)delete r.building;
 const before=structuredClone(f);
 assert.equal(repairFullDungeonContent(f,data),true);
 assert.equal(f.geometryVersion,before.geometryVersion+1);
 for(const r of f.rooms)assert.equal(r.building,data.config.building_rooms.includes(r.type));
 const repaired=structuredClone(f);for(const r of repaired.rooms)delete r.building;repaired.geometryVersion=before.geometryVersion;
 assert.deepEqual(repaired,before,'presentation upgrade must preserve the saved map and its mechanisms');
 assert.equal(repairFullDungeonContent(f,data),false,'an unchanged marker set must not invalidate snapshots repeatedly');
});

test('live map shows only a one-cell building border, open doorways and ocean around narrows',()=>{
 const f={theme:'arcadia_dockyard',walls:Array.from({length:12},()=>Array(12).fill(1)),rooms:[{x:3,y:3,w:4,h:4,building:true}]};
 for(let y=3;y<7;y++)for(let x=3;x<7;x++)f.walls[y][x]=0;
 f.walls[2][4]=0;f.walls[1][4]=0; // A narrow approach pier enters through the north doorway.
 for(let y=0;y<12;y++)for(let x=0;x<12;x++){
  const ring=x>=2&&x<=7&&y>=2&&y<=7&&(x===2||x===7||y===2||y===7);
  assert.equal(colour(f,x,y),!f.walls[y][x]?'#aa9776':ring?'#74777e':((x+y)%2?'#246683':'#286d89'));
 }
 f.rooms[0].building=false;
 assert.equal(colour(f,2,3),'#246683','an open quay must not receive warehouse walls');
 f.props=Array.from({length:12},()=>Array(12).fill(0));f.props[3][3]=1;
 assert.equal(colour(f,3,3),'#352840','solid cargo stays visible on deck');
});
