// Haunted Woods generator: a seeded port of the singleplayer Haunted Forest layout
// (scrForestDungeon.gml via python/preview_forest_trails.py): cellular-automata thicket,
// circular clearings, a Prim spanning tree of meandering Catmull-Rom trails plus a few
// short loop links, spurs, and a connectivity rescue that stitches or grows over pockets.
// The output has the same shape as generateDesert(), so the Dive engine, exits, pink
// mist, quest placements and the GM map treat it like any other wilderness floor.
import {seeded,walkable,inside} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';

const WALL=1,FLOOR=0,directions=[[1,0],[-1,0],[0,1],[0,-1]],key=p=>p.x+','+p.y;
const DEFAULT_TYPES={entrance:'trailhead',deepest:'deep_wood',pool:['bog','briar_thicket','mushroom_hollow','standing_stones','creekbed','abandoned_camp','hanging_grove']}; // Same fallbacks as forest_assign_clearing_types().

export function generateForest(data,edition,depth=1){
 const c=data.config,s=data.structure,rnd=seeded(`${c.route}:${edition}:${depth}:v${data.version}`); // Same seed grammar as every other weekly route.
 if(![c.width,c.height].every(n=>Number.isInteger(n)&&n>=40&&n<=128)||!Number.isInteger(c.enemies_per_room)||c.enemies_per_room<0||c.enemies_per_room>6)throw Error('Invalid Woods dimensions/density');
 if(![c.food_per_room,c.potions_per_room,c.treasures_per_room].every(n=>Number.isInteger(n)&&n>=0&&n<=4))throw Error('Invalid Woods loot density');
 if(!Number.isInteger(s.num_clearings)||s.num_clearings<2||s.num_clearings>40)throw Error('Invalid Woods clearing count');
 const W=c.width,H=c.height,mid=Math.floor(W/2),cy=Math.floor(H/2);
 const num=(k,fallback)=>typeof s[k]==='number'&&Number.isFinite(s[k])?s[k]:fallback; // Mirror of _forest_cfg(): numeric key with a safe default.
 const int=(a,b)=>a+rnd(b-a+1),real=(a,b)=>a+(b-a)*rnd(1000000000)/1000000000,pick=list=>list[rnd(list.length)]; // randint / uniform / choice on the seeded stream.
 const f={route:c.route,edition,depth,theme:c.theme,generatorVersion:1,contentVersion:data.version,dressingVersion:data.dressing_version,foodVersion:data.food_version,width:W,height:H,
  walls:Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>x===0||y===0||x===W-1||y===H-1?WALL:rnd(100)<num('fill_chance',43)?WALL:FLOOR)),props:Array.from({length:H},()=>Array(W).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[]}; // Step 1: random fill with a sealed border.
 const inBounds=(x,y)=>x>0&&y>0&&x<W-1&&y<H-1,open=(x,y)=>{if(inBounds(x,y))f.walls[y][x]=FLOOR;};

 for(let pass=0;pass<num('smooth_passes',5);pass++){ // Step 2: forest_ca_smooth() birth/death passes on a snapshot.
  const old=f.walls.map(r=>[...r]),birth=num('birth_limit',4),death=num('death_limit',3);
  for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){let n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dx||dy)n+=old[y+dy][x+dx];f.walls[y][x]=old[y][x]?(n<death?FLOOR:WALL):(n>=birth?WALL:FLOOR);}
 }

 const circle=(cx,cy,r)=>{for(let y=cy-r;y<=cy+r;y++)for(let x=cx-r;x<=cx+r;x++)if(Math.hypot(x-cx,y-cy)<=r)open(x,y);}; // forest_carve_circle()
 const endpoints=c.endpoints??[];
 if(!endpoints.length||new Set(endpoints.map(p=>p.zone)).size!==endpoints.length||endpoints.some(p=>!p.zone||!p.name||!['south','west','east','north'].includes(p.side)))throw Error('Invalid Woods endpoints');
 const gate={south:{exit:{x:mid,y:H-2},safe:{x:mid-3,y:H-8,w:7,h:7},centre:{cx:mid,cy:H-5}},north:{exit:{x:mid,y:1},safe:{x:mid-3,y:1,w:7,h:7},centre:{cx:mid,cy:4}},west:{exit:{x:4,y:cy},safe:{x:1,y:cy-3,w:7,h:7},centre:{cx:4,cy}},east:{exit:{x:W-5,y:cy},safe:{x:W-8,y:cy-3,w:7,h:7},centre:{cx:W-5,cy}}}; // Each crossing gets the same 7x7 safe square the Desert uses.
 f.safeRooms=endpoints.map(p=>({...gate[p.side].safe}));
 f.exits=endpoints.map(p=>({...gate[p.side].exit,zone:p.zone,name:p.name}));
 f.entries=Object.fromEntries(endpoints.map(p=>{const e=gate[p.side].exit,step={south:[0,-1],north:[0,1],west:[1,0],east:[-1,0]}[p.side];return [p.zone,{x:e.x+step[0],y:e.y+step[1]}];})); // Arrive one tile inside each crossing.
 f.entrance={...f.entries[endpoints[0].zone]}; // The first endpoint (Honeydew, to the south) is the default arrival.

 // Step 3: clearings. The gate clearings come first, so clearing 0 is the southern trailhead (the campaign's player start).
 const clearings=endpoints.map(p=>({...gate[p.side].centre,r:3,gate:true}));
 const want=endpoints.length+Math.floor(num('num_clearings',10)),lo=Math.floor(num('min_clearing',4)),hi=Math.floor(num('max_clearing',7));
 for(let attempts=0;clearings.length<want&&attempts<want*20;attempts++){
  const r=int(lo,hi),cx=int(r+2,W-r-3),cyy=int(r+2,H-r-3);
  if(clearings.some(o=>Math.hypot(cx-o.cx,cyy-o.cy)<r+o.r+3))continue; // Too close to an existing clearing (or a gate): retry.
  if(f.safeRooms.some(q=>cx+r>=q.x-2&&cx-r<q.x+q.w+2&&cyy+r>=q.y-2&&cyy-r<q.y+q.h+2))continue; // Keep wild clearings clear of every crossing's safe square.
  clearings.push({cx,cy:cyy,r});
 }
 for(const k of clearings)circle(k.cx,k.cy,k.r);

 // Step 3b: forest_assign_clearing_types() — gates are trailheads, the clearing farthest from Honeydew is the deep wood, the rest come from a shuffled bag.
 const types={...DEFAULT_TYPES,...(data.clearing_types??{})},bagSource=Array.isArray(types.pool)&&types.pool.length?types.pool:DEFAULT_TYPES.pool;
 const wild=clearings.filter(k=>!k.gate),start=clearings[0];
 const deep=wild.reduce((best,k)=>!best||Math.hypot(k.cx-start.cx,k.cy-start.cy)>Math.hypot(best.cx-start.cx,best.cy-start.cy)?k:best,null);
 let bag=[];for(const k of clearings){if(k.gate){k.type=types.entrance;continue;}if(k===deep){k.type=types.deepest;continue;}if(!bag.length){bag=[...bagSource];for(let i=bag.length-1;i>0;i--){const j=rnd(i+1);[bag[i],bag[j]]=[bag[j],bag[i]];}}k.type=bag.pop();} // Fisher-Yates cycles guarantee broad coverage.

 // Brush and trail helpers, one-to-one with the GML/Python functions of the same names.
 function stampBrush(cx,cy,radius,ragged){const icx=Math.round(cx),icy=Math.round(cy),ir=Math.max(0,Math.ceil(radius));for(let j=-ir;j<=ir;j++)for(let i=-ir;i<=ir;i++){const px=icx+i,py=icy+j,d=Math.hypot(i,j);if(!inBounds(px,py)||d>radius)continue;if(ragged>0&&d>1&&d>radius-1&&real(0,1)<ragged)continue;f.walls[py][px]=FLOOR;}} // _forest_stamp_brush(): rough blob, the 1-tile core always carved.
 function walkPoints(pts,wBase,wJitter,ragged){
  if(!pts.length)return;const phase=real(0,2*Math.PI),freq=real(0.12,0.28);let px=Math.round(pts[0].x),py=Math.round(pts[0].y);
  pts.forEach((p,i)=>{const ix=Math.round(p.x),iy=Math.round(p.y),width=wBase+Math.sin(phase+i*freq)*wJitter+real(-0.25,0.25),radius=Math.max(0.6,width*0.5);if(ix!==px&&iy!==py)stampBrush(ix,py,radius,ragged);stampBrush(ix,iy,radius,ragged);px=ix;py=iy;}); // Elbow fill keeps trails 4-connected.
 } // _forest_walk_points()
 const catmull=(p0,p1,p2,p3,t)=>0.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t);
 function trailPoints(x1,y1,x2,y2){ // _forest_build_trail_points(): tapered meander waypoints, Catmull-Rom sampling, then a two-sine wobble.
  const dist=Math.hypot(x2-x1,y2-y1);if(dist<1)return [{x:x1,y:y1}];
  const ux=(x2-x1)/dist,uy=(y2-y1)/dist,perpX=-uy,perpY=ux,segs=Math.max(2,Math.min(Math.floor(dist/6),Math.max(2,Math.floor(num('path_curve_segments',5)))));
  const way=[{x:x1,y:y1}];let side=rnd(2)?1:-1;
  for(let n=1;n<segs;n++){const t=n/segs,amp=num('path_wander',0.55)*dist*0.30*Math.sin(Math.PI*t)*real(0.45,1);way.push({x:Math.min(Math.max(x1+(x2-x1)*t+perpX*amp*side,3),W-4),y:Math.min(Math.max(y1+(y2-y1)*t+perpY*amp*side,3),H-4)});if(rnd(100)<75)side=-side;}
  way.push({x:x2,y:y2});
  const pts=[];for(let k=0;k<way.length-1;k++){const p0=way[Math.max(0,k-1)],p1=way[k],p2=way[k+1],p3=way[Math.min(way.length-1,k+2)],steps=Math.max(2,Math.ceil(Math.max(1,Math.hypot(p2.x-p1.x,p2.y-p1.y))*2));for(let n=0;n<=steps;n++){const t=n/steps;pts.push({x:catmull(p0.x,p1.x,p2.x,p3.x,t),y:catmull(p0.y,p1.y,p2.y,p3.y,t)});}}
  const jit=num('path_jitter',1.1);if(!(jit>0&&pts.length>=3))return pts;
  const ph1=real(0,2*Math.PI),f1=real(0.18,0.34),ph2=real(0,2*Math.PI),f2=real(0.05,0.11);
  return pts.map((p,i)=>{const a=pts[Math.max(0,i-1)],b=pts[Math.min(pts.length-1,i+1)],tx=b.x-a.x,ty=b.y-a.y,tl=Math.max(0.0001,Math.hypot(tx,ty)),off=(Math.sin(ph1+i*f1)*0.6+Math.sin(ph2+i*f2)*0.4)*jit;return {x:Math.min(Math.max(p.x+(-ty/tl)*off,2),W-3),y:Math.min(Math.max(p.y+(tx/tl)*off,2),H-3)};});
 }
 function growSpur(sx,sy,dirX,dirY,wBase,ragged){ // _forest_grow_spur(): a short dead-end tendril.
  const minLen=Math.floor(num('path_spur_len_min',4)),length=int(minLen,Math.max(minLen,Math.floor(num('path_spur_len_max',10))));
  let ang=Math.atan2(dirY,dirX)*180/Math.PI,x=sx,y=sy;const pts=[];
  for(let n=0;n<length;n++){ang+=real(-28,28);x+=Math.cos(ang*Math.PI/180);y+=Math.sin(ang*Math.PI/180);if(x<=2||x>=W-3||y<=2||y>=H-3)break;pts.push({x,y});}
  walkPoints(pts,Math.max(1,wBase-0.8),0.3,ragged);
 }
 function carvePath(x1,y1,x2,y2){ // forest_carve_path(): one winding trail plus an occasional spur.
  const wBase=num('path_width',2),ragged=Math.min(Math.max(num('path_edge_ragged',0.45),0),1),pts=trailPoints(x1,y1,x2,y2);
  walkPoints(pts,wBase,num('path_width_jitter',1.4),ragged);
  if(pts.length>6&&rnd(100)<num('path_spur_chance',22)){const idx=int(Math.floor(pts.length*0.25),Math.floor(pts.length*0.75)),a=pts[idx],b=pts[Math.min(pts.length-1,idx+1)],flip=rnd(2)?1:-1;growSpur(a.x,a.y,-(b.y-a.y)*flip,(b.x-a.x)*flip,wBase,ragged);}
 }

 // Step 4: forest_connect_clearings() — Prim's spanning tree, then the shortest unlinked pairs as loops so the trail net has local circuits.
 const n=clearings.length,linked=new Set(),inTree=new Set([0]),dist=(a,b)=>Math.hypot(a.cx-b.cx,a.cy-b.cy),link=(a,b)=>{linked.add(a+':'+b);linked.add(b+':'+a);carvePath(clearings[a].cx,clearings[a].cy,clearings[b].cx,clearings[b].cy);};
 while(inTree.size<n){let best=Infinity,ba=-1,bb=-1;for(const i of inTree)for(let j=0;j<n;j++)if(!inTree.has(j)){const d=dist(clearings[i],clearings[j]);if(d<best){best=d;ba=i;bb=j;}}inTree.add(bb);link(ba,bb);}
 const pairs=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(!linked.has(i+':'+j))pairs.push({a:i,b:j,d:dist(clearings[i],clearings[j])});
 pairs.sort((p,q)=>p.d-q.d||p.a-q.a||p.b-q.b).slice(0,Math.max(0,Math.floor(num('clearing_link_extra',3)))).forEach(p=>link(p.a,p.b));

 // Step 4b: forest_connect_all_walkable() — tiny pockets grow back over, real ones get a crooked guaranteed trail to the nearest reached tile.
 function flood(sx,sy){const seen=new Set();if(f.walls[sy][sx])return seen;const queue=[{x:sx,y:sy}];seen.add(sx+','+sy);for(let i=0;i<queue.length;i++)for(const [dx,dy] of directions){const x=queue[i].x+dx,y=queue[i].y+dy;if(x>=0&&y>=0&&x<W&&y<H&&!f.walls[y][x]&&!seen.has(x+','+y)){seen.add(x+','+y);queue.push({x,y});}}return seen;}
 function directPath(x1,y1,x2,y2){let x=x1,y=y1;const pts=[{x,y}];while(x!==x2){x+=Math.sign(x2-x);if(y!==y2&&rnd(100)<25)y+=Math.sign(y2-y);pts.push({x,y});}while(y!==y2){y+=Math.sign(y2-y);pts.push({x,y});}walkPoints(pts,Math.max(2,num('path_width',2)),0.5,Math.min(Math.max(num('path_edge_ragged',0.45),0),1)*0.5);} // forest_carve_direct_path()
 function nearest(ux,uy,seen){for(let r=1;r<=Math.max(W,H);r++)for(let j=-r;j<=r;j++)for(let i=-r;i<=r;i++){if(Math.abs(i)!==r&&Math.abs(j)!==r)continue;const x=ux+i,y=uy+j;if(inBounds(x,y)&&seen.has(x+','+y))return {x,y};}return null;} // _forest_nearest_reachable(): expanding ring.
 const safeCarve=()=>{for(const r of f.safeRooms)for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)open(x,y);}; // Crossings are always open ground.
 safeCarve();
 for(let round=0;round<256;round++){
  const seen=flood(start.cx,start.cy);let target=null;
  for(let x=1;x<W-1&&!target;x++)for(let y=1;y<H-1;y++)if(!f.walls[y][x]&&!seen.has(x+','+y)){target={x,y};break;}
  if(!target)break;
  const pocket=flood(target.x,target.y);
  if(pocket.size<num('min_pocket_tiles',12)){for(const cell of pocket){const [x,y]=cell.split(',').map(Number);if(inBounds(x,y))f.walls[y][x]=WALL;}continue;} // Thicket grows over the scrap.
  const near=nearest(target.x,target.y,seen);if(!near)break;directPath(target.x,target.y,near.x,near.y);
 }
 safeCarve();
 const reached=flood(start.cx,start.cy);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++)if(!reached.has(x+','+y))f.walls[y][x]=WALL; // Anything the rescue could not reach is sealed, as the Desert does.

 // Rooms: every crossing's safe square first, then one box per wild clearing carrying its identity.
 f.rooms.push(...f.safeRooms);const safeCount=f.rooms.length;
 for(const k of wild)f.rooms.push({x:Math.max(1,k.cx-k.r),y:Math.max(1,k.cy-k.r),w:Math.min(W-2,k.cx+k.r)-Math.max(1,k.cx-k.r)+1,h:Math.min(H-2,k.cy+k.r)-Math.max(1,k.cy-k.r)+1,cx:k.cx,cy:k.cy,r:k.r,type:k.type});
 const occupied=new Set(f.exits.map(key)),safe=p=>f.safeRooms.some(r=>inside(r,p.x,p.y));
 const inClearing=(r,x,y)=>Math.hypot(x-r.cx,y-r.cy)<=r.r+0.5; // Content sits in the round clearing, not the box corners.
 function free(r){const cells=[];for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++){const p={x,y};if(inClearing(r,x,y)&&walkable(f,x,y)&&!occupied.has(key(p))&&!safe(p))cells.push(p);}if(!cells.length)throw Error('No Woods content space');const p=cells[rnd(cells.length)];occupied.add(key(p));return p;}
 const weights=data.enemy_types.flatMap(e=>Array(e.chance).fill(e.enemy_id));
 for(let i=safeCount;i<f.rooms.length;i++){ // Same stable IDs and per-room density as the Desert, so progress, claims and respawns behave identically.
  const r=f.rooms[i];f.chests.push({id:`chest-${i}`,...free(r)});
  for(let m=0;m<c.enemies_per_room;m++){const p=free(r);f.enemies.push({id:`enemy-${i}-${m}`,type:weights[rnd(weights.length)],...p,spawn:{...p},roaming:true,engaged:null,respawnAt:0});}
  for(const [kind,count] of [['food',c.food_per_room],['potion',c.potions_per_room],['treasure',c.treasures_per_room]])for(let m=0;m<count;m++)f.pickups.push({id:`${kind}-${i}-${m}`,kind,...free(r),sprite:'sprItem'});
 }

 // Scenery (#12): each clearing is dressed from its identity's props first, then the rest of the budget scatters across the whole wood.
 const profiles=new Map((data.detail_profiles??[]).map(p=>[p.sprite,p])),themed=data.clearing_props??{};
 function place(p,x,y){
  const cells=[];for(let dy=0;dy<p.span_h;dy++)for(let dx=0;dx<p.span_w;dx++)cells.push({x:x+dx,y:y+dy});
  if(cells.some(v=>!walkable(f,v.x,v.y)||occupied.has(key(v))||safe(v)))return false;
  for(const v of cells)f.props[v.y][v.x]=1;
  try{validateDesert(f);}catch{for(const v of cells)f.props[v.y][v.x]=0;return false;} // A prop may never seal loot, an enemy or a crossing.
  for(const v of cells)occupied.add(key(v));f.decorations.push({...p,x,y});return true;
 }
 const budget=int(Math.floor(num('prop_count_min',30)),Math.max(Math.floor(num('prop_count_min',30)),Math.floor(num('prop_count_max',40))));
 for(let i=safeCount;i<f.rooms.length&&f.decorations.length<budget;i++){
  const r=f.rooms[i],list=(themed[r.type]??[]).map(s=>profiles.get(s)).filter(Boolean);if(!list.length)continue;
  for(let placed=0,attempt=0;placed<2&&attempt<24;attempt++){const p=pick(list);if(place(p,int(r.x,Math.max(r.x,r.x+r.w-p.span_w)),int(r.y,Math.max(r.y,r.y+r.h-p.span_h))))placed++;}
 }
 const everything=[...profiles.values()];
 for(let attempt=0;attempt<400&&f.decorations.length<budget&&everything.length;attempt++){const p=pick(everything);place(p,int(2,W-p.span_w-2),int(2,H-p.span_h-2));}
 f.clearingCount=clearings.length; // Diagnostic only: previews and tests read it; clients ignore it.
 validateDesert(f);return f;
}
