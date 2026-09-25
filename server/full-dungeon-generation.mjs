// Full-sized campaign layouts. Geometry and population use independent seeded streams;
// story orbs, campaign flags and the Nursery's control door never enter this generator.
import {seeded,walkable,inside} from './dive-generation.mjs';

const directions=[[1,0],[-1,0],[0,1],[0,-1]],key=p=>`${p.x},${p.y}`;
export function fullDungeonAmbientPool(data){
 const pool=[];
 for(const e of data.campaign.enemy_types??[]){
  if(!e.enemy_id||!data.enemies[e.enemy_id])throw Error('Unresolved campaign enemy: '+e.name);
  if(!Number.isSafeInteger(e.chance??1)||(e.chance??1)<0)throw Error('Invalid campaign enemy weight: '+e.name);
  for(let n=0;n<(e.chance??1);n++)pool.push(e.enemy_id);
 }
 if(data.config.theme==='dungeon'&&!pool.length)throw Error('Dungeon requires an authored ambient enemy pool');
 return pool;
} // A missing mapping fails generation instead of selecting from the global monster catalogue.

export function repairFullDungeonContent(f,data){
 let changed=false;
 for(const fixture of f.fixtures??[]){const npc=fixture.kind==='npc'?data.npcs[fixture.content]:null;if(npc&&fixture.sprite!==npc.sprite){fixture.sprite=npc.sprite;changed=true;}}
 if(data.config.theme==='dungeon'){
  const pool=fullDungeonAmbientPool(data),allowed=new Set(pool);
  for(const foe of f.enemies){
   if(foe.manual||foe.engaged||!(/^(enemy-|spawn-)/.test(foe.id))||allowed.has(foe.type))continue;
   const rnd=seeded(f.route+':'+f.edition+':repair:'+foe.id);foe.type=pool[rnd(pool.length)];
   foe.definition=structuredClone(data.enemies[foe.type]);foe.roaming=foe.definition.roaming!==false;changed=true;
  } // Keep encounter IDs, positions, timers and claims; active fights finish before their misplaced monster is repaired.
 }
 if(changed)f.geometryVersion=(f.geometryVersion??0)+1; // Refresh existing clients' fixture presentation without rerolling the map.
 return changed;
}

export function dungeonReachable(f,start=f.entrance){
 const seen=new Set(),queue=[start];
 for(let i=0;i<queue.length;i++){const p=queue[i];if(!walkable(f,p.x,p.y)||seen.has(key(p)))continue;seen.add(key(p));for(const [dx,dy] of directions)queue.push({x:p.x+dx,y:p.y+dy});}
 return seen;
} // One flood fill checks content and fixture approaches, without quadratic path searches.

export function validateFullDungeon(f){
 const opened={...f,props:f.props.map(r=>[...r])};
 for(const puzzle of f.puzzles)for(const b of puzzle.blocks)opened.props[b.y][b.x]=0; // A puzzle's guarded chest is reachable after pushing; fixed walls still count.
 const seen=dungeonReachable(opened),ids=new Set();
 for(const p of [...f.exits,...Object.values(f.entries),...f.enemies,...f.chests,...f.pickups]){
  if(!seen.has(key(p)))throw Error(`Unreachable full dungeon content: ${p.id??key(p)}`);
  if(p.id){if(ids.has(p.id))throw Error('Duplicate dungeon identity: '+p.id);ids.add(p.id);}
 }
 for(const p of f.fixtures)if(!directions.some(([dx,dy])=>seen.has(`${p.x+dx},${p.y+dy}`)))throw Error('Unreachable fixture: '+p.id);
 for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)if(walkable(opened,x,y)&&!seen.has(`${x},${y}`))throw Error('Disconnected full dungeon floor');
 for(const e of f.enemies)if(f.safeRooms.some(r=>inside(r,e.x,e.y)))throw Error('Enemy on a stair landing');
 return true;
}

export function solveDungeonPuzzle(f,q){
 const bounds=q.bounds??{x:q.x-2,y:q.y-2,w:5,h:5},base={...f,props:f.props.map(row=>[...row])};
 for(const b of q.blocks)base.props[b.y][b.x]=0;
 const states=[{blocks:q.blocks.map(b=>({...b})),at:{x:bounds.x,y:bounds.y},moves:[]}],visited=new Set();
 for(let index=0;index<states.length&&index<20000;index++){
  const state=states[index],blocked=new Set(state.blocks.map(key)),reachable=new Set(),queue=[state.at];
  for(let n=0;n<queue.length;n++){const p=queue[n],k=key(p);if(reachable.has(k)||blocked.has(k)||!inside(bounds,p.x,p.y)||!walkable(base,p.x,p.y))continue;reachable.add(k);for(const [dx,dy] of directions)queue.push({x:p.x+dx,y:p.y+dy});}
  if(reachable.has(key(q)))return state.moves;
  const signature=[...blocked].sort().join(';')+'|'+[...reachable].sort()[0];if(visited.has(signature))continue;visited.add(signature);
  for(const [bi,b] of state.blocks.entries())for(const [dx,dy] of directions){const behind={x:b.x-dx,y:b.y-dy},dest={x:b.x+dx,y:b.y+dy};if(!reachable.has(key(behind))||blocked.has(key(dest))||!inside(bounds,dest.x,dest.y)||!walkable(base,dest.x,dest.y))continue;const blocks=state.blocks.map(p=>({...p}));blocks[bi]={...b,...dest};states.push({blocks,at:behind,moves:[...state.moves,{block:b.id,from:behind,to:dest}]});}
 }
 return null;
} // Search legal pushes, including player access to the pushing side; opening every block is not a solvability proof.

export function generateFullDungeon(data,edition,depth=1){
 const c=data.config,s=data.structure,source=data.campaign,W=c.width,H=c.height,rnd=seeded(`${c.route}:${edition}:${depth}:v${data.version}`),range=(a,b)=>a+rnd(Math.max(1,b-a+1));
 if(![W,H].every(v=>Number.isInteger(v)&&v>=24&&v<=128)||!c.endpoints?.length)throw Error('Invalid full dungeon dimensions/endpoints');
 const f={route:c.route,edition,depth,theme:c.theme,width:W,height:H,generatorVersion:1,contentVersion:data.version,dressingVersion:data.dressing_version,foodVersion:data.food_version,geometryVersion:1,mechanismRevision:0,
  walls:Array.from({length:H},()=>Array(W).fill(1)),props:Array.from({length:H},()=>Array(W).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[],fixtures:[],traps:[],puzzles:[],exits:[],entries:{},safeRooms:[]};
 const open=(x,y)=>{if(x>0&&y>0&&x<W-1&&y<H-1)f.walls[y][x]=0;};
 const rectangle=(x,y,w,h)=>{const room={x,y,w,h,cx:x+Math.floor(w/2),cy:y+Math.floor(h/2)};for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)open(xx,yy);return room;};
 function hall(a,b,verticalFirst=false,width=s.hall_width){
  let x=a.cx,y=a.cy;const half=Math.floor(width/2),stamp=()=>{for(let dy=-half;dy<=half;dy++)for(let dx=-half;dx<=half;dx++)open(x+dx,y+dy);};
  stamp();while(x!==b.cx||y!==b.cy){if(verticalFirst&&y!==b.cy)y+=Math.sign(b.cy-y);else if(x!==b.cx)x+=Math.sign(b.cx-x);else y+=Math.sign(b.cy-y);stamp();}
 } // Campaign L-shaped halls use the authored width; Nursery control exits downward only.
 const shuffle=values=>{const a=[...values];for(let i=a.length-1;i>0;i--){const j=rnd(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;};
 if(c.theme==='dungeon'){
  function split(x,y,w,h,d){
   let horizontal=rnd(2)===0;if(w>h*1.25)horizontal=false;else if(h>w*1.25)horizontal=true;
   const size=horizontal?h:w,min=s.min_partition;
   if(d<s.max_depth&&size>=min*2){const cut=range(min,size-min),a=split(x,y,horizontal?w:cut,horizontal?cut:h,d+1),b=split(horizontal?x:x+cut,horizontal?y+cut:y,horizontal?w:w-cut,horizontal?h-cut:h,d+1);hall(a,b);return rnd(2)?a:b;}
   const rw=range(Math.min(s.min_room,w-2),w-2),rh=range(Math.min(s.min_room,h-2),h-2),r=rectangle(x+range(1,w-rw-1),y+range(1,h-rh-1),rw,rh);f.rooms.push(r);return r;
  }
  split(1,1,W-2,H-2,0);
  for(let i=0;i<s.extra_halls;i++)hall(f.rooms[rnd(f.rooms.length)],f.rooms[rnd(f.rooms.length)]);
  let bag=[];f.rooms.forEach((r,i)=>{if(!bag.length)bag=shuffle(source.room_types.pool);r.type=i===0?source.room_types.entrance:i===f.rooms.length-1?source.room_types.deepest:bag.pop();});
 }else{
  const cols=s.sector_cols,rows=s.sector_rows,sw=Math.floor(W/cols),sh=Math.floor(H/rows),types=shuffle(source.type_pool),fixed=c.theme==='nursery'?'control':c.entrance_type;
  const put=(type,index)=>{const at=types.indexOf(type);if(at<0)throw Error('Missing campaign room type '+type);[types[at],types[index]]=[types[index],types[at]];};
  put(fixed,0);if(c.theme==='nursery')put('intake',cols*rows-1);
  for(let col=0;col<cols;col++)for(let row=0;row<rows;row++){
   const maxW=Math.max(3,sw-2-s.room_margin*2),maxH=Math.max(3,sh-2-s.room_margin*2),w=range(Math.max(3,maxW-2),maxW),h=range(Math.max(3,maxH-2),maxH);
   const x=col*sw+1+s.room_margin+range(0,Math.max(0,sw-2-w-s.room_margin*2)),y=row*sh+1+s.room_margin+range(0,Math.max(0,sh-2-h-s.room_margin*2)),r=rectangle(x,y,w,h),i=f.rooms.length;
   r.original_type=types[i%types.length];r.is_atrium=c.theme==='school'||c.theme==='nursery'&&i!==0&&i!==cols*rows-1;r.is_hollow=false;r.col=col;r.row=row;r.type=r.is_atrium?'atrium':r.original_type;f.rooms.push(r);
  }
  for(let col=0;col<cols;col++)for(let row=0;row<rows;row++){const r=f.rooms[col*rows+row];if(col+1<cols&&r.type!=='control')hall(r,f.rooms[(col+1)*rows+row]);if(row+1<rows)hall(r,f.rooms[col*rows+row+1],r.type==='control');}
  if(s.hollow_spaces_enabled){
   const pool=source.hollow_room_type_pool,t=s.hollow_space_wall_thickness;
   for(let n=0;n<s.hollow_space_max_rooms;n++){
    let carved=false;
    for(let attempt=0;attempt<1800&&!carved;attempt++){
     const w=range(s.hollow_space_min_width,Math.min(s.hollow_space_max_width,sw+6)),h=range(s.hollow_space_min_height,Math.min(s.hollow_space_max_height,sh+6)),x=range(2,W-w-2),y=range(2,H-h-2);
     if(f.rooms.some(r=>x<r.x+r.w+1&&x+w+1>r.x&&y<r.y+r.h+1&&y+h+1>r.y))continue;
     let solid=true;for(let yy=y;yy<y+h&&solid;yy++)for(let xx=x;xx<x+w;xx++)if(!f.walls[yy][xx]){solid=false;break;}if(!solid)continue;
     const cx=x+Math.floor(w/2),cy=y+Math.floor(h/2);let door=null;
     for(const [dx,dy] of directions){const bx=dx<0?x:dx>0?x+w-1:cx,by=dy<0?y:dy>0?y+h-1:cy;
      for(let distance=1;distance<=9;distance++){const xx=bx+dx*distance,yy=by+dy*distance;if(xx<1||yy<1||xx>=W-1||yy>=H-1)break;if(!f.walls[yy][xx]){if(!door||distance<door.distance)door={bx,by,dx,dy,distance};break;}}
     }
     if(!door)continue;
     const r=rectangle(x+t,y+t,w-t*2,h-t*2);if(r.w<3||r.h<3)continue;
     r.type=pool[n%pool.length];r.original_type=r.type;r.is_hollow=true;r.is_atrium=false;f.rooms.push(r);
     for(let d=-t;d<=door.distance;d++)for(let off=0;off<s.hollow_space_door_width;off++)open(door.bx+door.dx*d+(door.dy?off:0),door.by+door.dy*d+(door.dx?off:0));
     carved=true;
    }
   }
   // The compact Nursery already restores missing wards; use the same fallback for
   // School so an unlucky hollow-room carve cannot erase its Principal or side objectives.
   for(const type of new Set(source.type_pool))if(!f.rooms.some(r=>r.type===type)){
    const r=f.rooms.find(r=>r.is_atrium&&r.original_type===type)??f.rooms.find(r=>r.is_atrium);
    if(!r)throw Error('No room available for '+type);r.type=type;r.is_atrium=false;
   }
  }
 }
 const start=f.rooms.find(r=>r.type===c.entrance_type)||f.rooms[0],end=f.rooms.at(-1);
 c.endpoints.forEach((e,i)=>{const r=i?end:start,p={x:r.cx,y:r.cy};f.exits.push({...e,...p});f.entries[e.zone]={x:p.x,y:p.y+1};f.safeRooms.push({x:p.x-1,y:p.y-1,w:3,h:4});rectangle(p.x-1,p.y-1,3,4);});
 f.entrance={...f.entries[c.endpoints[0].zone]};
 const occupied=new Set(f.exits.concat(Object.values(f.entries)).map(key)),safe=p=>f.safeRooms.some(r=>inside(r,p.x,p.y));
 const cells=r=>{const out=[];for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)if(walkable(f,x,y)&&!occupied.has(`${x},${y}`)&&!safe({x,y}))out.push({x,y});return out;};
 const free=r=>{const list=cells(r);if(!list.length)return null;const p=list[rnd(list.length)];occupied.add(key(p));return p;};
 function fixture(profile,preferred=f.rooms){
  for(const r of shuffle(preferred))for(const p of shuffle(cells(r))){
   const span=[];for(let dy=0;dy<(profile.span_h??1);dy++)for(let dx=0;dx<(profile.span_w??1);dx++)span.push({x:p.x+dx,y:p.y+dy});
   if(span.some(q=>!inside(r,q.x,q.y)||!walkable(f,q.x,q.y)||occupied.has(key(q))||safe(q)))continue;
   for(const q of span)f.props[q.y][q.x]=1;const seen=dungeonReachable(f),all=f.walls.reduce((sum,row,y)=>sum+row.filter((v,x)=>v===0&&!f.props[y][x]).length,0);
   if(seen.size!==all||!directions.some(([dx,dy])=>seen.has(`${p.x+dx},${p.y+dy}`))||f.fixtures.some(q=>!directions.some(([dx,dy])=>seen.has(`${q.x+dx},${q.y+dy}`)))){for(const q of span)f.props[q.y][q.x]=0;continue;}
   const placed={span_w:1,span_h:1,...profile,...p,solid:true};span.forEach(q=>occupied.add(key(q)));f.fixtures.push(placed);return placed;
  }
  throw Error('No accessible place for required fixture '+profile.id);
 }
 // Reserve the puzzle before any population, exactly as the campaign does. The
 // ring remains empty even when a compact ward would otherwise fill with NPCs.
 const bossPositions=new Map(c.bosses.map(b=>{const room=f.rooms.find(r=>r.type===b.room_type);if(!room)throw Error('Missing boss room '+b.room_type);const point=free(room);if(!point)throw Error('No space for '+b.enemy_id);return [b.enemy_id,point];})); // Required encounters reserve a tile before furniture or a large stamp can occupy their ward.
 const stamp=data.puzzle_stamps[rnd(data.puzzle_stamps.length)];
 puzzle:for(const r of f.rooms.filter(r=>r!==start&&r!==end).sort((a,b)=>b.w*b.h-a.w*a.h)){
  const x=r.cx-Math.floor(stamp.width/2),y=r.cy-Math.floor(stamp.height/2),bounds={x:x-1,y:y-1,w:stamp.width+2,h:stamp.height+2},area=[];for(let dy=0;dy<bounds.h;dy++)for(let dx=0;dx<bounds.w;dx++)area.push({x:bounds.x+dx,y:bounds.y+dy});
  if(area.some(p=>p.x<1||p.y<1||p.x>=W-1||p.y>=H-1||occupied.has(key(p))||safe(p)))continue;
  for(const p of area){open(p.x,p.y);occupied.add(key(p));}
  const blocks=[],fixed=[];let chest;
  for(let yy=0;yy<stamp.height;yy++)for(let xx=0;xx<stamp.width;xx++){
   const p={x:x+xx,y:y+yy},token=stamp.cells[yy][xx];
   if(['push','pushable','block'].includes(token))blocks.push({id:'block-'+blocks.length,...p});
   else if(token==='wall')fixed.push({...p});else if(token==='chest')chest=p;
  }
  if(!chest||!blocks.length)throw Error('Puzzle needs a chest and pushable blocks');
  f.puzzles.push({id:'puzzle-0',...chest,bounds,stamp:stamp.name,sprite:stamp.sprite,fixed,wall_sprite:stamp.wall_sprite,blocks,initial:structuredClone(blocks),solved:false,revision:0});f.chests.push({id:'puzzle-chest',...chest,puzzle:'puzzle-0'});break puzzle;
 }
 if(f.puzzles.length!==1)throw Error('Could not reserve the required campaign puzzle');
 if(c.theme==='hospital')fixture({id:'token-admission-form',kind:'token',content:'admission_form',name:'Admission Form',sprite:'sprItem'});
 // Required services and campaign residents are placed before optional clutter.
 fixture({id:'objNPCMerchant',kind:'shop',shop:'objNPCMerchant',name:'Mira',sprite:'sprFriendly'});
 fixture({id:'quest-board',kind:'quest_board',name:'Quest Board',...data.service_profiles.board});
 for(let i=0;i<(source.guaranteed_fixtures?.adult_toilets??2);i++)fixture({id:'toilet-'+i,kind:'toilet',style:'porcelain',name:'Toilet',...data.service_profiles.toilet});
 for(let i=0;i<(source.guaranteed_fixtures?.potty_chairs??3);i++)fixture({id:'potty-'+i,kind:'toilet',style:'potty',name:'Potty Chair',...data.service_profiles.potty});
 for(const profile of data.fixture_profiles)fixture(profile);
 for(const [id,npc] of Object.entries(data.npcs))fixture({id:'npc-'+id,kind:'npc',content:id,avatar:id,name:npc.name,sprite:npc.sprite});
 for(const profile of data.detail_profiles.filter(p=>p.narrative_chunk)){
  const rooms=f.rooms.filter(r=>!profile.room_types||profile.room_types.includes(r.type));
  fixture({...profile,id:'detail-'+f.fixtures.length,kind:'detail',name:'Examine',narrative:profile.narrative_chunk},[...rooms,...f.rooms.filter(r=>!rooms.includes(r))]); // Small BSP leaves use a reachable adjoining room when the native furniture cannot fit its preferred leaf.
 }
 const bossTypes=new Set(c.bosses.map(b=>b.enemy_id));
 const spawn=(type,p,id,roaming=data.enemies[type]?.roaming!==false)=>{f.enemies.push({id,type,...p,spawn:{...p},roaming,engaged:null,respawnAt:0});};
 for(const boss of c.bosses){const room=f.rooms.find(r=>r.type===boss.room_type),p=bossPositions.get(boss.enemy_id);spawn(boss.enemy_id,p,'boss-'+boss.enemy_id,boss.roaming);if(data.boss_loot.length){const loot=free(room);if(loot)f.chests.push({id:'boss-loot-'+boss.enemy_id,...loot,loot_pool:data.boss_loot,requires_encounter:'boss-'+boss.enemy_id});}}
 if(c.theme==='dungeon'){const p=free(start);if(!p)throw Error('No space for guaranteed Iron Dagger');f.pickups.push({id:'guaranteed-iron-dagger',kind:'treasure',...p,item_id:'iron_dagger',sprite:data.items.iron_dagger.sprite??'sprItem'});}
 const weighted=fullDungeonAmbientPool(data); // Never fall back to the live catalogue: it contains monsters from unrelated regions.
 const fallback=weighted;
 for(const [i,r] of f.rooms.entries()){
  if(r===start)continue;
  const pool=(data.room_enemies[r.type]??(r.is_atrium?data.room_enemies.atrium:undefined)??(c.theme==='dungeon'?fallback:[])).filter(id=>!bossTypes.has(id));
  const chance=c.theme==='dungeon'?source.spawn_chances.enemy_chance:r.is_atrium?(s.atrium_patrol_chance??25):100;
  if(pool.length&&rnd(100)<chance)for(let n=0;n<c.enemies_per_room;n++){const p=free(r);if(p)spawn(pool[rnd(pool.length)],p,`enemy-${i}-${n}`);}
  if(rnd(100)<(source.spawn_chances?.bonus_item_chance??s.bonus_item_chance??70)){const p=free(r);if(p)f.chests.push({id:'chest-'+i,...p,trapped:rnd(100)<(s.chest_trap_chance??source.spawn_chances?.chest_trap_chance??25)});}
  for(const kind of ['food','potion','treasure']){const p=free(r);if(p)f.pickups.push({id:`${kind}-${i}`,kind,...p,sprite:'sprItem',room_type:r.type,...(kind==='treasure'&&data.room_items[r.type]?.length?{loot_pool:data.room_items[r.type]}:{})});}
  if(rnd(100)<(s.trap_chance??source.spawn_chances?.trap_chance??0)){const p=free(r);if(p)f.traps.push({id:'trap-'+i,...p});}
 }
 if(c.theme==='dungeon')f.lullabyRooms=f.rooms.slice(Math.floor(f.rooms.length*(s.lullaby_zone_depth??0.6))).map(r=>({x:r.x,y:r.y,w:r.w,h:r.h}));
 for(const puzzle of f.puzzles){for(const b of [...puzzle.blocks,...puzzle.fixed])f.props[b.y][b.x]=1;for(const [i,b] of puzzle.fixed.entries())f.decorations.push({id:puzzle.id+'-wall-'+i,...b,sprite:puzzle.wall_sprite,span_w:1,span_h:1,solid:true});} // Activate the authored stamp after fixture placement.
 // Optional scenery keeps native sprite footprints. Validate after tentative placement.
 for(const [i,r] of f.rooms.entries()){
  const profiles=data.detail_profiles.filter(p=>!p.narrative_chunk&&(!p.room_types||p.room_types.includes(r.type)));if(!profiles.length)continue;
  for(let n=0;n<2;n++){const profile=profiles[rnd(profiles.length)],p=free(r);if(!p)continue;const span=[];for(let dy=0;dy<profile.span_h;dy++)for(let dx=0;dx<profile.span_w;dx++)span.push({x:p.x+dx,y:p.y+dy});
   if(span.some(q=>!inside(r,q.x,q.y)||!walkable(f,q.x,q.y)||(key(q)!==key(p)&&occupied.has(key(q)))||safe(q)))continue;
   for(const q of span)f.props[q.y][q.x]=1;
   try{validateFullDungeon(f);}catch{for(const q of span)f.props[q.y][q.x]=0;continue;}
   span.forEach(q=>occupied.add(key(q)));f.decorations.push({...profile,...p,id:`scenery-${i}-${n}`});
  }
 }
 validateFullDungeon(f);for(const puzzle of f.puzzles)if(solveDungeonPuzzle(f,puzzle)===null)throw Error('Unsolvable campaign puzzle: '+puzzle.stamp);return f;
}

export const generateCastleDungeon=(data,edition,depth)=>generateFullDungeon(data,edition,depth);
export const generateAutoNursery=(data,edition,depth)=>generateFullDungeon(data,edition,depth);
export const generateRegressionSchool=(data,edition,depth)=>generateFullDungeon(data,edition,depth);
export const generateRegressionHospital=(data,edition,depth)=>generateFullDungeon(data,edition,depth);
