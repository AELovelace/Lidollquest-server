import {seeded,walkable,inside} from './dive-generation.mjs';

const directions=[[1,0],[-1,0],[0,1],[0,-1]],key=p=>p.x+','+p.y;
function reachable(f){
 const queue=[f.entrance],seen=new Set([key(f.entrance)]);
 for(let i=0;i<queue.length;i++)for(const [dx,dy] of directions){const p={x:queue[i].x+dx,y:queue[i].y+dy};if(walkable(f,p.x,p.y)&&!seen.has(key(p))){seen.add(key(p));queue.push(p);}}
 return seen;
} // One flood fill validates every destination without repeated full-map path searches.
export function validateDesert(f){
 const seen=reachable(f),ids=new Set();
 if(!walkable(f,f.entrance.x,f.entrance.y)||!f.exits.length)throw Error('Invalid wilderness entrances');
 for(const p of [...f.exits,...f.enemies,...f.chests,...f.pickups]){
  if(!seen.has(key(p)))throw Error('Unreachable Desert content');
  if(p.id){if(ids.has(p.id))throw Error('Duplicate Desert content ID');ids.add(p.id);}
 }
 for(const p of [...f.enemies,...f.chests,...f.pickups])if(f.safeRooms.some(r=>inside(r,p.x,p.y)))throw Error('Unsafe Desert entrance');
 for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)if(walkable(f,x,y)&&!seen.has(x+','+y))throw Error('Disconnected Desert floor');
 return true;
}
export function generateDesert(data,edition,depth=1){
 const c=data.config,s=data.structure,rnd=seeded(`${c.route}:${edition}:${depth}:v${data.version}`),range=(a,b)=>a+rnd(b-a+1);
 if(![c.width,c.height].every(n=>Number.isInteger(n)&&n>=40&&n<=128)||!Number.isInteger(s.basin_count)||s.basin_count<2||s.basin_count>12||!Number.isInteger(c.enemies_per_room)||c.enemies_per_room<0||c.enemies_per_room>6)throw Error('Invalid Desert dimensions/density');
 if(![c.food_per_room,c.potions_per_room,c.treasures_per_room].every(n=>Number.isInteger(n)&&n>=0&&n<=4))throw Error('Invalid Desert loot density');
 const f={route:c.route,edition,depth,theme:c.theme,generatorVersion:1,contentVersion:data.version,dressingVersion:data.dressing_version,foodVersion:data.food_version,width:c.width,height:c.height,
  walls:Array.from({length:c.height},(_,y)=>Array.from({length:c.width},(_,x)=>x===0||y===0||x===c.width-1||y===c.height-1?1:rnd(100)<s.fill_chance?1:0)),props:Array.from({length:c.height},()=>Array(c.width).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[]};
 const carve=(x,y)=>{if(x>0&&y>0&&x<f.width-1&&y<f.height-1)f.walls[y][x]=0;};
 const rect=r=>{for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)carve(x,y);};
 function path(a,b,width){
  let {x,y}=a;const radius=Math.max(2,Math.floor(width/2));
  for(let n=0;n<f.width*f.height;n++){
   for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++)if(dx*dx+dy*dy<=radius*radius)carve(x+dx,y+dy);
   if(x===b.x&&y===b.y)return;
   if(rnd(100)<s.drunk_bias){if(Math.abs(b.x-x)>Math.abs(b.y-y))x+=Math.sign(b.x-x);else y+=Math.sign(b.y-y);}
   else {const [dx,dy]=directions[rnd(4)];x=Math.max(1,Math.min(f.width-2,x+dx));y=Math.max(1,Math.min(f.height-2,y+dy));}
  }
  throw Error('Desert path failed to converge');
 } // Port the native cellular rock fields, wide winding route and connected basins to seeded server generation.
 for(let pass=0;pass<s.smooth_passes;pass++){
  const old=f.walls.map(r=>[...r]);for(let y=1;y<f.height-1;y++)for(let x=1;x<f.width-1;x++){
   let n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dx||dy)n+=old[y+dy][x+dx];
   f.walls[y][x]=old[y][x]?(n<s.death_limit?0:1):(n>s.birth_limit?1:0);
  }
 }
 const endpoints=c.endpoints??[{zone:'honeydew-lantern',name:'Honeydew Village'},{zone:'littlebig-clockwork',name:'LittleBig City'}];
 const southern=endpoints.length===1&&endpoints[0].side==='south',northern=endpoints.length===1&&endpoints[0].side==='north',single=southern||northern,middle=Math.floor(f.width/2); // A single trailhead sits mid-wall: south (High Desert, reached from Dustbreak) or north (Autumnal Plains, reached from Honeydew).
 if((!single&&endpoints.length!==2)||new Set(endpoints.map(p=>p.zone)).size!==endpoints.length||endpoints.some(p=>!p.zone||!p.name))throw Error('Invalid crossing endpoints');
 f.safeRooms=southern?[{x:middle-3,y:f.height-8,w:7,h:7}]:northern?[{x:middle-3,y:1,w:7,h:7}]:[{x:1,y:Math.floor(f.height/2)-3,w:7,h:7},{x:f.width-8,y:Math.floor(f.height/2)-3,w:7,h:7}];
 f.exits=endpoints.map((p,i)=>({x:single?middle:i===0?4:f.width-5,y:southern?f.height-2:northern?1:Math.floor(f.height/2),zone:p.zone,name:p.name})); // Preserve the original crossing coordinates and random sequence.
 f.entries=Object.fromEntries(f.exits.map((p,i)=>[p.zone,{x:p.x+(single?0:i===0?1:-1),y:p.y+(northern?1:southern?-1:0)}])); // Arrive one tile inside the trailhead.
 f.entrance={...f.entries[endpoints[0].zone]};
 const safeCount=f.safeRooms.length;
 f.rooms.push(...f.safeRooms);path(f.exits[0],single?{x:middle,y:Math.floor(f.height/2)}:f.exits[1],range(s.main_path_width_min,s.main_path_width_max));
 const land=f.width-(s.sea_width??0); // Coast: the east band is sea, so trails and basins stay on land. 0 for every inland route (unchanged rolls).
 if(single)path({x:10,y:Math.floor(f.height/2)},{x:land-11,y:Math.floor(f.height/2)},range(s.main_path_width_min,s.main_path_width_max)); // A central east/west trail connects the clearings to the sole southern trailhead.
 for(let i=0;i<s.basin_count;i++){
  const w=range(s.min_basin_w,s.max_basin_w),h=range(s.min_basin_h,s.max_basin_h),x=Math.max(9,Math.min(land-w-9,Math.round(10+i*(land-30)/(s.basin_count-1))+range(-4,4))),y=range(3,f.height-h-3);
  const r={x,y,w,h};f.rooms.push(r);rect(r);path({x:x+Math.floor(w/2),y:y+Math.floor(h/2)},{x:x+Math.floor(w/2),y:Math.floor(f.height/2)},range(s.side_path_width_min,s.side_path_width_max));
 }
 for(let i=0;i<s.side_path_count;i++){const a=f.rooms[safeCount+rnd(s.basin_count)],b=f.rooms[safeCount+rnd(s.basin_count)];path({x:a.x+Math.floor(a.w/2),y:a.y+Math.floor(a.h/2)},{x:b.x+Math.floor(b.w/2),y:b.y+Math.floor(b.h/2)},range(s.side_path_width_min,s.side_path_width_max));}
 for(const r of f.safeRooms)rect(r);
 if(s.sea_width){ // Flood the east band with a wavy shoreline (no random numbers), then let the pocket cleanup below drop anything the sea cut off.
  f.shore=Array.from({length:f.height},(_,y)=>Math.max(land-4,Math.min(f.width-2,land+Math.round(3*Math.sin(y*0.15)+2*Math.sin(y*0.37+1)))));
  for(let y=1;y<f.height-1;y++)for(let x=f.shore[y];x<f.width-1;x++)f.walls[y][x]=1;
 }
 if(s.crater){ // Emberfall Caldera: a lava lake in the middle (seed-free wobble) ringed by a 3-wide rim road that rejoins every trail it cut.
  const cx=Math.floor(f.width/2),cy=Math.floor(f.height/2),r=s.crater.radius??9,ring=s.crater.ring??3;
  const edge=(x,y)=>r+1.2*Math.sin(Math.atan2(y-cy,x-cx)*3)+0.8*Math.sin(Math.atan2(y-cy,x-cx)*5+1); // Lava shoreline radius at this bearing.
  for(let y=1;y<f.height-1;y++)for(let x=1;x<f.width-1;x++){const d=Math.hypot(x-cx,y-cy),e=edge(x,y);if(d<=e)f.walls[y][x]=1;else if(d<=e+ring)f.walls[y][x]=0;}
  f.crater={x:cx,y:cy,r}; // The client paints walls inside the lava shoreline as lava, the rest as obsidian.
 }
 // Remove isolated CA pockets; all active content is placed only in the entrance's connected component.
 const connected=reachable(f);for(let y=1;y<f.height-1;y++)for(let x=1;x<f.width-1;x++)if(!connected.has(x+','+y))f.walls[y][x]=1;
 if(s.crater)f.rooms=f.rooms.filter((r,i)=>{if(i<safeCount)return true;let n=0;for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)if(walkable(f,x,y))n++;return n>=6;}); // Basins the lava swallowed hold no content.
 const occupied=new Set(f.exits.map(key)),safe=p=>f.safeRooms.some(r=>inside(r,p.x,p.y));
 function free(r){const cells=[];for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++){const p={x,y};if(walkable(f,x,y)&&!occupied.has(key(p))&&!safe(p))cells.push(p);}if(!cells.length)throw Error('No Desert content space');const p=cells[rnd(cells.length)];occupied.add(key(p));return p;}
 const weights=data.enemy_types.flatMap(e=>Array(e.chance).fill(e.enemy_id));
 for(let i=safeCount;i<f.rooms.length;i++){
  const r=f.rooms[i];f.chests.push({id:`chest-${i}`,...free(r)});
  for(let n=0;n<c.enemies_per_room;n++){const p=free(r);const type=weights[rnd(weights.length)];f.enemies.push({id:`enemy-${i}-${n}`,type,...p,spawn:{...p},roaming:data.enemies?.[type]?.roaming!==false,engaged:null,respawnAt:0});} // An authored stationary monster (the Plains' Scarecrow Sitter) keeps its post; every other wilderness foe roams as before.
  for(const [kind,count] of [['food',c.food_per_room],['potion',c.potions_per_room],['treasure',c.treasures_per_room]])for(let n=0;n<count;n++)f.pickups.push({id:`${kind}-${i}-${n}`,kind,...free(r),sprite:'sprItem'});
 }
 const count=range(s.prop_count_min,s.prop_count_max);
 for(let attempt=0;attempt<400&&f.decorations.length<count;attempt++){
  const p=data.detail_profiles[rnd(data.detail_profiles.length)],x=range(2,f.width-p.span_w-2),y=range(2,f.height-p.span_h-2),cells=[];
  for(let dy=0;dy<p.span_h;dy++)for(let dx=0;dx<p.span_w;dx++)cells.push({x:x+dx,y:y+dy});
  if(cells.some(v=>!walkable(f,v.x,v.y)||occupied.has(key(v))||safe(v)))continue;
  for(const v of cells)f.props[v.y][v.x]=1;
  try{validateDesert(f);}catch{for(const v of cells)f.props[v.y][v.x]=0;continue;}
  for(const v of cells)occupied.add(key(v));f.decorations.push({...p,x,y});
 } // Native-size props keep their complete footprint and cannot seal loot or either hub exit.
 validateDesert(f);return f;
}
