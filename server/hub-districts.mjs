import {readFileSync} from 'node:fs';
import {seeded} from './dive-generation.mjs';

export const districtData=JSON.parse(readFileSync(new URL('./hub-district-data.json',import.meta.url),'utf8'));
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
const parts=time=>Object.fromEntries(clock.formatToParts(time).map(p=>[p.type,p.value]));
export function monthlyWindow(time,hour=4){
 function boundary(year,month){const target=Date.UTC(year,month,1,hour);let value=target+8*3600000;for(let i=0;i<3;i++){const p=parts(value);value+=target-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour);}return value;}
 const p=parts(time);let year=+p.year,month=+p.month-1;
 if(time<boundary(year,month)){month--;if(month<0){month=11;year--;}}
 return {edition:`${year}-${String(month+1).padStart(2,'0')}`,starts:boundary(year,month),ends:boundary(year,month+1)};
} // Month boundaries stay at 04:00 Pacific across daylight-saving changes and downtime.
const footprint=f=>Array.from({length:f.span_h??1},(_,dy)=>Array.from({length:f.span_w??1},(_,dx)=>({x:f.x+dx,y:f.y+dy}))).flat();
export const districtBlocked=(f,x,y)=>x<0||y<0||x>=f.width||y>=f.height||f.walls[y][x]===1||f.fixtures.some(p=>p.solid!==false&&x>=p.x&&y>=p.y&&x<p.x+(p.span_w??1)&&y<p.y+(p.span_h??1));
export function reachableDistrict(f){
 const blocked=new Set(f.fixtures.filter(p=>p.solid!==false).flatMap(footprint).map(p=>p.x+','+p.y));
 const seen=new Set(),queue=[f.spawn];
 for(let n=0;n<queue.length;n++){const p=queue[n],key=p.x+','+p.y;if(seen.has(key)||p.x<0||p.y<0||p.x>=f.width||p.y>=f.height||f.walls[p.y][p.x]||blocked.has(key))continue;seen.add(key);queue.push({x:p.x-1,y:p.y},{x:p.x+1,y:p.y},{x:p.x,y:p.y-1},{x:p.x,y:p.y+1});}
 return seen;
}
export function generateDistrict(definition,window,data=districtData){
 const {width,height}=data;if(width!==50||height!==50||!Number.isInteger(data.scenery_count)||data.scenery_count<12||data.scenery_count>100)throw Error('Monthly districts require 50x50 maps and 12-100 scenery pieces.');
 const rnd=seeded(`${definition.hub}:${window.edition}:district:${data.version}`),cx=25,cy=25,castle=definition.style==='castle',city=definition.style==='nightlife';
 const f={width,height,name:definition.name,spawn:{x:48,y:25},exit:{x:49,y:24,w:1,h:2,style:'gap',side:'right'},district:{edition:window.edition,resetsAt:window.ends,style:definition.style,tileset:definition.tileset},walls:Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>castle||x===0||y===0||x===49||y===49?1:0)),floors:Array.from({length:height},()=>Array(width).fill(0)),fixtures:[],rooms:[]};
 const carve=(x,y)=>{if(x>0&&y>0&&x<49&&y<49)f.walls[y][x]=0;};
 if(castle){
  for(const ry of [10,25,40])for(const rx of [10,25,40]){const w=9+rnd(5),h=9+rnd(5),r={x:rx-Math.floor(w/2),y:ry-Math.floor(h/2),w,h};f.rooms.push(r);for(let y=r.y;y<r.y+h;y++)for(let x=r.x;x<r.x+w;x++)carve(x,y);}
  for(const axis of [10,25,40])for(let n=10;n<=40;n++)for(let d=-1;d<=1;d++){carve(axis+d,n);carve(n,axis+d);}
 }
 for(let x=39;x<49;x++)for(let y=23;y<=26;y++)carve(x,y);
 f.walls[24][49]=0;f.walls[25][49]=0;
 for(let y=0;y<50;y++)for(let x=0;x<50;x++){
  const road=[10,25,40].some(n=>Math.abs(x-n)<=1||Math.abs(y-n)<=1),plaza=Math.abs(x-cx)<6&&Math.abs(y-cy)<6;
  f.floors[y][x]=castle?(road?2:[1,1,3,5][rnd(4)]):city?(road?1:plaza?6:4+rnd(2)):(road||plaza?8:[3,3,5][rnd(3)]);
 }
 const occupied=new Set(),safe=p=>Math.abs(p.x-48)+Math.abs(p.y-25)<5;
 function place(profile,index,npc=false){
  for(let tries=0;tries<400;tries++){
   const x=npc&&index===0?44:2+rnd(45),y=npc&&index===0?23:2+rnd(45),p={...profile,x,y,id:(npc?'npc-':'scenery-')+index,kind:npc?'npc':'scenery',name:profile.name??'',span_w:profile.span_w??1,span_h:profile.span_h??1};
   const cells=footprint(p);if(cells.some(c=>c.x>=48||c.y>=48||f.walls[c.y][c.x]||occupied.has(c.x+','+c.y)||safe(c)))continue;
   if(!npc&&cells.some(c=>[10,25,40].some(n=>Math.abs(c.x-n)<=1||Math.abs(c.y-n)<=1)))continue;
   f.fixtures.push(p);const seen=reachableDistrict(f),count=f.walls.flat().filter(v=>v===0).length-new Set(f.fixtures.filter(p=>p.solid!==false).flatMap(footprint).map(p=>p.x+','+p.y)).size;
   if(seen.size!==count){f.fixtures.pop();continue;}
   for(const c of cells)occupied.add(c.x+','+c.y);return true;
  }return false;
 }
 definition.npcs.forEach((npc,i)=>{if(!place({...npc,solid:true},i,true))throw Error('No reachable place for district NPC');});
 for(let i=0;i<data.scenery_count;i++)place(definition.scenery[rnd(definition.scenery.length)],i);
 if(f.fixtures.filter(p=>p.kind==='scenery').length<12)throw Error('District scenery is too sparse');
 return f;
} // Native castle rooms and town/city streets share connected, safe entrances and inert monthly fixtures.

export function createHubDistricts(db,{now=Date.now,data=districtData}={}){
 db.exec('CREATE TABLE IF NOT EXISTS hub_district_editions(zone TEXT NOT NULL,edition TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(zone,edition)); CREATE TABLE IF NOT EXISTS hub_district_current(zone TEXT PRIMARY KEY,edition TEXT NOT NULL);');
 const cache=new Map();
 function ensure(def){
  const id=def.hub+'-garden',window=monthlyWindow(now(),data.reset_hour),cached=cache.get(id);if(cached?.district.edition===window.edition)return cached;
  const row=db.prepare('SELECT content FROM hub_district_editions WHERE zone=? AND edition=?').get(id,window.edition);
  const f=row?JSON.parse(row.content):generateDistrict(def,window,data);
  if(!row)db.prepare('INSERT INTO hub_district_editions VALUES (?,?,?)').run(id,window.edition,JSON.stringify(f));
  const current=db.prepare('SELECT edition FROM hub_district_current WHERE zone=?').get(id);
  if(current?.edition!==window.edition){
   db.prepare('UPDATE quest_presence SET x=?,y=?,moved=? WHERE zone=?').run(f.spawn.x,f.spawn.y,now(),id);
   db.prepare('INSERT INTO hub_district_current VALUES (?,?) ON CONFLICT(zone) DO UPDATE SET edition=excluded.edition').run(id,window.edition);
  } // Move visitors to the unchanged entry path when the month changes, preserving their character, inventory and needs turn.
  cache.set(id,f);return f;
 }
 function refresh(){for(const d of data.districts)ensure(d);}
 function resolve(base){const def=data.districts.find(d=>base.id===d.hub+'-garden');return def?{...base,...ensure(def)}:base;}
 return {refresh,resolve};
} // Materialized monthly editions survive service restarts and mid-month content deployments.
