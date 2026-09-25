// Autumnal Plains "nowhere to hide" features: tall-grass cover, sheltered spots beside scenery, village-style wells and seasonal rain showers.
// The client reads floor.cover / floor.exposed (online_dignity_witnessed) and snapshot dive.weather; the service owns the well drink (dive_well).
import {seeded,walkable,inside} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';

export const COVER={OPEN:'0',GRASS:'1',SHELTER:'2'}; // floor.cover rows: open field, tall grass, or tucked beside a haystack/tree/fence.
const key=(x,y)=>x+','+y;

export function addPlainsFeatures(f,features){ // Idempotent: generation and live editions both call it through upgradeFloor; returns true only when it changed the floor.
 if(!features||f.cover)return false;
 const rnd=seeded(`${f.route}:${f.edition}:plains-features:v1`),range=(a,b)=>a+rnd(b-a+1); // Its own stream, so the map's layout and content rolls never shift.
 const taken=new Set([...f.enemies,...f.enemies.map(e=>e.spawn).filter(Boolean),...f.chests,...(f.pickups??[]),...f.exits,f.entrance,...Object.values(f.entries??{})].filter(Boolean).map(p=>key(p.x,p.y)));
 const safe=(x,y)=>(f.safeRooms??[]).some(r=>inside(r,x,y));
 const wells=[],w=features.well??{},span=Math.max(1,w.span??2);
 for(let attempt=0;attempt<300&&wells.length<(features.wells??0);attempt++){ // Wells stand in the open fields (basins), never on a trail mouth, loot or a monster.
  const room=f.rooms[rnd(f.rooms.length)];if(!room||safe(room.x,room.y))continue;
  const x=range(room.x,Math.max(room.x,room.x+room.w-span)),y=range(room.y,Math.max(room.y,room.y+room.h-span)),cells=[];
  for(let dy=0;dy<span;dy++)for(let dx=0;dx<span;dx++)cells.push({x:x+dx,y:y+dy});
  const ring=[];for(let dy=-1;dy<=span;dy++)for(let dx=-1;dx<=span;dx++)ring.push({x:x+dx,y:y+dy}); // Keep a free tile all round so the drinker can stand beside it.
  if(ring.some(c=>!walkable(f,c.x,c.y)||taken.has(key(c.x,c.y))||safe(c.x,c.y)))continue;
  for(const c of cells)f.props[c.y][c.x]=1;
  try{validateDesert(f);}catch{for(const c of cells)f.props[c.y][c.x]=0;continue;} // Never seal loot, a monster or a crossing.
  for(const c of ring)taken.add(key(c.x,c.y));
  const well={id:'well-'+wells.length,sprite:w.sprite??'sprPlainsEnvWell',span_w:span,span_h:span,solid:true,x,y,well:true};wells.push(well);f.decorations.push(well);
 }
 const grass=new Set(); // Tall grass: noisy round patches over open floor, walkable like any field.
 for(let n=0;n<(features.cover_patches??0);n++){
  const room=f.rooms[rnd(f.rooms.length)];if(!room)continue;
  const cx=range(room.x,room.x+room.w-1),cy=range(room.y,room.y+room.h-1),r=range(features.cover_radius_min??2,features.cover_radius_max??4);
  for(let y=cy-r;y<=cy+r;y++)for(let x=cx-r;x<=cx+r;x++){
   const d=Math.hypot(x-cx,(y-cy)*1.2);if(d>r+(rnd(3)-1)*0.6)continue; // Ragged edges, a little wider than tall.
   if(walkable(f,x,y)&&!safe(x,y)&&!f.exits.some(e=>Math.abs(e.x-x)+Math.abs(e.y-y)<=2))grass.add(key(x,y));
  }
 }
 const shelter=new Set(); // Any open tile touching solid scenery (haystacks, trees, fences, wells) is a place to crouch out of sight.
 for(const d of f.decorations)if(d.solid!==false)for(let dy=-1;dy<=d.span_h;dy++)for(let dx=-1;dx<=d.span_w;dx++){
  const x=d.x+dx,y=d.y+dy,corner=(dx===-1||dx===d.span_w)&&(dy===-1||dy===d.span_h);if(!corner&&walkable(f,x,y))shelter.add(key(x,y));
 }
 f.cover=Array.from({length:f.height},(_,y)=>Array.from({length:f.width},(_,x)=>grass.has(key(x,y))?COVER.GRASS:shelter.has(key(x,y))?COVER.SHELTER:COVER.OPEN).join('')); // Compact rows: 80 strings of 80 characters.
 f.exposed=true;f.geometryVersion=(f.geometryVersion??0)+1; // Connected clients redraw the grass and re-read cover.
 return true;
}

export function inCover(f,x,y){return (f.cover?.[y]?.[x]??COVER.OPEN)!==COVER.OPEN;} // Grass or shelter; open field otherwise.

export function weatherAt(route,rain,time){ // Deterministic showers: each slot of slot_minutes rolls one shower of duration_minutes at chance_percent. Same answer on every worker and for every player.
 if(!rain)return {rain:false,until:0};
 const slot=Math.max(1,rain.slot_minutes??20)*60000,length=Math.min(slot,Math.max(1,rain.duration_minutes??6)*60000),index=Math.floor(time/slot),start=index*slot;
 const roll=seeded(`${route}:rain:${index}`),wet=roll(100)<(rain.chance_percent??35),offset=roll(Math.max(1,Math.floor((slot-length)/60000)+1))*60000; // A shower starts on a whole minute inside its slot.
 const from=start+offset,to=from+length;
 if(wet&&time>=from&&time<to)return {rain:true,until:to};
 return {rain:false,until:wet&&time<from?from:start+slot}; // until: the next moment the answer can change.
}

export function drinkFromWell(f,p,loadout,features,now,cooldowns){ // Returns the log lines; throws a player-facing error when the drinker is not beside a ready well.
 const well=f.decorations.find(d=>d.well&&p.x>=d.x-1&&p.x<=d.x+d.span_w&&p.y>=d.y-1&&p.y<=d.y+d.span_h&&!((p.x===d.x-1||p.x===d.x+d.span_w)&&(p.y===d.y-1||p.y===d.y+d.span_h)));
 if(!well)throw Object.assign(Error('Stand beside a well to drink.'),{status:409,code:'dive_action_failed'});
 const w=features?.well??{},wait=Math.max(0,w.cooldown_seconds??45)*1000,last=cooldowns[well.id]; // undefined: never drunk from this well.
 if(Number.isFinite(last)&&now-last<wait)throw Object.assign(Error('You just drank. Give it '+Math.ceil((wait-(now-last))/1000)+' more seconds.'),{status:409,code:'dive_action_failed'});
 cooldowns[well.id]=now;
 const i=loadout.player_info,num=v=>Number.isFinite(Number(v))?Number(v):0,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const thirst=clamp(num(i.thirst)+(w.thirst??120),0,250),wet=clamp(num(i.wet)+(w.wet??20),0,100),stamina=clamp(num(i.stamina)+(w.stamina??25),0,num(i.stamina_max)||100);
 const lines=['You drink deep from the cold well water.'];
 if(thirst>num(i.thirst))lines.push('Thirst +'+(thirst-num(i.thirst))+'.');
 if(stamina>num(i.stamina))lines.push('Stamina +'+(stamina-num(i.stamina))+'.');
 if(wet>num(i.wet))lines.push('It goes straight through you... Bladder +'+(wet-num(i.wet))+'.');
 Object.assign(i,{thirst,wet,stamina});
 return lines;
}
