// The GM floor patch layer: hand edits (walls, floor, scenery, safe rooms, arrival points) stored per zone and re-applied
// over every generated edition (weekly Dive floors, monthly hub districts) and over code-defined authored rooms, like the
// idempotent upgradeFloor steps in zones.mjs. Every application records an undo log on the floor (patchUndo), so a later
// revision (remove, rollback, clear) first reverts the previous edits and then applies the current ones in place: no
// regeneration is needed to see a change land or disappear.
// Snapshot workers (read-only database) only ever call apply() on in-memory copies; writes happen on the coordinator inside
// the GM action transaction (gm.mjs), where act() also re-realizes quest placements and relocates anyone standing in a new wall.
import {randomUUID} from 'node:crypto';
import {inExit} from './wilderness-links.mjs';
import {MOVABLE_FIXTURES,FURNITURE,furnitureFixture} from './hub-fixture-moves.mjs';

const fail=(message,status=409,code='world_patch_conflict')=>{throw Object.assign(Error(message),{status,code});};
const MAX_OPS=256,MAX_CELLS=4096,MAX_BODY=256*1024,MAX_SPAN=8; // Caps keep one zone's patch a few hundred KB at most.
const SPRITE=/^[A-Za-z][A-Za-z0-9_]{0,63}$/; // GameMaker sprite names; the client resolves them with asset_get_index and ignores unknown ones.
const SERVICE_KINDS=new Set(['shop','bank','dumpster','bed','toilet','changer','cauldron','reagents','altar','npc','mirror','pad','curse-remover','forge','sewing_table','kitchen']); // Hub fixtures players must be able to stand beside.
const key=(x,y)=>x+','+y;

export function createFloorPatches(db,{now=Date.now,readOnly=false}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS world_floor_patches(zone TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS world_floor_patch_history(zone TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(zone,revision));`);
 const rowQuery=db.prepare('SELECT * FROM world_floor_patches WHERE zone=?');
 function get(zone){const row=rowQuery.get(zone);if(!row)return {zone,revision:0,ops:[],updated:0,actor:''};const body=JSON.parse(row.body);return {zone,revision:row.revision,ops:body.ops??[],updated:row.updated,actor:row.actor};}
 const revisionQuery=db.prepare('SELECT revision FROM world_floor_patches WHERE zone=?'),revision=zone=>revisionQuery.get(zone)?.revision??0; // No body: zone() asks on every call.
 function history(zone){return db.prepare('SELECT revision,updated,actor,body FROM world_floor_patch_history WHERE zone=? ORDER BY revision DESC LIMIT 30').all(zone).map(r=>({revision:r.revision,updated:r.updated,actor:r.actor,count:(JSON.parse(r.body).ops??[]).length}));}
 function store(zone,ops,actor){ // Write the next revision and remember it in the history.
  if(readOnly)fail('Snapshot workers cannot edit floors.',500,'world_patch_readonly');
  const next=revision(zone)+1,body=JSON.stringify({version:1,ops});if(body.length>MAX_BODY)fail('This zone\'s patch is too large; remove some changes first.',400,'world_patch_too_large');
  db.prepare('INSERT INTO world_floor_patches VALUES (?,?,?,?,?) ON CONFLICT(zone) DO UPDATE SET revision=excluded.revision,body=excluded.body,updated=excluded.updated,actor=excluded.actor').run(zone,next,body,now(),actor);
  db.prepare('INSERT INTO world_floor_patch_history VALUES (?,?,?,?,?)').run(zone,next,body,now(),actor);return next;
 }

 // ----- Geometry helpers shared by apply() and validation -----
 const solidFixtures=f=>(f.fixtures??[]).filter(p=>p.solid!==false);
 function blocked(f,x,y){return !!(f.walls?.[y]?.[x])||!!(f.props?.[y]?.[x])||solidFixtures(f).some(p=>x>=p.x&&x<p.x+(p.span_w??1)&&y>=p.y&&y<p.y+(p.span_h??1));} // Same rule as quest-placements.mjs tiles().
 function blockedBy(f,x,y){ /* Why a tile is not walkable, in words for the GM (the inspector shows tile art, not collision). */if(f.walls?.[y]?.[x])return 'a wall';if(f.props?.[y]?.[x])return 'a scenery prop';const p=solidFixtures(f).find(p=>x>=p.x&&x<p.x+(p.span_w??1)&&y>=p.y&&y<p.y+(p.span_h??1));return p?'solid '+(p.kind??'scenery')+' '+(p.name||p.sprite||p.id||'')+' at '+p.x+','+p.y+((p.span_w??1)*(p.span_h??1)>1?' ('+(p.span_w??1)+'×'+(p.span_h??1)+')':''):'';}
 const walkable=(f,x,y)=>Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<f.width&&y<f.height&&!blocked(f,x,y);
 function flood(f,from=null){const seeds=(from??[f.entrance,f.spawn,...Object.values(f.entries??{})]).filter(p=>p&&walkable(f,p.x,p.y)),seen=new Set(seeds.map(p=>key(p.x,p.y))),queue=[...seeds];for(let i=0;i<queue.length;i++){const p=queue[i];for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]){const x=p.x+dx,y=p.y+dy;if(!seen.has(key(x,y))&&walkable(f,x,y)){seen.add(key(x,y));queue.push({x,y});}}}return seen;}
 const footprint=p=>{const cells=[];for(let dy=0;dy<(p.span_h??1);dy++)for(let dx=0;dx<(p.span_w??1);dx++)cells.push({x:p.x+dx,y:p.y+dy});return cells;};
 const beside=(reach,p)=>footprint(p).some(c=>reach.has(key(c.x,c.y))||[[0,-1],[-1,0],[1,0],[0,1]].some(([dx,dy])=>reach.has(key(c.x+dx,c.y+dy)))); // On or orthogonally next to any tile of the footprint.
 function openings(f,kind,extra){ // Border cells that may stay open: wall-gap exits (dives) or hub gates and doors (passed in by zones.mjs).
  const list=kind==='dive'?(f.exits??[]).filter(e=>e.style==='gap'):(extra??[]);return (x,y)=>list.some(g=>inExit(g,x,y));
 }
 function protectedTiles(f,kind){ // Tiles that must stay walkable: arrivals, crossings, treasure and (hubs) every fixture the patch did not add.
  const tiles=new Map();const add=(p,why)=>{if(p)tiles.set(key(p.x,p.y),why);};
  add(f.entrance,'the arrival tile');add(f.spawn,'the arrival tile');for(const e of Object.values(f.entries??{}))add(e,'an arrival tile');
  for(const e of f.exits??[])for(const c of footprint({x:e.x,y:e.y,span_w:e.w??1,span_h:e.h??1}))add(c,'an exit');
  for(const e of f.portals??[])for(const c of footprint({x:e.x,y:e.y,span_w:e.w??1,span_h:e.h??1}))add(c,'a door or gate');
  for(const c of f.chests??[])add(c,'a chest');for(const c of f.pickups??[])add(c,'a pickup');
  for(const p of f.fixtures??[])if(!String(p.id??'').startsWith('patch-'))for(const c of footprint(p))add(c,p.kind==='scenery'?'generated scenery':'the '+p.kind+(p.name?' '+p.name:''));
  return tiles;
 }
 function validate(f,kind,extraOpenings,touched,terrainBefore=null){ // Cell painting checks newly added terrain blockers; existing fixtures must not block repainting their floor.
  const open=openings(f,kind,extraOpenings),guard=protectedTiles(f,kind);
  for(const t of touched){
   const border=t.x===0||t.y===0||t.x===f.width-1||t.y===f.height-1;
   if(border&&!f.walls[t.y][t.x]&&!open(t.x,t.y))fail('The outer wall at '+t.x+','+t.y+' has to stay solid (only gates and exits open it).');
   const covers=terrainBefore?((!!f.walls[t.y][t.x]&&!terrainBefore.walls[t.y][t.x])||(!!f.props?.[t.y]?.[t.x]&&!terrainBefore.props?.[t.y]?.[t.x])):blocked(f,t.x,t.y); // Compare final collision layers with the pre-operation floor, including repeated cells in a stroke.
   if(covers&&guard.has(key(t.x,t.y)))fail('That would cover '+guard.get(key(t.x,t.y))+' at '+t.x+','+t.y+'.');
  }
  const reach=flood(f);if(!reach.size)fail('The arrival tile is walled in.');
  for(const e of Object.values(f.entries??{}))if(!reach.has(key(e.x,e.y)))fail('The arrival from a neighbour at '+e.x+','+e.y+' is cut off.');
  for(const e of [...(f.exits??[]),...(f.portals??[])])if(!beside(reach,{x:e.x,y:e.y,span_w:e.w??1,span_h:e.h??1}))fail('The way out at '+e.x+','+e.y+(e.name?' ('+e.name+')':'')+' is cut off.');
  for(const c of f.chests??[])if(!reach.has(key(c.x,c.y)))fail('Chest '+c.id+' at '+c.x+','+c.y+' is cut off.');
  for(const c of f.pickups??[])if(!reach.has(key(c.x,c.y)))fail('Pickup '+c.id+' at '+c.x+','+c.y+' is cut off.');
  for(const p of f.fixtures??[])if(SERVICE_KINDS.has(p.kind)&&!beside(reach,p))fail((p.name||p.kind)+' at '+p.x+','+p.y+' can no longer be reached.');
  for(const p of f.authoredPlacements??[])if(!walkable(f,p.x,p.y)&&!beside(reach,p))fail('Authored placement '+p.id+' is cut off.');
 }

 // ----- Applying and reverting ops on a floor -----
 function grid(f,name){return Array.isArray(f[name])?f[name]:null;}
 function remember(undo,f,x,y){const k=key(x,y);if(undo.cellIndex.has(k))return;undo.cellIndex.add(k);undo.cells.push({x,y,wall:f.walls[y][x],prop:f.props?.[y]?.[x]??null,floor:grid(f,'floors')?.[y]?.[x]??null,wallTile:grid(f,'wallTiles')?.[y]?.[x]??null,decor:grid(f,'decorTiles')?.[y]?.[x]??null,tree:grid(f,'treeTiles')?.[y]?.[x]??null});} // First touch only: the undo log keeps the pre-patch value.
 function applyOp(f,op,kind,undo,touched,rules={}){ // rules.destinations: zones a new crossing may lead to (GM actions); null on ticks, where stored ops were already checked.
  if(op.kind==='cells'){
   for(const c of op.cells){
    if(!Number.isInteger(c.x)||!Number.isInteger(c.y)||c.x<0||c.y<0||c.x>=f.width||c.y>=f.height)fail('Cell '+c.x+','+c.y+' is outside the map.',400);
    remember(undo,f,c.x,c.y);touched.push({x:c.x,y:c.y});
    if(c.wall!==undefined)f.walls[c.y][c.x]=c.wall?1:0;
    if(c.prop!==undefined){f.props??=f.walls.map(r=>r.map(()=>0));f.props[c.y][c.x]=c.prop?1:0;}
    if(c.floor!==undefined&&grid(f,'floors'))f.floors[c.y][c.x]=Math.max(0,Math.floor(c.floor));
    if(c.wallTile!==undefined&&grid(f,'wallTiles'))f.wallTiles[c.y][c.x]=Math.max(0,Math.floor(c.wallTile));
    if(c.decor!==undefined&&grid(f,'decorTiles'))f.decorTiles[c.y][c.x]=Math.max(0,Math.floor(c.decor));
    if(c.tree!==undefined&&grid(f,'treeTiles'))f.treeTiles[c.y][c.x]=Math.max(0,Math.floor(c.tree));
    if(c.wall===1&&f.floors&&c.floor===undefined&&grid(f,'wallTiles')&&!f.wallTiles[c.y][c.x])f.wallTiles[c.y][c.x]=f.district?.style==='nightlife'?11:10; // A new wall in a tiled room gets the room's plain wall tile unless the GM chose one.
   }
   return;
  }
  if(op.kind==='fixture'){
   if(kind==='dive')fail('Only hub furniture and services can be placed or moved this way.',400);
   if(op.op==='add'){ // Map Editor "Place furniture": a real service fixture from hub-fixture-moves.mjs FURNITURE.
    const placed=furnitureFixture(op.furniture,'patch-'+op.id,op.to.x,op.to.y);if(!placed)fail('Unknown furniture '+op.furniture+'.',400);
    const cells=footprint(placed);if(!cells.every(c=>c.x>=1&&c.y>=1&&c.x<f.width-1&&c.y<f.height-1&&walkable(f,c.x,c.y)))fail((placed.name||placed.kind)+' must stand on open floor inside the outer wall.');
    f.fixtures??=[];f.fixtures.push(placed);undo.fixturesAdded.push(placed.id);for(const c of cells)touched.push(c);return;
   }
   if(op.op==='remove'){const hit=(f.fixtures??[]).find(d=>d.id===op.match.id&&MOVABLE_FIXTURES.has(d.kind));if(!hit)return; /* Gone already, or added later by decoration (the vanity, crafting stations): nothing to remove here. */f.fixtures=f.fixtures.filter(d=>d!==hit);undo.fixturesRemoved.push(hit);for(const c of footprint(hit))touched.push(c);return;}
   return; // Moves are applied after decoration by hub-fixture-moves.mjs.
  }
  if(op.kind==='decoration'){
   if(op.op==='remove'){
    const m=op.match??{};const hit=kind==='dive'?(f.decorations??[]).find(d=>(m.id&&d.id===m.id)||(d.sprite===m.sprite&&d.x===m.x&&d.y===m.y)):(f.fixtures??[]).find(d=>['scenery','toilet'].includes(d.kind)&&((m.id&&d.id===m.id)||(d.sprite===m.sprite&&d.x===m.x&&d.y===m.y)));
    if(!hit)return; // Already gone (another edition, or removed by an earlier op): nothing to do.
    if(kind==='dive'){f.decorations=f.decorations.filter(d=>d!==hit);if(hit.solid)for(const c of footprint(hit)){remember(undo,f,c.x,c.y);if(f.props?.[c.y])f.props[c.y][c.x]=0;touched.push(c);}undo.decorationsRemoved.push(hit);}
    else {f.fixtures=f.fixtures.filter(d=>d!==hit);undo.fixturesRemoved.push(hit);for(const c of footprint(hit))touched.push(c);}
    return;
   }
   const d=op.decoration;if(!d||!SPRITE.test(String(d.sprite??'')))fail('Choose a sprite for the scenery.',400);
   const span_w=Math.min(MAX_SPAN,Math.max(1,Math.floor(d.span_w??1))),span_h=Math.min(MAX_SPAN,Math.max(1,Math.floor(d.span_h??1)));
   if(!Number.isInteger(d.x)||!Number.isInteger(d.y)||d.x<1||d.y<1||d.x+span_w>f.width-1||d.y+span_h>f.height-1)fail('Scenery must sit inside the outer wall.',400);
   if(kind==='dive'){const placed={id:'patch-'+op.id,sprite:d.sprite,span_w,span_h,solid:d.solid!==false,x:d.x,y:d.y,...(d.toilet?{toilet:true}:{})};f.decorations??=[];f.decorations.push(placed);if(placed.solid){f.props??=f.walls.map(r=>r.map(()=>0));for(const c of footprint(placed)){remember(undo,f,c.x,c.y);f.props[c.y][c.x]=1;}}undo.decorationsAdded.push(placed.id);for(const c of footprint(placed))touched.push(c);}
   else {const placed={id:'patch-'+op.id,name:'',kind:d.toilet?'toilet':'scenery',sprite:d.sprite,x:d.x,y:d.y,span_w,span_h,solid:d.solid!==false};f.fixtures??=[];f.fixtures.push(placed);undo.fixturesAdded.push(placed.id);for(const c of footprint(placed))touched.push(c);}
   return;
  }
  if(op.kind==='safeRoom'){
   if(kind!=='dive')fail('Safe rooms only exist on Dive and overworld floors.',400);const r=op.rect??{};
   if(![r.x,r.y,r.w,r.h].every(Number.isInteger)||r.w<1||r.h<1||r.x<0||r.y<0||r.x+r.w>f.width||r.y+r.h>f.height)fail('Safe room must be a rectangle inside the map.',400);
   f.safeRooms??=[];if(op.op==='remove'){const hit=f.safeRooms.find(s=>s.x===r.x&&s.y===r.y&&s.w===r.w&&s.h===r.h);if(hit){f.safeRooms=f.safeRooms.filter(s=>s!==hit);undo.safeRoomsRemoved.push(hit);}}
   else {const rect={x:r.x,y:r.y,w:r.w,h:r.h};f.safeRooms.push(rect);undo.safeRoomsAdded.push(rect);}
   return;
  }
  if(op.kind==='spawn'){
   if(op.entrance){const p=op.entrance;if(!walkable(f,p.x,p.y))fail('The arrival tile must be walkable.',400);if(kind==='dive'){undo.entrance??={...f.entrance};f.entrance={x:p.x,y:p.y};}else{undo.spawn??={...(f.spawn??{x:10,y:9})};f.spawn={x:p.x,y:p.y};}}
   if(op.entries&&kind==='dive'){f.entries??={};for(const [zone,p] of Object.entries(op.entries)){if(!f.entries[zone])fail('This map has no arrival from '+zone+'.',400);if(!walkable(f,p.x,p.y))fail('The arrival tile must be walkable.',400);undo.entries[zone]??={...f.entries[zone]};f.entries[zone]={x:p.x,y:p.y};}}
   return;
  }
  if(op.kind==='layer'){ // Biome layers the client paints and plays: tall-grass cover, the Gulch wash, the Coast shoreline, Pink Mist, the Caldera crater.
   if(kind!=='dive')fail('Biome layers only exist on Dive and overworld floors.',400);const theme=String(f.theme??''),W=f.width,H=f.height;
   const inside=(x,y)=>Number.isInteger(x)&&Number.isInteger(y)&&x>=1&&y>=1&&x<W-1&&y<H-1;
   const setRow=(name,y,row)=>{undo.rows[name]??={};if(!(y in undo.rows[name]))undo.rows[name][y]=f[name][y]??null;f[name][y]=row;}; // Whole rows restore on revert.
   if(op.layer==='cover'||op.layer==='wash'){
    if(op.layer==='cover'&&!['autumn_plains','coast'].includes(theme))fail('Cover only exists on the Autumnal Plains and the Seafoam Coast.',400);
    if(op.layer==='wash'&&theme!=='gulch')fail('The wash only exists in Echo Gulch.',400);
    if(!Array.isArray(f[op.layer])){f[op.layer]=Array.from({length:H},()=>'0'.repeat(W));undo.created.push(op.layer);}
    for(const c of op.cells){if(!inside(c.x,c.y))fail('Layer cell '+c.x+','+c.y+' is outside the map.',400);const v=String(c.v);if(v.length!==1||!(op.layer==='cover'?'012':'01').includes(v))fail('Bad '+op.layer+' value.',400);const row=String(f[op.layer][c.y]??'').padEnd(W,'0').slice(0,W);setRow(op.layer,c.y,row.slice(0,c.x)+v+row.slice(c.x+1));}
   }else if(op.layer==='shore'){
    if(theme!=='coast'||!Array.isArray(f.shore))fail('Only the Seafoam Coast has a shoreline.',400);
    for(const r of op.rows){if(!Number.isInteger(r.y)||r.y<0||r.y>=H||!Number.isInteger(r.edge)||r.edge<2||r.edge>W-1)fail('The shoreline must stay inside the map.',400);undo.shore??={};if(!(r.y in undo.shore))undo.shore[r.y]=f.shore[r.y];f.shore[r.y]=r.edge;}
   }else if(op.layer==='mist'){
    if(!f.mist||!Array.isArray(f.mist.rows))fail('This map has no mist layer.',400);
    undo.mistTiles??=f.mist.tiles??null;for(const c of op.cells){if(!inside(c.x,c.y))fail('Mist cell '+c.x+','+c.y+' is outside the map.',400);const v=String(c.v)==='1'?'1':'0',row=String(f.mist.rows[c.y]??'').padEnd(W,'0').slice(0,W);undo.rows.mist??={};if(!(c.y in undo.rows.mist))undo.rows.mist[c.y]=f.mist.rows[c.y]??null;f.mist.rows[c.y]=row.slice(0,c.x)+v+row.slice(c.x+1);}
    if(typeof f.mist.tiles==='number')f.mist.tiles=f.mist.rows.reduce((n,row)=>n+(row.match(/1/g)??[]).length,0);
   }else if(op.layer==='crater'){
    if(theme!=='caldera'||!f.crater)fail('Only Emberfall Caldera has a crater.',400);const c=op.crater;
    if(!Number.isInteger(c.x)||!Number.isInteger(c.y)||!Number.isInteger(c.r)||c.r<2||c.r>30||c.x-c.r<2||c.x+c.r>W-3||c.y-c.r<2||c.y+c.r>H-3)fail('The crater must fit inside the map (radius 2 to 30).',400);
    undo.crater??={crater:{...f.crater},heat:f.heat?{...f.heat}:null};const grow=c.r-f.crater.r;f.crater={...f.crater,x:c.x,y:c.y,r:c.r};if(f.heat)f.heat={...f.heat,x:c.x,y:c.y,radius:Math.max(c.r+1,(f.heat.radius??c.r+14)+grow)};
   }else fail('Unknown layer '+op.layer+'.',400);
   return;
  }
  if(op.kind==='exit'){ // Slide a wall-gap crossing along its wall, or move a warp pad; arrivals follow it.
   if(kind!=='dive'){if(op.op==='add')fail('Hubs cannot open new crossings; move one of their doors or gates instead.',400);moveHubDoor(f,op,undo,touched,rules.doors??[]);return;}
   const to=op.to;if(!Number.isInteger(to?.x)||!Number.isInteger(to?.y))fail('Choose a tile for the exit.',400);
   if(op.op==='add'){ // A brand-new crossing to a neighbour the travel rules already allow (a linked wilderness route, a hub, or a zone this map already opens onto).
    if(rules.destinations&&!rules.destinations.includes(op.zone))fail('This map cannot open onto '+op.zone+'. Crossings only lead to linked wilderness routes, hubs, or neighbours it already reaches.',400);
    f.exits??=[];const added={id:'patch-'+op.id,zone:op.zone,name:String(op.name??op.zone).slice(0,60),style:op.style==='warp'?'warp':'gap'};undo.exitsAdded.push(added.id);
    if(added.style==='gap'){
     const side=op.side;if(!['left','right','top','bottom'].includes(side))fail('Choose which wall the gate opens in.',400);const vertical=side==='left'||side==='right',w=vertical?1:2,h=vertical?2:1,edge=side==='left'||side==='top'?0:(vertical?f.width-1:f.height-1);
     const along=vertical?to.y:to.x,len=vertical?h:w,limit=vertical?f.height:f.width;if(along<1||along+len>limit-1)fail('A gate must stay between the corners.',400);
     const rect={x:vertical?edge:along,y:vertical?along:edge,w,h};if((f.exits??[]).some(e=>footprint({x:rect.x,y:rect.y,span_w:w,span_h:h}).some(c=>inExit(e,c.x,c.y))))fail('Another crossing already opens there.',400);
     Object.assign(added,rect,{side});f.exits.push(added);const entry=openGate(f,added,undo,touched);const safe={x:rect.x,y:rect.y,w,h};f.safeRooms??=[];f.safeRooms.push(safe);undo.safeRoomsAdded.push(safe); // Like openExitGaps: roaming enemies, loot and mist never occupy the opening.
     if(!f.entries?.[op.zone]){f.entries??={};f.entries[op.zone]={...entry};undo.entriesAdded.push(op.zone);} // Arrivals from the new neighbour stand just inside the gate unless this map already had an arrival for them.
     if(!flood(f,[f.entrance]).has(key(entry.x,entry.y)))fail('The new gate at '+rect.x+','+rect.y+' does not connect to the rest of the map; open a path to it first.');
    }else{
     if(!walkable(f,to.x,to.y)||to.x<1||to.y<1||to.x>f.width-2||to.y>f.height-2)fail('Place the pad on a walkable tile inside the map'+(blockedBy(f,to.x,to.y)?' ('+to.x+','+to.y+' is under '+blockedBy(f,to.x,to.y)+').':'.'),400);
     const neighbour=[[0,1],[0,-1],[1,0],[-1,0]].map(([dx,dy])=>({x:to.x+dx,y:to.y+dy})).find(p=>walkable(f,p.x,p.y));if(!neighbour)fail('The pad needs a walkable neighbour for arrivals.',400);
     Object.assign(added,{x:to.x,y:to.y});f.exits.push(added);const rect={x:to.x-1,y:to.y,w:3,h:2};f.safeRooms??=[];f.safeRooms.push(rect);undo.safeRoomsAdded.push(rect);touched.push({...to});
     if(!f.entries?.[op.zone]){f.entries??={};f.entries[op.zone]={...neighbour};undo.entriesAdded.push(op.zone);}
     if(!flood(f,[f.entrance]).has(key(neighbour.x,neighbour.y)))fail('The new pad at '+to.x+','+to.y+' does not connect to the rest of the map.');
    }
    return;
   }
   const exit=(f.exits??[]).find(e=>op.exit?e.id===op.exit:e.zone===op.zone);if(!exit)fail('This map has no exit to '+(op.exit??op.zone)+'.',400);
   undo.exits.push({id:exit.id,zone:exit.zone,x:exit.x,y:exit.y,entry:f.entries?.[exit.zone]?{...f.entries[exit.zone]}:null,entrance:{...f.entrance}});
   const swapSafe=(oldRect,newRect)=>{if(oldRect){const hit=(f.safeRooms??[]).find(r=>r.x===oldRect.x&&r.y===oldRect.y&&r.w===oldRect.w&&r.h===oldRect.h);if(hit){f.safeRooms=f.safeRooms.filter(r=>r!==hit);undo.safeRoomsRemoved.push(hit);}}if(newRect){f.safeRooms??=[];f.safeRooms.push(newRect);undo.safeRoomsAdded.push(newRect);}};
   const retarget=entry=>{const old=f.entries?.[exit.zone];if(old&&f.entrance&&f.entrance.x===old.x&&f.entrance.y===old.y)f.entrance={...entry};if(f.entries)f.entries[exit.zone]={...entry};}; // The default arrival follows the crossing it stood in.
   if(exit.style==='gap'){
    const vertical=exit.side==='left'||exit.side==='right',w=exit.w??1,h=exit.h??1,edge=vertical?exit.x:exit.y;
    if(vertical?to.x!==edge:to.y!==edge)fail('A gate can only slide along its own wall.',400);
    const along=vertical?to.y:to.x,len=vertical?h:w,limit=vertical?f.height:f.width;if(along<1||along+len>limit-1)fail('A gate must stay between the corners.',400);
    const inward={left:[1,0],right:[-1,0],top:[0,1],bottom:[0,-1]}[exit.side]??[0,0],others=(f.exits??[]).filter(e=>e!==exit);
    for(const c of footprint({x:exit.x,y:exit.y,span_w:w,span_h:h})){if(others.some(e=>inExit(e,c.x,c.y)))continue;remember(undo,f,c.x,c.y);f.walls[c.y][c.x]=1;touched.push(c);} // The old opening closes unless another crossing shares it.
    const rect={x:vertical?edge:along,y:vertical?along:edge,w,h};swapSafe({x:exit.x,y:exit.y,w,h},rect);Object.assign(exit,{x:rect.x,y:rect.y});const entry=openGate(f,exit,undo,touched);retarget(entry);
    if(!flood(f,[f.entrance]).has(key(entry.x,entry.y)))fail('The moved gate at '+rect.x+','+rect.y+' does not connect to the rest of the map; open a path to it first.');
   }else{
    if(!walkable(f,to.x,to.y)||to.x<1||to.y<1||to.x>f.width-2||to.y>f.height-2)fail('Place the pad on a walkable tile inside the map'+(blockedBy(f,to.x,to.y)?' ('+to.x+','+to.y+' is under '+blockedBy(f,to.x,to.y)+').':'.'),400);
    const neighbour=[[0,1],[0,-1],[1,0],[-1,0]].map(([dx,dy])=>({x:to.x+dx,y:to.y+dy})).find(p=>walkable(f,p.x,p.y)&&!(p.x===exit.x&&p.y===exit.y));if(!neighbour)fail('The pad needs a walkable neighbour for arrivals.',400);
    swapSafe({x:exit.x-1,y:exit.y,w:3,h:2},{x:to.x-1,y:to.y,w:3,h:2});Object.assign(exit,{x:to.x,y:to.y});retarget(neighbour);touched.push({...to});
    if(!flood(f,[f.entrance]).has(key(neighbour.x,neighbour.y)))fail('The moved pad at '+to.x+','+to.y+' does not connect to the rest of the map.');
   }
   return;
  }
  fail('Unknown patch operation '+op.kind+'.',400);
 }
 function openGate(f,exit,undo,touched){ // Open a wall gap at exit's rect plus one tile inside it, then carve straight inward (like openExitGaps) until it meets floor already joined to the entrance; scenery in the corridor is cleared. Returns the arrival tile.
  const w=exit.w??1,h=exit.h??1,inward={left:[1,0],right:[-1,0],top:[0,1],bottom:[0,-1]}[exit.side]??[0,0],cells=footprint({x:exit.x,y:exit.y,span_w:w,span_h:h});
  for(const c of cells){remember(undo,f,c.x,c.y);f.walls[c.y][c.x]=0;touched.push(c);const inner={x:c.x+inward[0],y:c.y+inward[1]};remember(undo,f,inner.x,inner.y);f.walls[inner.y][inner.x]=0;if(f.props?.[inner.y])f.props[inner.y][inner.x]=0;touched.push(inner);}
  const entry={x:cells[0].x+inward[0],y:cells[0].y+inward[1]},origin=f.entrance??f.spawn;let reach=flood(f,[origin]),probe={...entry},carved=0;
  while(!reach.has(key(probe.x,probe.y))&&carved<10){probe={x:probe.x+inward[0],y:probe.y+inward[1]};if(probe.x<1||probe.y<1||probe.x>f.width-2||probe.y>f.height-2)break;for(const c of cells){const cell={x:probe.x+(c.x-cells[0].x),y:probe.y+(c.y-cells[0].y)};if(cell.x<1||cell.y<1||cell.x>f.width-2||cell.y>f.height-2)continue;remember(undo,f,cell.x,cell.y);f.walls[cell.y][cell.x]=0;if(f.props?.[cell.y])f.props[cell.y][cell.x]=0;touched.push(cell);}carved++;reach=flood(f,[origin]);}
  if(carved){const cut=new Set(touched.map(t=>key(t.x,t.y)));for(const d of [...(f.decorations??[])])if(footprint(d).some(c=>cut.has(key(c.x,c.y)))){f.decorations=f.decorations.filter(x=>x!==d);undo.decorationsRemoved.push(d);for(const c of footprint(d)){remember(undo,f,c.x,c.y);if(f.props?.[c.y])f.props[c.y][c.x]=0;}}}
  return entry;
 }
 const movedGaps=(f,doors)=>doors.filter(d=>d.style==='gap'&&f.portalMoves?.[d.key]).map(d=>({...d,...f.portalMoves[d.key]})); // Wall openings a GM moved: the outer-wall check must allow them.
 function moveHubDoor(f,op,undo,touched,doors){ // Hubs: slide a gate or a room's way out along its own wall, move a doorstep to another floor tile, or move a building's street doorway round that building's walls. The new place is kept in f.portalMoves, which hubs.mjs applies wherever doors are read; the terrain changes go in the undo log like any painted cell.
  const base=doors.find(d=>d.key===(op.exit||op.zone))??doors.find(d=>!op.exit&&d.target===op.zone),k=base?.key??(op.exit||op.zone); // By key, or by where it leads (a room's way out leads to its parent).if(!base)fail('This map has no door '+k+' to move.',400);
  const to=op.to;if(!Number.isInteger(to?.x)||!Number.isInteger(to?.y))fail('Choose a tile for the door.',400);
  const at=d=>({...d,...(f.portalMoves?.[d.key]??{})}),cur=at(base),others=doors.filter(d=>d.key!==k).map(at),w=base.w??1,h=base.h??1;
  undo.portalMoves??={};if(!(k in undo.portalMoves))undo.portalMoves[k]=f.portalMoves?.[k]?{...f.portalMoves[k]}:null;
  const seal=(x,y,along)=>{remember(undo,f,x,y);f.walls[y][x]=1;if(grid(f,'wallTiles')&&!f.wallTiles[y][x]){const n=along.map(([dx,dy])=>({x:x+dx,y:y+dy})).find(c=>f.walls[c.y]?.[c.x]&&f.wallTiles[c.y]?.[c.x]);if(n)f.wallTiles[y][x]=f.wallTiles[n.y][n.x];}touched.push({x,y});}; // A closed opening borrows the wall art beside it.
  const pave=cells=>{if(!grid(f,'floors'))return;for(let pass=0;pass<12;pass++){let left=false;for(const c of cells){if(f.walls[c.y][c.x]||f.floors[c.y][c.x])continue;const n=[[0,-1],[-1,0],[1,0],[0,1]].map(([dx,dy])=>({x:c.x+dx,y:c.y+dy})).find(p=>!f.walls[p.y]?.[p.x]&&f.floors[p.y]?.[p.x]);if(n)f.floors[c.y][c.x]=f.floors[n.y][n.x];else left=true;}if(!left)break;}}; // New openings take the floor art next to them.
  let place={x:to.x,y:to.y};
  if(base.style==='doorway'){ // A generated building's street door: any outer wall tile of the same building except a corner, with a room behind it and walkable street in front.
   const b=base.building,inBuilding=to.x>=b.x&&to.y>=b.y&&to.x<b.x+b.w&&to.y<b.y+b.h,side=!inBuilding?null:to.x===b.x?[1,0]:to.x===b.x+b.w-1?[-1,0]:to.y===b.y?[0,1]:to.y===b.y+b.h-1?[0,-1]:null;
   const corner=(to.x===b.x||to.x===b.x+b.w-1)&&(to.y===b.y||to.y===b.y+b.h-1);
   if(!side||corner)fail('A doorway stays in its own building\'s outer wall, away from the corners.',400);
   if(to.x===cur.x&&to.y===cur.y)return;
   const inner={x:to.x+side[0],y:to.y+side[1]},outer={x:to.x-side[0],y:to.y-side[1]};
   if(!f.walls[to.y][to.x])fail('That wall is already open.',400);
   if(f.walls[inner.y][inner.x]||!walkable(f,outer.x,outer.y))fail('A doorway needs a room behind it and open street in front of it.',400);
   const tint=f.wallTiles?.[to.y]?.[to.x]??0;
   remember(undo,f,cur.x,cur.y);f.walls[cur.y][cur.x]=1;if(grid(f,'wallTiles'))f.wallTiles[cur.y][cur.x]=tint;touched.push({x:cur.x,y:cur.y});
   remember(undo,f,to.x,to.y);f.walls[to.y][to.x]=0;if(grid(f,'wallTiles'))f.wallTiles[to.y][to.x]=0;if(grid(f,'floors'))f.floors[to.y][to.x]=f.floors[inner.y][inner.x];touched.push({...to});
  }else if(base.style==='gap'){ // A town gate or a room's wall opening: slides along its own wall, keeps its size, and carves inward until it meets the map.
   const vertical=base.side==='left'||base.side==='right',edge=vertical?cur.x:cur.y;
   if(vertical?to.x!==edge:to.y!==edge)fail('A gate can only slide along its own wall.',400);
   const along=vertical?to.y:to.x,limit=vertical?f.height:f.width;if(along<1||along+(vertical?h:w)>limit-1)fail('A gate must stay between the corners.',400);
   const rect={...cur,x:vertical?edge:along,y:vertical?along:edge,w,h,side:base.side};place={x:rect.x,y:rect.y};
   if(rect.x===cur.x&&rect.y===cur.y)return;
   if(footprint({x:rect.x,y:rect.y,span_w:w,span_h:h}).some(c=>others.some(o=>inExit(o,c.x,c.y))))fail('Another door already opens there.',400);
   const wall=vertical?[[0,-1],[0,1]]:[[-1,0],[1,0]];for(const c of footprint({x:cur.x,y:cur.y,span_w:w,span_h:h}))if(!others.some(o=>inExit(o,c.x,c.y))&&!inExit(rect,c.x,c.y))seal(c.x,c.y,wall); // The old opening closes unless another door shares it.
   const opened=[],entry=openGate(f,rect,undo,opened);for(const c of opened)if(grid(f,'wallTiles')&&!f.walls[c.y][c.x])f.wallTiles[c.y][c.x]=0;pave(opened);touched.push(...opened);
   if(!flood(f,[f.spawn]).has(key(entry.x,entry.y)))fail('The moved gate at '+rect.x+','+rect.y+' does not connect to the rest of the map; open a path to it first.');
  }else{ // A doorstep (a plaza building, a storefront) or a room's door tile: any walkable floor tile inside the walls that can be reached.
   if(to.x<1||to.y<1||to.x>f.width-2||to.y>f.height-2||!walkable(f,to.x,to.y))fail('Put the door on a walkable floor tile inside the walls'+(blockedBy(f,to.x,to.y)?' ('+to.x+','+to.y+' is under '+blockedBy(f,to.x,to.y)+').':'.'),400);
   if(others.some(o=>inExit(o,to.x,to.y)))fail('Another door already opens there.',400);
   if(!flood(f,[f.spawn]).has(key(to.x,to.y)))fail('The door at '+to.x+','+to.y+' cannot be reached from the arrival tile.');
   touched.push({...to});
  }
  f.portalMoves={...(f.portalMoves??{}),[k]:place};
 }
 function revert(f,kind){ // Undo the previous application using the floor's own log, so a new revision starts from the generated layout.
  const undo=f.patchUndo;if(!undo)return false;
  for(const c of undo.cells){if(!(c.y in f.walls))continue;f.walls[c.y][c.x]=c.wall;if(c.prop!==null&&f.props?.[c.y])f.props[c.y][c.x]=c.prop;if(c.floor!==null&&grid(f,'floors'))f.floors[c.y][c.x]=c.floor;if(c.wallTile!==null&&grid(f,'wallTiles'))f.wallTiles[c.y][c.x]=c.wallTile;if(c.decor!==null&&grid(f,'decorTiles'))f.decorTiles[c.y][c.x]=c.decor;if(c.tree!==null&&grid(f,'treeTiles'))f.treeTiles[c.y][c.x]=c.tree;}
  for(const e of [...(undo.exits??[])].reverse()){const exit=(f.exits??[]).find(x=>e.id?x.id===e.id:x.zone===e.zone);if(exit)Object.assign(exit,{x:e.x,y:e.y});if(e.entry&&f.entries)f.entries[e.zone]={...e.entry};f.entrance={...e.entrance};} // Crossings return to their generated tiles, latest move first.
  const addedExits=new Set(undo.exitsAdded??[]);if(addedExits.size)f.exits=(f.exits??[]).filter(e=>!addedExits.has(e.id));for(const zone of undo.entriesAdded??[])if(f.entries)delete f.entries[zone]; // Crossings the patch created disappear with it.
  for(const [name,rows] of Object.entries(undo.rows??{})){const target=name==='mist'?f.mist?.rows:f[name];if(!target)continue;for(const [y,row] of Object.entries(rows))if(row===null)delete target[y];else target[y]=row;}
  for(const name of undo.created??[])delete f[name];if(undo.shore)for(const [y,edge] of Object.entries(undo.shore))f.shore[y]=edge;if(undo.mistTiles!==undefined&&undo.mistTiles!==null&&f.mist)f.mist.tiles=undo.mistTiles;if(undo.crater){f.crater={...undo.crater.crater};if(undo.crater.heat)f.heat={...undo.crater.heat};}
  if(kind==='dive'){const added=new Set(undo.decorationsAdded);f.decorations=(f.decorations??[]).filter(d=>!added.has(d.id));f.decorations.push(...undo.decorationsRemoved);const addedRooms=new Set(undo.safeRoomsAdded.map(r=>key(r.x,r.y)+'|'+r.w+'x'+r.h));f.safeRooms=(f.safeRooms??[]).filter(r=>!addedRooms.has(key(r.x,r.y)+'|'+r.w+'x'+r.h));f.safeRooms.push(...undo.safeRoomsRemoved);if(undo.entrance)f.entrance={...undo.entrance};for(const [zone,p] of Object.entries(undo.entries??{}))if(f.entries)f.entries[zone]={...p};}
  else {const added=new Set(undo.fixturesAdded);f.fixtures=(f.fixtures??[]).filter(d=>!added.has(d.id));f.fixtures.push(...undo.fixturesRemoved.filter(r=>!f.fixtures.some(d=>d.id===r.id))); /* A fixture an upgrade step already put back (hub-districts addCauldron) is not restored twice: two toilets on one tile made the stored remove fail forever. */if(undo.spawn)f.spawn={...undo.spawn};}
  for(const [k,v] of Object.entries(undo.portalMoves??{})){if(v)(f.portalMoves??={})[k]={...v};else if(f.portalMoves)delete f.portalMoves[k];}if(f.portalMoves&&!Object.keys(f.portalMoves).length)delete f.portalMoves; // Hub doors return to their code-defined places.
  delete f.patchUndo;delete f.patchRevision;delete f.patchSkipped;return true;
 }
 const editionMatches=(op,f)=>!Array.isArray(op.editions)||op.editions.includes(f.edition)||op.editions.includes(f.district?.layoutKey); // Ops may be pinned to specific editions; the default applies everywhere.
 function apply(zone,floor,{strict=false,kind='dive',openings:extraOpenings=[],doors=[],destinations=null}={}){ // doors (hubs): every movable door at its code-defined place (hubs.mjs hubDoors). // Mutates floor in place; returns true when geometry changed. strict: any failing op throws (GM actions); otherwise failing ops are skipped and listed in floor.patchSkipped (ticks and regeneration).
  const patch=get(zone);if(floor.patchRevision===patch.revision)return false;
  const work=structuredClone(floor),reverted=revert(work,kind),undo={cells:[],cellIndex:new Set(),decorationsRemoved:[],decorationsAdded:[],fixturesRemoved:[],fixturesAdded:[],safeRoomsRemoved:[],safeRoomsAdded:[],entrance:null,spawn:null,entries:{},exits:[],exitsAdded:[],entriesAdded:[],rows:{},created:[],shore:null,mistTiles:null,crater:null,portalMoves:{}},skipped=[];let applied=0;
  for(const op of patch.ops){
   if(!editionMatches(op,work))continue;
   const trial=structuredClone(work),trialUndo=structuredClone({...undo,cellIndex:[...undo.cellIndex]}),touched=[];trialUndo.cellIndex=new Set(trialUndo.cellIndex);
   try{applyOp(trial,op,kind,trialUndo,touched,{destinations,doors});validate(trial,kind,kind==='dive'?extraOpenings:[...extraOpenings,...movedGaps(trial,doors)],touched,op.kind==='cells'?work:null);}
   catch(error){if(strict)fail((error.message??String(error))+' (change: '+describe(op)+')',error.status??409,error.code??'world_patch_rejected');skipped.push({id:op.id,reason:error.message});continue;}
   Object.assign(work,trial);Object.assign(undo,trialUndo);applied++;
  }
  undo.cellIndex=undefined;delete undo.cellIndex;work.patchRevision=patch.revision;work.patchUndo=undo;if(skipped.length)work.patchSkipped=skipped;else delete work.patchSkipped;
  const changed=reverted||applied>0;if(changed)work.geometryVersion=(work.geometryVersion??0)+1; // Connected clients rebuild collision and the minimap.
  for(const k of Object.keys(floor))if(!(k in work))delete floor[k];Object.assign(floor,work);return changed;
 }
 const describe=op=>op.kind==='cells'?'paint '+op.cells.length+' cell(s)':op.kind==='decoration'?(op.op==='remove'?'remove ':'stamp ')+(op.decoration?.sprite??op.match?.sprite??'scenery'):op.kind==='safeRoom'?(op.op==='remove'?'remove':'add')+' safe room':op.kind==='spawn'?'move arrival':op.kind==='layer'?'paint '+op.layer:op.kind==='exit'?(op.op==='add'?'add a crossing to '+op.zone:'move the '+(op.exit&&!op.zone?'door '+op.exit:'exit to '+op.zone)):op.kind==='fixture'?(op.op==='add'?'place '+(FURNITURE[op.furniture]?.label??op.furniture):(op.op==='remove'?'remove ':'move ')+op.match.kind+' '+op.match.id):op.kind;
 function view(zone,floor){const p=get(zone);return {revision:p.revision,ops:p.ops,history:history(zone),skipped:floor?.patchSkipped??[],updated:p.updated,actor:p.actor};} // What the Map Editor shows in its Patch layer panel.

 function normalizeOps(list){ // Validate the shape of incoming ops before they are stored; geometry rules run in apply().
  if(!Array.isArray(list)||!list.length||list.length>64)fail('Send between 1 and 64 changes at a time.',400);
  return list.map(raw=>{
   if(!raw||typeof raw!=='object')fail('Malformed change.',400);const id=typeof raw.id==='string'&&/^[A-Za-z0-9_-]{4,64}$/.test(raw.id)?raw.id:randomUUID(),note=typeof raw.note==='string'?raw.note.slice(0,120):undefined,editions=Array.isArray(raw.editions)?raw.editions.map(String).slice(0,8):undefined;
   const base={id,kind:raw.kind,...(note?{note}:{}),...(editions?{editions}:{})};
   if(raw.kind==='cells'){if(!Array.isArray(raw.cells)||!raw.cells.length||raw.cells.length>MAX_CELLS)fail('A cells change needs 1 to '+MAX_CELLS+' cells.',400);return {...base,cells:raw.cells.map(c=>{const cell={x:Number(c.x),y:Number(c.y)};for(const k of ['wall','prop','floor','wallTile','decor','tree'])if(c[k]!==undefined&&c[k]!==null)cell[k]=Number(c[k]);if(Object.keys(cell).length===2)fail('A cell change must set wall, prop or a tile.',400);return cell;})};}
   if(raw.kind==='decoration'){if(raw.op==='remove'){const m=raw.match??{};return {...base,op:'remove',match:{...(m.id?{id:String(m.id).slice(0,80)}:{}),sprite:String(m.sprite??''),x:Number(m.x),y:Number(m.y)}};}const d=raw.decoration??{};return {...base,op:'add',decoration:{sprite:String(d.sprite??''),x:Number(d.x),y:Number(d.y),span_w:Number(d.span_w??1),span_h:Number(d.span_h??1),solid:d.solid!==false,...(d.toilet?{toilet:true}:{})}};}
   if(raw.kind==='safeRoom'){const r=raw.rect??{};return {...base,op:raw.op==='remove'?'remove':'add',rect:{x:Number(r.x),y:Number(r.y),w:Number(r.w),h:Number(r.h)}};}
   if(raw.kind==='layer'){const layer=String(raw.layer??'');if(!['cover','wash','shore','mist','crater'].includes(layer))fail('Unknown layer '+layer+'.',400);const out={...base,layer};if(layer==='shore'){if(!Array.isArray(raw.rows)||!raw.rows.length||raw.rows.length>512)fail('A shoreline change needs 1 to 512 rows.',400);out.rows=raw.rows.map(r=>({y:Number(r.y),edge:Number(r.edge)}));}else if(layer==='crater'){const c=raw.crater??{};out.crater={x:Number(c.x),y:Number(c.y),r:Number(c.r)};}else{if(!Array.isArray(raw.cells)||!raw.cells.length||raw.cells.length>MAX_CELLS)fail('A layer change needs 1 to '+MAX_CELLS+' cells.',400);out.cells=raw.cells.map(c=>({x:Number(c.x),y:Number(c.y),v:String(c.v??'1').slice(0,1)}));}return out;}
   if(raw.kind==='exit'){const to=raw.to??{};if(raw.op==='add')return {...base,op:'add',zone:String(raw.zone??'').slice(0,80),name:String(raw.name??'').slice(0,60),style:raw.style==='warp'?'warp':'gap',...(raw.side?{side:String(raw.side)}:{}),to:{x:Number(to.x),y:Number(to.y)}};return {...base,op:'move',...(raw.exit?{exit:String(raw.exit).slice(0,80)}:{}),zone:String(raw.zone??'').slice(0,80),to:{x:Number(to.x),y:Number(to.y)}};}
   if(raw.kind==='spawn'){const out={...base};if(raw.entrance)out.entrance={x:Number(raw.entrance.x),y:Number(raw.entrance.y)};if(raw.entries&&typeof raw.entries==='object')out.entries=Object.fromEntries(Object.entries(raw.entries).slice(0,8).map(([z,p])=>[String(z).slice(0,80),{x:Number(p.x),y:Number(p.y)}]));if(!out.entrance&&!out.entries)fail('A spawn change needs an entrance or entries.',400);return out;}
   if(raw.kind==='fixture'){const m=raw.match??{},to=raw.to??{};
    if(raw.op==='add'){const furniture=String(raw.furniture??'');if(!Object.hasOwn(FURNITURE,furniture))fail('Choose furniture to place.',400);return {...base,op:'add',furniture,to:{x:Number(to.x),y:Number(to.y)}};}
    const id=String(m.id??'').slice(0,80),kind=String(m.kind??'');if(!id||!MOVABLE_FIXTURES.has(kind))fail('Choose furniture or a service to move.',400);
    return raw.op==='remove'?{...base,op:'remove',match:{id,kind}}:{...base,op:'move',match:{id,kind},to:{x:Number(to.x),y:Number(to.y)}};}
   fail('Unknown change kind '+raw.kind+'.',400);
  });
 }
 function act(input,{zone,floor,kind,openings,doors=[],actor,commit,destinations=null}){ // GM actions from gm.mjs (inside BEGIN IMMEDIATE). commit(floor): the caller saves the floor, re-realizes placements and relocates occupants; a throw rolls everything back.
  const current=get(zone);if(Number(input.patch_revision)!==current.revision)fail('The patch layer changed. Refresh before editing.');
  let ops;
  if(input.action==='world_patch_apply')ops=[...current.ops,...normalizeOps(input.ops)].slice(-MAX_OPS);
  else if(input.action==='world_patch_remove'){ops=current.ops.filter(op=>op.id!==input.op);if(ops.length===current.ops.length)fail('That change is no longer stored.');}
  else if(input.action==='world_patch_rollback'){const row=db.prepare('SELECT body FROM world_floor_patch_history WHERE zone=? AND revision=?').get(zone,Number(input.target_revision));if(!row)fail('That patch revision does not exist.');ops=JSON.parse(row.body).ops??[];}
  else if(input.action==='world_patch_clear')ops=[];
  else fail('Unknown patch action.',400);
  db.exec('SAVEPOINT world_patch'); // Self-contained even outside gm.mjs's transaction: a refused change never leaves a stored revision behind.
  try{store(zone,ops,actor);apply(zone,floor,{strict:true,kind,openings,doors,destinations});commit(floor);db.exec('RELEASE world_patch');} // apply() throws with the offending change named.
  catch(error){db.exec('ROLLBACK TO world_patch');db.exec('RELEASE world_patch');throw error;}
  return view(zone,floor);
 }
 return {get,revision,history,view,apply,act,walkable,flood};
}
