// Paints a zone picture square by square with the game's real artwork: terrain from tile-painter.mjs, then scenery,
// then content (chests, pickups, monsters, GM placements, exits, arrival points) and players. Returns a PNG buffer.
// Only the GM panel calls this (GET /gm/map.png and the Map Editor); it is never part of a player snapshot.
import {decodePng,encodePng,createCanvas,blit,fillRect,strokeRect,fillCircle,scaleNearest,downscale} from './png-codec.mjs';
import {tileAt,paintPlan,atlasColumns,tileCell,TILE_SIZE} from './tile-painter.mjs';

export const DEFAULT_LAYERS=Object.freeze(['terrain','scenery','content','players']); // 'grid', 'safe' and 'reach' are opt-in overlays for the editor's downloads.
const BACKGROUND=[22,15,28,255]; // The panel's own dark violet behind cells no atlas paints (tile 0).
const MINT=[127,224,192,255],ROSE=[255,143,196,255],GOLD=[255,220,60,255],AQUA=[128,255,255],YELLOW=[255,255,0],RED=[174,36,61,255],BLUE=[119,187,255,255],WHITE=[255,255,255,255];
const SCENERY_KINDS=new Set(['scenery','toilet','changer','altar','mirror','cauldron','reagents']); // Hub fixtures drawn from their own sprite at their footprint (online_hub_draw).

export function createMapRenderer({tiles={sprites:{},tilesets:{}},compiled={},avatars=[],asset=null,cacheSize=8}={}){
 const widths=Object.fromEntries(Object.entries(tiles.sprites).map(([name,record])=>[name,record.width])); // Atlas widths -> columns for tile-painter.
 const decoded=new Map(),outputs=new Map(),avatarSprite=new Map(avatars.map(a=>[a.id,a.sprite]).filter(([,sprite])=>sprite));
 function image(name){ // Decoded RGBA for a sprite name: shipped tile/scenery art, compiled monster art, or a GM-uploaded managed asset.
  if(typeof name!=='string'||!name)return null;if(decoded.has(name))return decoded.get(name);
  let record=tiles.sprites[name]??compiled[name]??null;if(!record&&asset){try{record=asset(name);}catch{record=null;}}
  let img=null;if(record?.png){try{img={...decodePng(Buffer.from(record.png,'base64')),frames:Math.max(1,record.frames??1),xorigin:record.xorigin??0,yorigin:record.yorigin??0};}catch{img=null;}}
  if(!name.startsWith('managed-'))decoded.set(name,img); // Managed uploads can be replaced; shipped art is immutable for the process lifetime.
  return img;
 }
 const frameOf=img=>({sx:0,sy:0,sw:Math.floor(img.width/img.frames),sh:img.height}); // Frame 0 of a horizontal strip.
 function drawFit(canvas,name,x,y,tint=null){ // online_dive_sprite: scale the sprite to fit one 32px cell, centred (chests, pickups, monsters, tokens, stairs, bins).
  const img=image(name);if(!img)return false;const f=frameOf(img),size=Math.max(f.sw,f.sh),scale=TILE_SIZE/size;
  const crop=createCanvas(f.sw,f.sh);blit(crop,img,0,0,{sx:f.sx,sy:f.sy,sw:f.sw,sh:f.sh});
  const w=Math.max(1,Math.round(f.sw*scale)),h=Math.max(1,Math.round(f.sh*scale)),scaled=scale===1?crop:scaleNearest(crop,w,h);
  blit(canvas,scaled,x*TILE_SIZE+Math.round((TILE_SIZE-w)/2),y*TILE_SIZE+Math.round((TILE_SIZE-h)/2),{tint});return true;
 }
 function drawStanding(canvas,name,x,y){ // Avatars (NPC and merchant fixtures, placed NPCs): frame 0, bottom-centre anchored to the cell's bottom edge.
  const img=image(name);if(!img)return false;const f=frameOf(img);blit(canvas,img,x*TILE_SIZE+Math.round(TILE_SIZE/2-f.sw/2),y*TILE_SIZE+TILE_SIZE-f.sh,f);return true;
 }
 function drawMarker(canvas,x,y,colour,inset=8){fillRect(canvas,x*TILE_SIZE+inset,y*TILE_SIZE+inset,TILE_SIZE-inset*2,TILE_SIZE-inset*2,colour);strokeRect(canvas,x*TILE_SIZE+inset,y*TILE_SIZE+inset,TILE_SIZE-inset*2,TILE_SIZE-inset*2,WHITE);} // Flat square for anything without artwork.
 function paintTerrain(canvas,floor){
  const plan=paintPlan(floor),ctx={plan,tilesets:tiles.tilesets};
  for(let y=0;y<floor.height;y++)for(let x=0;x<floor.width;x++){
   for(const layer of tileAt(floor,x,y,ctx)){
    if(layer.fill){fillRect(canvas,x*TILE_SIZE,y*TILE_SIZE,TILE_SIZE,TILE_SIZE,layer.fill);continue;}
    const atlas=image(layer.atlas);if(!atlas){fillRect(canvas,x*TILE_SIZE,y*TILE_SIZE,TILE_SIZE,TILE_SIZE,floor.walls?.[y]?.[x]?[53,40,64,255]:[150,132,157,255]);continue;} // Missing atlas: the panel's old flat colours.
    const {sx,sy}=tileCell(layer.tile,atlasColumns(layer.atlas,widths));blit(canvas,atlas,x*TILE_SIZE,y*TILE_SIZE,{sx,sy,sw:TILE_SIZE,sh:TILE_SIZE,tint:layer.tint??null});
   }
  }
  if(Array.isArray(floor.mist?.rows))for(let y=0;y<floor.height;y++){const row=floor.mist.rows[y]??'';for(let x=0;x<floor.width;x++)if(row.charAt(x)==='1')fillRect(canvas,x*TILE_SIZE,y*TILE_SIZE,TILE_SIZE,TILE_SIZE,[255,143,196,70]);} // Pink Mist tiles (dive-mist.mjs), the way the minimap hints at them.
 }
 function paintScenery(canvas,floor){
  for(const p of floor.decorations??[]){ // Dive scenery: the sprite's authored origin sits at the cell centre (online_dive_ground_draw).
   const img=image(p.sprite);if(!img)continue;const f=frameOf(img);blit(canvas,img,p.x*TILE_SIZE+TILE_SIZE/2-img.xorigin,p.y*TILE_SIZE+TILE_SIZE/2-img.yorigin,f);
  }
  for(const f of floor.fixtures??[]){ // Hub fixtures: sprites anchor their top-left to the footprint; people stand on their tile; services get the client's markers.
   if(f.kind==='npc'){if(!drawStanding(canvas,f.sprite??avatarSprite.get(f.avatar),f.x,f.y))drawMarker(canvas,f.x,f.y,BLUE);continue;}
   if(f.kind==='shop'){if(!drawStanding(canvas,avatarSprite.get(f.id)??f.sprite,f.x,f.y))drawMarker(canvas,f.x,f.y,[190,120,220,255]);continue;}
   if(f.kind==='bank'){drawFit(canvas,'sprItem',f.x,f.y,AQUA);continue;}
   if(f.kind==='dumpster'){drawFit(canvas,'sprCityTrashCan',f.x,f.y)||drawMarker(canvas,f.x,f.y,[120,120,120,255]);continue;}
   if(typeof f.sprite==='string'&&f.sprite&&(SCENERY_KINDS.has(f.kind)||f.kind==='bed')){const img=image(f.sprite);if(img){blit(canvas,img,f.x*TILE_SIZE,f.y*TILE_SIZE,frameOf(img));continue;}}
   if(f.kind==='bed'){fillRect(canvas,f.x*TILE_SIZE+4,f.y*TILE_SIZE+6,TILE_SIZE-8,TILE_SIZE-12,[236,201,223,255]);strokeRect(canvas,f.x*TILE_SIZE+4,f.y*TILE_SIZE+6,TILE_SIZE-8,TILE_SIZE-12,[185,135,170,255]);continue;} // Campaign bed objects have no exported sprite: a pink mattress.
   if(f.kind==='token'){drawFit(canvas,f.sprite||'sprItem',f.x,f.y,YELLOW);continue;}
   if(f.kind!=='scenery')drawMarker(canvas,f.x,f.y,[255,204,102,255]); // Pads, pushables, levers and other full-dungeon fixtures.
  }
 }
 function paintContent(canvas,view){
  const floor=view.floor;
  for(const e of floor.exits??[]){ // Crossings: warp pads as aqua stairs, wall gaps as a soft glow, doorsteps as a mat.
   if(e.style==='warp'){drawFit(canvas,'sprStairs',e.x,e.y,AQUA)||drawMarker(canvas,e.x,e.y,[128,255,255,255]);}
   else if(e.style==='gap'){fillRect(canvas,e.x*TILE_SIZE,e.y*TILE_SIZE,(e.w??1)*TILE_SIZE,(e.h??1)*TILE_SIZE,[127,224,192,90]);}
   else fillRect(canvas,e.x*TILE_SIZE+4,e.y*TILE_SIZE+10,TILE_SIZE-8,TILE_SIZE-20,[185,135,170,220]);
  }
  for(const p of floor.portals??[]){if(p.style==='warp')drawFit(canvas,'sprStairs',p.x,p.y,AQUA)||drawMarker(canvas,p.x,p.y,[128,255,255,255]);else if(p.style==='gap')fillRect(canvas,p.x*TILE_SIZE,p.y*TILE_SIZE,(p.w??1)*TILE_SIZE,(p.h??1)*TILE_SIZE,[127,224,192,90]);else fillRect(canvas,p.x*TILE_SIZE+4,p.y*TILE_SIZE+10,TILE_SIZE-8,TILE_SIZE-20,[185,135,170,220]);} // Hub doors and gates.
  for(const ch of floor.chests??[])drawFit(canvas,'sprItem',ch.x,ch.y,YELLOW)||drawMarker(canvas,ch.x,ch.y,[255,204,102,255]);
  for(const pk of floor.pickups??[])drawFit(canvas,pk.sprite||'sprItem',pk.x,pk.y,YELLOW)||drawMarker(canvas,pk.x,pk.y,[255,204,102,255]);
  for(const e of floor.enemies??[]){if(e.dead)continue;const sprite=e.definition?.sprite??e.sprite;if(!drawFit(canvas,sprite,e.x,e.y))drawMarker(canvas,e.x,e.y,RED);if(e.engaged)strokeRect(canvas,e.x*TILE_SIZE,e.y*TILE_SIZE,TILE_SIZE,TILE_SIZE,ROSE,2);} // Engaged monsters get a pink ring like the panel's old pink square.
  for(const p of view.placements??[]){ // GM placements (quest-placements.mjs): NPCs stand, tokens and objects fit a cell, locations and orbs are marks.
   if(p.kind==='npc'){if(!drawStanding(canvas,p.sprite,p.x,p.y))drawMarker(canvas,p.x,p.y,BLUE);}
   else if(p.kind==='orb'){fillCircle(canvas,p.x*TILE_SIZE+TILE_SIZE/2,p.y*TILE_SIZE+TILE_SIZE/2,10,GOLD);fillCircle(canvas,p.x*TILE_SIZE+TILE_SIZE/2,p.y*TILE_SIZE+TILE_SIZE/2,5,WHITE);}
   else if(p.kind==='location'){strokeRect(canvas,p.x*TILE_SIZE+6,p.y*TILE_SIZE+6,TILE_SIZE-12,TILE_SIZE-12,[202,255,119,255],2);}
   else if(!drawFit(canvas,p.sprite||'sprItem',p.x,p.y))drawMarker(canvas,p.x,p.y,[202,255,119,255]);
  }
  const entrance=floor.entrance??floor.spawn;if(entrance)strokeRect(canvas,entrance.x*TILE_SIZE+2,entrance.y*TILE_SIZE+2,TILE_SIZE-4,TILE_SIZE-4,MINT,2); // Default arrival tile.
  for(const e of Object.values(floor.entries??{}))strokeRect(canvas,e.x*TILE_SIZE+6,e.y*TILE_SIZE+6,TILE_SIZE-12,TILE_SIZE-12,MINT,1); // Arrivals from each neighbour.
 }
 function paintOverlays(canvas,floor,layers){
  if(layers.includes('safe'))for(const r of floor.safeRooms??[])strokeRect(canvas,r.x*TILE_SIZE,r.y*TILE_SIZE,r.w*TILE_SIZE,r.h*TILE_SIZE,[127,224,192,160],2);
  if(layers.includes('grid')){for(let x=0;x<=floor.width;x++)fillRect(canvas,x*TILE_SIZE,0,1,floor.height*TILE_SIZE,[0,0,0,70]);for(let y=0;y<=floor.height;y++)fillRect(canvas,0,y*TILE_SIZE,floor.width*TILE_SIZE,1,[0,0,0,70]);}
 }
 function paintPlayers(canvas,players){for(const p of players??[]){fillRect(canvas,p.x*TILE_SIZE+9,p.y*TILE_SIZE+9,TILE_SIZE-18,TILE_SIZE-18,MINT);strokeRect(canvas,p.x*TILE_SIZE+9,p.y*TILE_SIZE+9,TILE_SIZE-18,TILE_SIZE-18,WHITE);}} // Mint squares, like the panel.
 function paint(view,layers){ // Full-size RGBA canvas of the zone.
  const floor=view.floor,canvas=createCanvas(floor.width*TILE_SIZE,floor.height*TILE_SIZE,BACKGROUND);
  if(layers.includes('terrain'))paintTerrain(canvas,floor);
  if(layers.includes('scenery'))paintScenery(canvas,floor);
  if(layers.includes('content'))paintContent(canvas,view);
  paintOverlays(canvas,floor,layers);
  if(layers.includes('players'))paintPlayers(canvas,view.players);
  return canvas;
 }
 function render(view,{scale=32,layers=DEFAULT_LAYERS}={}){ // -> PNG Buffer; scale 32 (full), 16 or 8 pixels per tile. Cached per zone revision.
  if(!view?.floor||!Number.isInteger(view.floor.width)||!Number.isInteger(view.floor.height))throw Object.assign(Error('This map is not ready yet.'),{status:409,code:'world_map_not_ready'});
  if(![8,16,32].includes(scale))throw Object.assign(Error('scale must be 8, 16 or 32.'),{status:400,code:'world_map_bad_scale'});
  const wanted=[...new Set(layers)].filter(l=>['terrain','scenery','content','players','grid','safe'].includes(l)),key=[view.id,view.revision,scale,wanted.join('+')].join('|');
  const hit=outputs.get(key);if(hit){outputs.delete(key);outputs.set(key,hit);return hit;} // Refresh LRU order.
  const canvas=paint(view,wanted),png=encodePng(scale===32?canvas:downscale(canvas,TILE_SIZE/scale));
  outputs.set(key,png);if(outputs.size>cacheSize)outputs.delete(outputs.keys().next().value);
  return png;
 }
 return {render,paint,image,manifest:()=>({version:tiles.version??0,tilesets:tiles.tilesets,sprites:Object.fromEntries(Object.entries(tiles.sprites).map(([name,{png,...rest}])=>[name,rest])),compiled:Object.keys(compiled)})}; // manifest: sizes and origins without the base64 payloads, plus the names of compiled monster/NPC art, so the editor never asks for a sprite that has no artwork.
}
