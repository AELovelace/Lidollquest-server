// Shared tile chooser: which 32px atlas cell (and tint) paints each map square. Mirrors the client's painters
// (scripts/scrTilePainter/scrTilePainter.gml tundra/plains/caldera/spa/coast/gulch/camp/farmstead formulas,
// scrOnlineRoom.gml online_district_paint/online_courtyard_paint/online_industrial_terrain_draw/online_caverns_terrain_draw,
// scrOnlineHubs.gml online_town_terrain_draw) so the server's PNG (map-render.mjs) and the GM Map Editor draw the same picture.
// Browser-safe on purpose: no imports, no Node APIs, every // comment ends its line. gm.mjs splices this file into the
// Map Editor page after stripping the leading `export ` keywords, so keep every export at the start of its line.
// Themes the client paints from random pools (desert, forest, dungeon, mansion, nursery, school, hospital, princess quarters,
// generic hub halls) are approximated with a per-cell hash pick from the same pools: stable, close, not pixel-identical.
// Time-based effects are frozen: caldera lava bubble 0, coast at low tide, gulch wash dry, caverns at ebb.

export const TILE_SIZE=32; // Every atlas is a grid of 32px cells; columns = atlas width / 32 (all shipped atlases are 320 wide = 10 columns).
export const TERRAIN_THEMES=['tundra','taiga','high_desert','autumn_plains','caldera','spa','coast','gulch','camp','farmstead','coastal_caverns','arcadia_factory','arcadia_dockyard']; // Formula painters mirrored exactly.
export const POOL_THEMES={ // Client irandom pools (scrTilePainter.gml macros) and the atlas each theme uses; block = floor variants chosen per NxN block like the campaign painters.
 dungeon:{atlas:'sprTileDungeon',floor:[1,1,1,1,2,2,3,4,5],wall:[10,10,10,10,11,11,12,13,14],block:1},
 forest:{atlas:'sprTileForest',floor:[1,1,1,1,2,2,3,3,4,5],wall:[10,10,10,10,11,11,12,13,14],block:1},
 mansion:{atlas:'sprTileMansion',floor:[1,1,1,2,2,3,3,4,6,7,9],wall:[10,10,10,11,11,12,13,15,16,17,18,19],block:1},
 desert_dungeon:{atlas:'sprTileDesert',floor:[1,1,1,2,2,3,4,5,6,7,8,9],wall:[10,10,10,11,11,12,13,14,15,16,17,18,19],block:1},
 nursery:{atlas:'sprTileAutoNursery',floor:[1,1,1,2,2,3,3,4,5,6,7],wall:[10,10,10,11,11,12,13,14],block:1},
 school:{atlas:'sprTileSchool',floor:[1,1,1,2,2,3,3,5],wall:[10,10,10,11,11,12,14],block:1},
 hospital:{atlas:'sprTileHospital',floor:[1,1,1,3],wall:[10,10,11,15],block:5},
 princess_quarters:{atlas:'sprTilePrincessQuarters',floor:[1,1,1,1,2,2,3,5],wall:[10,10,10,12,12,14],border:[10,10,11,13,14],block:4},
 town:{atlas:'sprTileTown',floor:[1,1,1,1,2,2,3,4,5,8],wall:[10,10,10,11,11,12,13,14,15],border:[34,34,34,35,36,37],block:3},
 city:{atlas:'sprTileCity',floor:[1,1,4,4,5,5],wall:[36,36,36,31,33,39],block:1},
 utopia:{atlas:'sprTileUtopia',floor:[2,2,2,3],wall:[10,11,12,13,14,15,16],border:[17],block:1},
 arcadia:{atlas:'sprTileArcadia',floor:[4,4,4,5],wall:[10,11,12,13,14,15,16],border:[17],block:1},
};
const HUB_THEME_POOL={rose:'princess_quarters',lantern:'town',clockwork:'city',arcanum:'utopia',foundry:'arcadia'}; // Generic hub halls (no tile grids) by the hub family's theme word.
const CAVERN_WALL_TINT=[155,180,185],CAVERN_FLOOR_TINT=[190,205,210],CAVERN_EBB_FILL=[45,125,170,56]; // online_caverns_terrain_draw colours; 56 = alpha 0.22.

export function hashPick(pool,x,y,salt){return pool[(((x*73856093)^(y*19349663)^((salt??0)*83492791))>>>0)%pool.length];} // Deterministic per cell; stands in for the client's irandom so the picture never flickers between renders.
export function atlasForTileset(name,tilesets){return (tilesets&&tilesets[name])||(typeof name==='string'&&name.startsWith('tile')?'spr'+name.charAt(0).toUpperCase()+name.slice(1):name);} // tileTown -> sprTileTown via tile-artwork.json's map, else by naming convention.
export function atlasColumns(name,widths){const width=widths&&widths[name];return width?Math.max(1,Math.floor(width/TILE_SIZE)):10;} // Columns from the artwork manifest; every shipped atlas is 10 wide.
export function tileCell(tile,columns){return {sx:(tile%columns)*TILE_SIZE,sy:Math.floor(tile/columns)*TILE_SIZE};} // Pixel origin of atlas cell n.

export function paintPlan(floor){ // What kind of painting this floor gets and which layers a GM may edit on it.
 if(!floor)return {mode:'none',theme:'',atlases:[],supports:{}};
 const grids=Array.isArray(floor.floors),theme=String(floor.theme??''),hubPool=HUB_THEME_POOL[theme];
 const mode=grids?(floor.district?'district':'authored'):floor.camp?'camp':floor.farmstead?'farmstead':TERRAIN_THEMES.includes(theme)?'terrain':POOL_THEMES[theme]?'pool':hubPool?'hub':'pool';
 const atlases=new Set();
 if(mode==='district')atlases.add(atlasForTileset(floor.district.tileset,floor.tilesetMap));
 else if(mode==='authored'){for(const key of ['floor','decor','trees','wall'])if(floor.tilesets&&floor.tilesets[key])atlases.add(atlasForTileset(floor.tilesets[key],floor.tilesetMap));}
 else if(mode==='camp'||theme==='camp')atlases.add('sprTileGulch');
 else if(mode==='farmstead'||theme==='farmstead'||theme==='autumn_plains')atlases.add('sprTileAutumnPlains');
 else if(mode==='hub')atlases.add(POOL_THEMES[hubPool].atlas);
 else if(mode==='pool')atlases.add((POOL_THEMES[theme]??POOL_THEMES.princess_quarters).atlas);
 if(theme==='tundra'||theme==='taiga')atlases.add('sprTileTundra');
 if(theme==='taiga'||theme==='high_desert')atlases.add('sprTileForest');
 if(theme==='high_desert')atlases.add('sprTileDesert');
 if(theme==='caldera'||theme==='spa')atlases.add('sprTileCaldera');
 if(theme==='coast'||theme==='coastal_caverns'||theme==='arcadia_dockyard')atlases.add('sprTileCoast');
 if(theme==='gulch')atlases.add('sprTileGulch');
 if(theme==='arcadia_factory'||theme==='arcadia_dockyard')atlases.add('sprTileArcadia');
 const dive=!grids&&!floor.camp&&!floor.farmstead&&!hubPool;
 return {mode,theme,atlases:[...atlases],supports:{terrain:true,grids,cover:dive&&(theme==='autumn_plains'||theme==='coast'),wash:theme==='gulch',shore:theme==='coast',mist:!!(floor.mist&&floor.mist.rows),crater:theme==='caldera',decorations:dive,fixtures:!dive,safeRooms:dive,exits:dive}};
}

function isWall(floor,x,y){return !!(floor.walls&&floor.walls[y]&&floor.walls[y][x]);} // 1/true = solid terrain (props are scenery, painted over the floor).
function terrainLayers(floor,theme,x,y,ctx){ // The mirrored formula painters. Each returns [{atlas,tile,tint?}] bottom-to-top, or extra {fill:[r,g,b,a]} overlays.
 const wall=isWall(floor,x,y);
 if(theme==='tundra'||theme==='taiga'){
  const variant=(Math.floor(x/3)+Math.floor(y/3))%2;let atlas='sprTileTundra',tile=(wall?10:1)+variant;
  if(theme==='taiga'){const snow=Math.sin(x*0.24+Math.sin(y*0.13)*2)+Math.cos(y*0.28-x*0.08)>0.1;if(!snow){atlas='sprTileForest';tile=(wall?10:1)+((x*7+y*11)%5);}} // Wide snowfields over the woodland.
  return [{atlas,tile}];
 }
 if(theme==='high_desert'){
  const grove=Math.sin(x*0.19+Math.cos(y*0.17)*2)+Math.cos(y*0.23+x*0.11)>0.7;
  if(grove)return [{atlas:'sprTileForest',tile:(wall?10:1)+((x*7+y*11)%5)}]; // Juniper groves.
  return [{atlas:'sprTileDesert',tile:wall?10+((x*3+y*7)%10):1+((x*7+y*13)%9)}];
 }
 if(theme==='autumn_plains'){
  const wave=Math.sin(x*0.21+Math.cos(y*0.15)*2)+Math.cos(y*0.19-x*0.07);let tile;
  if(wall)tile=wave>0.6?17+((x*5+y*3)%3):10+((x*7+y*11)%7); // Tree canopies 10-16, bramble hedgerows 17-19.
  else if(wave>0.9)tile=7+((x*3+y*7)%3); // Bare dirt.
  else if(wave>0.2)tile=4+((x*7+y*13)%3); // Leaf litter.
  else tile=1+((x*7+y*13)%3); // Golden grass.
  const row=floor.cover&&floor.cover[y];if(!wall&&typeof row==='string'&&row.charAt(x)==='1')tile=20+((x*5+y*3)%4); // Tall-grass cover (plains-features.mjs).
  return [{atlas:'sprTileAutumnPlains',tile}];
 }
 if(theme==='caldera'){
  const crater=floor.crater,cx=crater?crater.x:-1000,cy=crater?crater.y:-1000,r=crater?crater.r:0,d=Math.hypot(x-cx,y-cy);let tile;
  if(wall)tile=d<=r+2.2?15+((x*3+y*5)%5):10+((x*5+y*3)%5); // Lava (bubble frame 0) inside the crater, obsidian crags elsewhere.
  else {const n=Math.sin(x*0.23+Math.cos(y*0.19)*2)+Math.cos(y*0.21-x*0.09);tile=d<=r+5?8+((x+y)%2):(n>0.9?4+((x+y)%2):(n<-1.1?6+((x*3+y)%2):1+((x*7+y*13)%3)));} // Glowing cracks round the rim, ash drifts, cooled crust, basalt.
  return [{atlas:'sprTileCaldera',tile}];
 }
 if(theme==='spa'){
  let tile;if(wall)tile=26+((x*5+y*3)%4);else {tile=20+((x+y*3)%4);for(const room of floor.rooms??[])if((room.type??'')==='changing'&&x>=room.x&&x<room.x+room.w&&y>=room.y&&y<room.y+room.h){tile=24+(x%2);break;}} // Obsidian walls, stone flags, cedar slats in the changing room.
  return [{atlas:'sprTileCaldera',tile}];
 }
 if(theme==='coast'){
  const edge=floor.shore&&y<floor.shore.length?floor.shore[y]:floor.width,reach=(ctx&&ctx.tideReach)??3,flat=!wall&&x>=edge-reach&&x<edge;let tile;
  if(wall)tile=x>=edge?(x===edge?14:10+((x*3+y*7)%4)):15+((x*5+y*3)%5); // Sea with a foam line at the shore, rocks inland.
  else if(flat)tile=5+((x+y)%2); // Wet sand the tide reaches (drawn at low tide).
  else {const n=(x*7+y*13)%17;tile=n===0?7:(n===1?8+(x%2):1+((x*3+y*5)%4));} // Dry sand, the odd shell and pebbles.
  return [{atlas:'sprTileCoast',tile}];
 }
 if(theme==='gulch'){
  const row=floor.wash&&floor.wash[y],inWash=!wall&&typeof row==='string'&&row.charAt(x)==='1';let tile;
  if(wall)tile=10+((x*5+y*3)%5); // Banded cliffs.
  else if(inWash)tile=8+((x+y)%2); // The wash's cracked mud (dry; floodwater is time-based).
  else {const n=Math.sin(x*0.21+Math.cos(y*0.17)*2)+Math.cos(y*0.23-x*0.11);tile=n>1.0?4+((x+y)%2):(n<-1.1?6+((x*3+y)%2):1+((x*7+y*13)%3));} // Caliche, gravel, red sand.
  return [{atlas:'sprTileGulch',tile}];
 }
 if(theme==='camp')return [{atlas:'sprTileGulch',tile:wall?26+((x*5+y*3)%4):(y>=11?24+((x+y)%2):20+((x+y*7)%4))}]; // Prospector's Camp: timber-shored rock, packed dirt in the hall, planks in the rooms.
 if(theme==='farmstead')return [{atlas:'sprTileAutumnPlains',tile:wall?27+((x*5+y*3)%3):24+((x+y*7)%3)}]; // Farmhouse: timber walls, floorboards.
 if(theme==='coastal_caverns'){
  const band=floor.caveChannels&&floor.caveChannels[y]?floor.caveChannels[y][x]:0,tile=wall?15+((x*5+y*3)%5):(band?5+((x+y)%2):8+((x+y*3)%2));
  const layers=[{atlas:'sprTileCoast',tile,tint:wall?CAVERN_WALL_TINT:CAVERN_FLOOR_TINT}];if(band)layers.push({fill:CAVERN_EBB_FILL});return layers; // Limestone over coast art; low channels get the ebb-tide water wash.
 }
 if(theme==='arcadia_factory'||theme==='arcadia_dockyard'){
  const dock=theme==='arcadia_dockyard';
  if(dock&&wall){const ring=(floor.rooms??[]).some(r=>r.building&&x>=r.x-1&&x<=r.x+r.w&&y>=r.y-1&&y<=r.y+r.h&&(x===r.x-1||x===r.x+r.w||y===r.y-1||y===r.y+r.h));return ring?[{atlas:'sprTileCoast',tile:10+((x+y)%3)},{atlas:'sprTileArcadia',tile:11}]:[{atlas:'sprTileCoast',tile:10+((x+y)%3)}];} // Harbour water, with steel bulkheads round each building.
  return [{atlas:'sprTileArcadia',tile:wall?6:(dock?4:5)}];
 }
 return null;
}
function poolLayers(pool,floor,x,y){ // Hash-picked floor/wall from a campaign painter's pools; border walls may use their own decorative pool.
 const wall=isWall(floor,x,y),border=wall&&pool.border&&(x===0||y===0||x===floor.width-1||y===floor.height-1||!isWall(floor,x,y-1)||!isWall(floor,x,y+1)||!isWall(floor,x-1,y)||!isWall(floor,x+1,y));
 const tile=wall?(border?hashPick(pool.border,x,y,1):hashPick(pool.wall,x,y,2)):hashPick(pool.floor,Math.floor(x/(pool.block||1)),Math.floor(y/(pool.block||1)),3);
 return [{atlas:pool.atlas,tile}];
}

export function tileAt(floor,x,y,ctx){ // -> [{atlas,tile,tint?}|{fill:[r,g,b,a]}] bottom-to-top for one cell; [] when nothing is painted. ctx: {tilesets,tideReach}.
 if(!floor||x<0||y<0||x>=floor.width||y>=floor.height)return [];
 const plan=ctx&&ctx.plan?ctx.plan:paintPlan(floor),tilesets=ctx&&ctx.tilesets?ctx.tilesets:floor.tilesetMap;
 if(plan.mode==='district'){
  const atlas=atlasForTileset(floor.district.tileset,tilesets),wall=isWall(floor,x,y),layers=[];
  if(wall){const tile=floor.wallTiles&&floor.wallTiles[y]?floor.wallTiles[y][x]:(floor.district.style==='nightlife'?11:10);if(tile>0)layers.push({atlas,tile});} // online_district_paint / online_town_terrain_draw.
  else {const tile=floor.floors[y]?floor.floors[y][x]:0;if(tile>0)layers.push({atlas,tile});}
  if(floor.decorTiles&&floor.decorTiles[y]){const decor=floor.decorTiles[y][x];if(decor>0)layers.push({atlas,tile:decor});}
  return layers;
 }
 if(plan.mode==='authored'){
  const sets=floor.tilesets??{},floorAtlas=atlasForTileset(sets.floor,tilesets),layers=[];
  const tree=floor.treeTiles&&floor.treeTiles[y]?floor.treeTiles[y][x]:0,wall=isWall(floor,x,y);
  const base=floor.floors[y]?floor.floors[y][x]:0;if(base>0)layers.push({atlas:floorAtlas,tile:base}); // Grass continues beneath canopies and walls (online_courtyard_paint).
  if(floor.decorTiles&&floor.decorTiles[y]){const decor=floor.decorTiles[y][x];if(decor>0)layers.push({atlas:atlasForTileset(sets.decor??sets.floor,tilesets),tile:decor});}
  if(tree>0)layers.push({atlas:atlasForTileset(sets.trees??sets.floor,tilesets),tile:tree});
  if(wall&&tree===0&&floor.wallTiles&&floor.wallTiles[y]){const tile=floor.wallTiles[y][x];if(tile>0)layers.push({atlas:atlasForTileset(sets.wall,tilesets),tile});}
  return layers;
 }
 if(plan.mode==='camp')return terrainLayers(floor,'camp',x,y,ctx);
 if(plan.mode==='farmstead')return terrainLayers(floor,'farmstead',x,y,ctx);
 if(plan.mode==='terrain')return terrainLayers(floor,plan.theme,x,y,ctx)??[];
 if(plan.mode==='hub'){
  const pool=POOL_THEMES[HUB_THEME_POOL[plan.theme]],layers=poolLayers(pool,floor,x,y);
  if(floor.kind==='shops'&&plan.theme!=='rose'&&!floor.store&&!isWall(floor,x,y)&&x>0&&y>0&&x<floor.width-1&&y<floor.height-1){const aisle=(x>=19&&x<=21)||(y>=9&&y<=11)||y>=19;layers[0].tile=plan.theme==='clockwork'?(aisle?18:3):(aisle?8:5);} // Market Hall aisles (online_hub_build).
  return layers;
 }
 return poolLayers(POOL_THEMES[plan.theme]??POOL_THEMES.princess_quarters,floor,x,y);
}

export function walkableCell(floor,x,y){ // Same rule as quest-placements.mjs tiles(): terrain, scenery props and solid fixture footprints block.
 if(!floor||!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=floor.width||y>=floor.height)return false;
 if(isWall(floor,x,y)||(floor.props&&floor.props[y]&&floor.props[y][x]))return false;
 for(const f of floor.fixtures??[])if(f.solid!==false&&x>=f.x&&x<f.x+(f.span_w??1)&&y>=f.y&&y<f.y+(f.span_h??1))return false;
 return true;
}

export function reachableCells(floor){ // Flood fill from the entrance and every entry, as quest-placements.mjs tiles() does; returns a Set of "x,y".
 const seeds=[floor.entrance,floor.spawn,...Object.values(floor.entries??{})].filter(p=>p&&walkableCell(floor,p.x,p.y)),seen=new Set(seeds.map(p=>p.x+','+p.y)),queue=[...seeds];
 for(let i=0;i<queue.length;i++){const p=queue[i];for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]){const x=p.x+dx,y=p.y+dy,key=x+','+y;if(!seen.has(key)&&walkableCell(floor,x,y)){seen.add(key);queue.push({x,y});}}}
 return seen;
}
