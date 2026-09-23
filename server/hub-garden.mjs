// Rose Court's lobby is a walled 20x20 courtyard garden rather than a 20x12 hall. The map below is the
// single source of truth for its geometry: castle walls (Princess' Quarters tiles) surround Honeydew
// grass, flower patches, cobbled paths and solid tree clumps. Scenery comes from hub-data.json
// (courtyards[].decorations, authored in datafiles/generation/online_hubs.json) so modders can move props
// without touching this file; the DEFAULT_DECORATIONS list is only used when an older export lacks them.
export const GARDEN_SIZE=20; // Width and height of the courtyard in tiles.
const LEGEND={ // Map glyph -> {wall, floor tile in tileTown, tree tile in tileTown}. Floors 3/4/9 are grass, dark grass and flower-strewn grass; 1/2/8 are cobblestones.
 '#':{wall:true,floor:0,tree:0},   // Castle wall (painted from tilePrincessQuarters).
 'T':{wall:true,floor:3,tree:34},  // Tree clump: solid like a wall, drawn from the Honeydew woodland tiles over grass.
 '.':{wall:false,floor:3,tree:0},  // Grass.
 ',':{wall:false,floor:4,tree:0},  // Dark grass.
 '*':{wall:false,floor:9,tree:0},  // Flower-strewn grass.
 '=':{wall:false,floor:1,tree:0},  // Cobblestone path.
 '-':{wall:false,floor:2,tree:0},  // Lighter cobblestone plaza around the fountain.
 '~':{wall:false,floor:8,tree:0},  // Mossy cobblestone.
};
const MAP=[ // 20 columns x 20 rows. Openings are plain floor cells in the boundary; portals below say where they lead.
 '#########==#########', // y0  Dive Hall opening at x=9-10.
 '##.*.....==....*..##', // y1  Corner towers are two tiles thick.
 '#..T.....==.....T..#', // y2
 '#.TT....*==*...TT..#', // y3
 '#..T,....==....,T..#', // y4
 '#........===========', // y5  Tundra path east to the old Beds door position (x=19, y=5-6).
 '#........===========', // y6
 '#.*....------.....*#', // y7  Plaza x=7-12, y=7-12.
 '#.T....------....T.#', // y8
 '#*.....------.....*#', // y9  Fountain occupies x=9-10, y=9-10.
 '#......------......#', // y10
 '#.,....------....,.#', // y11
 '=======------====..#', // y12 The Castle gate is in the left wall (x=0, y=12-13); the path runs east across the plaza to the Shops.
 '=======------====..#', // y13
 '#.==.......*...==..#', // y14 Shops path turns south at x=15-16.
 '#.==.T.....,...==T.#', // y15
 '#.==.TT....*...=...#', // y16 Shops stairs at (15,16).
 '#.=..T...*.........#', // y17 Campaign stairs at (2,17).
 '##.......,.....,..##', // y18
 '####################', // y19
];
export const DEFAULT_DECORATIONS=[ // Princess' Quarters props and Honeydew props share the lawn; spans are sprite footprints in tiles.
 {id:'fountain',sprite:'sprCityParkFountain',x:9,y:9,span_w:2,span_h:2},
 {id:'bench-nw',sprite:'sprTownEnvBench',x:7,y:7,span_w:1,span_h:1},{id:'bench-ne',sprite:'sprTownEnvBench',x:12,y:7,span_w:1,span_h:1},
 {id:'bench-sw',sprite:'sprTownEnvBench',x:7,y:11,span_w:1,span_h:1},{id:'bench-se',sprite:'sprTownEnvBench',x:12,y:11,span_w:1,span_h:1},
 {id:'lamp-n1',sprite:'sprTownEnvLampPost',x:8,y:2,span_w:1,span_h:1},{id:'lamp-n2',sprite:'sprTownEnvLampPost',x:11,y:2,span_w:1,span_h:1},
 {id:'lamp-e1',sprite:'sprTownEnvLampPost',x:14,y:11,span_w:1,span_h:1},{id:'lamp-e2',sprite:'sprTownEnvLampPost',x:14,y:14,span_w:1,span_h:1},
 {id:'oil-lamp-1',sprite:'sprPQDetailOilLamp',x:13,y:4,span_w:1,span_h:1},{id:'oil-lamp-2',sprite:'sprPQDetailOilLamp',x:13,y:7,span_w:1,span_h:1},
 {id:'banner-gate-n',sprite:'sprPQDetailRoyalBanner',x:1,y:9,span_w:1,span_h:3},{id:'banner-gate-s',sprite:'sprPQDetailRoyalBanner',x:1,y:15,span_w:1,span_h:3},
 {id:'banner-dive-w',sprite:'sprPQDetailRoyalBanner',x:7,y:1,span_w:1,span_h:3},{id:'banner-dive-e',sprite:'sprPQDetailRoyalBanner',x:12,y:1,span_w:1,span_h:3},
 {id:'rose-1',sprite:'sprPQDetailPottedRose',x:6,y:8,span_w:1,span_h:2},{id:'rose-2',sprite:'sprPQDetailPottedRose',x:13,y:8,span_w:1,span_h:2},
 {id:'rose-3',sprite:'sprPQDetailPottedRose',x:4,y:6,span_w:1,span_h:2},{id:'rose-4',sprite:'sprPQDetailPottedRose',x:15,y:9,span_w:1,span_h:2},
 {id:'planter-n1',sprite:'sprTownEnvTestPlanterRow',x:4,y:1,span_w:3,span_h:1},{id:'planter-n2',sprite:'sprTownEnvTestPlanterRow',x:13,y:1,span_w:3,span_h:1},
 {id:'planter-s1',sprite:'sprTownEnvTestPlanterRow',x:7,y:18,span_w:3,span_h:1},{id:'planter-s2',sprite:'sprTownEnvTestPlanterRow',x:11,y:18,span_w:3,span_h:1},
 {id:'picnic-rug',sprite:'sprPQDetailLaceRug',x:10,y:15,span_w:3,span_h:2,solid:false},
 {id:'picnic-teddy',sprite:'sprPQDetailPlushTeddy',x:11,y:15,span_w:1,span_h:1},{id:'picnic-music-box',sprite:'sprPQDetailMusicBox',x:10,y:16,span_w:1,span_h:1},
 {id:'dollhouse',sprite:'sprPQDetailDollhouse',x:7,y:15,span_w:2,span_h:2},
 {id:'notice-board',sprite:'sprTownEnvNoticeBoard',x:4,y:11,span_w:1,span_h:1},
 {id:'well',sprite:'sprTownEnvTestTownWell',x:2,y:10,span_w:2,span_h:2},
 {id:'statue',sprite:'sprTownEnvTestStatue',x:16,y:9,span_w:1,span_h:2},
 {id:'signpost',sprite:'sprTownEnvSignpost',x:11,y:4,span_w:1,span_h:1},
];
export const GARDEN_PORTALS=Object.freeze([ // Lobby openings; hubs.mjs fills in the district's display name.
 {x:0,y:12,w:1,h:2,name:'The Castle',target:'princess-rose-garden',style:'gap',side:'left'},     // The castle keep is on the left: its gate leads into The Castle district.
 {x:19,y:5,w:1,h:2,name:'Frostveil Tundra',target:'dive-tundra',style:'gap',side:'right'},       // The Tundra road leaves where the old Beds door used to be.
 {x:15,y:16,name:'Shops',target:'princess-rose-shops',style:'stairs'},
 {x:9,y:0,w:2,h:1,name:'Dungeon Dive',target:'princess-rose-dives',style:'gap',side:'top'},
]);
export const GARDEN_SPAWN=Object.freeze({x:10,y:12}); // Just south of the fountain on the plaza.
export const GARDEN_EXIT=Object.freeze({x:2,y:17,style:'stairs'}); // Bottom-left stairs back to the singleplayer campaign, like every court.
const wallTile=(x,y)=>(x<=1||x>=GARDEN_SIZE-2)&&(y<=1||y>=GARDEN_SIZE-2)?11:[10,10,12,13,10,14][(x*7+y*3)%6]; // Corner towers use the darker block; the curtain wall mixes hearts and wainscoting deterministically.
const treeTile=(x,y)=>[34,37,34,36,37,34][(x+y*2)%6]; // Deciduous, flowering and pine canopies in a fixed pattern.
export function roseCourtyard(decorations){ // Build the lobby geometry once at boot; every visitor receives the same map.
 if(MAP.length!==GARDEN_SIZE||MAP.some(row=>row.length!==GARDEN_SIZE))throw Error('Rose courtyard map must be 20x20');
 const walls=[],floors=[],wallTiles=[],treeTiles=[];
 for(let y=0;y<GARDEN_SIZE;y++){walls.push([]);floors.push([]);wallTiles.push([]);treeTiles.push([]);
  for(let x=0;x<GARDEN_SIZE;x++){const cell=LEGEND[MAP[y][x]];if(!cell)throw Error(`Unknown courtyard glyph ${MAP[y][x]} at ${x},${y}`);
   walls[y].push(cell.wall?1:0);floors[y].push(cell.floor);treeTiles[y].push(cell.tree?treeTile(x,y):0);wallTiles[y].push(cell.wall&&!cell.tree?wallTile(x,y):0);
  }
 }
 const fixtures=(Array.isArray(decorations)&&decorations.length?decorations:DEFAULT_DECORATIONS).map(d=>({...d,kind:'scenery',name:d.name??'',span_w:d.span_w??1,span_h:d.span_h??1,solid:d.solid??true}));
 const garden={width:GARDEN_SIZE,height:GARDEN_SIZE,spawn:{...GARDEN_SPAWN},exit:{...GARDEN_EXIT},walls,floors,wallTiles,treeTiles,tilesets:{wall:'tilePrincessQuarters',floor:'tileTown',trees:'tileTown'},fixtures,courtyard:true};
 validateCourtyard(garden,GARDEN_PORTALS);return garden;
}
export function validateCourtyard(g,portals){ // Refuse to boot with a garden whose props seal a path, an opening or the spawn.
 const solid=(x,y)=>g.walls[y][x]===1||g.fixtures.some(f=>f.solid!==false&&x>=f.x&&y>=f.y&&x<f.x+f.span_w&&y<f.y+f.span_h);
 for(const f of g.fixtures)if(f.x<1||f.y<1||f.x+f.span_w>g.width-1||f.y+f.span_h>g.height-1||[...Array(f.span_h).keys()].some(dy=>[...Array(f.span_w).keys()].some(dx=>g.walls[f.y+dy][f.x+dx])))throw Error('Courtyard prop '+f.id+' overlaps a wall or the boundary');
 const seen=new Set(),queue=[g.spawn];if(solid(g.spawn.x,g.spawn.y))throw Error('Courtyard spawn is blocked');
 for(let n=0;n<queue.length;n++){const {x,y}=queue[n],key=x+','+y;if(x<0||y<0||x>=g.width||y>=g.height||seen.has(key)||solid(x,y))continue;seen.add(key);queue.push({x:x+1,y},{x:x-1,y},{x,y:y+1},{x,y:y-1});}
 for(let y=0;y<g.height;y++)for(let x=0;x<g.width;x++)if(!solid(x,y)&&!seen.has(x+','+y))throw Error(`Courtyard tile ${x},${y} is unreachable from the spawn`);
 for(const p of [...portals,g.exit])for(let dy=0;dy<(p.h??1);dy++)for(let dx=0;dx<(p.w??1);dx++)if(!seen.has((p.x+dx)+','+(p.y+dy)))throw Error('Courtyard opening '+p.name+' is not reachable');
 return true;
} // Reachability is checked with props included, so the authored garden can never trap a visitor.
