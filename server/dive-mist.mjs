import {readFileSync} from 'node:fs';
import {seeded,inside} from './dive-generation.mjs';

export const mistData=JSON.parse(readFileSync(new URL('./mist-data.json',import.meta.url),'utf8'));
const directions=[[1,0],[-1,0],[0,1],[0,-1]];
export const mistAt=(floor,x,y)=>floor.mist?.rows?.[y]?.[x]==='1';

export function addPinkMist(floor,policy=mistData){ // Add one deterministic layer; never regenerate terrain, encounters, claims or an existing mist edition.
 if(floor.mist)return false;
 const chance=policy.enabled?(policy.zone_chances[floor.theme]??0):0;
 const rnd=seeded(`${floor.route}:${floor.edition}:${floor.depth}:pink-mist:${policy.version}`);
 const rows=Array.from({length:floor.height},()=>Array(floor.width).fill('0'));
 const entrances=[floor.entrance,...Object.values(floor.entries??{}),...(floor.exits??[])].filter(Boolean);
 const safeRooms=floor.safeRooms??floor.rooms.slice(0,1);
 const allowed=(x,y)=>floor.walls[y]?.[x]===0&&!safeRooms.some(r=>inside(r,x,y))
  &&!entrances.some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=policy.entrance_radius);
 const queue=[];
 function fill(x,y,depth){if(allowed(x,y)&&rows[y][x]==='0'){rows[y][x]='1';queue.push({x,y,depth});}}
 if(chance>0&&rnd(1000000)<chance*1000000){
  const rooms=floor.rooms.filter(r=>!safeRooms.includes(r)&&!entrances.some(p=>inside(r,p.x,p.y)));
  for(let i=rooms.length-1;i>0;i--){const j=rnd(i+1);[rooms[i],rooms[j]]=[rooms[j],rooms[i]];}
  const fraction=policy.room_fraction_min+rnd(1000000)/1000000*(policy.room_fraction_max-policy.room_fraction_min);
  const count=fraction>0?Math.min(rooms.length,Math.max(1,Math.round(rooms.length*fraction))):0;
  for(const r of rooms.slice(0,count))for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)fill(x,y,0);
  for(let i=0;i<queue.length;i++){
   const p=queue[i];if(p.depth>=policy.hall_spread)continue;
   for(const [dx,dy] of directions)fill(p.x+dx,p.y+dy,p.depth+1);
  } // Expand from the original room seeds only; newly filled cells never reset the six-tile depth limit.
 }
 floor.mist={version:policy.version,rows:rows.map(row=>row.join('')),tiles:queue.length};
 return true;
} // One compact character per tile keeps 128x128 mist layers below 17 KiB in snapshots.
