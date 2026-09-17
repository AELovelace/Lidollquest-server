import {createHash} from 'node:crypto';

const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
function parts(ms){return Object.fromEntries(clock.formatToParts(ms).map(p=>[p.type,p.value]));} // Read civil time without assuming a fixed Pacific UTC offset.
function mondayUTC(date){
 const wanted=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),4);let result=wanted+8*3600000;
 for(let i=0;i<3;i++){const p=parts(result);result+=wanted-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour);}
 return result;
}
export function weeklyWindow(now){
 const p=parts(now),day=new Date(Date.UTC(+p.year,+p.month-1,+p.day));
 day.setUTCDate(day.getUTCDate()-(day.getUTCDay()+6)%7);
 if(mondayUTC(day)>now)day.setUTCDate(day.getUTCDate()-7);
 const start=mondayUTC(day),edition=day.toISOString().slice(0,10);day.setUTCDate(day.getUTCDate()+7);
 return {edition,start,ends:mondayUTC(day)};
} // Weekly boundaries remain 04:00 local across DST and server downtime.
export function seeded(seed){let s=createHash('sha256').update(seed).digest().readUInt32LE(0);return n=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return Math.floor(s/4294967296*n);};}
const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
export const walkable=(f,x,y)=>Number.isInteger(x)&&Number.isInteger(y)&&y>=0&&y<f.height&&x>=0&&x<f.width&&f.walls[y][x]===0&&!f.props?.[y]?.[x]; // Furniture blocks movement without becoming a structural wall.
export const inside=(r,x,y)=>x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h;
export function pathTo(f,start,target,limit=Infinity){
 const queue=[{...start,path:[]}],seen=new Set([start.x+','+start.y]);
 for(let q=0;q<queue.length;q++){const p=queue[q];if(p.x===target.x&&p.y===target.y)return p.path;if(p.path.length>=limit)continue;
  for(const [dx,dy] of dirs){const x=p.x+dx,y=p.y+dy,key=x+','+y;if(walkable(f,x,y)&&!seen.has(key)){seen.add(key);queue.push({x,y,path:[...p.path,{x,y}]});}}
 }return null;
} // The same cardinal topology validates generation and drives shared enemy pursuit.
export function generateFloor(data,edition,depth=1){
 const c=data.config,s=data.structure,rnd=seeded(`${c.route}:${edition}:${depth}:v${data.version}`);
 if(!Number.isInteger(c.width)||!Number.isInteger(c.height)||c.width<24||c.height<24||c.width>128||c.height>128||!Number.isInteger(c.enemies_per_room)||c.enemies_per_room<1||c.enemies_per_room>6||s.max_depth<1||s.max_depth>5)throw Error('Dive dimensions/density are outside supported bounds');
 if(!Array.isArray(c.themes)||c.themes.length!==1||c.themes[0]!=='princess_quarters')throw Error('Only the Quarters theme is available in this pilot');
 const f={route:c.route,edition,depth,theme:c.themes[(depth-1)%c.themes.length],generatorVersion:1,contentVersion:data.version,width:c.width,height:c.height,rooms:[],walls:Array.from({length:c.height},()=>Array(c.width).fill(1)),enemies:[],chests:[],decorations:[]};
 const carve=(x,y)=>{if(x>0&&y>0&&x<f.width-1&&y<f.height-1)f.walls[y][x]=0;};
 function hall(a,b){let x=a.cx,y=a.cy;while(x!==b.cx||y!==b.cy){for(let dy=-Math.floor(s.hall_width/2);dy<=Math.floor(s.hall_width/2);dy++)for(let dx=-Math.floor(s.hall_width/2);dx<=Math.floor(s.hall_width/2);dx++)carve(x+dx,y+dy);if(x!==b.cx)x+=Math.sign(b.cx-x);else y+=Math.sign(b.cy-y);}}
 function split(x,y,w,h,d){
  const vertical=w>h,min=Math.max(s.min_partition,s.min_room+2),size=vertical?w:h;
  if(d<s.max_depth&&size>=2*min){const cut=min+rnd(size-2*min+1),a=split(x,y,vertical?cut:w,vertical?h:cut,d+1),b=split(vertical?x+cut:x,vertical?y:y+cut,vertical?w-cut:w,vertical?h:h-cut,d+1);hall(a,b);return a;}
  const rw=Math.max(s.min_room,Math.floor((w-2)*(0.7+rnd(31)/100))),rh=Math.max(s.min_room,Math.floor((h-2)*(0.7+rnd(31)/100)));
  const room={x:x+1+rnd(Math.max(1,w-rw-1)),y:y+1+rnd(Math.max(1,h-rh-1)),w:rw,h:rh};room.cx=room.x+Math.floor(rw/2);room.cy=room.y+Math.floor(rh/2);
  f.rooms.push(room);for(let yy=room.y;yy<room.y+rh;yy++)for(let xx=room.x;xx<room.x+rw;xx++)carve(xx,yy);return room;
 }
 split(1,1,f.width-2,f.height-2,0);
 for(let i=0;i<s.extra_halls;i++)hall(f.rooms[rnd(f.rooms.length)],f.rooms[rnd(f.rooms.length)]);
 f.rooms.sort((a,b)=>a.cx+a.cy-b.cx-b.cy);f.entrance={x:f.rooms[0].cx,y:f.rooms[0].cy};
 const occupied=new Set([`${f.entrance.x},${f.entrance.y}`]);
 function free(room){const cells=[];for(let y=room.y;y<room.y+room.h;y++)for(let x=room.x;x<room.x+room.w;x++)if(walkable(f,x,y)&&!occupied.has(`${x},${y}`))cells.push({x,y});if(!cells.length)throw Error('No placement tile');const p=cells[rnd(cells.length)];occupied.add(`${p.x},${p.y}`);return p;}
 let far=f.rooms[1],distance=-1;
 for(let i=1;i<f.rooms.length;i++){const room=f.rooms[i],d=pathTo(f,f.entrance,{x:room.cx,y:room.cy})?.length??-1;if(d>distance){far=room;distance=d;}
  f.chests.push({id:`chest-${i}`,...free(room)});
  for(let j=0;j<c.enemies_per_room;j++){const p=free(room),type=rnd(100)<60?'diaper_fairy':'teddy_mimic';f.enemies.push({id:`enemy-${i}-${j}`,type,...p,spawn:{...p},engaged:null,respawnAt:0});}
  for(let j=0;j<2&&data.decorations.length;j++)f.decorations.push({...free(room),sprite:data.decorations[rnd(data.decorations.length)]});
 }
 const boss=free(far);f.enemies.push({id:'iris',type:'dive_iris',...boss,spawn:{...boss},engaged:null,respawnAt:0});
 dressFloor(data,f);validateFloor(f);return f;
} // Generate one materialized floor; the route/edition/depth key is ready for later lazy descent.
export function dressFloor(data,f,visitors=[]){
 if((f.dressingVersion??0)>=(data.dressing_version??2))return false;
 const c=data.config,rnd=seeded(`${f.route}:${f.edition}:${f.depth}:dressing2`),key=p=>p.x+','+p.y;
 const potions=c.potions_per_room??1,treasures=c.treasures_per_room??1,area=c.detail_area_per_object??18,max=c.details_max_per_room??4;
 if(![potions,treasures].every(n=>Number.isInteger(n)&&n>=0&&n<=4)||!Number.isInteger(area)||area<8||!Number.isInteger(max)||max<0||max>8)throw Error('Dive scenery/loot density is outside supported bounds');
 if(!data.potion_pool?.length||data.potion_pool.some(id=>!data.items[id]))throw Error('Missing eligible potion pool');
 f.props=Array.from({length:f.height},()=>Array(f.width).fill(0));f.decorations=[];f.pickups??=[];
 const occupied=new Set([f.entrance,...f.enemies,...f.enemies.map(e=>e.spawn),...f.chests,...f.pickups,...visitors].map(key));
 const cells=r=>{const a=[];for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)if(walkable(f,x,y)&&!occupied.has(x+','+y))a.push({x,y});return a;};
 for(let i=1;i<f.rooms.length;i++)for(const [kind,count] of [['potion',potions],['treasure',treasures]])for(let n=0;n<count;n++){
  const id=`${kind}-${i}-${n}`;if(f.pickups.some(p=>p.id===id))continue;
  const free=cells(f.rooms[i]);if(!free.length)throw Error('No room for personal pickups');
  const p=free[rnd(free.length)];occupied.add(key(p));f.pickups.push({id,kind,...p,sprite:'sprItem'});
 } // Add stable personal loot IDs without changing existing chest rolls, enemies or edition keys.
 function connected(){
  const queue=[f.entrance],seen=new Set([key(f.entrance)]);
  for(let i=0;i<queue.length;i++)for(const [dx,dy] of dirs){const p={x:queue[i].x+dx,y:queue[i].y+dy};if(walkable(f,p.x,p.y)&&!seen.has(key(p))){seen.add(key(p));queue.push(p);}}
  for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)if(walkable(f,x,y)&&!seen.has(x+','+y))return false;
  return true;
 } // Validate all remaining walkable cells, including approaches and occupied player tiles.
 const profiles=data.detail_profiles??[];
 for(let i=0;i<f.rooms.length;i++){
  const r=f.rooms[i],count=Math.max(0,Math.min(max,Math.max(1,Math.floor(r.w*r.h/area)))-(i===0?1:0));let placed=0;
  for(let attempt=0;attempt<160&&placed<count&&profiles.length;attempt++){
   const profile=profiles[rnd(profiles.length)],w=profile.span_w,h=profile.span_h;
   if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>8||h>8)throw Error('Invalid furniture footprint');
   const margin=r.w<=w+profile.margin*2||r.h<=h+profile.margin*2?0:profile.margin;
   if(r.w-w-2*margin<0||r.h-h-2*margin<0)continue;
   const x=r.x+margin+rnd(r.w-w-2*margin+1),y=r.y+margin+rnd(r.h-h-2*margin+1),footprint=[];
   for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)footprint.push({x:x+dx,y:y+dy});
   if(footprint.some(p=>!walkable(f,p.x,p.y)||occupied.has(key(p))||Math.abs(p.x-f.entrance.x)+Math.abs(p.y-f.entrance.y)<3))continue;
   if(profile.solid){for(const p of footprint)f.props[p.y][p.x]=1;if(!connected()){for(const p of footprint)f.props[p.y][p.x]=0;continue;}}
   for(const p of footprint)occupied.add(key(p));
   f.decorations.push({...profile,x,y});placed++;
  }
 }
 if(!connected())throw Error('Disconnected furnished floor');
 f.dressingVersion=data.dressing_version??2;return true;
} // Idempotent dressing upgrade preserves the live weekly layout, progress and reward entitlements.
export function validateFloor(f){
 if(f.rooms.length<2||!walkable(f,f.entrance.x,f.entrance.y))throw Error('Invalid entrance');
 const seen=new Set();for(const entity of [...f.enemies,...f.chests,...(f.pickups??[])]){const key=entity.x+','+entity.y;if(seen.has(key)||!pathTo(f,f.entrance,entity)||inside(f.rooms[0],entity.x,entity.y))throw Error('Unreachable or unsafe content');seen.add(key);}
 if(!f.enemies.some(e=>e.id==='iris'))throw Error('Missing guardian');
 return true;
}
