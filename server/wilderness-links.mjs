import {walkable} from './dive-generation.mjs';

export function addNorthTrail(f,{zone_id,name}){ // Carve a 3-wide north-center trail from (width/2,1) to the nearest open floor below it.
 if(f.exits.some(exit=>exit.zone===zone_id))return false;
 const x=Math.floor(f.width/2),cells=new Set();let end=2;
 while(end<f.height-2&&!walkable(f,x,end))end++;
 for(let y=1;y<=end;y++)for(let xx=x-1;xx<=x+1;xx++){f.walls[y][xx]=0;cells.add(xx+','+y);}
 f.decorations=f.decorations.filter(prop=>{
  let overlaps=false;
  for(let dy=0;dy<prop.span_h;dy++)for(let dx=0;dx<prop.span_w;dx++)if(cells.has((prop.x+dx)+','+(prop.y+dy)))overlaps=true;
  if(overlaps)for(let dy=0;dy<prop.span_h;dy++)for(let dx=0;dx<prop.span_w;dx++)f.props[prop.y+dy][prop.x+dx]=0;
  return !overlaps;
 }); // Remove an intersecting prop's complete footprint; every other object and claim ID stays in place.
 const safe={x:x-1,y:1,w:3,h:2};f.safeRooms.push(safe);
 f.exits.push({x,y:1,zone:zone_id,name});f.entries[zone_id]={x,y:2};
 f.geometryVersion=(f.geometryVersion??0)+1;
 return true; // Open only new terrain, so active editions retain their existing rooms, loot and encounter locks.
}
export const addTaigaTrail=addNorthTrail; // Tundra's original name stays importable for existing tests and tools.
