// Emberfall Caldera features: steam vents round the crater rim, hot springs out in the cooler fields, the heat zone and the
// eruption schedule. The client reads floor.crater / floor.heat for heat (thirst per step, sweat hides accidents) and the
// snapshot's dive.eruption for the rumble / eruption (a startle near a vent). The service owns the hot-spring soak (dive_soak).
import {seeded,walkable,inside} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';

const key=(x,y)=>x+','+y;
export const beside=(d,p)=>p.x>=d.x-1&&p.x<=d.x+(d.span_w??1)&&p.y>=d.y-1&&p.y<=d.y+(d.span_h??1)&&!((p.x===d.x-1||p.x===d.x+(d.span_w??1))&&(p.y===d.y-1||p.y===d.y+(d.span_h??1))); // Orthogonally next to a footprint (not diagonal).
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'dive_action_failed'});};

export function addCalderaFeatures(f,features){ // Idempotent: generation and live editions both call it through upgradeFloor; returns true only when it changed the floor.
 if(!features||f.calderaFeatures||!f.crater)return false;
 const rnd=seeded(`${f.route}:${f.edition}:caldera-features:v1`),c=f.crater,rim=c.r+(features.rim??4); // Its own stream, so layout and content rolls never shift.
 const taken=new Set([...f.enemies,...f.enemies.map(e=>e.spawn).filter(Boolean),...f.chests,...(f.pickups??[]),...f.exits,f.entrance,...Object.values(f.entries??{})].filter(Boolean).map(p=>key(p.x,p.y)));
 const safe=(x,y)=>(f.safeRooms??[]).some(r=>inside(r,x,y));
 const place=(x,y,span,extra)=>{ // Solid scenery with a free ring to stand in; never seals content or a crossing.
  const ring=[];for(let dy=-1;dy<=span;dy++)for(let dx=-1;dx<=span;dx++)ring.push({x:x+dx,y:y+dy});
  if(ring.some(p=>!walkable(f,p.x,p.y)||taken.has(key(p.x,p.y))||safe(p.x,p.y)))return false;
  const cells=[];for(let dy=0;dy<span;dy++)for(let dx=0;dx<span;dx++)cells.push({x:x+dx,y:y+dy});
  for(const p of cells)f.props[p.y][p.x]=1;
  try{validateDesert(f);}catch{for(const p of cells)f.props[p.y][p.x]=0;return false;}
  for(const p of ring)taken.add(key(p.x,p.y));
  f.decorations.push({span_w:span,span_h:span,solid:true,x,y,...extra});return true;
 };
 let vents=0;
 for(let attempt=0;attempt<800&&vents<(features.vents??0);attempt++){ // Vents hug the rim road, spread round the crater.
  const a=rnd(360)*Math.PI/180,d=rim+rnd(4),x=Math.round(c.x+Math.cos(a)*d),y=Math.round(c.y+Math.sin(a)*d);
  if(f.decorations.some(v=>v.vent&&Math.hypot(v.x-x,v.y-y)<8))continue;
  if(place(x,y,1,{id:'vent-'+vents,sprite:features.vent_sprite??'sprCalderaVent',vent:true}))vents++;
 }
 let springs=0;const span=features.spring?.span??2;
 for(let attempt=0;attempt<800&&springs<(features.springs??0);attempt++){ // Hot springs sit out in the cooler fields, away from the lava.
  const room=f.rooms[rnd(f.rooms.length)];if(!room)continue;
  const x=room.x+rnd(Math.max(1,room.w-span)),y=room.y+rnd(Math.max(1,room.h-span));
  if(Math.hypot(x-c.x,y-c.y)<c.r+(features.heat_reach??14)-2)continue; // Out of the worst heat.
  if(f.decorations.some(s=>s.spring&&Math.hypot(s.x-x,s.y-y)<16))continue;
  if(place(x,y,span,{id:'spring-'+springs,sprite:features.spring?.sprite??'sprCalderaHotSpring',spring:true}))springs++;
 }
 f.heat={x:c.x,y:c.y,radius:c.r+(features.heat_reach??14)}; // Inside this radius you are overheated: thirst per step, sweat hides accidents.
 f.calderaFeatures=true;f.geometryVersion=(f.geometryVersion??0)+1;
 return true;
}

export function eruptionAt(route,cfg,time){ // Deterministic eruptions: every period_minutes the vents rumble for rumble_seconds, then erupt for erupt_seconds.
 if(!cfg)return {state:'calm',until:0};
 const period=Math.max(1,cfg.period_minutes??8)*60000,erupt=(cfg.erupt_seconds??30)*1000,rumble=(cfg.rumble_seconds??40)*1000;
 const offset=seeded(`${route}:eruption`)(period),phase=(time+offset)%period,calmEnd=period-erupt-rumble;
 if(phase<calmEnd)return {state:'calm',until:time+(calmEnd-phase)};
 if(phase<calmEnd+rumble)return {state:'rumble',until:time+(calmEnd+rumble-phase)};
 return {state:'erupting',until:time+(period-phase)};
}

export function soakInSpring(f,p,loadout,features,now,cooldowns){ // dive_soak: full stamina, but the warmth relaxes everything (timed incontinence via forced_inco_turns). Returns log lines.
 const spring=f.decorations.find(d=>d.spring&&beside(d,p));
 if(!spring)fail('Stand at the edge of a hot spring to soak.');
 const s=features?.spring??{},wait=Math.max(0,s.cooldown_seconds??90)*1000,last=cooldowns[spring.id]; // undefined: never soaked here.
 if(Number.isFinite(last)&&now-last<wait)fail('You are still pink from the last soak. Give it '+Math.ceil((wait-(now-last))/1000)+' more seconds.');
 cooldowns[spring.id]=now;
 const i=loadout.player_info,num=v=>Number.isFinite(Number(v))?Number(v):0,before=num(i.stamina);
 i.stamina=num(i.stamina_max)||100;
 const relax=s.incontinence??250,turns=s.relax_turns??30;
 if(num(i.forced_inco_turns)>0)i.forced_inco_turns=Math.max(num(i.forced_inco_turns),turns); // Already loosened: the warmth just lasts longer.
 else {i.forced_inco_old_inco=num(i.incontinence);i.incontinence=Math.min(1000,num(i.incontinence)+relax);i.forced_inco_turns=turns;} // The same timer the hospital vaccine uses; it restores the old value when it ends.
 i.forced_inco_source='spring'; // The client words the countdown as the warmth fading.
 return ['You sink into the steaming water and every muscle lets go at once.','Stamina +'+(i.stamina-before)+'.','Everything feels very loose for a while... ('+turns+' turns)'];
}
