// Utopia's three civic interiors, entered from the doorsteps on the Arcanum plaza. All authored rooms painted with
// tileLBCInterior indices (floors 1-9/30-39, wainscot walls 10-19, rugs/plants 20-29; 0 is "no tile"), like lbc-inn.mjs.
//  - Nap Pods (beds): six glowing sleep capsules round a soft-mat aisle; resting here slowly restores Dignity (client, nap_pods).
//  - Artificer's Workshop (dives): workbenches, rune consoles and the warp pads (UTOPIA_PADS) into the Auto-Nursery and Regression School.
//  - Arcanum Tower (tower): the city's archive and registry, with the Archivist and the Rune Registrar.
// Utopia has no toilets anywhere: every room has an Auto-Changing Station (kind 'changer', client online_auto_change).
import {cauldronFixture,reagentFixture,changerFixture} from './hub-districts.mjs';

export const UTOPIA_ROOM_EXIT=Object.freeze({x:0,y:6,w:1,h:2,style:'gap',side:'left'}); // Every interior leaves through a gap in its left wall.
export const UTOPIA_PADS=Object.freeze([{x:17,y:3,zone:'dive-nursery'},{x:17,y:9,zone:'dive-school'}]); // The Workshop's warp pads (hubs.mjs dungeonPortals).

function room(W,H,floorTile,wallTile,features){ // A walled rectangle with a left-wall exit; features(open) can carve and paint.
 const walls=Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>x===0||y===0||x===W-1||y===H-1?1:0));
 const floors=walls.map(row=>row.map(w=>w?0:floorTile)),decorTiles=walls.map(row=>row.map(()=>0));
 for(let dy=0;dy<UTOPIA_ROOM_EXIT.h;dy++){walls[UTOPIA_ROOM_EXIT.y+dy][0]=0;floors[UTOPIA_ROOM_EXIT.y+dy][0]=floorTile;}
 features({walls,floors,decorTiles});
 const wallTiles=walls.map((row,y)=>row.map((w,x)=>w?((x+y)%4===0?wallTile+1:wallTile):0)); // Alternating wainscot panels.
 return {width:W,height:H,spawn:{x:1,y:7},exit:{...UTOPIA_ROOM_EXIT},walls,floors,wallTiles,decorTiles,tilesets:{wall:'tileLBCInterior',floor:'tileLBCInterior',decor:'tileLBCInterior'},authored:true};
}
const scenery=(id,sprite,x,y,extra={})=>({id,name:'',kind:'scenery',sprite,x,y,span_w:1,span_h:1,solid:true,...extra});

export function utopiaNapPods(beds){ // 22x14: pods along the top and bottom walls, a pink soft-mat aisle, the Pod Warden by the door.
 const r=room(22,14,31,11,({floors,decorTiles})=>{for(let x=1;x<21;x++)for(const y of [6,7])floors[y][x]=1;for(let x=3;x<20;x+=4)decorTiles[6][x]=21;decorTiles[12][1]=26;decorTiles[1][20]=26;});
 const spots=[{x:4,y:2},{x:9,y:2},{x:14,y:2},{x:4,y:11},{x:9,y:11},{x:14,y:11}];
 r.fixtures=[
  ...beds.map((bed,i)=>({...bed,kind:'bed',...spots[i],span_w:1,span_h:1,solid:true})),
  ...spots.map((s,i)=>scenery('pod-'+i,'sprUtopiaPod',s.x,s.y,{solid:false})), // Glowing capsule frames round each bed.
  {id:'pod-warden',name:'Pod Warden',kind:'npc',avatar:'objNPCBottleBaby',x:3,y:5,span_w:1,span_h:1,solid:true,line:'Welcome to the Nap Pods! Pick any pod you like. Everyone wakes up feeling a little more like themselves here, which is to say, little.'},
  changerFixture('pods-changer',20,5),
  scenery('pods-console','sprUtopiaConsole',19,12),scenery('pods-planter','sprUtopiaEnvHoverPlanter',1,1)
 ];
 r.nap_pods=true; // The client restores Dignity while resting here (Padded Pride).
 return r;
}

export function utopiaWorkshop(){ // 22x14: workbenches down the middle, rune consoles, the two warp pads on the right, a changer by the door.
 const r=room(22,14,34,13,({floors,decorTiles})=>{for(let y=1;y<13;y++)for(const x of [16,17,18])floors[y][x]=36;decorTiles[6][11]=24;});
 r.fixtures=[
  scenery('bench-1','sprUtopiaWorkbench',5,3,{span_w:2}),scenery('bench-2','sprUtopiaWorkbench',9,3,{span_w:2}),scenery('bench-3','sprUtopiaWorkbench',5,10,{span_w:2}),scenery('bench-4','sprUtopiaWorkbench',9,10,{span_w:2}),
  scenery('console-1','sprUtopiaConsole',13,1),scenery('console-2','sprUtopiaConsole',13,12),scenery('robot','sprUtopiaEnvToyRobot',20,12),scenery('dome','sprUtopiaEnvHoloSign',20,1),
  {id:'artificer',name:'Artificer Nib',kind:'npc',avatar:'objNPCMikaScrapwright',x:3,y:6,span_w:1,span_h:1,solid:true,line:'Pads to the right! The Auto-Nursery and the Regression School, fully rune-calibrated. Mind the sparks, and the crinkle.'},
  changerFixture('workshop-changer',1,10)
 ];
 return r;
}

export function utopiaTower(){ // 20x14: the Arcanum archive, with the Archivist, the Rune Registrar, the city's brewing lab and a changer.
 const r=room(20,14,9,15,({floors,decorTiles})=>{for(let y=4;y<10;y++)for(let x=7;x<13;x++)floors[y][x]=33;decorTiles[7][10]=25;decorTiles[1][1]=26;decorTiles[12][18]=26;});
 r.fixtures=[
  {id:'archivist',name:'Archivist Quill',kind:'npc',avatar:'objNPCShyStudent',x:10,y:3,span_w:1,span_h:1,solid:true,line:'The Arcanum keeps every rune ever drawn in Utopia. Someday the Director says the whole world will want to live like we do.'},
  {id:'registrar',name:'Rune Registrar',kind:'npc',avatar:'objNPCClassClown',x:15,y:9,span_w:1,span_h:1,solid:true,line:'New arrivals get a sticker and a smart diaper. Those are the only two rules. Well, three: no potties.'},
  scenery('shelf-1','sprSchoolEnvBookshelf',3,1),scenery('shelf-2','sprSchoolEnvBookshelf',4,1),scenery('shelf-3','sprSchoolEnvBookshelf',15,1),scenery('shelf-4','sprSchoolEnvBookshelf',16,1),
  scenery('orb-console','sprUtopiaConsole',10,6),scenery('spire','sprUtopiaEnvCrystalSpire',1,10),
  cauldronFixture(17,12),reagentFixture(15,12), // Utopia's Alchemy Lab corner (the city's cauldron and a reagent seller).
  changerFixture('tower-changer',18,5)
 ];
 return r;
}
