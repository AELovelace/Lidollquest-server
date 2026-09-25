// The LittleBig Inn, remodelled: a little boutique city hotel instead of one rectangle full of beds.
// Three themed bedrooms (pink, teal, violet) off a wood-floored corridor, a gold lobby with the concierge at the door,
// a lounge with LittleBigCity's brewing cauldron and Bramble, and a checker-tiled washroom with a toilet.
// Painted by the client's authored-room path (online_courtyard_paint) with tileLBCInterior indices:
// floors 1-9 / 30-39, wainscot walls 10-19, rugs and plants 20-29 (0 is "no tile").
import {cauldronFixture,reagentFixture,toiletFixture} from './hub-districts.mjs';

export const LBC_INN_SIZE=Object.freeze({width:24,height:16});
const W=LBC_INN_SIZE.width,H=LBC_INN_SIZE.height;

const ROOMS=Object.freeze([ // floor, the wall tile above the room, and any rug.
 {id:'rose',x:1,y:1,w:6,h:5,floor:1,wall:11,rug:{x:3,y:4,tile:21}},     // Pink bedroom.
 {id:'teal',x:8,y:1,w:7,h:5,floor:3,wall:12,rug:{x:11,y:4,tile:24}},    // Teal bedroom.
 {id:'violet',x:16,y:1,w:7,h:5,floor:7,wall:14,rug:{x:19,y:4,tile:25}}, // Violet bedroom.
 {id:'corridor',x:1,y:7,w:22,h:2,floor:34,wall:13},                     // Wood corridor with a runner.
 {id:'lobby',x:1,y:10,w:9,h:5,floor:9,wall:15,rug:{x:5,y:12,tile:21}},  // Gold lobby.
 {id:'lounge',x:11,y:10,w:7,h:5,floor:36,wall:18,rug:{x:14,y:12,tile:24}}, // Lounge with city windows.
 {id:'washroom',x:19,y:10,w:4,h:5,floor:5,wall:10}                      // Checker-tiled washroom.
]);
const DOORS=Object.freeze([ // One-tile doorways (and the lobby/lounge arches), floored like the corridor.
 {x:3,y:6},{x:11,y:6},{x:19,y:6},             // Bedrooms -> corridor.
 {x:3,y:9},{x:4,y:9},{x:5,y:9},               // Lobby arch.
 {x:13,y:9},{x:14,y:9},{x:15,y:9},            // Lounge arch.
 {x:20,y:9},{x:10,y:12}                       // Washroom door; lobby <-> lounge.
]);
export const LBC_INN_EXIT=Object.freeze({x:0,y:11,w:1,h:2,style:'gap',side:'left'}); // Out through the lobby's left wall, back onto the plaza.

export function littlebigInn(beds){
 const walls=Array.from({length:H},()=>Array(W).fill(1)),floors=Array.from({length:H},()=>Array(W).fill(0)),decorTiles=Array.from({length:H},()=>Array(W).fill(0));
 const roomAt=(x,y)=>ROOMS.find(r=>x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h);
 for(const r of ROOMS)for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++){walls[y][x]=0;floors[y][x]=r.floor;}
 for(const d of DOORS){walls[d.y][d.x]=0;floors[d.y][d.x]=34;} // Doorways share the corridor's boards.
 for(let dy=0;dy<LBC_INN_EXIT.h;dy++){walls[LBC_INN_EXIT.y+dy][0]=0;floors[LBC_INN_EXIT.y+dy][0]=9;} // The exit gap itself.
 const wallTiles=walls.map((row,y)=>row.map((w,x)=>w?(roomAt(x,y+1)?.wall??((x+y)%3===0?16:15)):0)); // A wall facing down into a room wears that room's wainscot; the rest alternate cream panels and sconces.
 for(const r of ROOMS)if(r.rug)decorTiles[r.rug.y][r.rug.x]=r.rug.tile;
 for(let x=2;x<=21;x++)decorTiles[8][x]=23; // Purple runner down the corridor.
 for(const [x,y] of [[1,5],[22,5],[16,5],[1,13],[17,14],[19,14]])decorTiles[y][x]=26; // Potted plants in the corners.
 const scenery=(id,sprite,x,y)=>({id,name:'',kind:'scenery',sprite,x,y,span_w:1,span_h:1,solid:true});
 const bedSpots=[{x:2,y:2},{x:5,y:2},{x:9,y:2},{x:13,y:2},{x:17,y:2},{x:21,y:2}]; // Two beds per bedroom against the back wall.
 const fixtures=[
  ...beds.map((bed,i)=>({...bed,kind:'bed',...bedSpots[i],span_w:1,span_h:1,solid:true})),
  scenery('rose-candelabra','sprMansionEnvCandelabra',3,1),scenery('teal-clock','sprMansionEnvGrandfatherClock',11,1),scenery('violet-cabinet','sprMansionEnvDisplayCabinet',19,1), // Something between each pair of beds.
  {id:'concierge',name:'Concierge',kind:'npc',avatar:'objNPCInnkeeper',x:7,y:10,span_w:1,span_h:1,solid:true,line:'Welcome to the LittleBig Inn! Rooms are up the corridor, the lounge is through the arch, and the washroom is at the far end. Take your time, darling.'},
  scenery('desk-left','sprCitySidewalkPlanter',6,10),scenery('desk-right','sprCitySidewalkPlanter',8,10), // Planters frame the concierge's desk.
  scenery('lobby-clock','sprMansionEnvGrandfatherClock',1,10),scenery('lobby-sofa-1','sprMansionEnvVelvetSofa',2,14),scenery('lobby-sofa-2','sprMansionEnvVelvetSofa',3,14),scenery('lobby-planter','sprCitySidewalkPlanter',9,14),
  cauldronFixture(17,10),reagentFixture(17,12), // LittleBigCity's brewing corner moves into the lounge, Bramble two tiles below it.
  scenery('lounge-shelf','sprSchoolEnvBookshelf',11,10),scenery('lounge-sofa-1','sprMansionEnvVelvetSofa',12,14),scenery('lounge-sofa-2','sprMansionEnvVelvetSofa',13,14),scenery('lounge-tea','sprMansionEnvTeaCart',15,14),
  toiletFixture('lbc-inn-toilet',22,10) // The washroom's toilet in the far corner.
 ];
 return {width:W,height:H,spawn:{x:1,y:12},exit:{...LBC_INN_EXIT},walls,floors,wallTiles,decorTiles,tilesets:{wall:'tileLBCInterior',floor:'tileLBCInterior',decor:'tileLBCInterior'},fixtures,authored:true};
}
