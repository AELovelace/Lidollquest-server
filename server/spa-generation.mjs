// The Obsidian Spa: the bathhouse built into Emberfall Caldera's mountainside, entered through the warp pad at its door.
// No monsters. Three private changing stalls (toilets, client online_toilet_use 'stall'), a lounge, and two cooling baths
// (dive_cool: thirst and stamina back after the heat). The layout is fixed; only the lounge's chest restocks weekly.
// Output has the same shape as generateDesert(), so the Dive engine, exits and the GM map just work.
import {inside} from './dive-generation.mjs';
import {validateDesert} from './desert-generation.mjs';
import {beside} from './caldera-features.mjs';

export const SPA_SIZE=Object.freeze({width:22,height:14});
const W=SPA_SIZE.width,H=SPA_SIZE.height;
const ROOMS=Object.freeze([
 {x:1,y:1,w:6,h:8,type:'changing'}, // Three stalls along the back wall.
 {x:8,y:1,w:5,h:8,type:'lounge'},   // Benches, towels and plants.
 {x:14,y:1,w:7,h:8,type:'baths'},   // Two cooling baths.
 {x:1,y:10,w:20,h:3,type:'hall'}    // Entry hall with the warp pad back outside.
]);
const DOORS=Object.freeze([{x:3,y:9},{x:10,y:9},{x:17,y:9},{x:7,y:5},{x:13,y:5}]); // Each room opens onto the hall; the lounge links both sides.
const PARTITIONS=Object.freeze([{x:3,y:1},{x:3,y:2},{x:5,y:1},{x:5,y:2}]); // Stall dividers between the three toilets.
export const SPA_PAD=Object.freeze({x:11,y:12});

export function generateSpa(data,edition,depth=1){
 const c=data.config;
 const f={route:c.route,edition,depth,theme:c.theme,generatorVersion:1,contentVersion:data.version,dressingVersion:data.dressing_version,foodVersion:data.food_version,width:W,height:H,
  walls:Array.from({length:H},()=>Array(W).fill(1)),props:Array.from({length:H},()=>Array(W).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[]};
 for(const r of ROOMS){for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)f.walls[y][x]=0;f.rooms.push({...r});}
 for(const d of DOORS)f.walls[d.y][d.x]=0;
 for(const p of PARTITIONS)f.walls[p.y][p.x]=1;
 const place=(sprite,x,y,span_w=1,span_h=1,extra={})=>{for(let dy=0;dy<span_h;dy++)for(let dx=0;dx<span_w;dx++)f.props[y+dy][x+dx]=1;f.decorations.push({sprite,span_w,span_h,solid:true,x,y,...extra});};
 for(const [i,x] of [[0,2],[1,4],[2,6]])place('sprSpaStall',x,1,1,1,{id:'stall-'+i,toilet:true,style:'stall'}); // Private stalls: used like any toilet.
 place('sprTownEnvBench',8,7);place('sprTownEnvBench',9,7);place('sprSpaTowelRack',12,1);place('sprCitySidewalkPlanter',8,1);place('sprCitySidewalkPlanter',12,8); // Lounge.
 for(const [i,x] of [[0,15],[1,18]])place('sprSpaCoolBath',x,2,2,2,{id:'bath-'+i,cool:true}); // Cooling baths.
 place('sprSpaTowelRack',20,8);place('sprCitySidewalkPlanter',1,10);place('sprCitySidewalkPlanter',20,10); // Hall.
 f.chests.push({id:'chest-lounge-0',x:10,y:2});
 f.pickups.push({id:'food-0',kind:'food',x:9,y:4,sprite:'sprItem'},{id:'potion-0',kind:'potion',x:16,y:6,sprite:'sprItem'});
 const endpoint=(c.endpoints??[])[0];if(!endpoint?.zone)throw Error('The spa needs its way back out (endpoints[0]).');
 const entry={x:SPA_PAD.x,y:SPA_PAD.y-1};
 f.exits=[{...SPA_PAD,zone:endpoint.zone,name:endpoint.name,style:'warp'}];f.entries={[endpoint.zone]:{...entry}};f.entrance={...entry};
 f.safeRooms=[{x:SPA_PAD.x-1,y:SPA_PAD.y-1,w:3,h:2}];
 if([...f.chests,...f.pickups].some(p=>f.props[p.y][p.x]||f.walls[p.y][p.x]||f.safeRooms.some(r=>inside(r,p.x,p.y))))throw Error('Spa content overlaps scenery.');
 validateDesert(f); // Every stall, bath, chest and the pad stay reachable.
 return f;
}

export function coolInBath(f,p,loadout,features,now,cooldowns){ // dive_cool: a dip in a cooling bath. Returns the log lines; throws a player-facing error when not beside a ready bath.
 const bath=f.decorations.find(d=>d.cool&&beside(d,p));
 if(!bath)throw Object.assign(Error('Stand beside a cooling bath to take a dip.'),{status:409,code:'dive_action_failed'});
 const c=features?.cool??{},wait=Math.max(0,c.cooldown_seconds??60)*1000,last=cooldowns[bath.id]; // undefined: never dipped here.
 if(Number.isFinite(last)&&now-last<wait)throw Object.assign(Error('You are still shivering from the last dip. Try again in '+Math.ceil((wait-(now-last))/1000)+' seconds.'),{status:409,code:'dive_action_failed'});
 cooldowns[bath.id]=now;
 const i=loadout.player_info,num=v=>Number.isFinite(Number(v))?Number(v):0;
 const thirst=Math.min(250,num(i.thirst)+(c.thirst??100)),stamina=Math.min(num(i.stamina_max)||100,num(i.stamina)+(c.stamina??30)),wet=Math.min(100,num(i.wet)+(c.wet??8));
 const lines=['You lower yourself into the cool, mineral-blue water. The heat finally lets go of you.'];
 if(thirst>num(i.thirst))lines.push('Thirst +'+(thirst-num(i.thirst))+'.');
 if(stamina>num(i.stamina))lines.push('Stamina +'+(stamina-num(i.stamina))+'.');
 if(wet>num(i.wet))lines.push('The sudden chill goes straight to your bladder... +'+(wet-num(i.wet))+'.');
 Object.assign(i,{thirst,stamina,wet});
 return lines;
}
