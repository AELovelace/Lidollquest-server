import {walkable} from './dive-generation.mjs';

export function addNorthTrail(f,{zone_id,name}){ // Carve a 3-wide north-center trail from (width/2,1) to the nearest open floor below it.
 if(f.exits.some(exit=>exit.zone===zone_id))return false;
 const x=Math.floor(f.width/2),cells=new Set();let end=2;
 while(end<f.height-2&&!walkable(f,x,end))end++;
 for(let y=1;y<=end;y++)for(let xx=x-1;xx<=x+1;xx++){f.walls[y][xx]=0;cells.add(xx+','+y);}
 clearProps(f,cells);
 const safe={x:x-1,y:1,w:3,h:2};f.safeRooms.push(safe);
 f.exits.push({x,y:1,zone:zone_id,name});f.entries[zone_id]={x,y:2};
 f.geometryVersion=(f.geometryVersion??0)+1;
 return true; // Open only new terrain, so active editions retain their existing rooms, loot and encounter locks.
}
export const addTaigaTrail=addNorthTrail; // Tundra's original name stays importable for existing tests and tools.

function clearProps(f,cells){ // Remove any prop whose footprint touches a newly opened cell; every other object and claim ID stays in place.
 f.decorations=f.decorations.filter(prop=>{
  let overlaps=false;
  for(let dy=0;dy<prop.span_h;dy++)for(let dx=0;dx<prop.span_w;dx++)if(cells.has((prop.x+dx)+','+(prop.y+dy)))overlaps=true;
  if(overlaps)for(let dy=0;dy<prop.span_h;dy++)for(let dx=0;dx<prop.span_w;dx++)f.props[prop.y+dy][prop.x+dx]=0;
  return !overlaps;
 });
}

export const inExit=(e,x,y)=>x>=e.x&&x<e.x+(e.w??1)&&y>=e.y&&y<e.y+(e.h??1); // True when (x,y) is one of the exit's tiles (a pad is 1x1, a gap 1x2 or 2x1).
export const nearExit=(e,x,y)=>Math.max(e.x-x,0,x-(e.x+(e.w??1)-1))+Math.max(e.y-y,0,y-(e.y+(e.h??1)-1))<=1; // Standing on or orthogonally beside any exit tile.

export function openExitGaps(f){ // Turn each interior exit tile into a two-tile opening in the boundary wall, like the hub wall gaps.
 let changed=false;
 for(const exit of f.exits??[]){
  if(exit.style==='gap')continue; // Already converted; safe to call on every upgrade.
  const side=exit.y<=1?'top':exit.y>=f.height-2?'bottom':exit.x<f.width/2?'left':'right'; // Nearest boundary wall to the old exit tile.
  const vertical=side==='left'||side==='right',cells=new Set(),open=(x,y)=>{f.walls[y][x]=0;cells.add(x+','+y);};
  const along=vertical?(exit.y+1<=f.height-2?exit.y:exit.y-1):(exit.x+1<=f.width-2?exit.x:exit.x-1); // First of the two tiles the opening spans.
  const edge=side==='left'||side==='top'?0:(vertical?f.width-1:f.height-1); // The boundary row/column the opening sits in.
  const depth=vertical?exit.x:exit.y; // Carve a straight corridor from the old exit tile out to the wall.
  for(let i=0;i<2;i++)for(let d=Math.min(edge,depth);d<=Math.max(edge,depth);d++)vertical?open(d,along+i):open(along+i,d);
  clearProps(f,cells);
  const gap=vertical?{x:edge,y:along,w:1,h:2}:{x:along,y:edge,w:2,h:1};
  const inward={left:[1,0],right:[-1,0],top:[0,1],bottom:[0,-1]}[side],entry={x:vertical?edge+inward[0]:exit.x,y:vertical?exit.y:edge+inward[1]}; // Arrive one tile inside the opening.
  const oldEntry=f.entries?.[exit.zone];if(oldEntry&&f.entrance?.x===oldEntry.x&&f.entrance?.y===oldEntry.y)f.entrance={...entry}; // Keep the default entrance on the same crossing.
  if(f.entries)f.entries[exit.zone]=entry;
  Object.assign(exit,gap,{style:'gap',side});
  f.safeRooms=[...(f.safeRooms??[]),{...gap}]; // Roaming enemies, loot and mist never occupy the opening.
  changed=true;
 }
 if(changed)f.geometryVersion=(f.geometryVersion??0)+1; // Connected clients refresh collision and the minimap.
 return changed;
}
