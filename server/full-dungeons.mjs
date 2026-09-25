import {readFileSync} from 'node:fs';
export const fullDungeonContent=JSON.parse(readFileSync(new URL('./full-dungeons-data.json',import.meta.url),'utf8'));
export const fullDungeons=fullDungeonContent.routes;
export const fullDungeonQuestIds=new Set(Object.keys(fullDungeonContent.quests).map(id=>'full-'+id));
export const fullDungeonLinks=zone=>fullDungeons.flatMap(d=>d.config.endpoints.filter(e=>e.zone===zone).map(e=>({target:d.config.zone_id,name:d.config.name,style:zone==='princess-rose-garden'||zone==='arcadia-foundry'?'stairs':'door',fullDungeon:true})));
export const fullDungeonHome=(destination,route)=>fullDungeons.some(d=>d.config.zone_id===route&&d.config.endpoints.some(e=>e.zone===destination));

export function addFullDungeonEntrances(f,zone,visitors=[]){
 const links=fullDungeonLinks(zone);if(!links.length)return false;
 f.fullDungeonPortals??=[];let changed=false;
 const blocked=(x,y)=>!f.walls[y]||f.walls[y][x]!==0||f.fixtures.some(p=>p.solid!==false&&x>=p.x&&y>=p.y&&x<p.x+(p.span_w??1)&&y<p.y+(p.span_h??1));
 const occupied=(x,y)=>visitors.some(p=>p.x===x&&p.y===y)||f.fixtures.some(p=>x>=p.x&&y>=p.y&&x<p.x+(p.span_w??1)&&y<p.y+(p.span_h??1)); // Additive upgrades cannot build over a visitor, passable resident, or objective fixture.
 const flood=()=>{const q=[f.spawn],seen=new Set();for(let i=0;i<q.length;i++){const p=q[i],k=p.x+','+p.y;if(seen.has(k)||blocked(p.x,p.y))continue;seen.add(k);for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]])q.push({x:p.x+dx,y:p.y+dy});}return seen;};
 for(const link of links){
  if(f.fullDungeonPortals.some(p=>p.target===link.target))continue;
  const reachable=flood(),candidates=[...reachable].map(k=>{const [x,y]=k.split(',').map(Number);return {x,y};}).sort((a,b)=>Math.abs(a.x-f.spawn.x)+Math.abs(a.y-f.spawn.y)-Math.abs(b.x-f.spawn.x)-Math.abs(b.y-f.spawn.y)||a.y-b.y||a.x-b.x);
  let placed=false;
  for(const p of candidates){
   if(p.x<3||p.y<5||p.x>=f.width-3||p.y>=f.height-3)continue;
   const protectedPoints=[f.spawn,f.exit,...(f.doorsteps??[]),...f.fullDungeonPortals];
   if(protectedPoints.some(v=>Math.abs(v.x-p.x)+Math.abs(v.y-p.y)<7))continue;
   if(![[0,0],[-1,0],[1,0],[0,1],[0,2]].every(([dx,dy])=>reachable.has((p.x+dx)+','+(p.y+dy))&&!occupied(p.x+dx,p.y+dy)))continue;
   if(link.style==='door'){
    const cells=[];for(let dy=-3;dy<0;dy++)for(let dx=-1;dx<=1;dx++)cells.push({x:p.x+dx,y:p.y+dy});
    if(cells.some(v=>!reachable.has(v.x+','+v.y)||occupied(v.x,v.y)))continue;
    const building={id:'entrance-'+link.target,kind:'scenery',name:link.name,x:p.x-1,y:p.y-3,span_w:3,span_h:3,solid:true,sprite:zone==='utopia-arcanum'?(link.target==='dungeon-auto-nursery'?'sprUtopiaNapPods':'sprUtopiaTower'):'sprCityFacadeApartment'};
    f.fixtures.push(building);const next=flood();
    if(next.size!==reachable.size-9||f.fixtures.some(v=>v.kind!=='scenery'&&![[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>next.has((v.x+dx)+','+(v.y+dy))))){f.fixtures.pop();continue;}
   }
   f.fullDungeonPortals.push({...link,...p});placed=true;changed=true;break;
  }
  if(!placed)throw Error('No safe entrance for '+link.name+' in '+zone);
 }
 if(changed)f.district.entranceVersion=(f.district.entranceVersion??0)+1;
 return changed;
} // Additive on existing editions: no scenery moves, no map reroll, no claim reset.
