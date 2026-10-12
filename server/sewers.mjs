import {seeded,walkable,inside} from './dive-generation.mjs';
import {validateFullDungeon} from './full-dungeon-generation.mjs';
import {exposeClothing} from './clothing-conditions.mjs';
import {isCrawling,movementDelay} from './crawl.mjs';

export const SEWER_ZONE='dungeon-littlebig-sewers';
const key=p=>p.x+','+p.y;
export const sewerLow=(f,x,y)=>f.sewer?.low?.[y]?.[x]==='1';
export const sewerWater=(f,x,y)=>f.sewer?.water?.[y]?.[x]==='1';

export function sewerStance(f,state,x,y){
 if(!state.loadout)return;
 state.loadout.world??={};
 state.loadout.world.environment_crawl=sewerLow(f,x,y); // Keep voluntary/knockdown stance separate; leaving pipes removes only the environmental constraint.
}
export function sewerDelay(f,state,x,y,nx,ny,tuning){
 if(!f.sewer)return movementDelay(state.loadout,tuning);
 const loadout={...state.loadout,world:{...state.loadout.world,environment_crawl:sewerLow(f,x,y)||sewerLow(f,nx,ny)}};
 return movementDelay(loadout,tuning)+(sewerWater(f,nx,ny)?f.sewer.step_delay_ms:0); // Entry is paced as crawling before any movement is committed.
}
export function sewerStep(f,state,x,y,catalog={}){
 sewerStance(f,state,x,y);
 if(!f.sewer||!sewerWater(f,x,y)||state.run||state.dungeonScene||state.pendingDefeat)return;
 const slots=isCrawling(state.loadout)?['socks','shoes','pants','torso']:['socks','shoes'];
 exposeClothing(state.loadout.player_info,slots,catalog,'sewer water'); // Existing persistent wet-garment penalties; no additional needs or damage tick.
}
export function refreshSewerWater(f){
 const s=f.sewer,water=Array.from({length:f.height},()=>Array(f.width).fill('0')),mist=s.baseMist.map(r=>r.split(''));
 for(const b of s.branches)for(const [i,cells] of b.paths.entries())for(const p of cells){water[p.y][p.x]=i===b.state?'1':'0';mist[p.y][p.x]=i===b.state?'1':'0';}
 s.water=water.map(r=>r.join(''));f.mist={version:1,rows:mist.map(r=>r.join('')),tiles:mist.flat().filter(v=>v==='1').length};
 for(const fixture of f.fixtures.filter(v=>v.kind==='sluice')){const b=s.branches[fixture.branch];fixture.name='Sluice '+(fixture.branch+1)+' — '+(b.state===0?'long passage':'low shortcut')+' flooded';}
} // Derive both hazard layers from the same persisted switches before publishing their revision.
export function sewerValve(f,fixture,revision){
 if(!f.sewer||revision!==f.mechanismRevision)throw Object.assign(Error('The sluice changed. Refresh before acting.'),{status:409,code:'dungeon_conflict'});
 const b=f.sewer.branches[fixture.branch];b.state=1-b.state;refreshSewerWater(f);f.mechanismRevision++;f.geometryVersion++;
 f.sewer.notice={revision:f.mechanismRevision,branch:fixture.branch,text:'Sluice '+(fixture.branch+1)+': '+(b.state===0?'long passage':'low shortcut')+' flooded; the other branch is draining and ventilating.'};
 return f.sewer.notice.text;
} // No collision changes: occupants always retain a way out, even during simultaneous visits.

export function generateSewers(data,edition,depth=1){
 const c=data.config,W=c.width,H=c.height,rnd=seeded(c.route+':'+edition+':sewer-v1'),s=data.structure;
 if(W!==128||H!==96||s.chamber_count!==18)throw Error('Sewers require a 128 x 96 map with 18 chambers');
 const f={route:c.route,edition,depth,theme:'sewer',width:W,height:H,generatorVersion:1,contentVersion:data.version,geometryVersion:1,mechanismRevision:0,
 walls:Array.from({length:H},()=>Array(W).fill(1)),props:Array.from({length:H},()=>Array(W).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[],fixtures:[],traps:[],puzzles:[],exits:[],entries:{},safeRooms:[]};
 const open=(x,y)=>{if(x<1||y<1||x>=W-1||y>=H-1)throw Error('Sewer carving escaped its border');f.walls[y][x]=0;};
 const circle=(x,y,r)=>{const cells=[];for(let yy=y-r;yy<=y+r;yy++)for(let xx=x-r;xx<=x+r;xx++)if((xx-x)**2+(yy-y)**2<=r*r){open(xx,yy);cells.push({x:xx,y:yy});}return cells;};
 for(let row=0;row<3;row++)for(let n=0;n<6;n++){
  const col=row%2?5-n:n,cx=12+col*20,cy=14+row*32,r=s.radius_min+rnd(s.radius_max-s.radius_min+1),i=f.rooms.length;
  f.rooms.push({x:cx-r,y:cy-r,w:2*r+1,h:2*r+1,cx,cy,radius:r,shape:'circle',type:'junction-'+i,cells:circle(cx,cy,r)});
 }
 const roomCells=new Set(f.rooms.flatMap(r=>r.cells.map(key))),bends=[],paths=[];
 function tunnel(points){const cells=new Map();for(let i=1;i<points.length;i++){let [x,y]=points[i-1];const [tx,ty]=points[i];while(true){for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){open(x+dx,y+dy);cells.set((x+dx)+','+(y+dy),{x:x+dx,y:y+dy});}if(x===tx&&y===ty)break;if(x!==tx)x+=Math.sign(tx-x);else y+=Math.sign(ty-y);}}return [...cells.values()].filter(p=>!roomCells.has(key(p)));}
 for(let i=0;i<17;i++){
  const a=f.rooms[i],b=f.rooms[i+1];let points;
  if(a.cy===b.cy){const dir=Math.sign(b.cx-a.cx),off=(i%2?1:-1)*10,mx=a.cx+dir*2;points=[[a.cx,a.cy],[mx,a.cy],[mx,a.cy+off],[b.cx-dir*2,a.cy+off],[b.cx-dir*2,b.cy],[b.cx,b.cy]];bends.push({x:mx,y:a.cy+off,radius:3});}
  else points=[[a.cx,a.cy],[a.cx+(a.cx>64?9:-9),a.cy],[a.cx+(a.cx>64?9:-9),b.cy],[b.cx,b.cy]];
  paths.push(tunnel(points));
 } // A serpentine graph with separate two-tile doglegs preserves the long standing route.
 const low=Array.from({length:H},()=>Array(W).fill('0')),branches=[];
 for(const edge of [2,8,14]){
  const a=f.rooms[edge],b=f.rooms[edge+1],short=tunnel([[a.cx,a.cy],[b.cx,b.cy]]),middle=(a.cx+b.cx)/2;
  for(const p of short)if(p.x>=middle-Math.floor(s.low_length/2)&&p.x<middle+Math.ceil(s.low_length/2))low[p.y][p.x]='1'; // Half-open bounds keep the minimum six-cell span; chamber rims may shorten the longest authored span.
  const index=branches.length;branches.push({state:1,paths:[paths[edge],short],rooms:[edge,edge+1]});
  for(const [end,r] of [a,b].entries())f.fixtures.push({id:'sluice-'+index+'-'+end,kind:'sluice',branch:index,name:'Sluice',sprite:'sprSewerValve',x:r.cx-2,y:r.cy-2,span_w:1,span_h:1,solid:true});
 }
 for(const [i,zone,name] of [[0,'littlebig-clockwork','LittleBigCity'],[17,'arcadia-foundry','Arcadia']]){const r=f.rooms[i];f.exits.push({x:r.cx,y:r.cy,zone,name,style:'stairs'});f.entries[zone]={x:r.cx,y:r.cy+1};f.safeRooms.push({...r});}
 f.entrance={...f.entries['littlebig-clockwork']};
 for(const i of [5,11]){const r=f.rooms[i];f.safeRooms.push({...r});for(const [kind,dx,sprite,name] of [['bed',-2,'sprBed','Maintenance cot'],['toilet',2,data.service_profiles.toilet.sprite,'Maintenance toilet']])f.fixtures.push({id:kind+'-'+i,kind,bed:'objBedCot',style:'porcelain',name,sprite,x:r.cx+dx,y:r.cy-1,span_w:1,span_h:1,solid:true});}
 for(const fix of f.fixtures)f.props[fix.y][fix.x]=1;
 const rooms=f.rooms.filter((r,i)=>![0,5,11,17].includes(i)),deadEnds=[];
 for(let i=0;i<5;i++){const r=rooms[i*2],dy=r.cy<45?1:-1,dx=r.cy===46?2:-2;deadEnds.push(tunnel([[r.cx+dx,r.cy],[r.cx+dx,r.cy+dy*(r.radius+4)]]));} // On the reversed middle row, branch off the opposite side of the standing passage to preserve real cul-de-sacs.
 const protectedCell=p=>f.safeRooms.some(r=>inside(r,p.x,p.y)),controlled=new Set(branches.flatMap(b=>b.paths.flat().map(key)));
 const base=Array.from({length:H},()=>Array(W).fill('0')),eligible=[];
 for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++)if(f.walls[y][x]===0&&!protectedCell({x,y})&&!controlled.has(x+','+y))eligible.push({x,y});
 for(let i=eligible.length-1;i>0;i--){const j=rnd(i+1);[eligible[i],eligible[j]]=[eligible[j],eligible[i]];}
 for(const p of eligible.slice(0,Math.ceil(eligible.length*c.sewer.mist_coverage)))base[p.y][p.x]='1';
 f.sewer={low:low.map(r=>r.join('')),branches,baseMist:base.map(r=>r.join('')),step_delay_ms:c.sewer.step_delay_ms,lighting:c.sewer.lighting,lights:[...f.rooms.filter((_,i)=>i%3!==1).map(r=>({x:r.cx,y:r.cy,radius:3+rnd(3)})),...bends.filter((_,i)=>i%2===0).slice(0,6)]};
 refreshSewerWater(f);
 const occupied=new Set([...f.fixtures,...f.exits,...Object.values(f.entries)].map(key));
 const take=cells=>{const choices=cells.filter(p=>walkable(f,p.x,p.y)&&!protectedCell(p)&&!occupied.has(key(p)));if(!choices.length)throw Error('No sewer content space');const p=choices[rnd(choices.length)];occupied.add(key(p));return {...p};};
 for(let i=0;i<3;i++)f.chests.push({id:'shortcut-treasure-'+i,...take(branches[i].paths[1])});
 for(let i=0;i<5;i++)f.chests.push({id:'treasure-'+i,...take(deadEnds[i].slice(-2))}); // Place each reward at the tip, beyond the last bend back to its junction.
 const pool=data.enemy_types.map(v=>v.enemy_id),offset=rnd(pool.length);
 for(let i=0;i<8;i++){const p=take(rooms[(i*3)%rooms.length].cells),type=pool[(i+offset)%pool.length];f.enemies.push({id:'enemy-'+i,type,...p,spawn:{...p},definition:structuredClone(data.enemies[type]),roaming:true,engaged:null,respawnAt:0});}
 for(let i=0;i<8;i++)f.pickups.push({id:'supply-'+i,kind:i%2?'potion':'food',sprite:'sprItem',...take(rooms[i%rooms.length].cells)});
 validateFullDungeon(f);return f;
} // Pure seeded generation is shared by live workers, previews, and the connectivity suite.
