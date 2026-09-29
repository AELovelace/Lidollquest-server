// Drifting Pink Smoke: puffy pink clouds that form, drift across an overworld and thin away.
// Every cloud is a pure function of (route, floor, config, time), exactly like rain, tides and eruptions:
// nothing is stored or ticked, every worker gives the same answer, and the client ages the clouds with serverTime.
// Standing in a dense cloud counts as Pink Mist for the move's needs turn (dive.mjs sets worldTurnDue.mist).
import {seeded} from './dive-generation.mjs';
import {mistData} from './dive-mist.mjs';

const minutes=60000;
export const SMOKE_FORM=0.2,SMOKE_FADE=0.3; // First 20% of a cloud's life it gathers; last 30% it thins away. The client mirrors these.
export const SMOKE_FIELDS={ // GM-editable keys with their allowed ranges (world-content.mjs validates against this table).
 clouds:[0,24,true],life_minutes:[1,60,false],gap_minutes:[0,60,false],speed_min:[0,30,false],speed_max:[0,30,false],
 radius_min:[1,12,false],radius_max:[1,12,false],wind_deg:[0,359,true],wind_spread_deg:[0,180,true],cover_threshold:[0.05,1,false],entrance_radius:[0,12,true]
};

export function smokeConfig(zoneId,policy=mistData){ // Shipped per-zone tuning merged over the defaults; null when the zone never gets smoke.
 const s=policy.smoke,zone=s?.zones?.[zoneId];if(!zone)return null;
 return {...s.defaults,...zone,enabled:!!s.enabled&&(zone.enabled??s.defaults?.enabled??true)};
}

const round=n=>Math.round(n*100)/100; // Two decimals keeps the snapshot small and hands server and client the very same numbers.
const unit=rnd=>rnd(1000000)/1000000; // seeded() yields integers; this turns one into 0..1.
const period=cfg=>Math.max(1,(Number(cfg.life_minutes)+Math.max(0,Number(cfg.gap_minutes)||0))*minutes); // One slot's full cycle: life then gap.

function spawnTile(floor,cfg,rnd){ // Open floor, away from exits and arrivals so nobody steps through a portal into fresh smoke.
 const avoid=[floor.entrance,...Object.values(floor.entries??{}),...(floor.exits??[])].filter(Boolean),reach=cfg.entrance_radius??3;
 let pick={x:rnd(floor.width),y:rnd(floor.height)};
 for(let tries=0;tries<12;tries++){
  const x=rnd(floor.width),y=rnd(floor.height);pick={x,y};
  if(floor.walls[y]?.[x]===0&&!avoid.some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=reach))return pick;
 }
 return pick; // A cramped map still gets its cloud; it simply spawns on the last candidate.
}

const memo=new Map(); // `${route}|${edition}|${cfg}|${slot}|${cycle}` -> cloud; clouds are pure, so caching only saves hashing.
function cloudFor(route,floor,cfg,slot,cycle,edition,cfgKey){
 const key=`${route}|${edition}|${cfgKey}|${slot}|${cycle}`;const hit=memo.get(key);if(hit)return hit;
 const rnd=seeded(`${route}:smoke:${slot}:${cycle}`),span=period(cfg),born=cycle*span-seeded(`${route}:smoke:${slot}`)(span);
 const spot=spawnTile(floor,cfg,rnd),heading=(Number(cfg.wind_deg)+(unit(rnd)*2-1)*Number(cfg.wind_spread_deg))*Math.PI/180;
 const speed=Number(cfg.speed_min)+unit(rnd)*Math.max(0,Number(cfg.speed_max)-Number(cfg.speed_min)); // Tiles per minute.
 const radius=Number(cfg.radius_min)+unit(rnd)*Math.max(0,Number(cfg.radius_max)-Number(cfg.radius_min));
 const lobes=[[0,0,round(radius*0.7)]];for(let n=2+rnd(3),i=0;i<n;i++){ // A core puff plus 2-4 side puffs make each cloud lumpy.
  const a=unit(rnd)*Math.PI*2,d=radius*(0.3+unit(rnd)*0.3);lobes.push([round(Math.cos(a)*d),round(Math.sin(a)*d),round(radius*(0.45+unit(rnd)*0.3))]);
 }
 const cloud={id:`${slot}:${cycle}`,born,dies:born+Math.round(Number(cfg.life_minutes)*minutes),x:spot.x,y:spot.y,vx:round(Math.cos(heading)*speed),vy:round(-Math.sin(heading)*speed),lobes}; // wind_deg 0 = east, 90 = north (screen y grows down).
 if(memo.size>512)memo.clear();memo.set(key,cloud);return cloud;
}

export function smokeDensity(cloud,time){ // {density 0..1, size multiplier}: gathers, holds, then swells and thins away.
 const u=(time-cloud.born)/Math.max(1,cloud.dies-cloud.born);
 if(u<0||u>1)return {density:0,size:0};
 if(u<SMOKE_FORM){const k=u/SMOKE_FORM;return {density:k,size:0.5+0.5*k};}
 if(u>1-SMOKE_FADE){const k=(1-u)/SMOKE_FADE;return {density:k,size:1+0.3*(1-k)};}
 return {density:1,size:1};
}

export function smokeCovers(cloud,cfg,time,x,y){ // Coverage rule shared with the client: tile centre inside a lobe, and the cloud dense enough to breathe.
 const {density,size}=smokeDensity(cloud,time);if(density<(cfg.cover_threshold??0.35))return false;
 const age=(time-cloud.born)/minutes,cx=cloud.x+cloud.vx*age,cy=cloud.y+cloud.vy*age;
 return cloud.lobes.some(([dx,dy,r])=>{const ex=x-(cx+dx),ey=y-(cy+dy),reach=r*size;return ex*ex+ey*ey<=reach*reach;});
}

function slots(cfg){return cfg?.enabled&&Number(cfg.clouds)>0&&Number(cfg.life_minutes)>0?Math.floor(Number(cfg.clouds)):0;}

export function smokeClouds(route,floor,cfg,time,edition=''){ // The current and next cloud of every slot, so the client always holds the upcoming one between snapshots.
 const count=slots(cfg);if(!count)return [];
 const span=period(cfg),cfgKey=JSON.stringify(cfg),out=[];
 for(let slot=0;slot<count;slot++){
  const cycle=Math.floor((time+seeded(`${route}:smoke:${slot}`)(span))/span);
  out.push(cloudFor(route,floor,cfg,slot,cycle,edition,cfgKey),cloudFor(route,floor,cfg,slot,cycle+1,edition,cfgKey));
 }
 return out.filter(c=>c.dies>time); // A slot resting in its gap only sends the cloud still to come.
}

export function smokeView(route,floor,cfg,time,edition=''){ // Snapshot field: dive.smoke.
 return {threshold:cfg.cover_threshold??0.35,form:SMOKE_FORM,fade:SMOKE_FADE,clouds:smokeClouds(route,floor,cfg,time,edition)};
}

export function smokeAt(route,floor,cfg,time,x,y,edition=''){ // True when a move onto (x,y) right now breathes a dense cloud.
 return smokeClouds(route,floor,cfg,time,edition).some(c=>smokeCovers(c,cfg,time,x,y));
}
