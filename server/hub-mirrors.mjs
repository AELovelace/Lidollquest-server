// Wardrobe mirrors: every hub room with beds (inns, dormitories, pods) gets one vanity mirror, where saving a new
// Sprite Lab look is free (zones.mjs `look`; elsewhere it costs one diamond). Placed like the crafting stations: on a
// reachable 2x2 spot near the beds that keeps every previously reachable floor tile reachable and stays clear of
// doorways, the spawn and other fixtures. Geometry is cached per layout, so snapshots never repeat the flood fill.
import {reachableTiles} from './crafting-service.mjs';

const cache=new Map(); // layout key -> mirror fixture (or null when the room has no room for one).
export const MIRROR_SPRITE='sprPQDetailVanity'; // Princess' Quarters vanity: 64x64 art over a 2x2 footprint.

function fits(z,x,y,original){ // A 2x2 solid at (x,y) must sit on open floor and leave the rest of the room connected.
 const fixtures=z.fixtures??[],protectedPoints=[z.spawn,z.entrance,z.exit,...(z.portals??[]),...(z.exits??[])].filter(Boolean);
 const cells=[[x,y],[x+1,y],[x,y+1],[x+1,y+1]],open=new Set(original.map(p=>p.x+','+p.y));
 if(!cells.every(([cx,cy])=>open.has(cx+','+cy)))return false; // Every footprint tile is ordinary reachable floor.
 if(cells.some(([cx,cy])=>protectedPoints.some(p=>Math.abs(p.x-cx)+Math.abs(p.y-cy)<=2)||fixtures.some(f=>Math.abs(f.x-cx)+Math.abs(f.y-cy)<=1)))return false; // Keep doorways and other services clear.
 const after=new Set(reachableTiles({...z,fixtures:[...fixtures,{x,y,span_w:2,span_h:2,solid:true}]}).map(p=>p.x+','+p.y));
 return original.every(p=>cells.some(([cx,cy])=>cx===p.x&&cy===p.y)||after.has(p.x+','+p.y)); // Nothing else is cut off.
}

export function hubMirrors(z){
 const fixtures=z.fixtures??[];
 if(!fixtures.some(f=>f.kind==='bed')||fixtures.some(f=>f.kind==='mirror'))return z; // Only bedrooms, and never twice.
 const key=z.id+':'+(z.district?.layoutKey??'')+':'+JSON.stringify(fixtures.map(f=>[f.id,f.x,f.y,f.kind]));
 if(!cache.has(key)){
  const anchor=fixtures.find(f=>f.kind==='bed'),original=reachableTiles(z);
  const spot=original.slice().sort((a,b)=>Math.abs(a.x-anchor.x)+Math.abs(a.y-anchor.y)-Math.abs(b.x-anchor.x)-Math.abs(b.y-anchor.y)||a.y-b.y||a.x-b.x).find(p=>fits(z,p.x,p.y,original));
  if(cache.size>200)cache.clear();
  cache.set(key,spot?{id:'wardrobe-mirror',kind:'mirror',name:'Vanity Mirror',sprite:MIRROR_SPRITE,x:spot.x,y:spot.y,span_w:2,span_h:2,solid:true}:null);
 }
 const mirror=cache.get(key);
 return mirror?{...z,fixtures:[...fixtures,{...mirror}]}:z;
}
