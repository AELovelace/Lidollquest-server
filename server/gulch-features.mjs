// Echo Gulch features: whisper stones out on the open canyon floors, the flash-flood schedule down the dry wash (floor.wash,
// carved by desert-generation.mjs), and the echo: how many path steps away roaming monsters can hear you. The client reads
// floor.wash and the snapshot's dive.flood / dive.echo; the service owns the whisper-stone listen (dive_listen) and uses
// echoReach() for every player in dive.mjs roam().
import {seeded,walkable,inside} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';
import {beside} from './caldera-features.mjs';
import {loseDignity,smellOf} from './dignity.mjs';
import {outfitLook} from './outfit.mjs';
import {isCrawling} from './crawl.mjs';

const key=(x,y)=>x+','+y;
const num=v=>v===true?1:Number.isFinite(Number(v))?Number(v):0; // Accident fields are counts on new saves and booleans on old ones.

export const inWash=(f,x,y)=>f.wash?.[y]?.[x]==='1'; // Same rule as the client (online_gulch_in_wash).

export function addGulchFeatures(f,features){ // Idempotent: generation and live editions both call it through upgradeFloor; returns true only when it changed the floor.
 if(!features||f.gulchFeatures)return false;
 const rnd=seeded(`${f.route}:${f.edition}:gulch-features:v1`),w=features.whisper??{},sw=Math.max(1,w.span_w??1),sh=Math.max(1,w.span_h??2); // Its own stream, so layout and content rolls never shift.
 const taken=new Set([...f.enemies,...f.enemies.map(e=>e.spawn).filter(Boolean),...f.chests,...(f.pickups??[]),...f.exits,f.entrance,...Object.values(f.entries??{})].filter(Boolean).map(p=>key(p.x,p.y)));
 const safe=(x,y)=>(f.safeRooms??[]).some(r=>inside(r,x,y));
 const open=f.rooms.filter(r=>!r.slot&&!(f.safeRooms??[]).includes(r)); // Stones stand on open canyon floor, never inside a slot-canyon maze or a trail mouth.
 let stones=0;
 for(let attempt=0;attempt<600&&stones<(features.whispers??0)&&open.length;attempt++){
  const room=open[rnd(open.length)],x=room.x+rnd(Math.max(1,room.w-sw)),y=room.y+rnd(Math.max(1,room.h-sh));
  if(f.decorations.some(d=>d.whisper&&Math.hypot(d.x-x,d.y-y)<(w.spacing??14)))continue; // Spread them out across the gulch.
  const ring=[];for(let dy=-1;dy<=sh;dy++)for(let dx=-1;dx<=sw;dx++)ring.push({x:x+dx,y:y+dy}); // A free tile all round, so a listener can stand beside it.
  if(ring.some(p=>!walkable(f,p.x,p.y)||taken.has(key(p.x,p.y))||safe(p.x,p.y)||inWash(f,p.x,p.y)))continue; // Floods would wash a listener away; keep stones on the banks.
  const cells=[];for(let dy=0;dy<sh;dy++)for(let dx=0;dx<sw;dx++)cells.push({x:x+dx,y:y+dy});
  for(const p of cells)f.props[p.y][p.x]=1;
  try{validateDesert(f);}catch{for(const p of cells)f.props[p.y][p.x]=0;continue;} // Never seal loot, a monster or a crossing.
  for(const p of ring)taken.add(key(p.x,p.y));
  f.decorations.push({id:'whisper-'+stones,sprite:w.sprite??'sprGulchWhisperStone',span_w:sw,span_h:sh,solid:true,x,y,whisper:true});stones++;
 }
 f.gulchFeatures=true;f.geometryVersion=(f.geometryVersion??0)+1; // Connected clients redraw the scenery.
 return true;
}

export function floodAt(route,cfg,time){ // Deterministic flash floods: every period_minutes a roar warns for warning_seconds, then the wash floods for flood_seconds.
 if(!cfg)return {state:'dry',until:0};
 const period=Math.max(1,cfg.period_minutes??10)*60000,flood=(cfg.flood_seconds??45)*1000,warning=(cfg.warning_seconds??30)*1000;
 const offset=seeded(`${route}:flood`)(period),phase=(time+offset)%period,dryEnd=period-flood-warning; // A per-route offset, like the tides and eruptions.
 if(phase<dryEnd)return {state:'dry',until:time+(dryEnd-phase)};
 if(phase<dryEnd+warning)return {state:'warning',until:time+(dryEnd+warning-phase)};
 return {state:'flooding',until:time+(period-phase)};
}

export const accidentMark=p=>num(p?.diaper_wet_absorbed)+num(p?.had_wet_accident)+num(p?.diaper_tum_absorbed)+num(p?.had_tum_accident); // Every accident path bumps one of these (the same four the client's online_dignity_witnessed counts).

export function noticeAccident(dive,loadout,echo,time){ // Called on every Gulch action: a new accident since the last one we saw starts the loud echo. Returns true when it just started.
 if(!echo||!dive)return false;
 const mark=accidentMark(loadout?.player_info),before=dive.echoMark;dive.echoMark=mark;
 if(!Number.isFinite(before)||mark<=before)return false; // First visit only records the baseline; a change of clothes (fewer marks) is silent.
 dive.echoUntil=time+Math.max(0,echo.accident_seconds??20)*1000;return true;
}

export function echoReading(state,echo,base,time,items){ // {reach, sounds, crawling, until}: how far monsters hear you in the Gulch and why. reach is in path steps (base = the route's pursuit_steps).
 const p=state?.loadout?.player_info??{},sounds=[];
 if(!echo)return {reach:base,sounds,crawling:false,until:0};
 const look=outfitLook(state.loadout,items);let reach=base;
 if(look.padded){reach+=echo.crinkle??2;sounds.push('crinkling');} // Padding crinkles with every step, hidden or not.
 if(p.slot_wet_panties===true||num(p.diaper_wet_absorbed)>0||num(p.had_wet_accident)>0){reach+=echo.slosh??2;sounds.push('sloshing');} // A soggy diaper or wet clothes squish and slosh.
 if(smellOf(p)>0){reach+=echo.squish??2;sounds.push('squelching');} // A mess you are still wearing.
 const until=Number(state?.dive?.echoUntil)||0;if(until>time){reach+=echo.accident??6;sounds.push('echoing');} // A fresh accident rings off the canyon walls for a while.
 const crawling=isCrawling(state.loadout);if(crawling)reach=reach*(echo.crawl_percent??50)/100; // Sneaking on hands and knees muffles everything.
 return {reach:Math.max(1,Math.min(echo.max_reach??16,Math.round(reach))),sounds,crawling,until:until>time?until:0};
}

export function listenAtStone(f,p,loadout,features,now,cooldowns,items,tuning=null){ // dive_listen: overhear the gossip carried by a whisper stone. If you are visibly wet or messy (or smell), it is about you and costs Dignity. Returns log lines.
 const stone=f.decorations.find(d=>d.whisper&&beside(d,p));
 if(!stone)throw Object.assign(Error('Stand beside a whisper stone to listen.'),{status:409,code:'dive_action_failed'});
 const w=features?.whisper??{},wait=Math.max(0,w.cooldown_seconds??120)*1000,last=cooldowns[stone.id]; // undefined: never listened here.
 if(Number.isFinite(last)&&now-last<wait)return ['Only the wind hisses through the stone now.']; // Quiet, not an error: the client listens automatically as you walk past.
 cooldowns[stone.id]=now;
 const i=loadout.player_info,look=outfitLook(loadout,items),about=look.used||smellOf(i)>0; // "Anyone who noticed" = anything visible or smellable.
 const pool=(about?w.about_you:w.rumours)??[],pick=pool.length?pool[seeded(`${stone.id}:${Math.floor(now/60000)}`)(pool.length)]:''; // The same whisper for everyone at this stone this minute.
 const lines=['You lean close to the stone. A voice from somewhere far down the canyon whispers...'];
 if(pick)lines.push('"'+pick+'"');
 if(about){const lost=loseDignity(i,w.dignity??10,tuning);if(lost>0)lines.push('They are talking about you. Dignity -'+lost+'.');}
 return lines;
}
