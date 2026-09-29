import {seeded,walkable} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';
export const CAVERNS_ZONE='dungeon-coastal-caverns';
const dirs=[[1,0],[-1,0],[0,1],[0,-1]],key=p=>p.x+','+p.y;
export function caveReach(f,start=f.entrance,dry=false){
 const seen=new Set([key(start)]),q=[start];for(let i=0;i<q.length;i++)for(const [dx,dy] of dirs){const p={x:q[i].x+dx,y:q[i].y+dy};if(walkable(f,p.x,p.y)&&(!dry||!f.caveChannels?.[p.y]?.[p.x])&&!seen.has(key(p))){seen.add(key(p));q.push(p);}}return seen;
} // Shared reachability check for generated floors and seed previews.
export function generateCaverns(data,edition,depth=1){
 const c=data.config,s=data.structure,W=c.width,H=c.height,rnd=seeded(`${c.route}:${edition}:${depth}:cave-v1`);
 if(![W,H].every(n=>Number.isInteger(n)&&n>=64&&n<=128))throw Error('Caverns dimensions must be 64 to 128');
 const count=s.chamber_count??9;if(!Number.isInteger(count)||count<7||count>10)throw Error('Choose 7 to 10 cave chambers');
 for(const [name,min,max] of [['chamber_radius',4,9],['channel_width',2,5],['dry_path_width',2,5],['ledge_bend',3,10],['extra_loops',0,4]])if(!Number.isFinite(s[name])||s[name]<min||s[name]>max)throw Error(`Caverns ${name} must be ${min} to ${max}`); // Reject unsafe editor values before carving or entering unbounded loops.
 const f={route:c.route,edition,depth,theme:c.theme,generatorVersion:1,contentVersion:data.version,dressingVersion:data.dressing_version,foodVersion:data.food_version,width:W,height:H,walls:Array.from({length:H},()=>Array(W).fill(1)),props:Array.from({length:H},()=>Array(W).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[],fixtures:[],safeRooms:[],caveChannels:Array.from({length:H},()=>Array(W).fill(0)),caveInlets:[]};
 const dry=new Set(),low=new Set();
 const disk=(cx,cy,rx,ry,mask=null)=>{for(let y=Math.max(1,Math.floor(cy-ry));y<=Math.min(H-2,Math.ceil(cy+ry));y++)for(let x=Math.max(1,Math.floor(cx-rx));x<=Math.min(W-2,Math.ceil(cx+rx));x++)if(((x-cx)/rx)**2+((y-cy)/ry)**2<=1){f.walls[y][x]=0;mask?.add(x+','+y);}};
 const anchors=[[.15,.83],[.38,.79],[.69,.83],[.84,.62],[.60,.52],[.32,.48],[.19,.27],[.43,.19],[.72,.22],[.83,.38]].slice(0,count);
 const centers=anchors.map(([x,y],i)=>({x:Math.round(x*W)+(i?rnd(5)-2:0),y:Math.round(y*H)+(i?rnd(5)-2:0)}));
 for(const [i,p] of centers.entries()){
  const r=(s.chamber_radius??6)+rnd(3),ry=r-1+rnd(3);disk(p.x,p.y,r,ry);
  for(let j=0;j<4;j++){const a=rnd(628)/100;disk(p.x+Math.cos(a)*r*.7,p.y+Math.sin(a)*ry*.7,3+rnd(3),3+rnd(3));} // Overlapping erosion pockets make scalloped, asymmetric walls.
  f.rooms.push({x:p.x-r-3,y:p.y-ry-3,w:2*r+7,h:2*ry+7,cx:p.x,cy:p.y,type:i<3?'saltmouth':i<count-1?'dripstone':'breathing_vault'});
  disk(p.x,p.y,3,3,dry);
 }
 function channel(a,b,ledge){const length=Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)*3),angle=Math.atan2(b.y-a.y,b.x-a.x),bend=ledge?(s.ledge_bend??7):1.5;
  for(let j=0;j<=length;j++){const t=j/length,offset=Math.sin(t*Math.PI)*bend,x=a.x+(b.x-a.x)*t-Math.sin(angle)*offset,y=a.y+(b.y-a.y)*t+Math.cos(angle)*offset;disk(x,y,ledge?(s.dry_path_width??3)/2:(s.channel_width??3)/2,ledge?(s.dry_path_width??3)/2:(s.channel_width??3)/2,ledge?dry:low);}
 } // Each pair has a shorter low channel and a winding dry ledge: no tide phase seals the route.
 for(let i=1;i<count;i++){channel(centers[i-1],centers[i],false);channel(centers[i-1],centers[i],true);}
 for(let i=0;i<(s.extra_loops??2);i++){const a=1+rnd(count-3);channel(centers[a],centers[a+2],true);}
 for(const cell of low)if(!dry.has(cell)){const [x,y]=cell.split(',').map(Number);f.caveChannels[y][x]=x>W*.5?2:1;}
 // Every disconnected channel segment has a natural sea-fed fissure, so water never appears without an inlet.
 const visited=new Set();for(const cell of low)if(!dry.has(cell)&&!visited.has(cell)){const [x,y]=cell.split(',').map(Number),q=[{x,y}];visited.add(cell);f.caveInlets.push({x,y});for(let i=0;i<q.length;i++)for(const [dx,dy] of dirs){const p={x:q[i].x+dx,y:q[i].y+dy},k=key(p);if(f.caveChannels[p.y]?.[p.x]&&!visited.has(k)){visited.add(k);q.push(p);}}}
 f.entrance={...centers[0]};const exit={x:f.entrance.x,y:f.entrance.y+1,zone:'overworld-seafoam-coast',name:'Seafoam Coast',style:'warp'};f.exits=[exit];f.entries={'overworld-seafoam-coast':{...f.entrance}};
 for(const i of [0,Math.floor(count/2)]){const p=centers[i];f.safeRooms.push({x:p.x-3,y:p.y-3,w:7,h:7});}
 f.caveLandmarks={camp:centers[0],refuge:centers[Math.floor(count/2)],vault:centers.at(-1),markers:[centers[2],centers[4],centers[6]]};
 const occupied=new Set([key(exit),key(f.entrance)]),reserve=(id,kind,content,p)=>{const at={x:p.x-2,y:p.y};if(occupied.has(key(at)))at.x=p.x+2;occupied.add(key(at));f.authoredPlacements??=[];f.authoredPlacements.push({id,kind,content,...at,name:content,sprite:kind==='token'?'sprItem':'',zone:CAVERNS_ZONE,lifetime:'persistent',dry:true});};
 reserve('caverns-surveyor','npc','caverns_surveyor',centers[0]);
 for(const [i,p] of f.caveLandmarks.markers.entries())reserve('caverns-marker-'+i,'token','caverns_survey_marker',p);
 reserve('caverns-refuge','location','caverns_recovery',centers[Math.floor(count/2)]);
 reserve('caverns-memory','orb','caverns_memory',centers.at(-1));
 f.decorations.push({id:'caverns-camp',sprite:'sprCoastBeachHut',x:centers[0].x+2,y:centers[0].y-2,span_w:2,span_h:2,solid:false,toilet:true,style:'cabana'});
 const pool=data.enemy_types.flatMap(v=>Array(Math.max(1,v.chance??v.weight??1)).fill(v.enemy_id));
 const free=(r,dryOnly=false)=>{const cells=[];for(let y=Math.max(1,r.y);y<Math.min(H-1,r.y+r.h);y++)for(let x=Math.max(1,r.x);x<Math.min(W-1,r.x+r.w);x++)if(walkable(f,x,y)&&!occupied.has(x+','+y)&&!f.safeRooms.some(v=>x>=v.x&&y>=v.y&&x<v.x+v.w&&y<v.y+v.h)&&Math.hypot(x-r.cx,y-r.cy)<6&&(!dryOnly||!f.caveChannels[y][x]))cells.push({x,y});if(!cells.length)throw Error('Cave chamber has no content space');const p=cells[rnd(cells.length)];occupied.add(key(p));return p;};
 for(let i=1;i<count;i++){const r=f.rooms[i];
  if(i===Math.floor(count/2))continue;
  for(let j=0;j<Math.min(4,c.treasures_per_room??1);j++)f.chests.push({id:`chest-${i}-${j}`,...free(r,true)});
  for(let j=0;j<Math.min(6,c.enemies_per_room);j++){const p=free(r),boss=i===count-1&&j===0,type=boss?(c.boss_enemy_id??'breakwater_hermit'):pool[rnd(pool.length)];f.enemies.push({id:boss?'breakwater-hermit':`enemy-${i}-${j}`,type,...p,spawn:{...p},roaming:false,engaged:null,respawnAt:0});}
  for(const kind of ['food','potion'])for(let j=0;j<Math.min(4,c[kind==='food'?'food_per_room':'potions_per_room']??1);j++)f.pickups.push({id:`${kind}-${i}-${j}`,kind,...free(r),sprite:'sprItem'});
 }
 f.bossId='breakwater-hermit';const reached=caveReach(f,undefined,true);for(const p of centers)if(!reached.has(key(p)))throw Error('Cave dry spine disconnected');validateDesert(f);return f;
}

export function addCavernsEntrance(f){
 if(f.exits?.some(e=>e.zone===CAVERNS_ZONE))return false;
 const cx=Math.floor(f.width/2),cy=Math.floor(f.height/2),protectedCell=(x,y)=>Math.abs(x-cx)<=3&&y>=cy-3&&y<=cy+3;
 const connected=caveReach(f),nearest=[...connected].map(k=>{const [x,y]=k.split(',').map(Number);return {x,y};}).sort((a,b)=>Math.abs(a.x-cx)+Math.abs(a.y-cy)-Math.abs(b.x-cx)-Math.abs(b.y-cy))[0];
 if(!nearest)throw Error('Coast entrance has no reachable approach');
 const cleared=new Set(),open=(x,y)=>{if(x>0&&y>0&&x<f.width-1&&y<f.height-1){f.walls[y][x]=0;f.props[y][x]=0;cleared.add(x+','+y);}};
 for(let y=cy-3;y<=cy+3;y++)for(let x=cx-3;x<=cx+3;x++)open(x,y);
 let x=cx,y=cy+2;while(x!==nearest.x||y!==nearest.y){for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)open(x+dx,y+dy);if(x!==nearest.x)x+=Math.sign(nearest.x-x);else y+=Math.sign(nearest.y-y);}
 f.decorations=f.decorations.filter(p=>{let hit=false;for(let dy=0;dy<(p.span_h??1);dy++)for(let dx=0;dx<(p.span_w??1);dx++)if(cleared.has((p.x+dx)+','+(p.y+dy)))hit=true;if(hit)for(let dy=0;dy<(p.span_h??1);dy++)for(let dx=0;dx<(p.span_w??1);dx++)f.props[p.y+dy][p.x+dx]=0;return !hit;});
 const rows=[...f.enemies,...f.chests,...(f.pickups??[])],used=new Set([...rows,...f.exits,f.entrance].map(key));
 const choices=[...caveReach(f)].map(k=>{const [x,y]=k.split(',').map(Number);return {x,y};}).filter(p=>!protectedCell(p.x,p.y)&&!used.has(key(p))&&!(f.safeRooms??[]).some(r=>p.x>=r.x&&p.x<r.x+r.w&&p.y>=r.y&&p.y<r.y+r.h)).sort((a,b)=>Math.abs(a.x-cx)+Math.abs(a.y-cy)-Math.abs(b.x-cx)-Math.abs(b.y-cy));
 for(const p of rows)if(protectedCell(p.x,p.y)){const at=choices.shift();if(!at)throw Error('No space beside central cave entrance');Object.assign(p,at);if(p.spawn)p.spawn={...at};} // Keep entity IDs and personal claims while clearing the mandatory center.
 f.decorations.push({id:'coastal-caverns-mouth',sprite:'sprCoastalCaveEntrance',x:cx-1,y:cy-2,span_w:3,span_h:3,solid:false,landmark:CAVERNS_ZONE});
 f.exits.push({x:cx,y:cy,zone:CAVERNS_ZONE,name:'Coastal Caverns',style:'warp'});f.entries??={};f.entries[CAVERNS_ZONE]={x:cx,y:cy+1};
 f.safeRooms??=[];f.safeRooms.push({x:cx-3,y:cy-3,w:7,h:7});f.geometryVersion=(f.geometryVersion??0)+1;validateDesert(f);return true;
} // The doorway is exactly the map-center tile, not a random landmark candidate. Existing Coast trails survive.
