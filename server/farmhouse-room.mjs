// The Farmstead as a SAFE hub room (2026-09-27). Doll: "farmhouse is a dive not a safe space".
// Same 24x16 farmhouse as farmstead-generation.mjs (kitchen, hayloft, outhouse corridor, entry hall),
// but it now runs on hub rules instead of the Dive engine: no pink mist, no fog of war, no weekly
// reset, no duels. Hay beds are hub beds (hub_rest), the outhouse is a hub toilet, and the kitchen
// stove doubles as a brewing cauldron. The weekly pantry chests are gone with the Dive engine.
//
// Travel: the barn's warp pad in the Autumnal Plains still names `overworld-farmstead` (so saved
// Plains floors and their `entries` stay valid); dive.mjs back() redirects that exit to this room.
// Walking onto the hall door (exit, target = the Plains) re-enters the Plains beside the barn.
import {FARMSTEAD_ROOMS,FARMSTEAD_DOORS,FARMSTEAD_PAD,FARMSTEAD_SIZE} from './farmstead-generation.mjs';
import {cauldronFixture,toiletFixture} from './hub-districts.mjs';

export const FARMSTEAD_ROOM_ID='honeydew-lantern-farmstead'; // Part of Honeydew's room family (the Plains is Honeydew's south gate).
export const FARMSTEAD_ROUTE_LINK=Object.freeze({route:'overworld-autumnal-plains',via:'overworld-farmstead'}); // route: where the door leads. via: the Plains exit/entry id of the barn pad.

export function farmsteadRoom(){ // Builds the hub room geometry once at boot (hubs.mjs validates every fixture is reachable).
 const {width:W,height:H}=FARMSTEAD_SIZE;
 const walls=Array.from({length:H},()=>Array(W).fill(1)); // Solid timber everywhere...
 for(const r of FARMSTEAD_ROOMS)for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)walls[y][x]=0; // ...then carve each room...
 for(const d of FARMSTEAD_DOORS)walls[d.y][d.x]=0; // ...and punch the doorways between them.
 const scenery=(id,sprite,x,y,span_w=1,span_h=1)=>({id,name:'',kind:'scenery',sprite,x,y,span_w,span_h,solid:true}); // Solid furniture the client draws from its sprite.
 const hayBed=(n,x)=>({id:'hay-bed-'+n,name:'Hay Bed',kind:'bed',bed:'objBedCot',sprite:'sprFarmHayBed',x,y:1,span_w:2,span_h:1,solid:true}); // bed: the campaign bed whose rest rules apply (no room object is spawned for it).
 const fixtures=[
  // Kitchen: the stove, a table with benches, and the brewing cauldron where the pantry chests used to be.
  scenery('farm-stove','sprFarmStove',1,1),scenery('farm-barrel','sprTownEnvBarrel',2,1),scenery('farm-table','sprFarmTable',3,4,2,1),
  scenery('farm-bench-0','sprTownEnvBench',3,5),scenery('farm-bench-1','sprTownEnvBench',4,5),scenery('farm-crates','sprTownEnvCrateStack',8,1),
  cauldronFixture(6,1),
  // Hayloft: three hay beds against the back wall, a haystack and a bale.
  hayBed(0,10),hayBed(1,13),hayBed(2,16),
  scenery('farm-haystack','sprPlainsEnvHayStack',17,7,2,2),scenery('farm-bale','sprPlainsEnvHayBale',10,8),
  // The outhouse at the end of its corridor: the one private place in the Plains to go properly.
  toiletFixture('farm-outhouse',21,1,'outhouse'),
  // Hall scenery, kept off the door and its approach.
  scenery('farm-hall-barrel','sprTownEnvBarrel',1,11),scenery('farm-pumpkins','sprPlainsEnvPumpkinPatch',19,13,2,1),
 ];
 return {width:W,height:H,walls,fixtures,
  spawn:{x:FARMSTEAD_PAD.x,y:FARMSTEAD_PAD.y-1}, // Arrivals stand just inside the door.
  exit:{x:FARMSTEAD_PAD.x,y:FARMSTEAD_PAD.y,style:'door',target:FARMSTEAD_ROUTE_LINK.route}, // Where the warp pad was: stepping on it goes back out to the barn.
  routeExit:{...FARMSTEAD_ROUTE_LINK}, // hubs.mjs/dive.mjs: this annex's exit leads into a Dive-engine route instead of its parent hub.
  farmstead:true}; // Client: painted by farmstead_terrain_draw() (plank floors, timber walls) instead of a tileset.
}
