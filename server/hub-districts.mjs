import {altarFixture,priestFixture,pewFixture} from './temple-rooms.mjs'; // Sable's temple in the Castle district.
import {templeGod} from './faith.mjs';
import {addDistrictResidents,moveDistrictResidents} from './district-residents.mjs';
import {districtLayout,districtSize,entryStrip,westStrip,northStrip,southStrip,carveEdgeGate} from './district-layouts.mjs';
import {readFileSync} from 'node:fs';
import {seeded} from './dive-generation.mjs';
import {addFullDungeonEntrances} from './full-dungeons.mjs';

export const districtData=JSON.parse(readFileSync(new URL('./hub-district-data.json',import.meta.url),'utf8'));
const hubJson=JSON.parse(readFileSync(new URL('./hub-data.json',import.meta.url),'utf8')); // Read directly to avoid a circular import with hubs.mjs.
const hubBeds=hubJson.beds; // The same six bed profiles the Resting Halls use.
export const districtZone=def=>def.lobby?def.hub:def.hub+'-garden'; // A lobby town (Honeydew Village) is its hub's own zone; every other district is the hub's "garden" annex.
export const shopFixtures=()=>hubJson.shops.map(shop=>({id:shop.id,name:shop.name,sprite:shop.sprite,kind:'shop'})); // The eight merchants, wherever a hub keeps them (a Market Hall or the village clearings).
export const marketServices=()=>[{id:'bank',name:'Bank',kind:'bank'},{id:'dumpster',name:'Dumpster',kind:'dumpster',sprite:'sprCityTrashCan'},{id:'curse-remover',name:'Cursebreaker',kind:'npc',avatar:'objNPCMossWitch',service:'curse_remove',price:hubJson.config.curse_removal_price,line:'I can release one piece of cursed gear for 20 LiDollCoins. Choose what you would like removed. Items returned to your bag remain cursed; used diapers are disposed of.'}]; // Bank, dumpster and Cursebreaker travel with the merchants.
export const SERVICE_KINDS=['npc','shop','bank','dumpster','cauldron','toilet','changer']; // Fixtures a player must be able to stand beside.
export const cauldronFixture=(x,y)=>({id:'cauldron',name:'Cauldron',kind:'cauldron',x,y,span_w:1,span_h:1,solid:true}); // A brewing station: the client draws objCauldron and opens the brewing panel beside it (scrAlchemy); brewing itself is client-side.
export const dormitoryCauldron=d=>cauldronFixture(d.x+d.w-1,d.y+Math.floor(d.h/2)); // East wall of a dormitory, clear of the three bed columns and the doorway (Rose Court: The Castle, 47,16).
export const reagentFixture=(x,y)=>({id:hubJson.reagent_shop.id,name:hubJson.reagent_shop.name,sprite:hubJson.reagent_shop.sprite,kind:'shop',x,y,span_w:1,span_h:1,solid:true}); // Bramble, the reagent seller: always beside a cauldron, never in Market Halls or storefronts (hub-data.json reagent_shop).
export const dormitoryReagents=d=>reagentFixture(d.x+d.w-1,d.y+Math.floor(d.h/2)+3); // three tiles south of the dormitory cauldron (The Castle, 47,19); two would wall in the tile between her, the pot and a bed.
export const dormitoryBeds=(d,beds=hubBeds)=>beds.map((bed,i)=>({...bed,kind:'bed',x:d.x+1+(i%3)*3,y:d.y+1+Math.floor(i/3)*3,span_w:1,span_h:1,solid:true})); // Two rows of three beds, three tiles apart so their name labels never overlap, with a free aisle between and around them.
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
const parts=time=>Object.fromEntries(clock.formatToParts(time).map(p=>[p.type,p.value]));
const monthMemo=new Map(); // reset hour -> last month window: {edition,starts,ends}.
export function monthlyWindow(time,hour=4){
 const memo=monthMemo.get(hour);if(memo&&time>=memo.starts&&time<memo.ends)return {...memo}; // Skip seven slow time-zone formats: every snapshot, read and tick asks for each town's month.
 function boundary(year,month){const target=Date.UTC(year,month,1,hour);let value=target+8*3600000;for(let i=0;i<3;i++){const p=parts(value);value+=target-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour);}return value;}
 const p=parts(time);let year=+p.year,month=+p.month-1;
 if(time<boundary(year,month)){month--;if(month<0){month=11;year--;}}
 const window={edition:`${year}-${String(month+1).padStart(2,'0')}`,starts:boundary(year,month),ends:boundary(year,month+1)};
 monthMemo.set(hour,window);return {...window}; // Callers get a copy, so nothing can edit the memo.
} // Month boundaries stay at 04:00 Pacific across daylight-saving changes and downtime.
const footprint=f=>Array.from({length:f.span_h??1},(_,dy)=>Array.from({length:f.span_w??1},(_,dx)=>({x:f.x+dx,y:f.y+dy}))).flat();
export const districtBlocked=(f,x,y)=>x<0||y<0||x>=f.width||y>=f.height||f.walls[y][x]===1||f.fixtures.some(p=>p.solid!==false&&x>=p.x&&y>=p.y&&x<p.x+(p.span_w??1)&&y<p.y+(p.span_h??1));
export function reachableDistrict(f){
 const blocked=new Set(f.fixtures.filter(p=>p.solid!==false).flatMap(footprint).map(p=>p.x+','+p.y));
 const seen=new Set(),queue=[f.spawn];
 for(let n=0;n<queue.length;n++){const p=queue[n],key=p.x+','+p.y;if(seen.has(key)||p.x<0||p.y<0||p.x>=f.width||p.y>=f.height||f.walls[p.y][p.x]||blocked.has(key))continue;seen.add(key);queue.push({x:p.x-1,y:p.y},{x:p.x+1,y:p.y},{x:p.x,y:p.y-1},{x:p.x,y:p.y+1});}
 return seen;
}
export const storeSlug=shop=>String(shop.name??shop.id).toLowerCase().replace(/[^a-z0-9]+/g,'-'); // "Mira" -> mira: the tail of a store room id (littlebig-clockwork-store-mira).
export const toiletFixture=(id,x,y,style='porcelain',name=style==='outhouse'?'Outhouse':'Toilet')=>({id,name,kind:'toilet',style,sprite:style==='outhouse'?'sprPlainsEnvOuthouse':'sprToilet',x,y,span_w:1,span_h:style==='outhouse'?2:1,solid:true}); // A private toilet: the client runs the relief (online_toilet_use), then commits the loadout.
export const changerFixture=(id,x,y)=>({id,name:'Auto-Changing Station',kind:'changer',sprite:'sprUtopiaChanger',x,y,span_w:1,span_h:2,solid:true}); // Utopia's magitek booth: a free change, and padding for anyone not wearing any (client online_auto_change).
export const dormitoryToilet=d=>toiletFixture('dormitory-toilet',d.x,d.y); // The Castle: top-left corner of the dormitory, clear of the bed rows (x+1..), the cauldron (east wall) and the doorway (bottom).

export const addOuthouses=(f,def,data=districtData)=>addSpreadFixtures(f,def,data,{count:def.lobby?.outhouses??0,seed:'outhouses',is:x=>x.kind==='toilet'&&x.style==='outhouse',make:(n,x,y)=>toiletFixture('outhouse-'+n,x,y,'outhouse')}); // Honeydew Village's outhouses.
export const payToiletFixture=(id,x,y)=>({id,name:'Pay Toilet',kind:'toilet',style:'paytoilet',sprite:'sprArcadiaPayToilet',x,y,span_w:1,span_h:2,solid:true}); // Arcadia's coin-turnstile cubicle: the server takes the fee (hubs.mjs preparePayToilet), then the client runs the relief.
export const addPayToilets=(f,def,data=districtData)=>addSpreadFixtures(f,def,data,{count:def.lobby?.pay_toilets??0,seed:'paytoilets',is:x=>x.kind==='toilet'&&x.style==='paytoilet',make:(n,x,y)=>payToiletFixture('paytoilet-'+n,x,y)}); // Arcadia's few street pay toilets, spread like Honeydew's outhouses.
export const addChangers=(f,def,data=districtData)=>addSpreadFixtures(f,def,data,{count:def.lobby?.changers??0,seed:'changers',is:x=>x.kind==='changer',make:(n,x,y)=>changerFixture('changer-'+n,x,y)}); // Utopia's Auto-Changing Stations.
export function addSpreadFixtures(f,def,data,{count,seed,is,make}){ // 1x2 fixtures spread round a lobby town (outhouses, changers). Used by new months and upgrades saved ones in place: its own seed, no reroll.
 const want=Math.max(0,count),have=f.fixtures.filter(is);
 if(have.length>=want)return false;
 const {width:W,height:H}=districtSize(def,data),cx=Math.floor(W/2),cy=Math.floor(H/2),rnd=seeded(`${def.hub}:${f.district?.layoutKey??''}:${seed}:v1`);
 const strips=[{...entryStrip(W,H),w:W},westStrip(H),...(def.lobby?.gates?.north?[northStrip(W)]:[]),...(def.lobby?.gates?.south?[southStrip(W,H)]:[])];
 const near=(p,x,y,d)=>Math.abs(p.x-x)<=d&&Math.abs(p.y-y)<=d;
 const avoid=(x,y)=>strips.some(s=>x>=s.x&&x<s.x+s.w&&y>=s.y&&y<s.y+s.h)||Math.hypot(x-cx,y-cy)<=(def.layout?.village_square_radius??6)+3 // Gates, entry strips and the village square stay clear...
  ||(def.lobby.buildings??[]).some(b=>x>=b.x-2&&x<b.x+(b.span_w??3)+2&&y>=b.y-2&&y<b.y+(b.span_h??3)+4) // ...and so does the ring round each facade and its doorstep.
  ||near(def.lobby.spawn,x,y,2)||near(def.lobby.stairs,x,y,2)||(f.doorsteps??[]).some(d=>near(d,x,y,2));
 let added=false;const placed=[...have];
 for(let attempt=0;attempt<600&&placed.length<want;attempt++){
  const x=2+rnd(W-4),y=2+rnd(H-5),cells=[{x,y},{x,y:y+1}];
  if(cells.some(c=>districtBlocked(f,c.x,c.y)||avoid(c.x,c.y)||f.fixtures.some(p=>footprint(p).some(q=>q.x===c.x&&q.y===c.y))))continue; // Never on anyone, not even a non-solid wandering resident.
  if(placed.some(o=>Math.hypot(o.x-x,o.y-y)<14))continue; // Spread them round the town.
  if(![-1,1].some(dx=>cells.every(c=>!districtBlocked(f,c.x+dx,c.y))))continue; // Somewhere to stand beside the door.
  const fixture=make(placed.length,x,y);f.fixtures.push(fixture);
  const seen=reachableDistrict(f),count=f.walls.flat().filter(v=>v===0).length-new Set(f.fixtures.filter(p=>p.solid!==false).flatMap(footprint).map(p=>p.x+','+p.y)).size;
  if(seen.size!==count||![-1,1].some(dx=>cells.some(c=>seen.has((c.x+dx)+','+c.y)))||f.fixtures.some(n=>SERVICE_KINDS.includes(n.kind)&&![[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen.has((n.x+dx)+','+(n.y+dy))))){f.fixtures.pop();continue;} // Never seal floor, keep its door side reachable, and never take the last free tile beside a merchant, service or resident.
  placed.push(fixture);added=true;
 }
 return added;
}

export function addArcadiaAir(f,def){ // Copy a district's smog and whistle tuning onto its floor; smog patches centre on each gravel smokestack yard. No random numbers, so saved months gain it in place.
 const smog=def.features?.smog,whistle=def.features?.whistle;
 if(!smog&&!whistle)return false;
 const before=JSON.stringify([f.smog,f.whistle]);
 if(smog)f.smog={...smog,patches:f.rooms.filter(r=>r.kind==='stack_yard').map(r=>({x:r.cx,y:r.cy,r:smog.radius}))}; // Choking air round every yard.
 if(whistle)f.whistle={...whistle}; // period_minutes, warning_seconds, blast_seconds, startle_wet: the client reads the shared serverTime clock.
 return JSON.stringify([f.smog,f.whistle])!==before;
}
export function addCastleTemple(f,def){ // Sable's Veiled Sanctum: a fixed room below the Castle's entry strip (def.temple {x,y,w,h,door:{x}}), its doorway running up to the strip. Seed-free, so saved months gain it in place.
 const tp=def.temple,god=tp?templeGod(def.hub):null;if(!tp||!god||f.fixtures.some(x=>x.kind==='altar'))return false;
 const cy=Math.floor(f.height/2),east=entryStrip(f.width,f.height),tile=def.style==='castle'?1:6,cells=[];
 for(let y=tp.y;y<tp.y+tp.h;y++)for(let x=tp.x;x<tp.x+tp.w;x++)cells.push({x,y});
 for(let y=east.y+east.h;y<tp.y;y++)cells.push({x:tp.door.x,y}); // The doorway north to the protected entry area.
 const inside=new Set(cells.map(c=>c.x+','+c.y));
 f.fixtures=f.fixtures.filter(x=>!footprint(x).some(c=>inside.has(c.x+','+c.y))); // A saved month's scenery or residents standing where the temple goes step aside.
 for(const c of cells){f.walls[c.y][c.x]=0;f.floors[c.y][c.x]=tile;f.wallTiles[c.y][c.x]=0;}
 const mid=tp.x+Math.floor(tp.w/2),back=tp.y+tp.h-1;
 f.fixtures.push(altarFixture(god.id,mid-1,back),priestFixture(god.id,mid+2,back-1),pewFixture('temple-pew-1',tp.x+1,tp.y+2),pewFixture('temple-pew-2',tp.x+tp.w-3,tp.y+2),pewFixture('temple-pew-3',tp.x+1,tp.y+4),pewFixture('temple-pew-4',tp.x+tp.w-3,tp.y+4)); // Altar at the far end, facing the door.
 if(!f.rooms.some(r=>r.kind==='temple'))f.rooms.push({x:tp.x,y:tp.y,w:tp.w,h:tp.h,cx:mid,cy:tp.y+Math.floor(tp.h/2),kind:'temple',god:god.id}); // Sable's changing-room rule reads this.
 return true;
}
export function generateDistrict(definition,window,data=districtData){
 const {width,height}=districtSize(definition,data);if(![width,height].every(n=>Number.isInteger(n)&&n>=40&&n<=80)||!Number.isInteger(data.scenery_count)||data.scenery_count<12||data.scenery_count>100)throw Error('Monthly districts require 40-80 tile maps and 12-100 scenery pieces.');
 const cx=Math.floor(width/2),cy=Math.floor(height/2),east=entryStrip(width,height),west=westStrip(height);
 const rnd=seeded(`${definition.hub}:${window.edition}:district:${data.version}`),layout=districtLayout(definition,rnd,data);
 const {protectedCells,paths,...geometry}=layout;
 const lobby=definition.lobby??null; // Set when this district IS its hub's lobby (Honeydew Village, LittleBigCity): gates in its own walls, civic buildings, and the hub's merchants in the town or in storefronts.
 const f={...geometry,width,height,name:definition.name,spawn:lobby?{...lobby.spawn}:{x:width-2,y:cy},exit:lobby?{...lobby.stairs,style:'stairs'}:{x:width-1,y:cy-1,w:1,h:2,style:'gap',side:'right'},district:{edition:window.edition,layoutVersion:data.version,layoutKey:`${window.edition}:v${data.version}`,resetsAt:window.ends,style:definition.style,tileset:definition.tileset,source:definition.source_zone,model:{castle:'bsp-rooms',market:'woodland-clearings',nightlife:'city-blocks',magitek:'rune-plazas',industrial:'factory-blocks'}[definition.style],routeCount:paths.length,lobby:!!lobby},fixtures:[],doorsteps:[]}; // A lobby town's exit is its campaign stairs; an annex district's exit is the east gap back to the lobby. doorsteps: storefront portals generated with the street plan.
 const inStrip=(p,strip)=>p.x>=strip.x&&p.x<strip.x+strip.w&&p.y>=strip.y&&p.y<strip.y+strip.h;
 const occupied=new Set(),safe=p=>inStrip(p,{...east,w:width-east.x})||(lobby&&inStrip(p,west))||(!!lobby?.gates?.north&&inStrip(p,northStrip(width)))||(!!lobby?.gates?.south&&inStrip(p,southStrip(width,height))); // Entry strips beside the east gate (and a lobby town's west, north and south gates) stay clear.
 if(definition.dormitory){ // Beds are fixed fixtures: the same tiles every month, reachable from the entrance in a few steps.
  const d=definition.dormitory;if(!(d.w>=9&&d.h>=6&&d.x>=1&&d.y>=1&&d.x+d.w<=width-2&&d.y+d.h<=east.y-1&&d.door.x>=d.x&&d.door.x<d.x+d.w))throw Error('District dormitory must be at least 9x6, sit above the entry area and own its doorway');
  for(const bed of dormitoryBeds(d)){f.fixtures.push(bed);for(const c of footprint(bed))occupied.add(c.x+','+c.y);}
  const pot=dormitoryCauldron(d);f.fixtures.push(pot);occupied.add(pot.x+','+pot.y); // the castle's brewing station sits with the beds
  const bramble=dormitoryReagents(d);f.fixtures.push(bramble);occupied.add(bramble.x+','+bramble.y); // and Bramble sells reagents beside it
  const loo=dormitoryToilet(d);f.fixtures.push(loo);occupied.add(loo.x+','+loo.y); // and the castle's toilet waits in the corner
 }
 if(definition.temple){addCastleTemple(f,definition);const tp=definition.temple;for(let y=tp.y-4;y<tp.y+tp.h;y++)for(let x=tp.x;x<tp.x+tp.w;x++){occupied.add(x+','+y);protectedCells.add(x+','+y);}} // Sable's temple before any scenery, so nothing is ever placed in it or its doorway.
 for(const b of lobby?.buildings??[]){const facade={id:b.id,kind:'scenery',name:'',sprite:b.sprite,x:b.x,y:b.y,span_w:b.span_w,span_h:b.span_h,solid:true};f.fixtures.push(facade);for(const c of footprint(facade))occupied.add(c.x+','+c.y);} // Plaza buildings (Community Hall / Inn, Coliseum / Inn): solid props whose doorsteps are lobby portals (hubs.mjs lobbyPortals).
 if(lobby?.storefronts){ // LittleBigCity: every merchant gets a storefront on a city-block facade, its doorstep on the sidewalk below (south face) or above (north face). Blocks change monthly, so the doors do too.
  const sf=lobby.storefronts,stores=shopFixtures(),blocks=f.blocks.filter(b=>b.kind==='city_block').map(b=>({...b,d:Math.hypot(b.cx-cx,b.cy-cy)})).sort((a,b)=>a.d-b.d); // Nearest blocks to the plaza first: the shopping streets ring the centre.
  const slots=[];
  for(const b of blocks)for(const face of ['south','north']){ // Two facades per face at most, so the shops spread along several streets.
   const fy=face==='south'?b.y+b.h-sf.span_h:b.y,dy=face==='south'?b.y+b.h:b.y-1;
   for(let x=b.x;x+sf.span_w<=b.x+b.w&&slots.filter(s=>s.block===b&&s.face===face).length<2;x+=sf.span_w+1){
    const cells=[];for(let yy=fy;yy<fy+sf.span_h;yy++)for(let xx=x;xx<x+sf.span_w;xx++)cells.push({x:xx,y:yy});
    const doorstep={x:x+Math.floor(sf.span_w/2),y:dy},arrival={x:doorstep.x,y:face==='south'?dy+1:dy-1};
    if(cells.some(c=>c.x<1||c.y<1||c.x>=width-1||c.y>=height-1||!f.walls[c.y][c.x]||occupied.has(c.x+','+c.y)))continue; // The facade replaces solid building mass only.
    if([doorstep,arrival].some(p=>p.x<1||p.y<1||p.x>=width-1||p.y>=height-1||f.walls[p.y][p.x]||occupied.has(p.x+','+p.y)||safe(p)||f.doorsteps.some(d=>Math.abs(d.x-p.x)+Math.abs(d.y-p.y)<2)))continue; // Doorstep and arrival must already be street.
    slots.push({block:b,face,x,fy,doorstep,arrival,cells});
   }
  }
  if(slots.length<stores.length)throw Error('Not enough building facades for the '+stores.length+' storefronts in '+definition.name);
  stores.forEach((shop,i)=>{const slot=slots[i],slug=storeSlug(shop);
   for(const c of slot.cells){f.walls[c.y][c.x]=0;f.floors[c.y][c.x]=f.floors[slot.arrival.y][slot.arrival.x];f.wallTiles[c.y][c.x]=0;occupied.add(c.x+','+c.y);} // The facade footprint becomes floor covered by the solid storefront sprite, like the plaza buildings.
   f.fixtures.push({id:'store-'+slug,kind:'scenery',name:'',sprite:sf.sprite,x:slot.x,y:slot.fy,span_w:sf.span_w,span_h:sf.span_h,solid:true});
   for(const p of [slot.doorstep,slot.arrival]){protectedCells.add(p.x+','+p.y);occupied.add(p.x+','+p.y);} // Nothing may ever stand on a doorstep or its arrival tile.
   f.doorsteps.push({x:slot.doorstep.x,y:slot.doorstep.y,name:shop.name+"'s Store",target:definition.hub+'-store-'+slug,style:'door',threshold:true,shop:shop.id});
  });
 }
 function place(profile,index,kind='scenery'){
  const npc=kind!=='scenery',fixed=kind==='npc'&&index===0&&!profile.id; // The first greeter always stands at the east entry.
  for(let tries=0;tries<500;tries++){
   const region=f.rooms[(index+Math.floor(tries/20))%f.rooms.length];
   let x=2+rnd(width-5),y=2+rnd(height-5);
   if(fixed){x=width-6;y=cy-2;}
   else if(tries<300&&(definition.style!=='nightlife'||npc||index%4===0)){
    if(region.r){x=region.cx-region.r+1+rnd(Math.max(1,2*region.r-1));y=region.cy-region.r+1+rnd(Math.max(1,2*region.r-1));}
    else {x=region.x+rnd(Math.max(1,region.w-(profile.span_w??1)+1));y=region.y+rnd(Math.max(1,region.h-(profile.span_h??1)+1));
     if(!npc&&tries%2===0)y=region.y; // Castle furnishings and city courtyard details gather against edges, preserving open room centres.
    }
   }
   const p={...profile,x,y,id:profile.id??(npc?'npc-':'scenery-')+index,kind,name:profile.name??'',span_w:profile.span_w??1,span_h:profile.span_h??1}; // Merchants and services keep their authored IDs (objNPCMerchant, bank, ...); greeters and scenery are numbered.
   const cells=footprint(p);
   if(cells.some(c=>c.x<1||c.y<1||c.x>=width-2||c.y>=height-2||f.walls[c.y][c.x]||occupied.has(c.x+','+c.y)))continue;
   if(!fixed&&cells.some(c=>safe(c)||protectedCells.has(c.x+','+c.y)))continue;
   f.fixtures.push(p);const seen=reachableDistrict(f),count=f.walls.flat().filter(v=>v===0).length-new Set(f.fixtures.filter(p=>p.solid!==false).flatMap(footprint).map(p=>p.x+','+p.y)).size;
   if(seen.size!==count||f.fixtures.some(n=>SERVICE_KINDS.includes(n.kind)&&![[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen.has((n.x+dx)+','+(n.y+dy))))){f.fixtures.pop();continue;} // Every person, counter, bank and bin keeps a free tile beside it.
   for(const c of cells)occupied.add(c.x+','+c.y);return true;
  }return false;
 }
 definition.npcs.filter(npc=>!npc.roaming).forEach((npc,i)=>{if(!place({...npc,solid:true},i,'npc'))throw Error('No reachable place for district NPC');});
 if(lobby)[...(lobby.storefronts?[]:shopFixtures()),...marketServices()].forEach((service,i)=>{if(!place({...service,solid:true},i+1,service.kind))throw Error('No reachable place for '+service.name+' in '+definition.name);}); // The bank, dumpster and Cursebreaker (and, without storefronts, the merchants too) stand in the town, one clearing after another.
 // Building mass now comes from LittleBig City's block topology; freestanding facade sprites must not occupy its streets.
 const profiles=definition.scenery.filter(p=>definition.style!=='nightlife'||!p.sprite.includes('Facade'));
 for(let i=0;i<data.scenery_count;i++)place(profiles[rnd(profiles.length)],i);
 if(f.fixtures.filter(p=>p.kind==='scenery').length<12)throw Error('District scenery is too sparse');
 if(lobby){addOuthouses(f,definition,data);addChangers(f,definition,data);addPayToilets(f,definition,data);} // On their own seeds after every fixed roll, and before the wanderers, so residents never change where they stand.
 addArcadiaAir(f,definition); // Arcadia: smog over the smokestack yards and the shift whistle's schedule (client online_arcadia_step).
 addFullDungeonEntrances(f,districtZone(definition)); // Reserve entrance footprints before placing passable wanderers, keeping fixed geometry independent of resident upgrades.
 addDistrictResidents(f,definition,data); // Add wanderers after scenery so the original four residents and geometry keep their seeded positions.
 return f;
} // Host-specific geometry replaces the old universal path lattice; ordinary movement and monthly resets remain shared.

export function createHubDistricts(db,{now=Date.now,data=districtData,beforeActivate=()=>{}}={}){
 db.exec('CREATE TABLE IF NOT EXISTS hub_district_editions(zone TEXT NOT NULL,edition TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(zone,edition)); CREATE TABLE IF NOT EXISTS hub_district_current(zone TEXT PRIMARY KEY,edition TEXT NOT NULL);');
 const cache=new Map();
 db.exec('CREATE TABLE IF NOT EXISTS hub_district_controls(zone TEXT PRIMARY KEY,locked INTEGER NOT NULL,pinned TEXT,month TEXT,reroll INTEGER NOT NULL)'); // GM lock / regenerate state per monthly hub map; survives restarts.
 const controlQuery=db.prepare('SELECT * FROM hub_district_controls WHERE zone=?');let visitorsQuery=null; // Prepared once: windowFor runs for every town on every snapshot and tick. visitorsQuery waits for first use (standalone district tests have no presence table).
 const control=id=>controlQuery.get(id)??{zone:id,locked:0,pinned:null,month:null,reroll:0};
 const saveControl=c=>db.prepare('INSERT INTO hub_district_controls VALUES (?,?,?,?,?) ON CONFLICT(zone) DO UPDATE SET locked=excluded.locked,pinned=excluded.pinned,month=excluded.month,reroll=excluded.reroll').run(c.zone,c.locked?1:0,c.pinned,c.month,c.reroll);
 function windowFor(id){ // Which layout this hub should show right now: a locked hub keeps its pinned layout; a GM reroll this month gets a fresh seed; otherwise the calendar month.
  const base=monthlyWindow(now(),data.reset_hour),c=control(id);
  if(c.locked&&c.pinned)return JSON.parse(c.pinned); // Monthly resets skip a locked hub.
  return c.month===base.edition&&c.reroll>0?{...base,edition:base.edition+'-r'+c.reroll}:base; // A reroll lasts until the next monthly reset.
 }
 const visitors=id=>(visitorsQuery??=db.prepare('SELECT x,y FROM quest_presence WHERE zone=? AND seen>?')).all(id,now()-30000);
 const addCauldron=(f,def)=>{ // Editions generated before cauldrons (and Bramble) existed gain them on load, without regenerating the month.
  if(!def.dormitory)return false;
  let added=false;
  for(const [kind,make] of [['cauldron',dormitoryCauldron],['reagents',dormitoryReagents],['toilet',dormitoryToilet]]){
   const fixture=make(def.dormitory);
   if(f.fixtures.some(x=>x.id===fixture.id&&x.x===fixture.x&&x.y===fixture.y))continue; // already there
   if(districtBlocked(f,fixture.x,fixture.y))continue;                                    // a resident is standing there: try again next load
   f.fixtures.push(fixture);added=true;
  }
  return added;
 };
 const addEdgeGate=(f,def,side)=>{ // Months generated before Honeydew's north (Woods) or south (Autumnal Plains) gate existed gain it in place: no reroll, nobody sent back to the entrance.
  if(!def.lobby?.gates?.[side])return false;
  const cx=Math.floor(f.width/2),row=side==='south'?f.height-1:0;if(!f.walls[row][cx-1]&&!f.walls[row][cx])return false; // Already open.
  const cells=new Set(carveEdgeGate(f,def,data,side).map(c=>c.x+','+c.y)),buildings=new Set((def.lobby.buildings??[]).map(b=>b.id));
  f.fixtures=f.fixtures.filter(x=>x.kind!=='scenery'||buildings.has(x.id)||!Array.from({length:(x.span_w??1)*(x.span_h??1)},(_,i)=>(x.x+i%(x.span_w??1))+','+(x.y+Math.floor(i/(x.span_w??1)))).some(k=>cells.has(k))); // Loose scenery sitting on the new road is cleared; plaza buildings and people stay.
  return true;
 };
 const upgrade=(id,f,def)=>{const gate=addEdgeGate(f,def,'north')|addEdgeGate(f,def,'south')|(def.lobby?addOuthouses(f,def,data)|addChangers(f,def,data)|addPayToilets(f,def,data):false)|addArcadiaAir(f,def)|addCastleTemple(f,def),pot=addCauldron(f,def)||gate;if(((f.district.residentVersion??0)<(data.resident_version??0)&&addDistrictResidents(f,def,data,visitors(id)))||pot)persist(id,f);};
 const persist=(id,f)=>db.prepare('UPDATE hub_district_editions SET content=? WHERE zone=? AND edition=?').run(JSON.stringify(f),id,f.district.layoutKey);
 function ensure(def){
  const id=districtZone(def),window=windowFor(id),layoutKey=`${window.edition}:v${data.version}`,cached=cache.get(id);if(cached?.district.layoutKey===layoutKey){upgrade(id,cached,def);return cached;}
  const row=db.prepare('SELECT content FROM hub_district_editions WHERE zone=? AND edition=?').get(id,layoutKey);
  const f=row?JSON.parse(row.content):generateDistrict(def,window,data);
  const prior=db.prepare('SELECT edition FROM hub_district_current WHERE zone=?').get(id);
  if(prior&&prior.edition!==layoutKey){const old=db.prepare('SELECT content FROM hub_district_editions WHERE zone=? AND edition=?').get(id,prior.edition);try{beforeActivate(id,f);}catch(error){if(old)return JSON.parse(old.content);throw error;}}
  if(!row)db.prepare('INSERT INTO hub_district_editions VALUES (?,?,?)').run(id,layoutKey,JSON.stringify(f));
  else upgrade(id,f,def); // A resident-only update does not replace the layout or send visitors back to the entrance.
  if(addFullDungeonEntrances(f,id,visitors(id)))persist(id,f); // Add doors to a saved month without replacing content or covering a connected visitor.
  const current=db.prepare('SELECT edition FROM hub_district_current WHERE zone=?').get(id);
  if(current?.edition!==layoutKey){
   db.prepare('UPDATE quest_presence SET x=?,y=?,moved=? WHERE zone=?').run(f.spawn.x,f.spawn.y,now(),id);
   db.prepare('INSERT INTO hub_district_current VALUES (?,?) ON CONFLICT(zone) DO UPDATE SET edition=excluded.edition').run(id,layoutKey);
  } // Move visitors to the unchanged entry path when the month or layout version changes, preserving their character, inventory and needs turn.
  cache.set(id,f);return f;
 }
 function refresh(){for(const d of data.districts)ensure(d);}
 function resolve(base){const def=data.districts.find(d=>base.id===districtZone(d));return def?{...base,...ensure(def)}:base;} // A lobby town resolves onto its hub's own catalog entry.
 function tick(){for(const def of data.districts){const id=districtZone(def),players=visitors(id);if(!players.length)continue;const f=ensure(def);if(moveDistrictResidents(f,players,now(),data))persist(id,f);}}
 const defFor=id=>data.districts.find(d=>districtZone(d)===id);
 function status(id){ // What the GM panel shows for a monthly hub map; null for fixed rooms (courtyards, inns, halls).
  const def=defFor(id);if(!def)return null;
  const c=control(id),wanted=`${windowFor(id).edition}:v${data.version}`,shown=ensure(def).district.layoutKey;
  return {locked:!!c.locked,layoutKey:shown,pending:wanted!==shown,resetsAt:c.locked?null:monthlyWindow(now(),data.reset_hour).ends}; // pending: a new layout waits for battles in this hub to end.
 }
 function lock(id,locked){ // Pin the layout on screen now, or return to the calendar month.
  const def=defFor(id);if(!def)throw Object.assign(Error('Only monthly hub maps can be locked.'),{status:400});
  const c=control(id);
  if(locked&&!c.locked){const f=ensure(def),current=windowFor(id),shownEdition=f.district.edition;saveControl({...c,locked:true,pinned:JSON.stringify({...current,edition:shownEdition})});} // Pin exactly what visitors see, even while a reroll is still waiting on a battle.
  else if(!locked&&c.locked)saveControl({...c,locked:false,pinned:null}); // The next read follows the calendar again (or this month's reroll).
  cache.delete(id);return status(id);
 }
 function regenerate(id){ // Roll a brand-new layout for this hub now; a locked hub stays locked on the new layout.
  const def=defFor(id);if(!def)throw Object.assign(Error('Only monthly hub maps can be regenerated.'),{status:400});
  const base=monthlyWindow(now(),data.reset_hour),c=control(id),reroll=c.month===base.edition?c.reroll+1:1,next={...base,edition:base.edition+'-r'+reroll};
  saveControl({...c,month:base.edition,reroll,pinned:c.locked?JSON.stringify(next):null}); // Fresh seed: <month>-r<n>.
  cache.delete(id);ensure(def);return status(id); // Activates immediately, or waits (pending) while someone in the hub is mid-battle.
 }
 return {refresh,resolve,tick,status,lock,regenerate};
} // Materialized monthly editions survive service restarts and mid-month content deployments.
