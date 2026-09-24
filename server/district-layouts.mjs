const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export const districtSize=(def,data)=>({width:def.width??data?.width??50,height:def.height??data?.height??50}); // Per-district size (LittleBigCity is 60x60); the shared default is 50x50.
export const entryStrip=(width,height)=>({x:width-8,y:Math.floor(height/2)-3,w:7,h:6}); // The protected strip inside the east wall: gate rows are cy-1 and cy.
export const westStrip=height=>({x:1,y:Math.floor(height/2)-3,w:7,h:6}); // Its mirror inside the west wall (lobby towns only).
export function districtLayout(def,rnd,data=null){
 const {width:W,height:H}=districtSize(def,data),cx=Math.floor(W/2),cy=Math.floor(H/2); // Everything below is expressed from the size, so a 60x60 city and a 50x50 castle share one grammar.
 const grid=value=>Array.from({length:H},()=>Array(W).fill(value));
 const c=def.layout,f={walls:grid(1),floors:grid(0),wallTiles:grid(0),rooms:[],paths:[],blocks:[]},protectedCells=new Set();
 const key=(x,y)=>x+','+y,inside=(x,y)=>x>0&&y>0&&x<W-1&&y<H-1;
 function open(x,y,tile=1,protect=false){if(!inside(x,y))return;f.walls[y][x]=0;f.floors[y][x]=tile;if(protect)protectedCells.add(key(x,y));}
 function rect(x,y,w,h,tile=1){for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)open(xx,yy,tile);}
 function circle(cx,cy,r,tile=1){for(let y=cy-r;y<=cy+r;y++)for(let x=cx-r;x<=cx+r;x++)if(Math.hypot(x-cx,y-cy)<=r)open(x,y,tile);}
 function line(a,b,width,tile=1,winding=false){
  let x=a.cx,y=a.cy;const points=[],half=Math.floor(width/2);let budget=600;
  function stamp(){points.push({x,y});for(let dy=-half;dy<width-half;dy++)for(let dx=-half;dx<width-half;dx++)open(x+dx,y+dy,tile,true);}
  while((x!==b.cx||y!==b.cy)&&budget-->0){
   stamp();
   if(winding&&rnd(100)>=70){const [dx,dy]=[[1,0],[-1,0],[0,1],[0,-1]][rnd(4)];x=clamp(x+dx,2,W-3);y=clamp(y+dy,2,H-3);}
   else if(Math.abs(b.cx-x)>Math.abs(b.cy-y))x+=Math.sign(b.cx-x);else if(y!==b.cy)y+=Math.sign(b.cy-y);else x+=Math.sign(b.cx-x);
  }
  while(x!==b.cx){stamp();x+=Math.sign(b.cx-x);}while(y!==b.cy){stamp();y+=Math.sign(b.cy-y);}stamp();
  f.paths.push({width,points}); // Store route identity for seed checks and previews, then omit it from network snapshots.
 }
 function elbow(a,b,width,tile=1){const bend=rnd(2)?{cx:b.cx,cy:a.cy}:{cx:a.cx,cy:b.cy};line(a,bend,width,tile);line(bend,b,width,tile);}
 if(def.style==='castle'){
  function split(n,depth){
   const horizontal=n.h>n.w*1.25?true:n.w>n.h*1.25?false:!!rnd(2),length=horizontal?n.h:n.w;
   if(depth>=c.max_depth||length<c.min_partition*2){
    const maxw=n.w-2,maxh=n.h-2,minw=Math.max(c.min_room,Math.floor(maxw*.7)),minh=Math.max(c.min_room,Math.floor(maxh*.7));
    const w=minw+rnd(maxw-minw+1),h=minh+rnd(maxh-minh+1),x=n.x+1+rnd(n.w-w-1),y=n.y+1+rnd(n.h-h-1);
    const r={x,y,w,h,cx:x+Math.floor(w/2),cy:y+Math.floor(h/2),kind:['parlour','bedchamber','library','gallery'][f.rooms.length%4]};f.rooms.push(r);rect(x,y,w,h);return r;
   }
   const cut=c.min_partition+rnd(length-c.min_partition*2+1);
   const a=split(horizontal?{...n,h:cut}:{...n,w:cut},depth+1),b=split(horizontal?{...n,y:n.y+cut,h:n.h-cut}:{...n,x:n.x+cut,w:n.w-cut},depth+1);
   elbow(a,b,c.hall_width,2);return rnd(2)?a:b;
  }
  split({x:1,y:1,w:W-2,h:H-2},0);
  for(let i=0;i<c.extra_halls;i++){const a=f.rooms[rnd(f.rooms.length)],b=f.rooms[rnd(f.rooms.length)];elbow(a,b,c.hall_width,2);}
  // Campaign floor variants occur in four-tile patches, rather than one noisy random tile at a time.
  for(let y=1;y<H-1;y+=4)for(let x=1;x<W-1;x+=4){const tile=[1,1,1,1,2,2,3,5][rnd(8)];for(let dy=0;dy<4&&y+dy<H-1;dy++)for(let dx=0;dx<4&&x+dx<W-1;dx++)if(!f.walls[y+dy][x+dx]&&!protectedCells.has(key(x+dx,y+dy)))f.floors[y+dy][x+dx]=tile;}
 }else if(def.style==='market'){
  // Match Honeydew's cellular woodland, circular clearings and 70/30 winding-road bias.
  for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++)f.walls[y][x]=rnd(100)<c.fill_chance?1:0;
  for(let pass=0;pass<c.smooth_passes;pass++){
   const old=f.walls.map(row=>[...row]);
   for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){
    let count=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dx||dy)count+=old[y+dy][x+dx];
    f.walls[y][x]=old[y][x]?(count<c.death_limit?0:1):(count>=c.birth_limit?1:0);
   }
  }
  const plaza={cx,cy,r:c.village_square_radius,kind:'village_square'};f.rooms.push(plaza);circle(cx,cy,plaza.r,8);
  for(let tries=0;tries<500&&f.rooms.length<c.num_clearings;tries++){
   const r=c.min_clearing+rnd(c.max_clearing-c.min_clearing+1),ccx=r+3+rnd(W-6-2*r),ccy=r+3+rnd(H-6-2*r);
   if(f.rooms.some(p=>Math.hypot(p.cx-ccx,p.cy-ccy)<p.r+r+c.building_min_gap))continue;
   f.rooms.push({cx:ccx,cy:ccy,r,kind:'market_clearing'});circle(ccx,ccy,r,3);
  }
  for(const r of f.rooms.slice(1))line(r,plaza,c.path_width,5,true);
  for(let i=1;i<f.rooms.length-1;i++)line(f.rooms[i],f.rooms[i+1],c.path_width,5,true);
  circle(cx,cy,plaza.r,8); // The village square remains a recognisable flagstone gathering space after road carving.
  // Decorate grass in patches while preserving the dirt routes and flagstone village square.
  for(let y=1;y<H-1;y+=3)for(let x=1;x<W-1;x+=3){const tile=[1,1,2,3][rnd(4)];for(let dy=0;dy<3&&y+dy<H-1;dy++)for(let dx=0;dx<3&&x+dx<W-1;dx++)if(!f.walls[y+dy][x+dx]&&!f.floors[y+dy][x+dx])f.floors[y+dy][x+dx]=tile;}
 }else{
  function axis(centre,limit){const a=[centre];for(const direction of [-1,1]){let p=centre;while(true){p+=direction*Math.max(8,c.avenue_spacing+rnd(2*c.road_spacing_jitter+1)-c.road_spacing_jitter);if(p<=3||p>=limit-4)break;a.push(p);}}return a.sort((a,b)=>a-b);}
  const xs=axis(cx,W),ys=axis(cy,H);f.axes={x:xs,y:ys};
  const half=(v,centre)=>Math.floor((v===centre?c.boulevard_width:c.avenue_width)/2);
  for(const x of xs){const width=x===cx?c.boulevard_width:c.avenue_width;rect(x-half(x,cx)-1,1,width+2,H-2,4);line({cx:x,cy:1},{cx:x,cy:H-2},width,1);}
  for(const y of ys){const width=y===cy?c.boulevard_width:c.avenue_width;rect(1,y-half(y,cy)-1,W-2,width+2,4);line({cx:1,cy:y},{cx:W-2,cy:y},width,1);}
  // Restore bare asphalt at crossings after sidewalk stamps from the other axis.
  for(const p of protectedCells){const [x,y]=p.split(',').map(Number);f.floors[y][x]=1;}
  const allx=[0,...xs,W-1],ally=[0,...ys,H-1];
  for(let j=0;j<ally.length-1;j++)for(let i=0;i<allx.length-1;i++){
   const x=allx[i]+half(allx[i],cx)+2,y=ally[j]+half(ally[j],cy)+2;
   const right=allx[i+1]-half(allx[i+1],cx)-2,bottom=ally[j+1]-half(ally[j+1],cy)-2;
   if(right-x>=3&&bottom-y>=3)f.blocks.push({x,y,w:right-x+1,h:bottom-y+1,cx:Math.floor((x+right)/2),cy:Math.floor((y+bottom)/2),kind:'city_block'});
  }
  const candidates=[...f.blocks];
  for(let i=0;i<c.park_block_count&&candidates.length;i++){
   const r=candidates.splice(rnd(candidates.length),1)[0];r.kind=i%2?'courtyard':'park';rect(r.x-1,r.y-1,r.w+2,r.h+2,i%2?6:8);f.rooms.push(r);
  }
  const plaza={cx,cy,r:c.village_square_radius,kind:'civic_plaza'};circle(cx,cy,plaza.r,6);f.rooms.unshift(plaza);
 }
 const road=def.style==='castle'?2:def.style==='market'?5:1,strip=def.style==='castle'?2:def.style==='market'?8:4,east=entryStrip(W,H);
 const entry={cx:W-5,cy},nearest=[...f.rooms].sort((a,b)=>Math.hypot(a.cx-entry.cx,a.cy-entry.cy)-Math.hypot(b.cx-entry.cx,b.cy-entry.cy))[0];
 elbow(entry,nearest,3,road);
 rect(east.x,east.y,east.w,east.h,strip);
 for(let y=east.y;y<east.y+east.h;y++)for(let x=east.x;x<W;x++)protectedCells.add(key(x,y));
 const gates=def.lobby?.gates??null; // A lobby town opens onto the wilderness through its own walls: west and/or east, as authored; an annex district always opens east back to its lobby.
 if(def.lobby){ // A lobby town: a matching west entry strip, the authored gates, and a clear civic strip around each plaza building, its doorstep, the arrival tile, the spawn and the campaign stairs.
  const west=westStrip(H),civicTile=def.style==='market'?8:6,westNearest=[...f.rooms].sort((a,b)=>Math.hypot(a.cx-4,a.cy-cy)-Math.hypot(b.cx-4,b.cy-cy))[0];
  elbow({cx:4,cy},westNearest,3,road);rect(west.x,west.y,west.w,west.h,strip); // Mirror of the east entry: a road into the nearest clearing and a strip inside the gate.
  for(let y=west.y;y<west.y+west.h;y++)for(let x=1;x<west.x+west.w;x++)protectedCells.add(key(x,y));
  if(gates?.west){f.walls[cy-1][0]=0;f.walls[cy][0]=0;f.floors[cy-1][0]=f.floors[cy][0]=f.floors[cy][1];} // West gate (0, cy-1..cy).
  const square=(x,y)=>Math.hypot(x-cx,y-cy)<=c.village_square_radius;
  const civic=[...(def.lobby.buildings??[]).flatMap(b=>{const cells=[];for(let y=b.y-1;y<b.y+b.span_h+3;y++)for(let x=b.x-1;x<=b.x+b.span_w;x++)cells.push([x,y]);return cells;}),[def.lobby.spawn.x,def.lobby.spawn.y],[def.lobby.stairs.x,def.lobby.stairs.y]]; // A one-tile ring around each facade, its door row, the arrival row and one more row of breathing room.
  for(const [x,y] of civic){if(square(x,y)||(x===def.lobby.stairs.x&&y===def.lobby.stairs.y))open(x,y,civicTile,true);else protectedCells.add(key(x,y));} // Inside the square the strip is paved floor; outside it is merely kept clear of props.
 }
 const d=def.dormitory; // Optional fixed resting room beside the entrance (Rose Court's beds live here): carved after the host layout so it always exists in the same place.
 if(d){const tile=def.style==='castle'?1:def.style==='market'?6:6;rect(d.x,d.y,d.w,d.h,tile);
  for(let y=d.y;y<d.y+d.h;y++)for(let x=d.x;x<d.x+d.w;x++)protectedCells.add(key(x,y)); // Scenery never lands on the beds' floor.
  for(let y=d.y+d.h;y<east.y;y++)open(d.door.x,y,tile,true); // A one-tile doorway runs south from the room to the protected entry area.
  f.rooms.push({x:d.x,y:d.y,w:d.w,h:d.h,cx:d.x+Math.floor(d.w/2),cy:d.y+Math.floor(d.h/2),kind:'dormitory'});
 }
 if(!def.lobby||gates?.east){f.walls[cy-1][W-1]=0;f.walls[cy][W-1]=0;f.floors[cy-1][W-1]=f.floors[cy][W-1]=f.floors[cy][W-2];} // East gap: back to the lobby (annex districts) or the authored east gate (lobby towns).
 // Seal isolated pockets instead of exposing unreachable decorative floor.
 const seen=new Set(),queue=[{x:W-2,y:cy}];
 for(let i=0;i<queue.length;i++){const {x,y}=queue[i],k=key(x,y);if(x<0||y<0||x>W-1||y>H-1||f.walls[y][x]||seen.has(k))continue;seen.add(k);queue.push({x:x+1,y},{x:x-1,y},{x,y:y+1},{x,y:y-1});}
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  if(!seen.has(key(x,y))){f.walls[y][x]=1;f.floors[y][x]=0;}
  if(!f.walls[y][x])continue;
  const edge=[[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen.has(key(x+dx,y+dy)));
  if(def.style==='castle')f.wallTiles[y][x]=edge?[10,10,12,12,14][rnd(5)]:10;
  else if(def.style==='market')f.wallTiles[y][x]=edge?[34,34,35,36,37][rnd(5)]:35;
  else f.wallTiles[y][x]=edge?([31,33,39,32,34,40][Math.floor(x/3+y/3)%6]):36; // Use campaign facade windows around solid city mass.
 }
 return {...f,protectedCells};
} // Each host keeps its native layout grammar; only safe geometry and scenery are generated online.
