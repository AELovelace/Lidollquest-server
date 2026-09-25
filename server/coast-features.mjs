// Seafoam Coast features: striped beach changing huts along the shoreline (private places to go), cover for the Dignity rule,
// and the tide schedule. The beach is public (floor.exposed, like the Plains): only the huts and the rocks give shelter.
// Tide flats are the sand within tide.reach tiles of the shoreline (floor.shore, per row); the client floods them at high tide.
import {seeded,walkable,inside} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';
import {COVER} from './plains-features.mjs';

const key=(x,y)=>x+','+y;

export function isTideFlat(f,x,y,reach){ // Sand near the water: floods at high tide. Same rule as the client (online_coast_flat).
 const shore=f.shore?.[y];return shore!=null&&walkable(f,x,y)&&x>=shore-reach&&x<shore;
}

export function addCoastFeatures(f,features){ // Idempotent: generation and live editions both call it through upgradeFloor; returns true only when it changed the floor.
 if(!features||f.cover)return false;
 const rnd=seeded(`${f.route}:${f.edition}:coast-features:v1`); // Its own stream, so layout and content rolls never shift.
 const reach=features.tide?.reach??3,hut=features.hut??{},span=Math.max(1,hut.span??2);
 const taken=new Set([...f.enemies,...f.enemies.map(e=>e.spawn).filter(Boolean),...f.chests,...(f.pickups??[]),...f.exits,f.entrance,...Object.values(f.entries??{})].filter(Boolean).map(p=>key(p.x,p.y)));
 const safe=(x,y)=>(f.safeRooms??[]).some(r=>inside(r,x,y));
 const huts=[],fits=(x,y)=>{ // A hut needs dry, empty sand all round (a free ring to stand in), clear of the flats, content and trail mouths.
  for(let dy=-1;dy<=span;dy++)for(let dx=-1;dx<=span;dx++){const cx=x+dx,cy=y+dy;if(!walkable(f,cx,cy)||taken.has(key(cx,cy))||safe(cx,cy)||isTideFlat(f,cx,cy,reach))return false;}
  return true;
 };
 const candidates=[];
 for(let y=2;y<f.height-2-span;y++){const shore=f.shore?.[y];if(shore==null)continue;for(let x=shore-reach-span-1;x>=Math.max(2,shore-reach-span-24);x--)if(fits(x,y)){candidates.push({x,y});break;}} // The seaward-most dry spot on each row (up to 24 tiles back on a rocky shore): huts line the beach.
 for(let pick=0;pick<candidates.length*2&&huts.length<(features.huts??0);pick++){
  const {x,y}=candidates[rnd(candidates.length)];
  if(huts.some(h=>Math.abs(h.y-y)<10)||!fits(x,y))continue; // Spread north to south; earlier huts may have taken the ring.
  const cells=[];for(let dy=0;dy<span;dy++)for(let dx=0;dx<span;dx++)cells.push({x:x+dx,y:y+dy});
  for(const c of cells)f.props[c.y][c.x]=1;
  try{validateDesert(f);}catch{for(const c of cells)f.props[c.y][c.x]=0;continue;} // Never seal loot, a monster or a crossing.
  for(let dy=-1;dy<=span;dy++)for(let dx=-1;dx<=span;dx++)taken.add(key(x+dx,y+dy));
  const h={id:'hut-'+huts.length,sprite:hut.sprite??'sprCoastBeachHut',span_w:span,span_h:span,solid:true,x,y,toilet:true,style:'cabana'};huts.push(h);f.decorations.push(h);
 }
 for(const y of [...new Set(candidates.map(c=>c.y))])if(huts.length<(features.huts??0)){const c=candidates.find(v=>v.y===y);if(c&&!huts.some(h=>Math.abs(h.y-c.y)<10)&&fits(c.x,c.y)){ // Deterministic sweep fills any hut the random picks missed.
  const cells=[];for(let dy=0;dy<span;dy++)for(let dx=0;dx<span;dx++)cells.push({x:c.x+dx,y:c.y+dy});
  for(const v of cells)f.props[v.y][v.x]=1;
  try{validateDesert(f);}catch{for(const v of cells)f.props[v.y][v.x]=0;continue;}
  for(let dy=-1;dy<=span;dy++)for(let dx=-1;dx<=span;dx++)taken.add(key(c.x+dx,c.y+dy));
  const h={id:'hut-'+huts.length,sprite:hut.sprite??'sprCoastBeachHut',span_w:span,span_h:span,solid:true,x:c.x,y:c.y,toilet:true,style:'cabana'};huts.push(h);f.decorations.push(h);
 }}
 const shelter=new Set(); // Crouch beside a hut or a rock and nobody on the beach can see you; the open sand is exposed.
 for(const d of f.decorations)if(d.solid!==false)for(let dy=-1;dy<=d.span_h;dy++)for(let dx=-1;dx<=d.span_w;dx++){
  const x=d.x+dx,y=d.y+dy,corner=(dx===-1||dx===d.span_w)&&(dy===-1||dy===d.span_h);if(!corner&&walkable(f,x,y))shelter.add(key(x,y));
 }
 f.cover=Array.from({length:f.height},(_,y)=>Array.from({length:f.width},(_,x)=>shelter.has(key(x,y))?COVER.SHELTER:COVER.OPEN).join(''));
 f.exposed=true;f.geometryVersion=(f.geometryVersion??0)+1;
 return true;
}

export function tideAt(route,tide,time){ // Deterministic tides: high for half of each period, low for the other half. Same answer for everyone.
 if(!tide)return {high:false,until:0};
 const period=Math.max(2,tide.period_minutes??12)*60000,offset=seeded(`${route}:tide`)(period),phase=(time+offset)%period,half=period/2; // A per-route offset so neighbouring coasts don't turn together.
 return phase<half?{high:true,until:time+(half-phase)}:{high:false,until:time+(period-phase)};
}
