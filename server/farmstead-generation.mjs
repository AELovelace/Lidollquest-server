// Farmstead interior: the small authored farmhouse behind the barn's warp pad in the middle of the Autumnal Plains.
// No monsters. A kitchen with pantry chests and supper pickups, a hayloft with hay beds to nap in (dive_rest), and the
// outhouse: the one private place in the Plains to go properly (client online_outhouse_use). The layout is fixed; only the
// pantry rolls change weekly. Output has the same shape as generateDesert(), so the Dive engine, exits and the GM map just work.
import {inside} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';

export const FARMSTEAD_SIZE=Object.freeze({width:24,height:16});
const W=FARMSTEAD_SIZE.width,H=FARMSTEAD_SIZE.height;

// Rooms (inclusive-exclusive boxes). The hall runs along the bottom; the three rooms open onto it through one-tile doors.
const ROOMS=Object.freeze([
 {x:1,y:1,w:8,h:9,type:'kitchen'},   // Stove, table, pantry chests.
 {x:10,y:1,w:9,h:9,type:'hayloft'},  // Hay beds to nap in, a haystack.
 {x:20,y:1,w:3,h:9,type:'outhouse'}, // A narrow corridor with the outhouse at its far end.
 {x:1,y:11,w:22,h:4,type:'hall'}     // Entry hall with the warp pad back out to the fields.
]);
const DOORS=Object.freeze([{x:4,y:10},{x:14,y:10},{x:21,y:10},{x:9,y:5}]); // Kitchen, hayloft, outhouse corridor, and kitchen<->hayloft.
export const FARMSTEAD_PAD=Object.freeze({x:12,y:14}); // Warp pad in the hall, bottom centre.

export function generateFarmstead(data,edition,depth=1){
 const c=data.config;
 const f={route:c.route,edition,depth,theme:c.theme,generatorVersion:1,contentVersion:data.version,dressingVersion:data.dressing_version,foodVersion:data.food_version,width:W,height:H,
  walls:Array.from({length:H},()=>Array(W).fill(1)),props:Array.from({length:H},()=>Array(W).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[]};
 for(const r of ROOMS){for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)f.walls[y][x]=0;f.rooms.push({...r});} // Carve every room.
 for(const d of DOORS)f.walls[d.y][d.x]=0; // Punch the doorways.
 const place=(sprite,x,y,span_w=1,span_h=1,extra={})=>{const d={sprite,span_w,span_h,solid:true,x,y,...extra};for(let dy=0;dy<span_h;dy++)for(let dx=0;dx<span_w;dx++)f.props[y+dy][x+dx]=1;f.decorations.push(d);return d;};
 // Kitchen.
 place('sprFarmStove',1,1);place('sprTownEnvBarrel',2,1);place('sprFarmTable',3,4,2,1);place('sprTownEnvBench',3,5);place('sprTownEnvBench',4,5);place('sprTownEnvCrateStack',8,1);
 // Hayloft: three hay beds against the back wall, a haystack in the corner.
 for(const [i,x] of [[0,10],[1,13],[2,16]])place('sprFarmHayBed',x,1,2,1,{id:'hay-'+i,rest:true});
 place('sprPlainsEnvHayStack',17,7,2,2);place('sprPlainsEnvHayBale',10,8);
 // The outhouse at the end of its corridor (1x2, door facing down the corridor).
 place('sprPlainsEnvOuthouse',21,1,1,2,{id:'outhouse',toilet:true});
 // Hall scenery, kept off the pad and its approach.
 place('sprTownEnvBarrel',1,11);place('sprPlainsEnvPumpkinPatch',19,13,2,1);
 // Pantry chests and supper pickups (rolled weekly from the pools).
 f.chests.push({id:'chest-pantry-0',x:6,y:1},{id:'chest-pantry-1',x:7,y:8});
 f.pickups.push({id:'food-0',kind:'food',x:1,y:8,sprite:'sprItem'},{id:'food-1',kind:'food',x:5,y:7,sprite:'sprItem'},{id:'potion-0',kind:'potion',x:12,y:6,sprite:'sprItem'});
 const endpoint=(c.endpoints??[])[0];if(!endpoint?.zone)throw Error('The farmstead needs its way back out (endpoints[0]).');
 const entry={x:FARMSTEAD_PAD.x,y:FARMSTEAD_PAD.y-1};
 f.exits=[{...FARMSTEAD_PAD,zone:endpoint.zone,name:endpoint.name,style:'warp'}];f.entries={[endpoint.zone]:{...entry}};f.entrance={...entry};
 f.safeRooms=[{x:FARMSTEAD_PAD.x-1,y:FARMSTEAD_PAD.y-1,w:3,h:2}]; // Mist never settles on the doormat.
 if([...f.chests,...f.pickups].some(p=>f.props[p.y][p.x]||f.walls[p.y][p.x]||f.safeRooms.some(r=>inside(r,p.x,p.y))))throw Error('Farmstead content overlaps scenery.');
 validateDesert(f); // Every chest, pickup, bed and the outhouse stay reachable from the pad.
 return f;
}

export function restInHay(f,p,loadout,features,now,cooldowns){ // dive_rest: a nap on a hay bed. Returns the log lines; throws a player-facing error when not beside a ready bed.
 const bed=f.decorations.find(d=>d.rest&&p.x>=d.x-1&&p.x<=d.x+d.span_w&&p.y>=d.y-1&&p.y<=d.y+d.span_h&&!((p.x===d.x-1||p.x===d.x+d.span_w)&&(p.y===d.y-1||p.y===d.y+d.span_h)));
 if(!bed)throw Object.assign(Error('Lie down beside a hay bed to rest.'),{status:409,code:'dive_action_failed'});
 const r=features?.rest??{},wait=Math.max(0,r.cooldown_seconds??120)*1000,last=cooldowns[bed.id]; // undefined: never napped here.
 if(Number.isFinite(last)&&now-last<wait)throw Object.assign(Error('You are not sleepy yet. Try again in '+Math.ceil((wait-(now-last))/1000)+' seconds.'),{status:409,code:'dive_action_failed'});
 cooldowns[bed.id]=now;
 const i=loadout.player_info,num=v=>Number.isFinite(Number(v))?Number(v):0,max=num(i.stamina_max)||100;
 const stamina=Math.min(max,num(i.stamina)+(r.stamina??60)),wet=Math.min(100,num(i.wet)+(r.wet??10));
 const lines=['You curl up in the warm, sweet-smelling hay. Up here nobody can see you at all.'];
 if(stamina>num(i.stamina))lines.push('Stamina +'+(stamina-num(i.stamina))+'.');
 if(wet>num(i.wet))lines.push('You wake up needing the outhouse... Bladder +'+(wet-num(i.wet))+'.');
 Object.assign(i,{stamina,wet});
 return lines;
}
