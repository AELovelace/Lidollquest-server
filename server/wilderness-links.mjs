import {walkable} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';

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

export function addSideTrail(f,{zone_id,name,side}){ // Carve a 3-tall trail in from the middle of the west ('left') or east ('right') wall to the nearest open floor.
 if(f.exits.some(exit=>exit.zone===zone_id))return false; // Idempotent: an edition that already has this crossing is left alone.
 if(side!=='left'&&side!=='right')throw Error('Side trails open on the left or right wall.');
 const y=Math.floor(f.height/2),step=side==='left'?1:-1,wall=side==='left'?1:f.width-2,cells=new Set(); // Walk inward from the first tile inside the wall.
 const clear=x=>[y-1,y,y+1].every(yy=>!f.exits.some(e=>inExit(e,x,yy))); // Never carve through another crossing's opening.
 let end=wall+step*2;
 while(end>1&&end<f.width-2&&!walkable(f,end,y))end+=step; // Stop at the first walkable tile on the centre row.
 for(let x=wall;x!==end+step;x+=step){if(!clear(x))break;for(let yy=y-1;yy<=y+1;yy++){f.walls[yy][x]=0;cells.add(x+','+yy);}}
 clearProps(f,cells);
 const safe={x:side==='left'?wall:wall-1,y:y-1,w:2,h:3};f.safeRooms.push(safe); // Loot, mist and roamers stay off the trail mouth.
 f.exits.push({x:wall,y,zone:zone_id,name});f.entries[zone_id]={x:wall+step,y}; // openExitGaps() then turns this tile into a two-tile wall gap.
 f.geometryVersion=(f.geometryVersion??0)+1;
 return true; // Only new terrain opens, so the live edition keeps its rooms, loot and encounter locks.
}

export function addLandmark(f,{zone,name,sprite,span_w=4,span_h=4,door_x=Math.floor(span_w/2),radius=6}){ // A building near the map centre whose door is a warp pad into another route (the Woods' haunted house -> Spooky Mansion).
 if(!zone||f.exits.some(exit=>exit.zone===zone))return false; // Idempotent across restarts and weekly editions.
 const W=f.width,H=f.height,cx=Math.floor(W/2),cy=Math.floor(H/2),k=(x,y)=>x+','+y;
 const taken=new Set([...f.enemies,...f.enemies.map(e=>e.spawn).filter(Boolean),...f.chests,...(f.pickups??[]),...f.exits,f.entrance,...Object.values(f.entries??{})].map(p=>k(p.x,p.y))); // Content never moves; the house must fit around it.
 const offsets=[];for(let d=0;d<=radius;d++)for(let dy=-d;dy<=d;dy++)for(let dx=-d;dx<=d;dx++)if(Math.max(Math.abs(dx),Math.abs(dy))===d)offsets.push([dx,dy]); // Nearest-to-centre first.
 for(const [ox,oy] of offsets){
  const x0=cx-Math.floor(span_w/2)+ox,y0=cy-Math.floor(span_h/2)-1+oy,pad={x:x0+door_x,y:y0+span_h},entry={x:pad.x,y:pad.y+1}; // House a little north of centre, pad at its door, arrival just south of the pad.
  if(x0<2||y0<2||x0+span_w>W-2||entry.y>H-3)continue;
  const footprint=[];for(let dy=0;dy<span_h;dy++)for(let dx=0;dx<span_w;dx++)footprint.push({x:x0+dx,y:y0+dy});
  if([...footprint,pad,entry].some(p=>taken.has(k(p.x,p.y))))continue;
  const g=structuredClone({walls:f.walls,props:f.props,decorations:f.decorations}),open=(x,y)=>{if(x>0&&y>0&&x<W-1&&y<H-1)g.walls[y][x]=0;}; // Work on a copy; commit only a valid result.
  const mx=x0+Math.floor(span_w/2),my=y0+Math.floor(span_h/2);
  for(let y=my-radius;y<=my+radius+2;y++)for(let x=mx-radius;x<=mx+radius;x++)if(Math.hypot(x-mx,(y-my-1)*0.9)<=radius)open(x,y); // An oval clearing around the house and its porch.
  const reach=new Set(),queue=[f.entrance];reach.add(k(f.entrance.x,f.entrance.y));
  for(let i=0;i<queue.length;i++)for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const x=queue[i].x+dx,y=queue[i].y+dy;if(walkable(f,x,y)&&!reach.has(k(x,y))){reach.add(k(x,y));queue.push({x,y});}} // Floor already joined to the entrance, before any carving.
  if(!reach.has(k(entry.x,entry.y))){ // Clearing is still cut off: run a 3-wide L path to the nearest joined floor.
   let best=null,bd=Infinity;for(const cell of reach){const [x,y]=cell.split(',').map(Number),d=Math.abs(x-entry.x)+Math.abs(y-entry.y);if(d<bd){bd=d;best={x,y};}}
   if(!best)continue;let x=entry.x,y=entry.y;while(x!==best.x){for(let d=-1;d<=1;d++)open(x,y+d);x+=Math.sign(best.x-x);}while(y!==best.y){for(let d=-1;d<=1;d++)open(x+d,y);y+=Math.sign(best.y-y);}open(best.x,best.y);
  }
  const clearCells=new Set([...footprint,pad,entry].map(p=>k(p.x,p.y)));
  g.decorations=g.decorations.filter(prop=>{let hit=false;for(let dy=0;dy<prop.span_h;dy++)for(let dx=0;dx<prop.span_w;dx++)if(clearCells.has(k(prop.x+dx,prop.y+dy)))hit=true;if(hit)for(let dy=0;dy<prop.span_h;dy++)for(let dx=0;dx<prop.span_w;dx++)g.props[prop.y+dy][prop.x+dx]=0;return !hit;}); // Old scenery never blocks the house or its porch.
  for(const p of footprint)g.props[p.y][p.x]=1;
  g.decorations.push({sprite,span_w,span_h,solid:true,x:x0,y:y0,landmark:zone});
  const trial={...f,walls:g.walls,props:g.props,decorations:g.decorations,exits:[...f.exits,{...pad,zone,name,style:'warp'}],safeRooms:[...(f.safeRooms??[]),{x:pad.x-1,y:pad.y,w:3,h:2}]};
  try{validateDesert(trial);}catch{continue;} // The house may never seal loot, an enemy or a crossing: try the next spot.
  if(!walkable(trial,entry.x,entry.y)||!walkable(trial,pad.x,pad.y))continue;
  Object.assign(f,{walls:g.walls,props:g.props,decorations:g.decorations,exits:trial.exits,safeRooms:trial.safeRooms});
  f.entries={...(f.entries??{}),[zone]:{...entry}};f.geometryVersion=(f.geometryVersion??0)+1; // Connected clients refresh collision, scenery and the minimap.
  return true;
 }
 throw Error('No room for the '+name+' landmark near the centre of '+(f.route??'this map')+'.');
}

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
  if(exit.style==='gap'||exit.style==='warp')continue; // Already converted, or an interior warp pad (the Woods' haunted house) that must stay where it is.
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
