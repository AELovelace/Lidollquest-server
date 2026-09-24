import {seeded} from './dive-generation.mjs';

const key=p=>p.x+','+p.y;
const covers=(p,x,y)=>x>=p.x&&y>=p.y&&x<p.x+(p.span_w??1)&&y<p.y+(p.span_h??1);
const open=(f,x,y)=>x>0&&y>0&&x<f.width-2&&y<f.height-2&&!f.walls[y][x]&&!f.fixtures.some(p=>p.solid!==false&&covers(p,x,y));
const entry=(f,x,y)=>{const cy=Math.floor(f.height/2);return y>=cy-3&&y<=cy+2&&(x>=f.width-8||(f.district?.lobby===true&&x<=7));}; // Gate strips: the east entry everywhere, plus the west entry of a lobby town.
const steps=[[0,1,0],[0,-1,1],[1,0,2],[-1,0,3]];

export function addDistrictResidents(f,definition,data,players=[]){
 const version=data.resident_version??0;
 if((f.district.residentVersion??0)>=version)return false;
 const rnd=seeded(`${definition.hub}:${f.district.layoutKey}:residents:${version}`);
 for(const profile of definition.npcs.filter(n=>n.roaming)){
  if(f.fixtures.some(n=>n.id===profile.id))continue; // Existing residents retain their positions and identity through content upgrades.
  const cells=[];
  for(let y=2;y<f.height-2;y++)for(let x=2;x<f.width-2;x++){
   if(!open(f,x,y)||entry(f,x,y)||f.fixtures.some(n=>covers(n,x,y))||players.some(p=>p.x===x&&p.y===y)||(f.doorsteps??[]).some(d=>Math.abs(d.x-x)+Math.abs(d.y-y)<=1))continue; // Never home a wanderer on a storefront doorstep.
   if(steps.filter(([dx,dy])=>open(f,x+dx,y+dy)).length<3)continue;
   cells.push({x,y});
  }
  if(!cells.length)throw Error('No safe place for district resident '+profile.id);
  const home=cells[rnd(cells.length)];
  f.fixtures.push({...profile,kind:'npc',...home,home:{...home},span_w:1,span_h:1,solid:false,facing:0}); // Passable residents never close a corridor or change click-path collision.
 }
 f.district.residentVersion=version;return true;
} // Add people with an independent seed, preserving every existing wall, furnishing and entry position.

export function moveDistrictResidents(f,players,time,data){
 const interval=data.roam_interval_ms??3000;
 if(!players.length||time-(f.residentTickAt??0)<interval)return false;
 f.residentTickAt=time;let changed=false;
 const occupied=new Set(f.fixtures.filter(n=>n.kind==='npc').map(key));
 for(const npc of f.fixtures.filter(n=>n.kind==='npc'&&n.roaming)){
  if(players.some(p=>Math.abs(p.x-npc.x)+Math.abs(p.y-npc.y)<=2))continue; // Stop before a player reaches interaction range, including while their dialogue is open.
  const radius=npc.roam_radius??data.roam_radius??8,home=npc.home??npc;
  const choices=steps.filter(([dx,dy])=>{
   const x=npc.x+dx,y=npc.y+dy;
   return open(f,x,y)&&!entry(f,x,y)&&!(f.doorsteps??[]).some(d=>d.x===x&&d.y===y)&&Math.abs(x-home.x)+Math.abs(y-home.y)<=radius&&!occupied.has(x+','+y)&&!players.some(p=>p.x===x&&p.y===y);
  });
  if(!choices.length)continue;
  const forward=choices.find(s=>s[2]===npc.facing);if(forward)choices.push(forward); // A slight forward preference makes a stroll less jittery than pure random turns.
  const rnd=seeded(`${f.district.layoutKey}:${npc.id}:${Math.floor(time/interval)}`),choice=rnd(choices.length+1);
  if(choice===choices.length)continue; // Occasional pauses let the square breathe.
  const [dx,dy,facing]=choices[choice];occupied.delete(key(npc));npc.x+=dx;npc.y+=dy;npc.facing=facing;occupied.add(key(npc));changed=true;
 }
 return changed;
} // One shared server clock drives every visitor's NPC positions; missed ticks never trigger catch-up teleports.
