import {addDistrictResidents,moveDistrictResidents} from './district-residents.mjs';
import {districtLayout,districtSize,entryStrip,westStrip,northStrip,carveNorthGate} from './district-layouts.mjs';
import {readFileSync} from 'node:fs';
import {seeded} from './dive-generation.mjs';

export const districtData=JSON.parse(readFileSync(new URL('./hub-district-data.json',import.meta.url),'utf8'));
const hubJson=JSON.parse(readFileSync(new URL('./hub-data.json',import.meta.url),'utf8')); // Read directly to avoid a circular import with hubs.mjs.
const hubBeds=hubJson.beds; // The same six bed profiles the Resting Halls use.
export const districtZone=def=>def.lobby?def.hub:def.hub+'-garden'; // A lobby town (Honeydew Village) is its hub's own zone; every other district is the hub's "garden" annex.
export const shopFixtures=()=>hubJson.shops.map(shop=>({id:shop.id,name:shop.name,sprite:shop.sprite,kind:'shop'})); // The eight merchants, wherever a hub keeps them (a Market Hall or the village clearings).
export const marketServices=()=>[{id:'bank',name:'Bank',kind:'bank'},{id:'dumpster',name:'Dumpster',kind:'dumpster',sprite:'sprCityTrashCan'},{id:'curse-remover',name:'Cursebreaker',kind:'npc',avatar:'objNPCMossWitch',service:'curse_remove',price:hubJson.config.curse_removal_price,line:'I can release one piece of cursed gear for 20 LiDollCoins. Choose what you would like removed. Items returned to your bag remain cursed; used diapers are disposed of.'}]; // Bank, dumpster and Cursebreaker travel with the merchants.
export const SERVICE_KINDS=['npc','shop','bank','dumpster','cauldron']; // Fixtures a player must be able to stand beside.
export const cauldronFixture=(x,y)=>({id:'cauldron',name:'Cauldron',kind:'cauldron',x,y,span_w:1,span_h:1,solid:true}); // A brewing station: the client draws objCauldron and opens the brewing panel beside it (scrAlchemy); brewing itself is client-side.
export const dormitoryCauldron=d=>cauldronFixture(d.x+d.w-1,d.y+Math.floor(d.h/2)); // East wall of a dormitory, clear of the three bed columns and the doorway (Rose Court: The Castle, 47,16).
export const reagentFixture=(x,y)=>({id:hubJson.reagent_shop.id,name:hubJson.reagent_shop.name,sprite:hubJson.reagent_shop.sprite,kind:'shop',x,y,span_w:1,span_h:1,solid:true}); // Bramble, the reagent seller: always beside a cauldron, never in Market Halls or storefronts (hub-data.json reagent_shop).
export const dormitoryReagents=d=>reagentFixture(d.x+d.w-1,d.y+Math.floor(d.h/2)+3); // three tiles south of the dormitory cauldron (The Castle, 47,19); two would wall in the tile between her, the pot and a bed.
export const dormitoryBeds=(d,beds=hubBeds)=>beds.map((bed,i)=>({...bed,kind:'bed',x:d.x+1+(i%3)*3,y:d.y+1+Math.floor(i/3)*3,span_w:1,span_h:1,solid:true})); // Two rows of three beds, three tiles apart so their name labels never overlap, with a free aisle between and around them.
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
const parts=time=>Object.fromEntries(clock.formatToParts(time).map(p=>[p.type,p.value]));
export function monthlyWindow(time,hour=4){
 function boundary(year,month){const target=Date.UTC(year,month,1,hour);let value=target+8*3600000;for(let i=0;i<3;i++){const p=parts(value);value+=target-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour);}return value;}
 const p=parts(time);let year=+p.year,month=+p.month-1;
 if(time<boundary(year,month)){month--;if(month<0){month=11;year--;}}
 return {edition:`${year}-${String(month+1).padStart(2,'0')}`,starts:boundary(year,month),ends:boundary(year,month+1)};
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
export function generateDistrict(definition,window,data=districtData){
 const {width,height}=districtSize(definition,data);if(![width,height].every(n=>Number.isInteger(n)&&n>=40&&n<=80)||!Number.isInteger(data.scenery_count)||data.scenery_count<12||data.scenery_count>100)throw Error('Monthly districts require 40-80 tile maps and 12-100 scenery pieces.');
 const cx=Math.floor(width/2),cy=Math.floor(height/2),east=entryStrip(width,height),west=westStrip(height);
 const rnd=seeded(`${definition.hub}:${window.edition}:district:${data.version}`),layout=districtLayout(definition,rnd,data);
 const {protectedCells,paths,...geometry}=layout;
 const lobby=definition.lobby??null; // Set when this district IS its hub's lobby (Honeydew Village, LittleBigCity): gates in its own walls, civic buildings, and the hub's merchants in the town or in storefronts.
 const f={...geometry,width,height,name:definition.name,spawn:lobby?{...lobby.spawn}:{x:width-2,y:cy},exit:lobby?{...lobby.stairs,style:'stairs'}:{x:width-1,y:cy-1,w:1,h:2,style:'gap',side:'right'},district:{edition:window.edition,layoutVersion:data.version,layoutKey:`${window.edition}:v${data.version}`,resetsAt:window.ends,style:definition.style,tileset:definition.tileset,source:definition.source_zone,model:{castle:'bsp-rooms',market:'woodland-clearings',nightlife:'city-blocks'}[definition.style],routeCount:paths.length,lobby:!!lobby},fixtures:[],doorsteps:[]}; // A lobby town's exit is its campaign stairs; an annex district's exit is the east gap back to the lobby. doorsteps: storefront portals generated with the street plan.
 const inStrip=(p,strip)=>p.x>=strip.x&&p.x<strip.x+strip.w&&p.y>=strip.y&&p.y<strip.y+strip.h;
 const occupied=new Set(),safe=p=>inStrip(p,{...east,w:width-east.x})||(lobby&&inStrip(p,west))||(!!lobby?.gates?.north&&inStrip(p,northStrip(width))); // Entry strips beside the east gate (and a lobby town's west and north gates) stay clear.
 if(definition.dormitory){ // Beds are fixed fixtures: the same tiles every month, reachable from the entrance in a few steps.
  const d=definition.dormitory;if(!(d.w>=9&&d.h>=6&&d.x>=1&&d.y>=1&&d.x+d.w<=width-2&&d.y+d.h<=east.y-1&&d.door.x>=d.x&&d.door.x<d.x+d.w))throw Error('District dormitory must be at least 9x6, sit above the entry area and own its doorway');
  for(const bed of dormitoryBeds(d)){f.fixtures.push(bed);for(const c of footprint(bed))occupied.add(c.x+','+c.y);}
  const pot=dormitoryCauldron(d);f.fixtures.push(pot);occupied.add(pot.x+','+pot.y); // the castle's brewing station sits with the beds
  const bramble=dormitoryReagents(d);f.fixtures.push(bramble);occupied.add(bramble.x+','+bramble.y); // and Bramble sells reagents beside it
 }
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
 addDistrictResidents(f,definition,data); // Add wanderers after scenery so the original four residents and geometry keep their seeded positions.
 return f;
} // Host-specific geometry replaces the old universal path lattice; ordinary movement and monthly resets remain shared.

export function createHubDistricts(db,{now=Date.now,data=districtData,beforeActivate=()=>{}}={}){
 db.exec('CREATE TABLE IF NOT EXISTS hub_district_editions(zone TEXT NOT NULL,edition TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(zone,edition)); CREATE TABLE IF NOT EXISTS hub_district_current(zone TEXT PRIMARY KEY,edition TEXT NOT NULL);');
 const cache=new Map();
 const visitors=id=>db.prepare('SELECT x,y FROM quest_presence WHERE zone=? AND seen>?').all(id,now()-30000);
 const addCauldron=(f,def)=>{ // Editions generated before cauldrons (and Bramble) existed gain them on load, without regenerating the month.
  if(!def.dormitory)return false;
  let added=false;
  for(const [kind,make] of [['cauldron',dormitoryCauldron],['reagents',dormitoryReagents]]){
   const fixture=make(def.dormitory);
   if(f.fixtures.some(x=>x.id===fixture.id&&x.x===fixture.x&&x.y===fixture.y))continue; // already there
   if(districtBlocked(f,fixture.x,fixture.y))continue;                                    // a resident is standing there: try again next load
   f.fixtures.push(fixture);added=true;
  }
  return added;
 };
 const addNorthGate=(f,def)=>{ // Months generated before Honeydew's north gate existed gain it in place: no reroll, nobody sent back to the entrance.
  if(!def.lobby?.gates?.north)return false;
  const cx=Math.floor(f.width/2);if(!f.walls[0][cx-1]&&!f.walls[0][cx])return false; // Already open.
  const cells=new Set(carveNorthGate(f,def,data).map(c=>c.x+','+c.y)),buildings=new Set((def.lobby.buildings??[]).map(b=>b.id));
  f.fixtures=f.fixtures.filter(x=>x.kind!=='scenery'||buildings.has(x.id)||!Array.from({length:(x.span_w??1)*(x.span_h??1)},(_,i)=>(x.x+i%(x.span_w??1))+','+(x.y+Math.floor(i/(x.span_w??1)))).some(k=>cells.has(k))); // Loose scenery sitting on the new road is cleared; plaza buildings and people stay.
  return true;
 };
 const upgrade=(id,f,def)=>{const gate=addNorthGate(f,def),pot=addCauldron(f,def)||gate;if(((f.district.residentVersion??0)<(data.resident_version??0)&&addDistrictResidents(f,def,data,visitors(id)))||pot)persist(id,f);};
 const persist=(id,f)=>db.prepare('UPDATE hub_district_editions SET content=? WHERE zone=? AND edition=?').run(JSON.stringify(f),id,f.district.layoutKey);
 function ensure(def){
  const id=districtZone(def),window=monthlyWindow(now(),data.reset_hour),layoutKey=`${window.edition}:v${data.version}`,cached=cache.get(id);if(cached?.district.layoutKey===layoutKey){upgrade(id,cached,def);return cached;}
  const row=db.prepare('SELECT content FROM hub_district_editions WHERE zone=? AND edition=?').get(id,layoutKey);
  const f=row?JSON.parse(row.content):generateDistrict(def,window,data);
  const prior=db.prepare('SELECT edition FROM hub_district_current WHERE zone=?').get(id);
  if(prior&&prior.edition!==layoutKey){const old=db.prepare('SELECT content FROM hub_district_editions WHERE zone=? AND edition=?').get(id,prior.edition);try{beforeActivate(id,f);}catch(error){if(old)return JSON.parse(old.content);throw error;}}
  if(!row)db.prepare('INSERT INTO hub_district_editions VALUES (?,?,?)').run(id,layoutKey,JSON.stringify(f));
  else upgrade(id,f,def); // A resident-only update does not replace the layout or send visitors back to the entrance.
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
 return {refresh,resolve,tick};
} // Materialized monthly editions survive service restarts and mid-month content deployments.
