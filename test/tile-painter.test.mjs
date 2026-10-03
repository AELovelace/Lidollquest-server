import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {tileAt,paintPlan,walkableCell,reachableCells,hashPick,atlasForTileset,atlasColumns,tileCell,TERRAIN_THEMES,POOL_THEMES} from '../server/tile-painter.mjs';

const grid=(w,h,fill)=>Array.from({length:h},()=>Array(w).fill(fill));
function wilderness(theme,extra={}){const walls=grid(12,12,0);for(let i=0;i<12;i++){walls[0][i]=walls[11][i]=walls[i][0]=walls[i][11]=1;}walls[5][5]=1;return {width:12,height:12,theme,walls,props:grid(12,12,0),entrance:{x:1,y:1},...extra};}

test('mirrored terrain formulas pick the same atlas cells as scrTilePainter.gml for hand-computed cells',()=>{
 const tundra=wilderness('tundra');assert.deepEqual(tileAt(tundra,5,5),[{atlas:'sprTileTundra',tile:10}]);assert.deepEqual(tileAt(tundra,4,4),[{atlas:'sprTileTundra',tile:1}]); // Wall at 5,5: (5 div 3 + 5 div 3) mod 2 = 0 -> 10; floor at 4,4: variant 0 -> 1.
 assert.deepEqual(tileAt(tundra,3,0),[{atlas:'sprTileTundra',tile:11}]); // (1+0) mod 2 = 1 -> wall 11.
 const plains=wilderness('autumn_plains',{cover:Array.from({length:12},(_,y)=>y===2?'001100000000':'000000000000')});
 assert.deepEqual(tileAt(plains,2,2),[{atlas:'sprTileAutumnPlains',tile:20+((2*5+2*3)%4)}]); // Tall grass row 2 columns 2-3.
 const wave=(x,y)=>Math.sin(x*0.21+Math.cos(y*0.15)*2)+Math.cos(y*0.19-x*0.07);
 const plainsFloor=tileAt(plains,6,6)[0].tile,expected=wave(6,6)>0.9?7+((6*3+6*7)%3):wave(6,6)>0.2?4+((6*7+6*13)%3):1+((6*7+6*13)%3);assert.equal(plainsFloor,expected);
 const caldera=wilderness('caldera',{crater:{x:5,y:5,r:1}});assert.deepEqual(tileAt(caldera,5,5),[{atlas:'sprTileCaldera',tile:15+((5*3+5*5)%5)}]);assert.deepEqual(tileAt(caldera,0,0),[{atlas:'sprTileCaldera',tile:10}]); // Lava inside the crater (bubble frozen at 0), obsidian crag far away: (0*5+0*3)%5 = 0.
 assert.deepEqual(tileAt(caldera,6,6),[{atlas:'sprTileCaldera',tile:8+((6+6)%2)}]); // Within r+5 of the crater: glowing cracks.
 const coast=wilderness('coast',{shore:Array(12).fill(8)});for(let x=8;x<11;x++)coast.walls[3][x]=1;
 assert.deepEqual(tileAt(coast,8,3),[{atlas:'sprTileCoast',tile:14}]);assert.deepEqual(tileAt(coast,9,3),[{atlas:'sprTileCoast',tile:10+((9*3+3*7)%4)}]);assert.deepEqual(tileAt(coast,6,3),[{atlas:'sprTileCoast',tile:5+((6+3)%2)}]); // Foam at the shoreline, sea beyond it, wet sand within reach 3.
 const gulch=wilderness('gulch',{wash:Array.from({length:12},(_,y)=>y===4?'000011110000':'')});assert.deepEqual(tileAt(gulch,5,4),[{atlas:'sprTileGulch',tile:8+((5+4)%2)}]);assert.deepEqual(tileAt(gulch,5,5),[{atlas:'sprTileGulch',tile:10+((5*5+5*3)%5)}]);
 const caverns=wilderness('coastal_caverns',{caveChannels:grid(12,12,0)});caverns.caveChannels[2][2]=1;
 assert.deepEqual(tileAt(caverns,2,2),[{atlas:'sprTileCoast',tile:5+((2+2)%2),tint:[190,205,210]},{fill:[45,125,170,56]}]);assert.deepEqual(tileAt(caverns,5,5),[{atlas:'sprTileCoast',tile:15+((5*5+5*3)%5),tint:[155,180,185]}]);
 const dock=wilderness('arcadia_dockyard',{rooms:[{x:2,y:2,w:2,h:2,building:true}]});dock.walls[1][1]=1;assert.deepEqual(tileAt(dock,1,1),[{atlas:'sprTileCoast',tile:10+((1+1)%3)},{atlas:'sprTileArcadia',tile:11}]);assert.deepEqual(tileAt(dock,6,6),[{atlas:'sprTileArcadia',tile:4}]);
 assert.deepEqual(tileAt(wilderness('arcadia_factory'),6,6),[{atlas:'sprTileArcadia',tile:5}]);
 assert.deepEqual(tileAt({width:20,height:12,walls:grid(20,12,0),camp:true,theme:'clockwork'},3,11),[{atlas:'sprTileGulch',tile:24+((3+11)%2)}]);
 assert.deepEqual(tileAt({width:20,height:12,walls:grid(20,12,0),farmstead:true,theme:'lantern'},3,3),[{atlas:'sprTileAutumnPlains',tile:24+((3+3*7)%3)}]);
 const spa=wilderness('spa',{rooms:[{x:2,y:2,w:3,h:3,type:'changing'}]});assert.deepEqual(tileAt(spa,3,3),[{atlas:'sprTileCaldera',tile:25}]);assert.deepEqual(tileAt(spa,0,0),[{atlas:'sprTileCaldera',tile:26}]);
 const taiga=wilderness('taiga');const snow=Math.sin(6*0.24+Math.sin(6*0.13)*2)+Math.cos(6*0.28-6*0.08)>0.1;assert.equal(tileAt(taiga,6,6)[0].atlas,snow?'sprTileTundra':'sprTileForest');
 for(const theme of TERRAIN_THEMES)assert.ok(paintPlan(wilderness(theme)).atlases.length,theme+' names at least one atlas');
});

test('district and authored hub rooms pass their tile grids through; pool themes are deterministic',()=>{
 const district={width:3,height:2,walls:[[1,0,0],[0,0,1]],floors:[[0,5,8],[1,2,0]],wallTiles:[[34,0,0],[0,0,0]],district:{tileset:'tileTown',style:'market'}};
 assert.deepEqual(tileAt(district,0,0),[{atlas:'sprTileTown',tile:34}]);assert.deepEqual(tileAt(district,1,0),[{atlas:'sprTileTown',tile:5}]);assert.deepEqual(tileAt(district,2,1),[]); // A saved wall tile of 0 paints nothing, exactly like tilemap_set(…,0).
 const {wallTiles,...legacy}=district;assert.deepEqual(tileAt(legacy,2,1),[{atlas:'sprTileTown',tile:10}]);assert.deepEqual(tileAt({...legacy,district:{tileset:'tileCity',style:'nightlife'}},2,1),[{atlas:'sprTileCity',tile:11}]); // Editions without wallTiles fall back to 10 (11 for nightlife).
 const authored={width:2,height:1,walls:[[1,1]],floors:[[3,3]],wallTiles:[[10,10]],treeTiles:[[34,0]],decorTiles:[[0,21]],tilesets:{wall:'tilePrincessQuarters',floor:'tileTown',trees:'tileTown',decor:'tileLBCInterior'}};
 assert.deepEqual(tileAt(authored,0,0),[{atlas:'sprTileTown',tile:3},{atlas:'sprTileTown',tile:34}]); // A tree clump paints over grass instead of the castle wall.
 assert.deepEqual(tileAt(authored,1,0),[{atlas:'sprTileTown',tile:3},{atlas:'sprTileLBCInterior',tile:21},{atlas:'sprTilePrincessQuarters',tile:10}]);
 assert.equal(paintPlan(district).mode,'district');assert.equal(paintPlan(authored).mode,'authored');assert.equal(paintPlan(authored).supports.grids,true);
 const hall={width:20,height:12,walls:grid(20,12,0),theme:'rose',kind:'dives'};for(let x=0;x<20;x++)hall.walls[0][x]=1;
 assert.equal(paintPlan(hall).mode,'hub');assert.equal(tileAt(hall,0,0)[0].atlas,'sprTilePrincessQuarters');assert.deepEqual(tileAt(hall,4,4),tileAt(hall,4,4));assert.ok(POOL_THEMES.princess_quarters.floor.includes(tileAt(hall,4,4)[0].tile));
 const market={width:40,height:24,walls:grid(40,24,0),theme:'clockwork',kind:'shops'};assert.equal(tileAt(market,20,5)[0].tile,18);assert.equal(tileAt(market,5,5)[0].tile,3); // Market Hall aisles.
 const quarters={width:4,height:4,walls:[[1,1,1,1],[1,0,0,1],[1,0,0,1],[1,1,1,1]],theme:'princess_quarters'};assert.ok(POOL_THEMES.princess_quarters.border.includes(tileAt(quarters,0,0)[0].tile));
 assert.equal(hashPick([1,2,3],4,5,0),hashPick([1,2,3],4,5,0));assert.equal(atlasForTileset('tileTown',{tileTown:'sprTileTown'}),'sprTileTown');assert.equal(atlasForTileset('tileUtopia'),'sprTileUtopia');
 assert.equal(atlasColumns('sprTileUtopia',{sprTileUtopia:320}),10);assert.equal(atlasColumns('missing'),10);assert.deepEqual(tileCell(23,10),{sx:96,sy:64});
 assert.deepEqual(tileAt(district,-1,0),[]);assert.deepEqual(tileAt(null,0,0),[]);
});

test('walkable cells and the reachability flood follow the placement rules',()=>{
 const f=wilderness('tundra',{fixtures:[{x:2,y:2,span_w:2,span_h:1,solid:true},{x:8,y:8,solid:false}]});f.props[3][3]=1;
 assert.equal(walkableCell(f,1,1),true);assert.equal(walkableCell(f,5,5),false);assert.equal(walkableCell(f,3,3),false);assert.equal(walkableCell(f,3,2),false);assert.equal(walkableCell(f,8,8),true);assert.equal(walkableCell(f,0,0),false);assert.equal(walkableCell(f,99,1),false);
 const reach=reachableCells(f);assert.ok(reach.has('10,10'));assert.ok(!reach.has('5,5'));assert.ok(!reach.has('0,0'));
 for(let x=1;x<11;x++)f.walls[6][x]=1;assert.ok(!reachableCells(f).has('10,10'),'a wall across the map cuts the flood');
});

test('the painter stays browser-safe: no imports, no Node globals, every export at line start, and comments only at line ends',()=>{
 const source=readFileSync(new URL('../server/tile-painter.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/^\s*import\s/m);assert.doesNotMatch(source,/\b(require|process|Buffer)\b/);
 assert.doesNotMatch(source,/\/\/.*(const|let|var)\s+\w+\s*=/,'a line comment would swallow code when the file is minified into one line');
 const browser=source.replace(/^export /gm,'');new Function(browser+'\nreturn tileAt;'); // Exactly how gm.mjs splices it into the Map Editor page.
 assert.ok(/^export function tileAt/m.test(source)&&/^export function paintPlan/m.test(source));
});
