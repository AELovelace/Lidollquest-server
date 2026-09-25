// Arcadia's three civic interiors, entered from the doorsteps on the Foundry Square. All authored rooms painted with
// tileLBCInterior indices (floors 1-9/30-39, wainscot walls 10-19, rugs/plants 20-29; 0 is "no tile"), like utopia-rooms.mjs.
//  - Boarding House (beds): six cramped bunks, a coal stove and a landlady who disapproves of everything.
//  - Rail Depot (dives): a stopped locomotive, benches and the ticket booth. No pads yet: Arcadia's own dungeon will add them.
//  - Clockmakers' Guildhall (tower): the Guildmaster, the Assay Clerk, the city's cauldron and its pay toilet.
// Arcadia is a city of bigs: its interiors have no changing stations, and the only indoor toilet costs a coin (hubs.mjs preparePayToilet).
import {cauldronFixture,reagentFixture,payToiletFixture} from './hub-districts.mjs';
export {payToiletFixture}; // Re-exported for callers that think of it as an Arcadia room piece.

export const ARCADIA_ROOM_EXIT=Object.freeze({x:0,y:6,w:1,h:2,style:'gap',side:'left'}); // Every interior leaves through a gap in its left wall.

function room(W,H,floorTile,wallTile,features){ // A walled rectangle with a left-wall exit; features(open) can carve and paint.
 const walls=Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>x===0||y===0||x===W-1||y===H-1?1:0));
 const floors=walls.map(row=>row.map(w=>w?0:floorTile)),decorTiles=walls.map(row=>row.map(()=>0));
 for(let dy=0;dy<ARCADIA_ROOM_EXIT.h;dy++){walls[ARCADIA_ROOM_EXIT.y+dy][0]=0;floors[ARCADIA_ROOM_EXIT.y+dy][0]=floorTile;}
 features({walls,floors,decorTiles});
 const wallTiles=walls.map((row,y)=>row.map((w,x)=>w?((x+y)%3===0?wallTile+1:wallTile):0)); // Dingy, uneven panelling.
 return {width:W,height:H,spawn:{x:1,y:7},exit:{...ARCADIA_ROOM_EXIT},walls,floors,wallTiles,decorTiles,tilesets:{wall:'tileLBCInterior',floor:'tileLBCInterior',decor:'tileLBCInterior'},authored:true};
}
const scenery=(id,sprite,x,y,extra={})=>({id,name:'',kind:'scenery',sprite,x,y,span_w:1,span_h:1,solid:true,...extra});

export function arcadiaBoardingHouse(beds){ // 22x14: two tight rows of bunks, a threadbare runner down the middle, the stove and washstand at the far end.
 const r=room(22,14,32,18,({floors,decorTiles})=>{for(let x=1;x<21;x++)for(const y of [6,7])floors[y][x]=35;decorTiles[6][12]=22;});
 const spots=[{x:4,y:2},{x:8,y:2},{x:12,y:2},{x:4,y:11},{x:8,y:11},{x:12,y:11}]; // Barely a bunk's width apart.
 r.fixtures=[
  ...beds.map((bed,i)=>({...bed,kind:'bed',...spots[i],span_w:1,span_h:1,solid:true})),
  {id:'landlady',name:'Mrs. Grimsby',kind:'npc',avatar:'objNPCMansionHousekeeper',x:3,y:5,span_w:1,span_h:1,solid:true,line:'A bunk is a bunk and the rules are the rules: boots off, lamps out at ten, and no wetting the mattresses. I have had littles in here before. Once.'},
  scenery('stove','sprArcadiaStove',19,1),scenery('washstand','sprArcadiaWashstand',20,12),scenery('crates','sprArcadiaEnvCrates',17,12),scenery('gauge','sprArcadiaEnvGauge',16,1,{span_h:2})
 ];
 return r;
}

export function arcadiaRailDepot(){ // 22x14: a platform, a stopped locomotive on the right, benches and the ticket booth. Its pads arrive with Arcadia's dungeon.
 const r=room(22,14,36,14,({floors,decorTiles})=>{for(let y=1;y<13;y++)for(const x of [15,16,17,18,19,20])floors[y][x]=33;decorTiles[7][8]=24;});
 r.fixtures=[
  scenery('locomotive','sprArcadiaLocomotive',16,5,{span_w:3,span_h:2}),
  scenery('ticket-booth','sprArcadiaTicketBooth',8,1,{span_w:2,span_h:2}),
  scenery('bench-1','sprArcadiaBench',4,11,{span_w:2}),scenery('bench-2','sprArcadiaBench',9,11,{span_w:2}),
  scenery('lamp-1','sprArcadiaEnvGasLamp',13,1,{span_h:2}),scenery('coal','sprArcadiaEnvCoalCart',20,12),
  {id:'stationmaster',name:'Stationmaster Cogsworth',kind:'npc',avatar:'objNPCFormerSoldier',x:10,y:4,span_w:1,span_h:1,solid:true,line:'No departures today. No departures any day, until the new line opens. Mind the gap, and mind your manners; littles ride in the goods van.'}
 ];
 return r;
}

export function arcadiaGuildhall(){ // 20x14: the Clockmakers' hall, with the Guildmaster, the Assay Clerk's counter, the brewing corner and the pay toilet.
 const r=room(20,14,9,16,({floors,decorTiles})=>{for(let y=4;y<10;y++)for(let x=7;x<13;x++)floors[y][x]=33;decorTiles[7][10]=25;});
 r.fixtures=[
  {id:'guildmaster',name:'Guildmaster Ironside',kind:'npc',avatar:'objNPCFormerPolitician',x:10,y:3,span_w:1,span_h:1,solid:true,line:'The Clockmakers built this city one gear at a time. Precision, punctuality, continence. A grown person keeps all three.'},
  {id:'assay-clerk',name:'Assay Clerk Penwick',kind:'npc',avatar:'objNPCFormerProfessor',x:14,y:7,span_w:1,span_h:1,solid:true,line:'Everything that comes into Arcadia is weighed, stamped and valued. Everyone, too. You, for instance, would be marked down.'},
  scenery('assay-counter','sprArcadiaAssayCounter',13,8,{span_w:2}),
  scenery('clock','sprArcadiaWallClock',2,1,{span_h:2}),scenery('gears','sprArcadiaEnvGearPile',1,12),scenery('pipes','sprArcadiaEnvPipes',5,12,{span_w:2}),
  cauldronFixture(17,12),reagentFixture(15,12), // Arcadia's alchemy corner (the city's cauldron and a reagent seller).
  payToiletFixture('guildhall-toilet',18,1) // The city's one indoor toilet, and it costs a coin.
 ];
 return r;
}
