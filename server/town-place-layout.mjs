// Place-owned geometry is applied by copy, so moving a parcel never leaves old walls behind.
import {validateCourtyard} from './hub-garden.mjs';
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'town_place_conflict'});};
const contains=(r,p)=>p.x>=r.x&&p.y>=r.y&&p.x<r.x+r.w&&p.y<r.y+r.h;
const cells=r=>Array.from({length:r.h},(_,y)=>Array.from({length:r.w},(_,x)=>({x:r.x+x,y:r.y+y}))).flat();
export const placeZone=(place,key)=>key==='town'?place.home:place.rooms.find(r=>r.roomKey===key)?.id;
export function placeConnections(place){
 const links=(place.connections??[]).map(c=>({...c,a:{...c.a},b:{...c.b}}));
 if(place.exterior&&place.rooms.length){
  const r=place.rooms[0],e=place.exterior;
  links.unshift({id:'entrance',a:{zone:'town',x:e.x+Math.floor(e.w/2),y:e.y+e.h,arrival:{x:e.x+Math.floor(e.w/2),y:e.y+e.h+1}},b:{zone:r.roomKey,x:r.exit.x,y:r.exit.y,w:r.exit.w,h:r.exit.h,side:r.exit.side,arrival:r.spawn},defaultFor:r.roomKey});
 }
 return links;
} // The facade and its paired doorway share one identity and move together.
export function decoratePlaceZone(base,places){
 const relevant=places.filter(p=>p.home===base.id||p.rooms.some(r=>r.id===base.id));
 if(!relevant.length)return base;
 const f={...base,walls:base.walls?.map(r=>[...r]),floors:base.floors?.map(r=>[...r]),wallTiles:base.wallTiles?.map(r=>[...r]),decorTiles:base.decorTiles?.map(r=>[...r]),fixtures:[...(base.fixtures??[])],placePortals:[],placeAnchors:[],places:[]};
 for(const p of relevant){
  if(p.home===base.id&&p.exterior){
   const e=p.exterior,reservation={x:e.x,y:e.y,w:e.w,h:e.h+2};
   if(f.places.some(other=>cells(reservation).some(c=>contains({x:other.x,y:other.y,w:other.w,h:other.h+2},c))))fail(p.name+': reserved parcels overlap.');
   if(e.x<1||e.y<1||e.x+e.w>=f.width-1||e.y+e.h+2>=f.height-1)fail(p.name+': parcel and approach must fit inside the town.');
   if(contains(reservation,f.spawn))fail(p.name+': parcel overlaps town arrival.');
   const occupied=f.fixtures.filter(v=>cells({x:v.x,y:v.y,w:v.span_w??1,h:v.span_h??1}).some(c=>contains(reservation,c)));
   if(occupied.some(v=>!v.id?.startsWith('patch-')&&(v.kind!=='scenery'||v.placeId||/Tower|Workshop|Pod|Inn|Temple|Shop|Bank|Chapel|Church|Building/i.test(v.sprite??''))))fail(p.name+': parcel overlaps a resident, service, or protected building.');
   // Loose scenery may yield to a reserved parcel; service fixtures and residents must be preserved.
   f.fixtures=f.fixtures.filter(v=>!occupied.includes(v)||v.id?.startsWith('patch-')); // Keep deliberate GM furnishings inside walk-in buildings and POIs.
   for(const c of cells(reservation)){f.walls[c.y][c.x]=0;if(f.floors)f.floors[c.y][c.x]=p.type==='poi'?9:6;if(f.wallTiles)f.wallTiles[c.y][c.x]=0;}
   if(p.type==='interior')f.fixtures.push({id:'place-facade-'+p.id,placeId:p.id,kind:'scenery',name:p.name,sprite:e.sprite??'sprUtopiaWorkshop',x:e.x,y:e.y,span_w:e.w,span_h:e.h,solid:true});
   if(p.type==='walkin')for(const c of cells(e)){const edge=c.x===e.x||c.x===e.x+e.w-1||c.y===e.y||c.y===e.y+e.h-1,door=c.x===e.x+Math.floor(e.w/2)&&c.y===e.y+e.h-1;f.walls[c.y][c.x]=edge&&!door?1:0;if(f.wallTiles)f.wallTiles[c.y][c.x]=edge&&!door?15:0;}
   for(const c of e.cells??[]){const x=e.x+c.x,y=e.y+c.y;if(c.wall!==undefined)f.walls[y][x]=c.wall;if(c.floor!==undefined&&f.floors)f.floors[y][x]=c.floor;if(c.wallTile!==undefined&&f.wallTiles)f.wallTiles[y][x]=c.wallTile;if(c.decor!==undefined&&f.decorTiles)f.decorTiles[y][x]=c.decor;}
   f.places.push({id:p.id,name:p.name,type:p.type,...e});
  }
  for(const a of p.anchors??[])if(placeZone(p,a.zone)===base.id)f.placeAnchors.push({...a,id:'place:'+p.id+':'+a.id});
  for(const c of placeConnections(p))for(const [from,to] of [[c.a,c.b],[c.b,c.a]]){
   if(placeZone(p,from.zone)!==base.id)continue;
   const portal={x:from.x,y:from.y,w:from.w??1,h:from.h??1,side:from.side,style:from.side?'gap':'door',target:placeZone(p,to.zone),name:c.name??p.name,connection:p.id+':'+c.id,arrival:{...to.arrival},placeId:p.id};
   if(c.defaultFor===from.zone){f.exit=portal;f.defaultReturn=portal.target;}
   else f.placePortals.push(portal);
  }
 }
 return f;
} // The same door records feed snapshots, player travel, NPC routing, and quest guidance.
export function validatePlaceZone(f,existingDoors=[]){
 for(const a of f.placeAnchors??[])if(f.walls?.[a.y]?.[a.x]!==0||f.fixtures.some(v=>v.solid!==false&&contains({x:v.x,y:v.y,w:v.span_w??1,h:v.span_h??1},a)))fail('Anchor '+a.id+' is blocked.');
 const portals=f.placePortals??[],doors=[...existingDoors,...portals,...(f.exit?[f.exit]:[])];
 for(const p of portals)if(f.walls?.[p.y]?.[p.x]!==0)fail('Door '+p.connection+' is on a blocked tile in '+f.name+'.');
 for(const parcel of f.places??[])for(const d of existingDoors)if(contains({x:parcel.x,y:parcel.y,w:parcel.w,h:parcel.h+2},d))fail(parcel.name+': parcel overlaps an existing entrance.');
 try{validateCourtyard({...f,exit:f.exit??f.spawn,fixtures:f.fixtures.map(v=>({span_w:1,span_h:1,...v}))},doors);}catch(error){fail(f.name+': '+error.message);}
} // A rejected regeneration retains the old edition instead of stranding an interior.
