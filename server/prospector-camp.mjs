// The Prospector's Camp: a SAFE hub room dug into the canyon wall behind Echo Gulch's mine head (2026-09-29).
// Built like the Farmstead room (farmhouse-room.mjs): hub rules, no mist, no fog of war, no weekly reset, no duels.
// Three rooms off an entry hall: the bunkhouse (hub beds), Old Gritt's assay office (his grumpy shop, hub-data.json
// prospector_shop) and the outhouse corridor. The hall door leads back out to the mine head in the Gulch.
//
// Travel: the Gulch's landmark warp pad names `overworld-prospector-camp` (no Dive engine behind it); dive.mjs back()
// sees this room's routeExit and moves the player here. Walking onto the hall door re-enters the Gulch beside the mine head.
import {toiletFixture} from './hub-districts.mjs';

export const PROSPECTOR_CAMP_ROOM_ID='littlebig-clockwork-prospector-camp'; // LittleBigCity's room family: the Gulch sits between the Desert and the Coast, both LittleBigCity's gates.
export const PROSPECTOR_CAMP_LINK=Object.freeze({route:'overworld-echo-gulch',via:'overworld-prospector-camp'}); // route: where the door leads. via: the Gulch exit/entry id of the mine-head pad.
export const CAMP_SIZE=Object.freeze({width:24,height:16});

// Rooms (inclusive-exclusive boxes), the same frame as the Farmstead so both interiors read alike on the minimap.
export const CAMP_ROOMS=Object.freeze([
 {x:1,y:1,w:8,h:9,type:'bunkhouse'}, // Three bunks, a stove and a wash barrel.
 {x:10,y:1,w:9,h:9,type:'assay'},    // Old Gritt behind his counter, ore carts and the assay scale.
 {x:20,y:1,w:3,h:9,type:'outhouse'}, // A narrow corridor with the outhouse at its far end.
 {x:1,y:11,w:22,h:4,type:'hall'}     // Entry hall: the door back out to the mine head.
]);
export const CAMP_DOORS=Object.freeze([{x:4,y:10},{x:14,y:10},{x:21,y:10},{x:9,y:5}]); // Bunkhouse, assay office, outhouse corridor, and bunkhouse<->office.
export const CAMP_DOOR=Object.freeze({x:12,y:14}); // The hall door, bottom centre (where the Farmstead keeps its pad).

export function prospectorCampRoom(shop){ // shop: hub-data.json prospector_shop ({id,name,sprite,pool}); hubs.mjs passes it in so this module never reads hub-data itself.
 const {width:W,height:H}=CAMP_SIZE;
 const walls=Array.from({length:H},()=>Array(W).fill(1)); // Solid canyon rock everywhere...
 for(const r of CAMP_ROOMS)for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)walls[y][x]=0; // ...then dig out each room...
 for(const d of CAMP_DOORS)walls[d.y][d.x]=0; // ...and the doorways between them.
 const scenery=(id,sprite,x,y,span_w=1,span_h=1)=>({id,name:'',kind:'scenery',sprite,x,y,span_w,span_h,solid:true}); // Solid furniture the client draws from its sprite.
 const bunk=(n,x)=>({id:'camp-bunk-'+n,name:'Bunk',kind:'bed',bed:'objBedCot',sprite:'sprCampBunk',x,y:1,span_w:2,span_h:1,solid:true}); // bed: the campaign cot's rest rules (no room object is spawned for it).
 const fixtures=[
  // Bunkhouse: three bunks against the back wall, the stove and the wash barrel.
  bunk(0,1),bunk(1,4),bunk(2,7),
  scenery('camp-stove','sprFarmStove',1,8),scenery('camp-barrel','sprTownEnvBarrel',7,8),scenery('camp-bench','sprTownEnvBench',4,6),
  // Assay office: Old Gritt stands behind a crate counter with one gap to trade across.
  ...(shop?[{id:shop.id,name:shop.name,sprite:shop.sprite,kind:'shop',x:14,y:2,span_w:1,span_h:1,solid:true,greetings:shop.greetings??[]}]:[]), // greetings: the client grumbles one into the log when his shop opens.
  ...[11,12,13,15,16,17].map(x=>scenery('camp-counter-'+x,'sprTownEnvCrateStack',x,3)), // The counter; (14,3) is the gap where customers stand.
  scenery('camp-scale','sprCampAssayScale',17,1),scenery('camp-cart-0','sprCampOreCart',11,7),scenery('camp-cart-1','sprCampOreCart',17,7),
  // The outhouse at the end of its corridor.
  toiletFixture('camp-outhouse',21,1,'outhouse'),
  // Hall: the pick rack and a lantern barrel, kept off the door and its approach.
  scenery('camp-picks','sprCampPickRack',1,11),scenery('camp-hall-barrel','sprTownEnvBarrel',21,13),
 ];
 return {width:W,height:H,walls,fixtures,
  spawn:{x:CAMP_DOOR.x,y:CAMP_DOOR.y-1}, // Arrivals stand just inside the door.
  exit:{x:CAMP_DOOR.x,y:CAMP_DOOR.y,style:'door',target:PROSPECTOR_CAMP_LINK.route}, // Stepping on it goes back out to the mine head.
  routeExit:{...PROSPECTOR_CAMP_LINK}, // hubs.mjs/dive.mjs: this annex's exit leads into a Dive-engine route instead of its parent hub.
  camp:true}; // Client: painted by camp_terrain_draw() (plank floors, canyon-rock walls) instead of a tileset.
}
