// Spooky Mansion generator: a seeded port of the singleplayer Spooky Mansion layout (scrMansionDungeon.gml).
// BSP partitions -> leaf rooms filled with cellular-automata rubble around a cleared core, joined by
// drunk-walk halls; extra halls; rectangular "hollow" rooms and triangular "wedge" rooms reclaimed from
// unused wall mass; then a two-pass connectivity rescue (organic drunk paths, then deterministic cuts).
// Room identities follow mansion_assign_room_types(): room 0 is the foyer, the last room is the sanctum,
// everything between comes from a shuffled bag. The output has the same shape as generateDesert(), so
// the Dive engine, exits, pink mist, quest placements and the GM map treat it like any wilderness floor.
import {seeded,walkable,inside} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';

const WALL=1,FLOOR=0,key=p=>p.x+','+p.y;
const DEFAULT_TYPES={entrance:'foyer',deepest:'sanctum',pool:['parlour','dining_hall','gallery','music_room','library','dormitory','washroom']};

export function wedgeContains(c,orientation,wallThickness,x,y,interiorOnly){ // mansion_wedge_contains(): right-triangle mask with a kept rim.
 const lx=x-c.x,ly=y-c.y;if(lx<0||ly<0||lx>=c.w||ly>=c.h)return false;
 let u=lx,v=ly;const o=((orientation%4)+4)%4;
 if(o===1)u=c.w-1-lx;else if(o===2){u=c.w-1-lx;v=c.h-1-ly;}else if(o===3)v=c.h-1-ly; // Rotate so the right angle sits at the local origin.
 const ex=Math.max(1,c.w-1),ey=Math.max(1,c.h-1),slope=u*ey+v*ex,limit=ex*ey;
 if(slope>limit)return false;if(!interiorOnly)return true;
 const t=Math.max(1,Math.floor(wallThickness));if(u<t||v<t)return false;
 return slope<=limit-t*Math.max(ex,ey); // Roughly the same rim thickness on the sloped wall.
}
export function mansionRoomContains(room,x,y){ // mansion_room_contains_cell(): exact wedge membership, plain bounds otherwise.
 if(x<room.x||x>=room.x+room.w||y<room.y||y>=room.y+room.h)return false;
 if(!room.is_wedge)return true;
 return wedgeContains({x:room.wedge_outer_x,y:room.wedge_outer_y,w:room.wedge_outer_w,h:room.wedge_outer_h},room.wedge_orientation,room.wedge_wall_thickness,x,y,true);
}

export function generateMansion(data,edition,depth=1){
 const c=data.config,s=data.structure,rnd=seeded(`${c.route}:${edition}:${depth}:v${data.version}`); // Same seed grammar as every other weekly route.
 if(![c.width,c.height].every(n=>Number.isInteger(n)&&n>=40&&n<=128)||!Number.isInteger(c.enemies_per_room)||c.enemies_per_room<0||c.enemies_per_room>6)throw Error('Invalid Mansion dimensions/density');
 if(![c.food_per_room,c.potions_per_room,c.treasures_per_room].every(n=>Number.isInteger(n)&&n>=0&&n<=4))throw Error('Invalid Mansion loot density');
 const endpoints=c.endpoints??[];if(endpoints.length!==1||!endpoints[0].zone||!endpoints[0].name)throw Error('The Mansion has exactly one way in: its foyer pad.');
 const W=c.width,H=c.height,cfg=(k,fallback)=>s[k]??fallback,num=(k,fallback)=>Number.isFinite(Number(s[k]))?Number(s[k]):fallback;
 const irandom=n=>rnd(Math.floor(n)+1),range=(a,b)=>a+rnd(Math.max(0,Math.floor(b)-Math.floor(a))+1); // GML irandom / irandom_range on the seeded stream.
 const f={route:c.route,edition,depth,theme:c.theme,generatorVersion:1,contentVersion:data.version,dressingVersion:data.dressing_version,foodVersion:data.food_version,width:W,height:H,
  walls:Array.from({length:H},()=>Array(W).fill(WALL)),props:Array.from({length:H},()=>Array(W).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[]}; // ds_grid_clear(map, CELL_WALL)
 const inner=(x,y)=>x>0&&y>0&&x<W-1&&y<H-1,wall=(x,y)=>f.walls[y][x]===WALL,set=(x,y,v)=>{f.walls[y][x]=v;},open=(x,y)=>{if(inner(x,y))set(x,y,FLOOR);};
 const rooms=[]; // global.mansion_rooms

 function carveLeaf(node){ // mansion_carve_leaf_room(): a CA-roughened room with a guaranteed clear 3x3 core.
  const minRoom=num('min_room',6),maxW=node.w-2,maxH=node.h-2;
  if(maxW<minRoom||maxH<minRoom){const tx=Math.min(Math.max(node.x+Math.floor(node.w/2),1),W-2),ty=Math.min(Math.max(node.y+Math.floor(node.h/2),1),H-2);set(tx,ty,FLOOR);node.room={x:tx,y:ty,w:1,h:1,cx:tx,cy:ty};rooms.push(node.room);return;}
  let rw=range(minRoom,maxW),rh=range(minRoom,maxH),rx=node.x+1+range(0,node.w-rw-2),ry=node.y+1+range(0,node.h-rh-2);
  rx=Math.min(Math.max(rx,1),W-2);ry=Math.min(Math.max(ry,1),H-2);rw=Math.max(1,Math.min(rw,W-1-rx));rh=Math.max(1,Math.min(rh,H-1-ry));
  const fill=num('ca_fill_chance',44);
  for(let x=rx;x<rx+rw;x++)for(let y=ry;y<ry+rh;y++){const edge=x===rx||y===ry||x===rx+rw-1||y===ry+rh-1;set(x,y,edge?WALL:(irandom(99)<fill?WALL:FLOOR));}
  const birth=num('ca_birth_limit',4),death=num('ca_death_limit',3);
  for(let pass=0;pass<num('ca_smooth_passes',3);pass++){
   const snap=f.walls.map(r=>[...r]);
   for(let x=rx+1;x<rx+rw-1;x++)for(let y=ry+1;y<ry+rh-1;y++){let n=0;for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)if((dx||dy)&&snap[y+dy][x+dx]===WALL)n++;if(snap[y][x]===WALL){if(n<death)set(x,y,FLOOR);}else if(n>=birth)set(x,y,WALL);}
  }
  const cx=rx+Math.floor(rw/2),cy=ry+Math.floor(rh/2);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)open(cx+dx,cy+dy);
  node.room={x:rx,y:ry,w:rw,h:rh,cx,cy};rooms.push(node.room);
 }
 function roomOf(node){if(!node)return null;if(node.room)return node.room;const l=roomOf(node.left),r=roomOf(node.right);if(!l)return r;if(!r)return l;return irandom(1)===0?l:r;} // mansion_get_room()
 function drunk(x1,y1,x2,y2,pw,bias){ // mansion_carve_drunk_path(): biased random walk, pw x pw brush.
  let x=x1,y=y1,steps=(W+H)*4;
  const stamp=(sx,sy)=>{for(let dx=0;dx<pw;dx++)for(let dy=0;dy<pw;dy++)open(sx+dx,sy+dy);};
  while((x!==x2||y!==y2)&&steps-->0){
   stamp(x,y);
   if(irandom(99)<bias){const ddx=Math.abs(x2-x),ddy=Math.abs(y2-y);if(ddx>ddy)x+=Math.sign(x2-x);else if(ddy>0)y+=Math.sign(y2-y);else x+=Math.sign(x2-x);}
   else switch(irandom(3)){case 0:x=Math.min(x+1,W-2);break;case 1:x=Math.max(x-1,1);break;case 2:y=Math.min(y+1,H-2);break;default:y=Math.max(y-1,1);}
  }
  stamp(x2,y2);
 }
 const pw=num('drunk_width',2),bias=num('drunk_bias',72);
 function split(node,d){ // mansion_split(): aspect-biased BSP down to max_depth.
  if(d>=num('max_depth',6))return carveLeaf(node);
  const horizontal=node.h>node.w*1.25?true:node.w>node.h*1.25?false:irandom(1)===0,minPart=num('min_partition',8);
  if(horizontal){if(node.h<minPart*2)return carveLeaf(node);const cut=range(minPart,node.h-minPart);node.left={x:node.x,y:node.y,w:node.w,h:cut};node.right={x:node.x,y:node.y+cut,w:node.w,h:node.h-cut};}
  else{if(node.w<minPart*2)return carveLeaf(node);const cut=range(minPart,node.w-minPart);node.left={x:node.x,y:node.y,w:cut,h:node.h};node.right={x:node.x+cut,y:node.y,w:node.w-cut,h:node.h};}
  split(node.left,d+1);split(node.right,d+1);
  const a=roomOf(node.left),b=roomOf(node.right);if(a&&b)drunk(a.cx,a.cy,b.cx,b.cy,pw,bias); // mansion_connect()
 }
 split({x:1,y:1,w:W-2,h:H-2},0);
 { // mansion_add_extra_halls(): loops between random far-apart rooms.
  const want=num('extra_halls',10);let added=0,tries=want*12;
  while(rooms.length>=2&&added<want&&tries-->0){const a=rooms[irandom(rooms.length-1)],b=rooms[irandom(rooms.length-1)];if(a===b||Math.abs(a.cx-b.cx)+Math.abs(a.cy-b.cy)<4)continue;drunk(a.cx,a.cy,b.cx,b.cy,pw,bias);added++;}
 }

 // Hollow rooms: rectangles reclaimed from untouched wall mass, joined by a short straight doorway.
 const solidRect=(x,y,w,h)=>{if(x<=0||y<=0||x+w>=W||y+h>=H)return false;for(let ix=x;ix<x+w;ix++)for(let iy=y;iy<y+h;iy++)if(!wall(ix,iy))return false;return true;};
 const overlapsRoom=(x,y,w,h,gap)=>rooms.some(r=>!(x+w-1+gap<r.x||x-gap>r.x+r.w-1||y+h-1+gap<r.y||y-gap>r.y+r.h-1));
 function hollowDoor(c0,wallT,maxLink){ // mansion_hollow_find_door(): shortest, most centred ray from a face to existing floor.
  const t=Math.max(1,Math.floor(wallT)),link=Math.max(1,Math.floor(maxLink)),mx=c0.x+Math.floor(c0.w/2),my=c0.y+Math.floor(c0.h/2);let best=null,bestScore=999999;
  for(const face of [{dx:-1,dy:0,fixed:c0.x,h:false},{dx:1,dy:0,fixed:c0.x+c0.w-1,h:false},{dx:0,dy:-1,fixed:c0.y,h:true},{dx:0,dy:1,fixed:c0.y+c0.h-1,h:true}]){
   const start=face.h?c0.x+t:c0.y+t,end=face.h?c0.x+c0.w-1-t:c0.y+c0.h-1-t;
   for(let span=start;span<=end;span++){const dx0=face.h?span:face.fixed,dy0=face.h?face.fixed:span;
    for(let dist=1;dist<=link;dist++){const tx=dx0+face.dx*dist,ty=dy0+face.dy*dist;if(tx<=0||tx>=W-1||ty<=0||ty>=H-1)break;if(!wall(tx,ty)){const score=dist*10+(face.h?Math.abs(dx0-mx):Math.abs(dy0-my));if(score<bestScore){bestScore=score;best={x:dx0,y:dy0,dx:face.dx,dy:face.dy,distance:dist};}break;}}}
  }
  return best;
 }
 function carveHollow(c0,door,wallT,doorW){ // mansion_hollow_carve_candidate()
  if(!solidRect(c0.x,c0.y,c0.w,c0.h))return false;
  const t=Math.max(1,Math.floor(wallT)),dw=Math.max(1,Math.floor(doorW)),ix=c0.x+t,iy=c0.y+t,iw=c0.w-2*t,ih=c0.h-2*t;if(iw<3||ih<3)return false;
  for(let x=ix;x<ix+iw;x++)for(let y=iy;y<iy+ih;y++)set(x,y,FLOOR);
  const start=-Math.floor(dw/2);
  for(let o=0;o<dw;o++){const off=start+o,lx=door.dy!==0?off:0,ly=door.dx!==0?off:0;
   for(let d=0;d<t;d++)open(door.x+lx-door.dx*d,door.y+ly-door.dy*d);
   for(let dist=1;dist<door.distance;dist++)open(door.x+lx+door.dx*dist,door.y+ly+door.dy*dist);}
  rooms.push({x:ix,y:iy,w:iw,h:ih,cx:ix+Math.floor(iw/2),cy:iy+Math.floor(ih/2),is_hollow:true});return true;
 }
 function findHollow(minW,minH,maxW,maxH,wallT,maxLink,attempts,gap){ // mansion_find_hollow_candidate(): best random sample, then a row-major fallback.
  const sw=Math.min(maxW,W-4),sh=Math.min(maxH,H-4);if(sw<minW||sh<minH)return null;let best=null,bestScore=-999999;
  for(let n=0;n<attempts;n++){const w=range(minW,sw),h=range(minH,sh),x=range(2,W-w-2),y=range(2,H-h-2);if(!solidRect(x,y,w,h)||overlapsRoom(x,y,w,h,gap))continue;const c0={x,y,w,h},door=hollowDoor(c0,wallT,maxLink);if(!door)continue;const score=w*h*4-door.distance*12+irandom(31);if(score>bestScore){bestScore=score;best={candidate:c0,door};}}
  if(!best)for(let x=2;x<=W-minW-2;x++)for(let y=2;y<=H-minH-2;y++){if(!solidRect(x,y,minW,minH)||overlapsRoom(x,y,minW,minH,gap))continue;const c0={x,y,w:minW,h:minH},door=hollowDoor(c0,wallT,maxLink);if(door)return {candidate:c0,door};}
  return best;
 }
 const wedgeSolid=(c0,o,t,minCells)=>{if(c0.x<=0||c0.y<=0||c0.x+c0.w>=W||c0.y+c0.h>=H)return false;let n=0;for(let x=c0.x;x<c0.x+c0.w;x++)for(let y=c0.y;y<c0.y+c0.h;y++){if(!wedgeContains(c0,o,t,x,y,false))continue;if(!wall(x,y))return false;if(wedgeContains(c0,o,t,x,y,true))n++;}return n>=Math.max(1,Math.floor(minCells));};
 function wedgeDoor(c0,o,wallT,maxLink){ // mansion_wedge_find_door()
  const t=Math.max(1,Math.floor(wallT)),link=Math.max(1,Math.floor(maxLink));let best=null,bestScore=999999;
  for(let x=c0.x;x<c0.x+c0.w;x++)for(let y=c0.y;y<c0.y+c0.h;y++){
   if(!wedgeContains(c0,o,t,x,y,false)||wedgeContains(c0,o,t,x,y,true))continue;
   for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
    if(wedgeContains(c0,o,t,x+dx,y+dy,false)||!wedgeContains(c0,o,t,x-dx*t,y-dy*t,true))continue;
    for(let dist=1;dist<=link;dist++){const tx=x+dx*dist,ty=y+dy*dist;if(tx<=0||tx>=W-1||ty<=0||ty>=H-1)break;if(!wall(tx,ty)){const score=dist*10+irandom(3);if(score<bestScore){bestScore=score;best={x,y,dx,dy,distance:dist};}break;}}
   }
  }
  return best;
 }
 function carveWedge(c0,o,door,wallT,minCells){ // mansion_wedge_carve_candidate()
  if(!wedgeSolid(c0,o,wallT,minCells))return false;
  const t=Math.max(1,Math.floor(wallT));let sx=0,sy=0,n=0;
  for(let x=c0.x;x<c0.x+c0.w;x++)for(let y=c0.y;y<c0.y+c0.h;y++)if(wedgeContains(c0,o,t,x,y,true)){set(x,y,FLOOR);sx+=x;sy+=y;n++;}
  if(n<=0)return false;
  for(let d=0;d<t;d++)open(door.x-door.dx*d,door.y-door.dy*d);
  for(let dist=1;dist<door.distance;dist++)open(door.x+door.dx*dist,door.y+door.dy*dist);
  const tx=Math.round(sx/n),ty=Math.round(sy/n);let cx=tx,cy=ty,best=Infinity;
  for(let x=c0.x;x<c0.x+c0.w;x++)for(let y=c0.y;y<c0.y+c0.h;y++)if(wedgeContains(c0,o,t,x,y,true)){const sc=(x-tx)**2+(y-ty)**2;if(sc<best){best=sc;cx=x;cy=y;}}
  rooms.push({x:c0.x+t,y:c0.y+t,w:c0.w-2*t,h:c0.h-2*t,cx,cy,is_hollow:true,is_wedge:true,wedge_outer_x:c0.x,wedge_outer_y:c0.y,wedge_outer_w:c0.w,wedge_outer_h:c0.h,wedge_orientation:((o%4)+4)%4,wedge_wall_thickness:t});return true;
 }
 function findWedge(minW,minH,maxW,maxH,wallT,maxLink,attempts,minCells){ // mansion_find_wedge_candidate()
  const sw=Math.min(maxW,W-4),sh=Math.min(maxH,H-4);if(sw<minW||sh<minH)return null;let best=null,bestScore=-999999;
  for(let n=0;n<attempts;n++){const w=range(minW,sw),h=range(minH,sh),x=range(2,W-w-2),y=range(2,H-h-2),o=irandom(3),c0={x,y,w,h};if(!wedgeSolid(c0,o,wallT,minCells))continue;const door=wedgeDoor(c0,o,wallT,maxLink);if(!door)continue;const score=Math.floor(w*h/2)*5-door.distance*12+irandom(31);if(score>bestScore){bestScore=score;best={candidate:c0,orientation:o,door};}}
  return best;
 }
 if(cfg('hollow_spaces_enabled',false)===true){ // mansion_carve_hollow_spaces()
  const t=Math.max(1,Math.floor(num('hollow_space_wall_thickness',1))),minW=Math.max(t*2+3,Math.floor(num('hollow_space_min_width',6))),minH=Math.max(t*2+3,Math.floor(num('hollow_space_min_height',6)));
  const maxW=Math.max(minW,Math.floor(num('hollow_space_max_width',11))),maxH=Math.max(minH,Math.floor(num('hollow_space_max_height',10)));
  for(let placed=0;placed<Math.max(0,Math.floor(num('hollow_space_max_rooms',5)));placed++){const pick=findHollow(minW,minH,maxW,maxH,t,num('hollow_space_max_link_length',9),Math.max(1,Math.floor(num('hollow_space_attempts',650))),Math.max(0,Math.floor(num('hollow_space_room_gap',0))));if(!pick||!carveHollow(pick.candidate,pick.door,t,num('hollow_space_door_width',2)))break;}
  if(cfg('wedge_spaces_enabled',true)===true){ // mansion_carve_wedge_spaces(): reclaim triangular pockets beside diagonal halls.
   const wt=Math.max(1,Math.floor(num('wedge_space_wall_thickness',1))),wMinW=Math.max(wt*2+4,Math.floor(num('wedge_space_min_width',7))),wMinH=Math.max(wt*2+4,Math.floor(num('wedge_space_min_height',7))),minCells=Math.max(4,Math.floor(num('wedge_space_min_interior_cells',12)));
   for(let placed=0;placed<Math.max(0,Math.floor(num('wedge_space_max_rooms',4)));placed++){const pick=findWedge(wMinW,wMinH,Math.max(wMinW,Math.floor(num('wedge_space_max_width',15))),Math.max(wMinH,Math.floor(num('wedge_space_max_height',15))),wt,num('wedge_space_max_link_length',7),Math.max(1,Math.floor(num('wedge_space_attempts',900))),minCells);if(!pick||!carveWedge(pick.candidate,pick.orientation,pick.door,wt,minCells))break;}
  }
 }

 // Connectivity: mansion_connect_all_walkable() twice (organic, then deterministic), plus the start-egress guard.
 function flood(sx,sy){const seen=new Set();if(sx<0||sy<0||sx>=W||sy>=H||wall(sx,sy))return seen;const q=[{x:sx,y:sy}];seen.add(sx+','+sy);for(let i=0;i<q.length;i++)for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const x=q[i].x+dx,y=q[i].y+dy;if(x>=0&&y>=0&&x<W&&y<H&&!wall(x,y)&&!seen.has(x+','+y)){seen.add(x+','+y);q.push({x,y});}}return seen;}
 function directRescue(x1,y1,x2,y2,width){let x=x1,y=y1;const w=Math.max(1,Math.floor(width)),stamp=(sx,sy)=>{for(let dx=0;dx<w;dx++)for(let dy=0;dy<w;dy++)open(sx+dx,sy+dy);};while(x!==x2){stamp(x,y);x+=Math.sign(x2-x);}while(y!==y2){stamp(x,y);y+=Math.sign(y2-y);}stamp(x2,y2);} // mansion_carve_direct_rescue()
 function connectAll(sx,sy,deterministic){
  for(let round=0;round<256;round++){
   const seen=flood(sx,sy);let u=null;
   for(let x=1;x<W-1&&!u;x++)for(let y=1;y<H-1;y++)if(!wall(x,y)&&!seen.has(x+','+y)){u={x,y};break;}
   if(!u)return true;
   if(deterministic){let best=null,bd=Infinity;for(let x=1;x<W-1;x++)for(let y=1;y<H-1;y++)if(seen.has(x+','+y)){const d=Math.abs(x-u.x)+Math.abs(y-u.y);if(d<bd){bd=d;best={x,y};}}if(!best)return false;directRescue(u.x,u.y,best.x,best.y,Math.max(2,pw));}
   else drunk(u.x,u.y,sx,sy,Math.max(2,pw),80);
  }
  return false;
 }
 if(!rooms.length)throw Error('Mansion produced no rooms');
 const start=rooms[0];for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)open(start.cx+dx,start.cy+dy); // The foyer core is always open, even for a degenerate first leaf.
 connectAll(start.cx,start.cy,false);
 let ok=connectAll(start.cx,start.cy,true);
 const egress=rooms.length<=1||rooms.slice(1).some(r=>flood(start.cx,start.cy).has(r.cx+','+r.cy));
 if((!ok||!egress)&&rooms.length>1){directRescue(start.cx,start.cy,rooms[1].cx,rooms[1].cy,Math.max(2,pw));ok=connectAll(start.cx,start.cy,true);} // Last-resort foyer corridor, as in the campaign.
 { // Anything still cut off is sealed, as the Desert does, so every floor tile is reachable from the foyer.
  const reached=flood(start.cx,start.cy);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++)if(!reached.has(x+','+y))set(x,y,WALL);
 }

 // mansion_assign_room_types(): foyer, sanctum, then a shuffled bag (the campaign's story-room reservations stay offline).
 const types={...DEFAULT_TYPES,...(data.room_types??{})},pool=Array.isArray(types.pool)&&types.pool.length?types.pool:DEFAULT_TYPES.pool;
 start.type=types.entrance;if(rooms.length>1)rooms[rooms.length-1].type=types.deepest;
 let bag=[];for(let i=1;i<rooms.length-1;i++){if(!bag.length){bag=[...pool];for(let k=bag.length-1;k>0;k--){const j=rnd(k+1);[bag[k],bag[j]]=[bag[j],bag[k]];}}rooms[i].type=bag.pop();}

 // The foyer pad: stand on it (or press E beside it) to walk back out to the Woods.
 const pad={x:start.cx,y:start.cy},entry={x:start.cx,y:start.cy+1}; // Arrive one tile south of the pad, inside the guaranteed-open foyer core.
 f.exits=[{...pad,zone:endpoints[0].zone,name:endpoints[0].name,style:'warp'}];f.entries={[endpoints[0].zone]:{...entry}};f.entrance={...entry};
 f.safeRooms=[{x:start.x,y:start.y,w:start.w,h:start.h},{x:start.cx-1,y:start.cy-1,w:3,h:3}]; // Nothing spawns in the foyer.
 f.rooms=rooms; // Carries type and wedge metadata: the client's mansion painter and lighting read both.

 // Content: the same stable IDs and per-room density as every other overworld.
 const occupied=new Set([key(pad),key(entry)]),safe=p=>f.safeRooms.some(r=>inside(r,p.x,p.y));
 const cells=r=>{const out=[];for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++){const p={x,y};if(mansionRoomContains(r,x,y)&&walkable(f,x,y)&&!occupied.has(key(p))&&!safe(p))out.push(p);}return out;};
 const free=r=>{const list=cells(r);if(!list.length)return null;const p=list[rnd(list.length)];occupied.add(key(p));return p;}; // Tiny closets simply hold less.
 const weights=data.enemy_types.flatMap(e=>Array(e.chance).fill(e.enemy_id));
 const chance={enemy_chance:38,item_chance:28,bonus_item_chance:55,...(data.spawn_chances??{})}; // mansion_dungeon.json spawn_chances, exported as-is.
 for(let i=1;i<rooms.length;i++){
  const r=rooms[i];if(cells(r).length<4)continue; // One-tile BSP stubs and slivers stay empty corridors.
  if(rnd(100)<chance.bonus_item_chance){const chest=free(r);if(chest)f.chests.push({id:`chest-${i}`,...chest});} // Campaign spawn_chances decide which rooms hold what, so the big house is not wall-to-wall monsters.
  if(rnd(100)<chance.enemy_chance)for(let n=0;n<c.enemies_per_room;n++){const p=free(r);if(!p)break;const type=weights[rnd(weights.length)];f.enemies.push({id:`enemy-${i}-${n}`,type,...p,spawn:{...p},roaming:data.enemies[type]?.roaming!==false,engaged:null,respawnAt:0});}
  for(const [kind,count] of [['food',c.food_per_room],['potion',c.potions_per_room],['treasure',c.treasures_per_room]])if(rnd(100)<chance.item_chance)for(let n=0;n<count;n++){const p=free(r);if(p)f.pickups.push({id:`${kind}-${i}-${n}`,kind,...p,sprite:'sprItem'});}
 }

 // Scenery: each room is dressed from its identity first (two pieces), then the rest of the budget scatters anywhere.
 const profiles=new Map((data.detail_profiles??[]).map(p=>[p.sprite,p])),themed=data.room_props??{};
 function place(p,x,y,room=null){
  const footprint=[];for(let dy=0;dy<p.span_h;dy++)for(let dx=0;dx<p.span_w;dx++)footprint.push({x:x+dx,y:y+dy});
  if(footprint.some(v=>!walkable(f,v.x,v.y)||occupied.has(key(v))||safe(v)||(room&&!mansionRoomContains(room,v.x,v.y))))return false;
  for(const v of footprint)f.props[v.y][v.x]=1;
  try{validateDesert(f);}catch{for(const v of footprint)f.props[v.y][v.x]=0;return false;} // Furniture may never seal loot, an enemy or the pad.
  for(const v of footprint)occupied.add(key(v));f.decorations.push({...p,x,y});return true;
 }
 const lo=Math.floor(num('prop_count_min',26)),budget=range(lo,Math.max(lo,Math.floor(num('prop_count_max',36))));
 for(let i=0;i<rooms.length&&f.decorations.length<budget;i++){
  const r=rooms[i],list=(themed[r.type]??[]).map(sp=>profiles.get(sp)).filter(Boolean);if(!list.length||r.w<2||r.h<2)continue;
  for(let placed=0,attempt=0;placed<2&&attempt<24;attempt++){const p=list[rnd(list.length)];if(place(p,range(r.x,Math.max(r.x,r.x+r.w-p.span_w)),range(r.y,Math.max(r.y,r.y+r.h-p.span_h)),r))placed++;}
 }
 const everything=[...profiles.values()];
 for(let attempt=0;attempt<400&&f.decorations.length<budget&&everything.length;attempt++){const p=everything[rnd(everything.length)];place(p,range(2,W-p.span_w-2),range(2,H-p.span_h-2));}
 validateDesert(f);return f;
}
