// One painted poster of the whole online world for the GM panel (GET /gm/world.png): every overworld, full dungeon and
// hub reachable from Honeydew, each zone painted by map-render.mjs and placed where its exits say it belongs.
// Wall gaps on a zone's edge (side left/right/top/bottom) are walk-through borders, so those neighbours sit flush on
// that side with their gaps lined up. Doors, warp pads and stairs lead somewhere with no compass direction (interiors,
// shops, caves, dungeons), so those zones are tucked into the nearest free space beside their entrance with a line
// back to it. Instanced Dives (category 'dive') are left out: they are weekly boss runs, not places on the map.
// layoutWorld is pure; paintWorld needs a renderer and runs in world-map-worker.mjs so the game loop never stalls.
import {createCanvas,blit,fillRect,downscale,encodePng} from './png-codec.mjs';
import {TILE_SIZE} from './tile-painter.mjs';
import {Worker} from 'node:worker_threads';

export const WORLD_SCALES=Object.freeze([4,8]); // Pixels per tile; 16 is already ~67 megapixels (~600 MB while encoding) for today's world.
export const WORLD_MAX_PIXELS=60000000; // Refuse anything larger than ~240 MB of RGBA before allocating it.
const SIDES={left:[-1,0],right:[1,0],top:[0,-1],bottom:[0,1]},OPPOSITE={left:'right',right:'left',top:'bottom',bottom:'top'};
const BACKGROUND=[13,8,18,255],FRAME=[58,42,77,255],LABEL_BG=[22,15,28,215],LABEL_INK=[242,233,247,255];
const LINK_COLOUR={gap:[127,224,192,255],door:[255,143,196,255],warp:[128,255,255,255],stairs:[255,220,60,255]}; // Mint borders, rose doors, aqua pads, gold stairs (the panel's palette).

export function layoutWorld({root,zones,gutter=6}){ // zones: [{id,name,width,height,exits:[{to,x,y,w,h,style,side}]}] -> {width,height,zones:[{id,name,x,y,width,height}],links} in tiles.
 const byId=new Map(zones.filter(z=>z.width>0&&z.height>0).map(z=>[z.id,z]));if(!byId.has(root))throw Object.assign(Error('The world map has no '+root+' to start from.'),{status:409,code:'world_map_not_ready'});
 const exitsOf=id=>(byId.get(id).exits??[]).filter(e=>byId.has(e.to)&&e.to!==id);
 const order=[root],seen=new Set(order);for(let i=0;i<order.length;i++)for(const e of exitsOf(order[i]))if(!seen.has(e.to)){seen.add(e.to);order.push(e.to);} // Breadth-first from Honeydew: unreachable zones are not on the map.
 const placed=new Map(),clear=r=>{for(const p of placed.values())if(r.x<p.x+p.width+gutter&&p.x<r.x+r.width+gutter&&r.y<p.y+p.height+gutter&&p.y<r.y+r.height+gutter)return false;return true;}; // Every zone keeps a gutter of empty tiles around it.
 const place=(id,x,y)=>{const z=byId.get(id);placed.set(id,{id,name:z.name??id,x,y,width:z.width,height:z.height});};
 const centre=(e,axis)=>axis==='x'?e.x+(e.w??1)/2:e.y+(e.h??1)/2; // Middle of an exit footprint along one axis.
 place(root,0,0);
 for(const queue=[root];queue.length;){const a=placed.get(queue.shift()); // Pass 1: borders. Only zones already on the map pull neighbours in, so a room's own "gap left" back to its lobby never moves it.
  for(const e of exitsOf(a.id)){const dir=SIDES[e.side];if(!dir||e.style!=='gap'||placed.has(e.to))continue;
   const b=byId.get(e.to),back=b.exits?.find(x=>x.to===a.id&&x.side===OPPOSITE[e.side])??b.exits?.find(x=>x.to===a.id),along=dir[0]?'y':'x'; // Line the two gaps up; a one-way border (Arcadia's south gate onto the Brassworks stairs) lines up with whatever exit leads back.
   const offset=Math.round(centre(e,along)-(back?centre(back,along):(along==='x'?b.width:b.height)/2));
   const x0=dir[0]?(dir[0]>0?a.x+a.width+gutter:a.x-gutter-b.width):a.x+offset,y0=dir[1]?(dir[1]>0?a.y+a.height+gutter:a.y-gutter-b.height):a.y+offset;
   const spot=nearestClear(clear,{width:b.width,height:b.height},x0,y0,dir,Math.ceil(Math.max(b.width,b.height)/2));if(!spot)continue;
   place(b.id,spot.x,spot.y);queue.push(b.id);
  }
 }
 for(const id of order){if(placed.has(id))continue; // Pass 2: everything reached through a door, pad or stairs sits as close to that entrance as the map allows.
  const anchor=order.map(o=>placed.get(o)).find(p=>p&&exitsOf(p.id).some(e=>e.to===id));if(!anchor)continue;
  const e=exitsOf(anchor.id).find(x=>x.to===id),z=byId.get(id);place(id,...satelliteSpot(clear,placed,z,anchor.x+e.x+0.5,anchor.y+e.y+0.5,gutter));
 }
 const links=[],linked=new Set(); // One line per connected pair and style, from the exit tile on each side.
 for(const a of placed.values())for(const e of exitsOf(a.id)){const b=placed.get(e.to);if(!b)continue;const key=[a.id,b.id].sort().join('|');if(linked.has(key))continue;linked.add(key);
  const back=byId.get(b.id).exits?.find(x=>x.to===a.id);
  links.push({from:a.id,to:b.id,style:e.style??'stairs',ax:a.x+centre(e,'x'),ay:a.y+centre(e,'y'),bx:b.x+(back?centre(back,'x'):b.width/2),by:b.y+(back?centre(back,'y'):b.height/2)});
 }
 const all=[...placed.values()],minX=Math.min(...all.map(p=>p.x))-gutter,minY=Math.min(...all.map(p=>p.y))-gutter; // Shift so the map starts one gutter in from the top-left corner.
 for(const p of all){p.x-=minX;p.y-=minY;}for(const l of links){l.ax-=minX;l.bx-=minX;l.ay-=minY;l.by-=minY;}
 return {width:Math.max(...all.map(p=>p.x+p.width))+gutter,height:Math.max(...all.map(p=>p.y+p.height))+gutter,gutter,zones:all,links};
}

function nearestClear(clear,size,x0,y0,dir,slide){ // First free spot pushing outward along dir, sliding sideways at most `slide` tiles at each step.
 for(let push=0;push<=400;push++)for(let k=0;k<=slide;k++)for(const sign of k?[-1,1]:[1]){
  const side=k*sign,x=x0+dir[0]*push+(dir[0]?0:side),y=y0+dir[1]*push+(dir[1]?0:side);if(clear({x,y,...size}))return {x,y};
 }
 return null;
}

function satelliteSpot(clear,placed,z,px,py,gutter){ // The free top-left closest to the entrance (px,py): every optimum touches some zone's gutter or centres on the entrance, so only those columns and rows are tried.
 const xs=new Set([Math.round(px-z.width/2)]),ys=new Set([Math.round(py-z.height/2)]);
 for(const p of placed.values()){xs.add(p.x+p.width+gutter);xs.add(p.x-gutter-z.width);ys.add(p.y+p.height+gutter);ys.add(p.y-gutter-z.height);}
 const candidates=[];for(const x of xs)for(const y of ys){const dx=Math.max(x-px,0,px-(x+z.width)),dy=Math.max(y-py,0,py-(y+z.height));candidates.push({x,y,cost:dx*dx+dy*dy});}
 candidates.sort((a,b)=>a.cost-b.cost||a.y-b.y||a.x-b.x);
 for(const c of candidates)if(clear({x:c.x,y:c.y,width:z.width,height:z.height}))return [c.x,c.y];
 const bottom=Math.max(...[...placed.values()].map(p=>p.y+p.height));return [Math.round(px-z.width/2),bottom+gutter]; // Unreachable in practice: below everything.
}

export function spriteNames(view,avatarSprite=new Map()){ // Every sprite a zone picture may ask for, so the main thread can hand GM uploads and monster art to the worker.
 const names=new Set(),walk=value=>{if(Array.isArray(value)){for(const v of value)walk(v);return;}if(!value||typeof value!=='object')return;for(const [key,v] of Object.entries(value)){if(key==='sprite'&&typeof v==='string')names.add(v);else if(v&&typeof v==='object')walk(v);}};
 walk(view.floor?.decorations);walk(view.floor?.fixtures);walk(view.floor?.enemies);walk(view.floor?.pickups);walk(view.placements);
 for(const f of view.floor?.fixtures??[])for(const id of [f.avatar,f.id]){const s=avatarSprite.get(id);if(s)names.add(s);} // Residents and merchants draw from their avatar.
 return names;
}

export function paintWorld(renderer,layout,views,{scale=8,layers}={}){ // -> PNG Buffer. views: zone id -> paintMap view.
 if(!WORLD_SCALES.includes(scale))throw Object.assign(Error('scale must be '+WORLD_SCALES.join(', ')+'.'),{status:400,code:'world_map_bad_scale'});
 const width=layout.width*scale,height=layout.height*scale;if(width*height>WORLD_MAX_PIXELS)throw Object.assign(Error('The world is too large to paint at '+scale+' px per tile; choose a smaller scale.'),{status:413,code:'world_map_too_large'});
 const canvas=createCanvas(width,height,BACKGROUND);
 for(const z of layout.zones){const view=views[z.id];if(!view?.floor)continue; // Paint each zone at full size, shrink it, then drop it in place.
  const picture=downscale(renderer.paint(view,layers??['terrain','scenery','content']),TILE_SIZE/scale);
  fillRect(canvas,z.x*scale-1,z.y*scale-1,picture.width+2,picture.height+2,FRAME);blit(canvas,picture,z.x*scale,z.y*scale);
 }
 const thick=Math.max(1,Math.round(scale/4));
 for(const l of layout.links){const colour=LINK_COLOUR[l.style]??LINK_COLOUR.stairs;
  line(canvas,l.ax*scale,l.ay*scale,l.bx*scale,l.by*scale,thick,colour);for(const [x,y] of [[l.ax,l.ay],[l.bx,l.by]])fillRect(canvas,Math.round(x*scale-thick*1.5),Math.round(y*scale-thick*1.5),thick*3,thick*3,colour);
 }
 const glyph=Math.max(1,Math.round(scale/4)); // 5x7 letters: 1x at 4 px/tile, 2x at 8.
 for(const z of layout.zones){const text=z.name.toUpperCase(),pad=glyph*2,room=Math.floor((z.width*scale-pad*2)/(6*glyph)),shown=text.length>room?text.slice(0,Math.max(0,room-1))+'.':text; // Long names are cut to the zone's width.
  const w=shown.length*6*glyph-glyph+pad*2,h=7*glyph+pad*2,x=z.x*scale,y=z.y*scale-h-2;fillRect(canvas,x,y,w,h,LABEL_BG);drawText(canvas,shown,x+pad,y+pad,glyph,LABEL_INK);
 }
 return encodePng(canvas);
}

function line(canvas,x0,y0,x1,y1,thick,colour){const steps=Math.max(1,Math.ceil(Math.hypot(x1-x0,y1-y0)/Math.max(1,thick/2)));for(let i=0;i<=steps;i++){const t=i/steps;fillRect(canvas,Math.round(x0+(x1-x0)*t-thick/2),Math.round(y0+(y1-y0)*t-thick/2),thick,thick,colour);}} // Stamped squares; overlapping stamps stay opaque because the colour is.

const FONT={ // 5x7 capitals, one number per row, high bit on the left. Anything else prints as '?'.
 A:[14,17,17,31,17,17,17],B:[30,17,17,30,17,17,30],C:[14,17,16,16,16,17,14],D:[28,18,17,17,17,18,28],E:[31,16,16,30,16,16,31],F:[31,16,16,30,16,16,16],G:[14,17,16,23,17,17,15],
 H:[17,17,17,31,17,17,17],I:[14,4,4,4,4,4,14],J:[7,2,2,2,2,18,12],K:[17,18,20,24,20,18,17],L:[16,16,16,16,16,16,31],M:[17,27,21,21,17,17,17],N:[17,17,25,21,19,17,17],
 O:[14,17,17,17,17,17,14],P:[30,17,17,30,16,16,16],Q:[14,17,17,17,21,18,13],R:[30,17,17,30,20,18,17],S:[15,16,16,14,1,1,30],T:[31,4,4,4,4,4,4],U:[17,17,17,17,17,17,14],
 V:[17,17,17,17,17,10,4],W:[17,17,17,21,21,21,10],X:[17,17,10,4,10,17,17],Y:[17,17,17,10,4,4,4],Z:[31,1,2,4,8,16,31],
 0:[14,17,19,21,25,17,14],1:[4,12,4,4,4,4,14],2:[14,17,1,2,4,8,31],3:[31,2,4,2,1,17,14],4:[2,6,10,18,31,2,2],5:[31,16,30,1,1,17,14],6:[6,8,16,30,17,17,14],7:[31,1,2,4,8,8,8],8:[14,17,17,14,17,17,14],9:[14,17,17,15,1,2,12],
 ' ':[0,0,0,0,0,0,0],"'":[4,4,8,0,0,0,0],'-':[0,0,0,14,0,0,0],'.':[0,0,0,0,0,12,12],',':[0,0,0,0,12,4,8],':':[0,12,12,0,12,12,0],'&':[12,18,20,8,21,18,13],'(':[2,4,8,8,8,4,2],')':[8,4,2,2,2,4,8],'!':[4,4,4,4,4,0,4],'/':[0,1,2,4,8,16,0],'?':[14,17,1,2,4,0,4],
};
export function drawText(canvas,text,x,y,size,colour){for(const [i,ch] of [...text].entries()){const rows=FONT[ch]??FONT['?'];for(let r=0;r<7;r++)for(let c=0;c<5;c++)if(rows[r]&(16>>c))fillRect(canvas,x+(i*6+c)*size,y+r*size,size,size,colour);}return canvas;}

export function createWorldPainter({spawn=workerData=>new Worker(new URL('./world-map-worker.mjs',import.meta.url),{workerData}),timeout=120000,ttl=60000,now=Date.now}={}){ // One poster at a time; a repeat click within a minute of an unchanged world reuses the last picture.
 let queue=Promise.resolve(),last=null;
 const fresh=key=>last&&last.key===key&&now()-last.at<ttl;
 function once(input){return new Promise((resolve,reject)=>{
  const worker=spawn(input),timer=setTimeout(()=>{worker.terminate();reject(Object.assign(Error('Painting the world took too long; try a smaller scale.'),{status:503,code:'world_map_timeout'}));},timeout);
  const done=()=>{clearTimeout(timer);worker.removeAllListeners();};
  worker.once('message',m=>{done();void worker.terminate();if(m.error)reject(Object.assign(Error(m.error),{status:m.status??500,code:m.code??'world_map_failed'}));else resolve(Buffer.from(m.png.buffer,m.png.byteOffset,m.png.byteLength));});
  worker.once('error',error=>{done();reject(Object.assign(Error('The world painter failed: '+error.message),{status:500,code:'world_map_failed'}));});
  worker.once('exit',code=>{done();reject(Object.assign(Error('The world painter stopped (exit '+code+').'),{status:500,code:'world_map_failed'}));}); // Settling twice is a no-op, so a clean exit after the message changes nothing.
 });}
 function render(input,key){ // input: {root,zones,views,scale,layers,sprites,avatars}; key names the world state it shows.
  if(fresh(key))return Promise.resolve(last.png);
  const run=queue.then(()=>fresh(key)?last.png:once(input).then(png=>{last={key,png,at:now()};return png;}));
  queue=run.catch(()=>{});return run;
 }
 return {render};
}
