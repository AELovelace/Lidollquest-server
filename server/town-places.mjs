// Persistent place drafts and published interior definitions. Only the coordinator writes;
// every world reader combines these rooms with the shipped catalog through the same registry.
import {validateCourtyard} from './hub-garden.mjs';
import {DatabaseSync} from 'node:sqlite';
import {FURNITURE,applyFixtureMoves} from './hub-fixture-moves.mjs';
import {createFloorPatches} from './floor-patches.mjs';
import {decoratePlaceZone,placeConnections,placeZone} from './town-place-layout.mjs';

export const PLACE_LIMITS=Object.freeze({places:32,rooms:64,roomsPerPlace:8,minSize:6,maxSize:48,bodyBytes:1048576,connections:24,anchors:64});
export const PLACE_ACTIONS=Object.freeze(['world_place_save','world_place_publish','world_place_retire','world_place_patch','world_place_stage']);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,code:'town_place_invalid'});};
const slug=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,23}$/.test(value);
const text=value=>{if(typeof value!=='string'||!value.trim()||value.length>80||/[\u0000-\u001f\u007f]/.test(value))fail('Give the place and each room a name of 1 to 80 characters.');return value.trim();};
const integer=(value,min,max,label)=>{if(!Number.isInteger(value)||value<min||value>max)fail(label+' must be an integer from '+min+' to '+max+'.');return value;};
const fields=(value,allowed,label)=>{if(!value||typeof value!=='object'||Array.isArray(value))fail('Choose a '+label+'.');for(const key of Object.keys(value))if(!allowed.includes(key))fail('Unsupported '+label+' field: '+key+'.');};
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}; // Published definitions cannot be mutated by a reader or a map preview.

export function createTownPlaces(db,{hubs,shippedRooms,roots=hubs,now=Date.now,readOnly=false,validatePublication=()=>{},afterPublication=()=>{}}){
 db.exec(`CREATE TABLE IF NOT EXISTS world_places(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,draft TEXT NOT NULL,published TEXT,updated INTEGER NOT NULL,actor TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS world_place_history(place TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,body TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(place,revision));
 CREATE TABLE IF NOT EXISTS world_place_catalog_revision(id INTEGER PRIMARY KEY,token TEXT NOT NULL);
 INSERT OR IGNORE INTO world_place_catalog_revision VALUES (1,'initial');
 CREATE TRIGGER IF NOT EXISTS world_places_insert AFTER INSERT ON world_places WHEN NEW.published IS NOT NULL BEGIN UPDATE world_place_catalog_revision SET token=lower(hex(randomblob(16))) WHERE id=1; END;
 CREATE TRIGGER IF NOT EXISTS world_places_update AFTER UPDATE OF published ON world_places WHEN NEW.published IS NOT OLD.published BEGIN UPDATE world_place_catalog_revision SET token=lower(hex(randomblob(16))) WHERE id=1; END;
 CREATE TRIGGER IF NOT EXISTS world_places_delete AFTER DELETE ON world_places WHEN OLD.published IS NOT NULL BEGIN UPDATE world_place_catalog_revision SET token=lower(hex(randomblob(16))) WHERE id=1; END;`);
 // A random transaction-local token cannot alias a different publication after rollback, unlike an increment reused by a retry.
 const getRow=db.prepare('SELECT * FROM world_places WHERE id=?'),rows=db.prepare('SELECT * FROM world_places ORDER BY id');
 const epoch=db.prepare('SELECT token FROM world_place_catalog_revision WHERE id=1'),publishedRows=db.prepare('SELECT published FROM world_places WHERE published IS NOT NULL ORDER BY id');
 const shippedIds=new Set([...roots,...shippedRooms].map(r=>r.id));let cached=null;
 function current(){
  const token=epoch.get().token;if(cached?.token===token)return cached;
  const places=publishedRows.all().map(row=>JSON.parse(row.published)),custom=places.flatMap(p=>p.rooms).map(freeze);
  const rooms=[...shippedRooms,...custom],all=[...roots,...rooms];
  cached={token,places,custom,rooms,all,byId:new Map(all.map(r=>[r.id,r]))};return cached;
 } // One inexpensive token read refreshes every room consumer, including an already-running snapshot worker.
 function view(id){
  const row=getRow.get(id);if(!row)return null;
  const saved=JSON.parse(row.draft),draft=editable(saved);
  return {id:row.id,revision:row.revision,draft,published:row.published?JSON.parse(row.published):null,updated:row.updated,actor:row.actor};
 } // Drafts are returned only by the GM interface, never by the public room registry.
 function room(raw,home,place){
  fields(raw,['id','name','width','height','spawn','exit','walls','floors','wallTiles','decorTiles','ops'],'room');
  if(raw.ops!==undefined&&!Array.isArray(raw.ops))fail('Room paint and furnishing operations must be a list.'); // Reject malformed imports before the patch engine reads them.
  if(!slug(raw.id))fail('Room IDs use 1 to 24 lowercase letters, digits or hyphens, starting with a letter.');
  const id=home.id+'-place-'+place+'-'+raw.id;if(id.length>80||shippedIds.has(id))fail('Room ID is too long or already reserved.');
  const width=integer(raw.width??20,PLACE_LIMITS.minSize,PLACE_LIMITS.maxSize,'Room width'),height=integer(raw.height??20,PLACE_LIMITS.minSize,PLACE_LIMITS.maxSize,'Room height');
  const gap=raw.exit??{side:'left',offset:Math.min(6,height-3)};
  fields(gap,['side','offset'],'exit');if(!['left','right','top','bottom'].includes(gap.side))fail('Choose an exit wall.');
  const vertical=['left','right'].includes(gap.side),offset=integer(gap.offset,1,(vertical?height:width)-3,'Exit offset');
  const exit={x:vertical?(gap.side==='left'?0:width-1):offset,y:vertical?offset:(gap.side==='top'?0:height-1),w:vertical?1:2,h:vertical?2:1,style:'gap',side:gap.side};
  const inside=(x,y)=>x>=exit.x&&x<exit.x+exit.w&&y>=exit.y&&y<exit.y+exit.h;
  const walls=Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>!inside(x,y)&&(x===0||y===0||x===width-1||y===height-1)?1:0));
  const grid=(value,fallback,max,label)=>{if(value===undefined)return fallback;if(!Array.isArray(value)||value.length!==height||value.some(row=>!Array.isArray(row)||row.length!==width))fail(label+' must match the room dimensions.');return value.map(row=>row.map(v=>integer(v,0,max,label+' cell')));};
  const collision=grid(raw.walls,walls,1,'Walls');
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if((x===0||y===0||x===width-1||y===height-1)&&collision[y][x]!==walls[y][x])fail('Keep the outer wall closed except for the declared exit.');
  const spawn=raw.spawn??{x:vertical?(gap.side==='left'?1:width-2):offset,y:vertical?offset:(gap.side==='top'?1:height-2)};
  fields(spawn,['x','y'],'spawn');
  const out={id,homeTown:home.id,placeId:place,roomKey:raw.id,parent:home.id,hub:home.hub,theme:home.theme,kind:'interior',customPlace:true,
   name:text(raw.name),width,height,spawn:{x:integer(spawn.x,1,width-2,'Spawn X'),y:integer(spawn.y,1,height-2,'Spawn Y')},exit,
   walls:collision,floors:grid(raw.floors,collision.map(row=>row.map(w=>w?0:9)),39,'Floor'),
   wallTiles:grid(raw.wallTiles,collision.map(row=>row.map(w=>w?15:0)),39,'Wall art'),
   decorTiles:grid(raw.decorTiles,collision.map(row=>row.map(()=>0)),39,'Decoration'),
   tilesets:{wall:'tileLBCInterior',floor:'tileLBCInterior',decor:'tileLBCInterior'},fixtures:[],authored:true};
  out.authoring={id:raw.id,name:out.name,width,height,spawn:{...out.spawn},exit:{side:gap.side,offset},walls:structuredClone(out.walls),floors:structuredClone(out.floors),wallTiles:structuredClone(out.wallTiles),decorTiles:structuredClone(out.decorTiles),...(raw.ops?{ops:structuredClone(raw.ops)}:{})};
  if(raw.ops?.length){const scratch=new DatabaseSync(':memory:');try{const patches=createFloorPatches(scratch);patches.act({action:'world_patch_apply',patch_revision:0,ops:raw.ops},{zone:id,floor:out,kind:'hub',openings:[exit],doors:[],actor:'draft',commit:()=>{}});}finally{scratch.close();}const moved=applyFixtureMoves(out,raw.ops);if(moved.patchSkipped?.length)fail(moved.patchSkipped[0].reason);out.fixtures=moved.fixtures;delete out.patchRevision;delete out.patchUndo;delete out.patchSkipped;}
  try{validateCourtyard(out,[]);}catch(error){fail('Room '+raw.id+': '+error.message);}
  return out; // Compile the private grids and furnishing strokes into the same floor format used by live rooms.
 }
 function compactRoom(r){
  const ops=[];
  for(const f of r.fixtures){const id=f.id.replace(/^patch-/,''),furniture=Object.entries(FURNITURE).find(([,t])=>{const a=t.make();return a.kind===f.kind&&(a.bed??'')===(f.bed??'')&&(a.style??'')===(f.style??'')&&(a.sprite??'')===(f.sprite??'');})?.[0];
   if(furniture)ops.push({id,kind:'fixture',op:'add',furniture,to:{x:f.x,y:f.y}});
   else ops.push({id,kind:'decoration',decoration:{sprite:f.sprite,x:f.x,y:f.y,span_w:f.span_w,span_h:f.span_h,solid:f.solid,toilet:f.kind==='toilet'}});
  }
  const paint=r.paint;if(paint?.cells?.length){const cells=[];for(let i=0;i<paint.cells.length;i+=4)cells.push({x:paint.cells[i],y:paint.cells[i+1],atlas:paint.atlases[paint.cells[i+2]],tile:paint.cells[i+3]});ops.push({id:'palette',kind:'paint',cells});}
  return {...r.authoring,spawn:r.spawn,walls:r.walls,floors:r.floors,wallTiles:r.wallTiles,decorTiles:r.decorTiles,ops};
 } // Compact completed strokes into full grids and current furnishings; history retains every prior draft revision.
 function editable(p){return {name:p.name,home:p.home,type:p.type??'interior',exterior:p.exterior,connections:(p.connections??[]).map(c=>({...c,a:{zone:c.a.zone,x:c.a.x,y:c.a.y,arrival:c.a.arrival},b:{zone:c.b.zone,x:c.b.x,y:c.b.y,arrival:c.b.arrival}})),anchors:p.anchors??[],placements:p.placements??[],rooms:p.rooms.map(r=>r.authoring??({id:r.roomKey,name:r.name,width:r.width,height:r.height,spawn:r.spawn,exit:{side:r.exit.side,offset:['left','right'].includes(r.exit.side)?r.exit.y:r.exit.x},walls:r.walls,floors:r.floors,wallTiles:r.wallTiles,decorTiles:r.decorTiles}))};} // Portable authoring data excludes runtime occupants, patches, memory and server revisions.
 function extend(p,entry){
  const point=v=>{fields(v,['x','y'],'position');return {x:integer(v.x,0,255,'X'),y:integer(v.y,0,255,'Y')};};
  const zone=v=>{if(v!=='town'&&!p.rooms.some(r=>r.roomKey===v))fail('Connection/anchor names an unknown room.');return v;};
  if(entry.exterior){const e=entry.exterior;fields(e,['x','y','w','h','sprite','cells'],'exterior');if(e.sprite&&!['sprUtopiaWorkshop','sprUtopiaTower','sprUtopiaNapPods','sprCityShopAwning'].includes(e.sprite))fail('Choose a shipped building facade.');p.exterior={...point({x:e.x,y:e.y}),w:integer(e.w,3,12,'Parcel width'),h:integer(e.h,3,12,'Parcel height'),sprite:e.sprite??'sprUtopiaWorkshop'};if(e.cells!==undefined){if(!Array.isArray(e.cells)||e.cells.length>144)fail('Too many parcel cells.');p.exterior.cells=e.cells.map(c=>{fields(c,['x','y','wall','floor','wallTile','decor'],'parcel cell');const out={x:integer(c.x,0,e.w-1,'Parcel cell X'),y:integer(c.y,0,e.h-1,'Parcel cell Y')};for(const k of ['wall','floor','wallTile','decor'])if(c[k]!==undefined)out[k]=integer(c[k],0,k==='wall'?1:39,k);return out;});}}
  const list=(v,max,label)=>{if(v===undefined)return [];if(!Array.isArray(v)||v.length>max)fail('Too many '+label+'.');return v;};
  const endpoint=e=>{fields(e,['zone','x','y','arrival'],'door endpoint');return {zone:zone(e.zone),...point({x:e.x,y:e.y}),arrival:point(e.arrival)};};
  p.connections=list(entry.connections,PLACE_LIMITS.connections,'connections').map(c=>{fields(c,['id','name','a','b','defaultFor'],'connection');if(!slug(c.id)||c.id==='entrance')fail('Choose a unique connection ID other than entrance.');if(c.a.zone===c.b.zone)fail('Connect two different rooms.');const out={id:c.id,name:text(c.name??c.id),a:endpoint(c.a),b:endpoint(c.b)};if(c.defaultFor){zone(c.defaultFor);if(c.defaultFor==='town'||![c.a.zone,c.b.zone].includes(c.defaultFor))fail('Default return must belong to one connected room.');out.defaultFor=c.defaultFor;const r=p.rooms.find(r=>r.roomKey===c.defaultFor),e=out.a.zone===c.defaultFor?out.a:out.b;Object.assign(e,{x:r.exit.x,y:r.exit.y,w:r.exit.w,h:r.exit.h,side:r.exit.side,arrival:r.spawn});}return out;});
  if(new Set(p.connections.map(c=>c.id)).size!==p.connections.length)fail('Connection IDs must be unique.');
  p.anchors=list(entry.anchors,PLACE_LIMITS.anchors,'anchors').map(a=>{fields(a,['id','name','zone','x','y'],'anchor');if(!slug(a.id))fail('Choose a stable anchor ID.');return {id:a.id,name:text(a.name??a.id),zone:zone(a.zone),...point({x:a.x,y:a.y})};});
  if(new Set(p.anchors.map(a=>a.id)).size!==p.anchors.length)fail('Anchor IDs must be unique.');
  p.placements=list(entry.placements,64,'placements').map(a=>{fields(a,['id','zone','kind','content','name','sprite','x','y'],'placement');if(!slug(a.id)||!['npc','interact','location','token','orb'].includes(a.kind))fail('Choose a stable placement ID and supported content kind.');return {id:a.id,zone:zone(a.zone),kind:a.kind,content:text(a.content),name:text(a.name??a.content),sprite:typeof a.sprite==='string'?a.sprite:'',...point({x:a.x,y:a.y})};});
  if(new Set(p.placements.map(a=>a.id)).size!==p.placements.length)fail('Placement IDs must be unique.');
  for(const c of placeConnections(p))for(const e of [c.a,c.b]){const r=p.rooms.find(r=>r.roomKey===e.zone);if(r&&(r.walls[e.y]?.[e.x]!==0||r.walls[e.arrival.y]?.[e.arrival.x]!==0))fail('Connection '+c.id+': door or arrival is blocked.');if(e.x===e.arrival.x&&e.y===e.arrival.y)fail('Connection '+c.id+': arrival must be clear of the doorway.');}
 } // Every author-supplied reference stays inside its owning place and town.
 function normalize(id,entry){
  if(!slug(id))fail('Place IDs use 1 to 24 lowercase letters, digits or hyphens, starting with a letter.');
  fields(entry,['name','home','rooms','type','exterior','connections','anchors','placements'],'place');const home=hubs.find(h=>h.id===entry.home);if(!home)fail('Choose an existing home town.');
  if(!Array.isArray(entry.rooms)||((entry.type??'interior')==='interior'&&!entry.rooms.length)||entry.rooms.length>PLACE_LIMITS.roomsPerPlace)fail('A place needs 1 to '+PLACE_LIMITS.roomsPerPlace+' rooms.');
  const out={id,name:text(entry.name),home:home.id,type:entry.type??'interior',rooms:entry.rooms.map(r=>room(r,home,id))};
  if(!['interior','poi','walkin'].includes(out.type))fail('Choose interior, poi or walkin.');
  extend(out,entry);
  if(new Set(out.rooms.map(r=>r.id)).size!==out.rooms.length)fail('Room IDs must be unique within the place.');
  if(Buffer.byteLength(JSON.stringify(out))>PLACE_LIMITS.bodyBytes)fail('Keep one place below 1 MiB.');
  return out; // Only normalized, bounded definitions reach the database; callers cannot inject service fixtures or travel targets.
 }
 function act(input,actor){
  if(readOnly)fail('Snapshot workers cannot edit places.',403);
  if(!PLACE_ACTIONS.includes(input.action))fail('Unknown place action.');
  if(!slug(input.id))fail('Choose a valid place ID.');
  const old=getRow.get(input.id);if(input.revision!==(old?.revision??0))fail('This place changed. Refresh before saving.',409);
  if(!old&&rows.all().length>=PLACE_LIMITS.places)fail('The server supports at most '+PLACE_LIMITS.places+' custom places.');
  let draft,published=old?.published??null;
  if(input.action==='world_place_save')draft=normalize(input.id,input.entry);
  else if(input.action==='world_place_patch'||input.action==='world_place_stage'){
   if(!old)fail('Save the place first.');const entry=editable(JSON.parse(old.draft)),r=entry.rooms.find(r=>r.id===input.room);if(!r&&input.room!=='town')fail('Choose a draft room.');
   if(input.action==='world_place_patch'&&input.room==='town'){const e=entry.exterior;if(!e)fail('Choose an exterior parcel first.');if(!Array.isArray(input.ops)||input.ops.some(o=>o.kind!=='cells'||o.cells?.some(c=>c.atlas||c.prop||c.tree)))fail('Parcel drafts support local wall/floor tiles. Select the zone palette.');const cells=new Map((e.cells??[]).map(c=>[c.x+','+c.y,c]));for(const op of input.ops)for(const c of op.cells??[]){const v={x:c.x-e.x,y:c.y-e.y};for(const k of ['wall','floor','wallTile','decor'])if(c[k]!==undefined)v[k]=c[k];cells.set(v.x+','+v.y,{...cells.get(v.x+','+v.y),...v});}e.cells=[...cells.values()];}
   else if(input.action==='world_place_patch'){if(!Array.isArray(input.ops)||input.ops.some(o=>!['cells','paint','decoration','fixture','spawn'].includes(o.kind)))fail('Use paint, furniture, scenery or arrival tools in drafts.');r.ops=[...(r.ops??[]),...input.ops];}
   else {entry.placements??=[];if(input.remove)entry.placements=entry.placements.filter(p=>p.id!==input.remove);else {entry.placements=entry.placements.filter(p=>p.id!==input.placement?.id);entry.placements.push(input.placement);}}
   draft=normalize(input.id,entry);
   if(input.action==='world_place_patch'&&input.room!=='town'){const compiled=draft.rooms.find(v=>v.roomKey===input.room);compiled.authoring=compactRoom(compiled);draft=normalize(input.id,editable(draft));}
  }
  else {if(!old)fail('Save the place draft first.');draft=JSON.parse(old.draft);
   const previous=old.published?JSON.parse(old.published):null;
   if(previous)for(const r of previous.rooms){const next=draft.rooms.find(v=>v.id===r.id);if(!next||next.width!==r.width||next.height!==r.height)fail('Keep published room IDs and dimensions; retire an unreferenced place before replacing it.',409);}
   if(previous&&previous.home!==draft.home)fail('A published place cannot change home town.',409);
   const others=publishedRows.all().map(r=>JSON.parse(r.published)).filter(p=>p.id!==input.id);
   if(others.reduce((sum,p)=>sum+p.rooms.length,0)+draft.rooms.length>PLACE_LIMITS.rooms)fail('The server supports at most '+PLACE_LIMITS.rooms+' published custom rooms.');
   const existing=new Set(others.flatMap(p=>p.rooms.map(r=>r.id)));if(draft.rooms.some(r=>existing.has(r.id)))fail('A room ID already belongs to another place.',409);
   validatePublication(draft,previous,input.action==='world_place_retire');
   published=input.action==='world_place_retire'?null:JSON.stringify(draft);
  }
  const revision=(old?.revision??0)+1,body=JSON.stringify(draft),at=now();
  db.exec('SAVEPOINT town_place');
  try{
   db.prepare('INSERT INTO world_places VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,draft=excluded.draft,published=excluded.published,updated=excluded.updated,actor=excluded.actor').run(input.id,revision,body,published,at,actor);
   db.prepare('INSERT INTO world_place_history VALUES (?,?,?,?,?,?)').run(input.id,revision,input.action,body,at,actor);
   if(['world_place_publish','world_place_retire'].includes(input.action))afterPublication(draft,old?.published?JSON.parse(old.published):null,input.action==='world_place_retire');
   db.exec('RELEASE town_place');
  }catch(error){db.exec('ROLLBACK TO town_place');db.exec('RELEASE town_place');throw error;}
  return view(input.id); // The surrounding GM transaction journals the request and publication together.
 }
 return {act,view,normalize,editable,decorate:(base,override=null)=>decoratePlaceZone(base,override??current().places),published:()=>current().places,list:()=>rows.all().map(row=>view(row.id)),limits:PLACE_LIMITS,version:()=>current().token,
  all:()=>current().all,rooms:()=>current().rooms,custom:()=>current().custom,
  get:id=>current().byId.get(id),has:id=>current().byId.has(id),invalidate:()=>{cached=null;}};
}
