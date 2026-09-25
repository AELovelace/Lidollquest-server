import {GODS,godsData,FAITH_SETTINGS,templeGod,dedicate,combatFaith,blessingValue} from './faith.mjs'; // The gods: temple annexes, dedication and Orin's Cursebreaker discount.
import {templeRoom} from './temple-rooms.mjs';
import {removeCursedGear} from './curse-removal.mjs';
import {districtData,districtZone,shopFixtures,marketServices,storeSlug,cauldronFixture,reagentFixture,toiletFixture,changerFixture} from './hub-districts.mjs';
import {districtSize} from './district-layouts.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {seeded} from './dive-generation.mjs';
import {createLootRoller,DEFAULT_TUNING} from './loot.mjs';
import {currentTuning} from './combat.mjs'; // Live loot tuning (daily_coin_cap); combat.mjs never imports this module, so there is no cycle.
import {roseCourtyard,GARDEN_PORTALS,validateCourtyard} from './hub-garden.mjs';
import {littlebigInn} from './lbc-inn.mjs';
import {utopiaNapPods,utopiaWorkshop,utopiaTower,UTOPIA_PADS} from './utopia-rooms.mjs';
import {arcadiaBoardingHouse,arcadiaRailDepot,arcadiaGuildhall} from './arcadia-rooms.mjs';
import {inArcadia,arcadiaLook,littleTax,taxedPrice} from './arcadia-rules.mjs';
import {dignityTuning} from './dignity.mjs';
import {withGenerated} from './generated-items.mjs';
import {fullDungeonHome} from './full-dungeons.mjs';

export const hubData=JSON.parse(readFileSync(new URL('./hub-data.json',import.meta.url),'utf8'));
export const findShop=id=>hubData.shops.find(s=>s.id===id)??(hubData.reagent_shop?.id===id?hubData.reagent_shop:undefined); // the eight merchants, plus Bramble beside the cauldrons
export const campaignDives=JSON.parse(readFileSync(new URL('./campaign-dives-data.json',import.meta.url),'utf8')).routes;
const c=hubData.config;
// Shop stock rolls through the same Adjective + Item + Rarity table as chests (shipped as `loot`
// inside dive-data.json). zones.mjs hands over the live gamemaster store so a /gm retune reaches
// the next day's stock; without it the shipped table alone is used (tests, tools).
const shopLootData=(()=>{try{return JSON.parse(readFileSync(new URL('./dive-data.json',import.meta.url),'utf8'));}catch{return {};}})();
const shopLootTable=shopLootData.loot??null,shopLootBases=shopLootData.bases??null;
let shopLoot={store:null,revision:null,roller:createLootRoller(shopLootTable,shopLootBases)};
export function configureShopLoot(store){shopLoot={store,revision:null,roller:createLootRoller(store?store.apply(shopLootTable):shopLootTable,store?store.applyBases(shopLootBases):shopLootBases)};}
export function shopRoller(){
 if(!shopLoot.store)return shopLoot.roller;
 const revision=shopLoot.store.revision();
 if(revision!==shopLoot.revision)shopLoot={...shopLoot,revision,roller:createLootRoller(shopLoot.store.apply(shopLootTable),shopLoot.store.applyBases(shopLootBases))};
 return shopLoot.roller;
}
if(!Number.isInteger(c.stock_size)||c.stock_size<1||c.stock_size>24||!Number.isFinite(c.coin_price_multiplier)||c.coin_price_multiplier<=0||c.coin_price_multiplier>100||!Number.isInteger(c.inventory_capacity)||c.inventory_capacity<1||c.inventory_capacity>512||!Number.isInteger(c.rest_tick_ms)||c.rest_tick_ms<500)throw Error('Invalid online hub tuning');
export const DAILY_COIN_CAP=c.daily_coin_cap??DEFAULT_TUNING.daily_coin_cap; // Shipped fallback only (hub-data.json config, else the tuning default): every live check goes through dailyCoinCap().
if(!Number.isInteger(DAILY_COIN_CAP)||DAILY_COIN_CAP<1||DAILY_COIN_CAP>100000)throw Error('Invalid daily coin cap'); // One account-wide UTC earnings allowance shared by arena payouts, dungeon bosses, weekly quests and item sales.
export function dailyCoinCap(){const n=Number(currentTuning()?.daily_coin_cap);return Number.isInteger(n)&&n>=1&&n<=100000?n:DAILY_COIN_CAP;} // The /gm Loot tab (daily_coin_cap) and the in-game GM Combat page retune the allowance live; a malformed key falls back to the shipped cap.
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'hub_conflict'});};
if(c.shop_width!==40||c.shop_height!==24||c.curse_removal_price!==20)throw Error('Invalid market dimensions or curse service price');
const gardenWidth=districtData.width,gardenHeight=districtData.height;
if(![gardenWidth,gardenHeight].every(n=>Number.isInteger(n)&&n>=20&&n<=80))throw Error('Invalid garden dimensions');
const roseGarden=roseCourtyard(hubData.courtyards?.find(h=>h.hub==='princess-rose')?.decorations); // Rose Court's lobby is a walled 20x20 garden; the other courts keep their 20x12 halls. Boot fails if the authored props trap anyone.
const lobbyTown=hub=>{const d=districtData.districts.find(d=>d.hub===hub);if(!d?.lobby)throw Error(hub+' must be exported as a lobby town (online_districts.json lobby, export_online_districts.py)');return d;}; // A hub whose lobby IS its monthly district (hub-districts.mjs resolves the map onto the catalog entry).
const town=lobbyTown('honeydew-lantern'),city=lobbyTown('littlebig-clockwork'),utopia=lobbyTown('utopia-arcanum'),arcadia=lobbyTown('arcadia-foundry'); // Honeydew Village (50x50), LittleBigCity (60x60), Utopia (60x60, the magitek city of littles north of the Taiga) and Arcadia (60x60, the steampunk city of bigs south of the Plains).
export function lobbyGates(def){ // Wilderness gates in a lobby town's own walls: rows cy-1..cy on the west and/or east wall, columns cx-1..cx on the north and/or south wall, as authored in lobby.gates.
 const {width,height}=districtSize(def,districtData),cx=Math.floor(width/2),cy=Math.floor(height/2),names={'dive-tundra':'Frostveil Tundra','dive-desert':'Dustbreak Desert','dive-haunted-woods':'Haunted Woods','dive-autumnal-plains':'Autumnal Plains','dive-seafoam-coast':'Seafoam Coast','dive-taiga':'Frostveil Taiga'},g=def.lobby.gates??{};
 return [...(g.west?[{x:0,y:cy-1,w:1,h:2,name:names[g.west]??g.west,target:g.west,style:'gap',side:'left'}]:[]),...(g.east?[{x:width-1,y:cy-1,w:1,h:2,name:names[g.east]??g.east,target:g.east,style:'gap',side:'right'}]:[]),...(g.north?[{x:cx-1,y:0,w:2,h:1,name:names[g.north]??g.north,target:g.north,style:'gap',side:'top'}]:[]),...(g.south?[{x:cx-1,y:height-1,w:2,h:1,name:names[g.south]??g.south,target:g.south,style:'gap',side:'bottom'}]:[])]; // Honeydew's north gate opens onto the Haunted Woods, its south gate onto the Autumnal Plains.
}
export const lobbyPortals=(def,resolved=null)=>[...lobbyGates(def),...(def.lobby.buildings??[]).map(b=>({x:b.door.x,y:b.door.y,name:b.name,target:def.hub+'-'+b.target,style:'door',threshold:true})),...(resolved?.doorsteps??[]).map(d=>({...d}))]; // Gates, the authored plaza doorsteps, and (for LittleBigCity) this month's storefront doorsteps. Stepping onto a doorstep transfers like a wall gap; the client draws a mat, not a doorway.
const campaignRoom=(key,label)=>{const r=hubData[key];if(!r||r.width!==20||r.height!==20||!Array.isArray(r.walls))throw Error('hub-data.json needs the 20x20 '+label+' export (export_online_hubs.py)');return r;}; // Both village interiors are the campaign rooms, tile for tile.
const communityHall=campaignRoom('community_hall','Community Hall'),innRoom=campaignRoom('inn','Inn');
const lbcInn=littlebigInn(hubData.beds); // Built once at boot; validated below like the village rooms.
const utopiaInteriors={beds:utopiaNapPods(hubData.beds),dives:utopiaWorkshop(),tower:utopiaTower()}; // Built once at boot; validated below.
const templeInteriors=Object.fromEntries(godsData.gods.filter(g=>g.temple_hub!=='princess-rose').map(g=>[g.temple_hub,templeRoom(g.id)])); // One temple annex per town; built once at boot and validated below.
if(templeInteriors['utopia-arcanum'])templeInteriors['utopia-arcanum'].fixtures.push(changerFixture('temple-changer',18,5)); // Utopia keeps its promise: an Auto-Changing Station in every room, Sula's Cradle included.
const arcadiaInteriors={beds:arcadiaBoardingHouse(hubData.beds),dives:arcadiaRailDepot(),tower:arcadiaGuildhall()}; // Arcadia's Boarding House, Rail Depot and Guildhall; validated below.
export const TOWN_PORTALS=Object.freeze(lobbyPortals(town)); // Honeydew Village's fixed openings (tests and docs refer to them by this name).
const VILLAGE_ROOM_EXIT=Object.freeze({x:10,y:18,style:'door'}); // Where town_subroom_generate() puts the campaign stairs: bottom centre, one tile above the wall. Walking onto it steps back outside.
const VILLAGE_ROOM_SPAWN=Object.freeze({x:10,y:17}); // Arrivals stand just inside the door.
export const INN_BEDS=Object.freeze([{x:2,y:3},{x:5,y:3},{x:9,y:3},{x:12,y:3},{x:16,y:3},{x:3,y:15}]); // One or two beds per Inn bedroom, three tiles apart so labels stay readable.
const villageRoom=(art,fixtures)=>({width:art.width,height:art.height,spawn:{...VILLAGE_ROOM_SPAWN},exit:{...VILLAGE_ROOM_EXIT},walls:art.walls,floors:art.floors,wallTiles:art.wallTiles,decorTiles:art.decorTiles,tilesets:art.tilesets,fixtures,authored:true}); // authored: the client paints these tile grids instead of a generic interior.
const innFixtures=[...hubData.beds.map((bed,i)=>({...bed,kind:'bed',...INN_BEDS[i],span_w:1,span_h:1,solid:true})),{id:'innkeeper',name:'Innkeeper',kind:'npc',avatar:'objNPCInnkeeper',x:12,y:15,span_w:1,span_h:1,solid:true,line:'Welcome to the Honeydew Inn, sweetheart. Pick any bed you like and rest as long as you need. Nobody here minds a little accident.'},toiletFixture('inn-toilet',18,12)]; // The innkeeper stands where the campaign places her; the toilet fills the little closet off the hall (17-18,12-15, door at 17,16).
export const villageRooms=Object.freeze({dives:villageRoom(communityHall,[cauldronFixture(14,2),reagentFixture(16,2)]),beds:villageRoom(innRoom,innFixtures)}); // The Community Hall's quiet north-east room holds Honeydew's brewing cauldron, with Bramble selling reagents beside it. // Community Hall (Dive pads in the old companion room, top-left) and Inn (six beds in its bedrooms).
export const STORE={width:11,height:9,spawn:{x:5,y:6},exit:{x:5,y:7,style:'door'},counter:{y:4,gap:5},keeper:{x:5,y:2}}; // A LittleBigCity store: one room per merchant, a planter counter with a gap in the middle, the keeper behind it, the door at the bottom back onto the sidewalk.
const storeRoom=shop=>({width:STORE.width,height:STORE.height,spawn:{...STORE.spawn},exit:{...STORE.exit},store:true,
 walls:Array.from({length:STORE.height},(_,y)=>Array.from({length:STORE.width},(_,x)=>x===0||y===0||x===STORE.width-1||y===STORE.height-1?1:0)),
 fixtures:[{id:shop.id,name:shop.name,sprite:shop.sprite,kind:'shop',x:STORE.keeper.x,y:STORE.keeper.y,span_w:1,span_h:1,solid:true},...Array.from({length:STORE.width-2},(_,i)=>i+1).filter(x=>x!==STORE.counter.gap).map(x=>({id:'counter-'+x,kind:'scenery',name:'',sprite:'sprCitySidewalkPlanter',x,y:STORE.counter.y,span_w:1,span_h:1,solid:true}))]}); // Planters make the counter; walk through the gap to stand beside the keeper.
export const storeRooms=Object.freeze(shopFixtures().map(shop=>({slug:storeSlug(shop),shop,room:storeRoom(shop)}))); // Eight stores, one per merchant, in the order the Market Halls list them.
export const hubCatalog=Object.freeze([
 {id:'honeydew-lantern',hub:'town',theme:'lantern',prefix:'Lantern',name:town.name,...districtSize(town,districtData),spawn:{...town.lobby.spawn},exit:{...town.lobby.stairs,style:'stairs'},town:true}, // Walls, floors, fixtures and the monthly edition are merged in by hub-districts.mjs at request time.
 {id:'littlebig-clockwork',hub:'littlebig_city',theme:'clockwork',prefix:'Clockwork',name:city.name,...districtSize(city,districtData),spawn:{...city.lobby.spawn},exit:{...city.lobby.stairs,style:'stairs'},town:true}, // LittleBigCity: the 60x60 city itself, storefront doorsteps included once resolved.
 {id:'utopia-arcanum',hub:'utopia',theme:'arcanum',prefix:'Arcanum',name:utopia.name,...districtSize(utopia,districtData),spawn:{...utopia.lobby.spawn},exit:{...utopia.lobby.stairs,style:'stairs'},town:true}, // Utopia: the 60x60 magitek city of littles, north of Frostveil Taiga.
 {id:'arcadia-foundry',hub:'arcadia',theme:'foundry',prefix:'Foundry',name:arcadia.name,...districtSize(arcadia,districtData),spawn:{...arcadia.lobby.spawn},exit:{...arcadia.lobby.stairs,style:'stairs'},town:true}, // Arcadia: the 60x60 steampunk industrial city of bigs, south of the Autumnal Plains.
 {id:'princess-rose',hub:'princess_quarters',theme:'rose',prefix:'Rose',name:'Rose Court',...roseGarden}, // width/height/spawn/exit/walls/floors/wallTiles/treeTiles/tilesets/fixtures come from the courtyard map.
]); // A single catalog supplies lobby identity, annexes and legacy entry validation.
export function dungeonPortals(parent){
 const quarters={x:6,y:4,name:"Princess' Quarters",target:'dive-quarters',style:'warp'};
 const west={x:0,y:5,w:1,h:2,style:'gap',side:'left'},east={x:19,y:5,w:1,h:2,style:'gap',side:'right'}; // Wall openings matching the lobby's Beds/District gaps.
 const desert={name:'Dustbreak Desert',target:'dive-desert'};
 const existing=parent==='princess-rose'?[quarters]:[]; // West-to-east: Rose | Tundra | Honeydew | Desert | LittleBig. Every hub now reaches the wilderness from its own lobby wall (wildernessGates), so no hall keeps a side gap.
 const utopiaPads=parent==='utopia-arcanum'?UTOPIA_PADS.map(p=>({x:p.x,y:p.y,name:campaignDives.find(d=>d.config.zone_id===p.zone)?.config.name??p.zone,target:p.zone,style:'warp'})):[]; // Utopia's Workshop sends littles into the Auto-Nursery and Regression School too.
 return [...existing,...campaignDives.filter(d=>d.config.hub===parent).map(({config:c})=>({...c.pad,name:c.name,target:c.zone_id,style:'warp'})),...utopiaPads];
} // Princess' Quarters belongs only to Rose Court; these coordinates also drive client labels and return arrivals.
export const wildernessGates=parent=>parent==='princess-rose'?GARDEN_PORTALS.filter(p=>p.target.startsWith('dive-')):parent==='honeydew-lantern'?lobbyGates(town):parent==='littlebig-clockwork'?lobbyGates(city):parent==='utopia-arcanum'?lobbyGates(utopia):parent==='arcadia-foundry'?lobbyGates(arcadia):[]; // Overworld routes that open straight from a lobby's own wall instead of its Dive Hall (Rose: Tundra; Honeydew: Tundra west, Desert east; LittleBigCity: Desert west).
export const routePortals=room=>[...(room.fullDungeonPortals??[]),...(room.parent?dungeonPortals(room.parent):[...dungeonPortals(room.id),...wildernessGates(room.id)])]; // Full dungeon connectors use the resolved monthly map, including The Castle annex.
export const routeHome=(hub,route,{returnZone='',gate=false}={})=>fullDungeonHome(hub,route)||wildernessGates(hub).some(g=>g.target===route)?hub:(returnZone===''||returnZone.endsWith('-dives')||gate?hub+'-dives':hub);
export const returnSource=(origin,route)=>fullDungeonHome(origin,route)||origin.endsWith('-dives')||wildernessGates(origin).some(g=>g.target===route)?route:origin+'-dives'; // Full dungeon returns stand beside their own entrance.
const lobbyTargets=root=>districtData.districts.find(d=>d.hub===root.id)?.lobby?.buildings?.map(b=>b.target)??[]; // Which extra rooms a lobby town's square has doors to.
const annexKinds=root=>root.id==='princess-rose'?['garden','shops','dives']:['beds','dives',...['tower','temple'].filter(k=>lobbyTargets(root).includes(k))]; // Utopia's Arcanum Tower and Arcadia's Guildhall (tower), and each town's temple. Rose's temple is a Castle district room. // Rose's beds are in The Castle; Honeydew and LittleBigCity are their own garden and market, keeping only an Inn and a Dive room (plus, for the city, one store per merchant below).
export const hubRooms=[...hubCatalog.flatMap(root=>annexKinds(root).map(kind=>({
 id:root.id+'-'+kind,parent:root.id,kind,hub:root.hub,theme:root.theme,
 name:kind==='temple'?templeGod(root.id).temple_name:kind==='garden'?districtData.districts.find(d=>d.hub===root.id).name:root.id==='honeydew-lantern'?({beds:'Honeydew Inn',dives:'Community Hall'})[kind]:root.id==='littlebig-clockwork'?({beds:'LittleBig Inn',dives:'Clockwork Coliseum'})[kind]:root.id==='utopia-arcanum'?({beds:'Nap Pods',dives:"Artificer's Workshop",tower:'Arcanum Tower'})[kind]:root.id==='arcadia-foundry'?({beds:'Boarding House',dives:'Rail Depot',tower:"Clockmakers' Guildhall"})[kind]:root.prefix+' '+({garden:'Garden',beds:'Resting Hall',shops:'Market Hall',dives:'Dive Hall'})[kind],
 width:kind==='garden'?gardenWidth:kind==='shops'?c.shop_width:20,height:kind==='garden'?gardenHeight:kind==='shops'?c.shop_height:12,
 spawn:kind==='garden'?{x:gardenWidth-2,y:Math.floor(gardenHeight/2)}:kind==='beds'?{x:1,y:6}:kind==='shops'?{x:20,y:21}:{x:9,y:10}, // Dive Hall arrivals stand just inside its bottom-wall opening.
 exit:kind==='garden'?{x:gardenWidth-1,y:Math.floor(gardenHeight/2)-1,w:1,h:2,style:'gap',side:'right'}:kind==='beds'?{x:0,y:5,w:1,h:2,style:'gap',side:'left'}:kind==='shops'?{x:20,y:22,style:'stairs'}:{x:9,y:11,w:2,h:1,style:'gap',side:'bottom'}, // Market Halls keep their stairs; the Dive Hall returns through a bottom-wall opening.
 fixtures:kind==='beds'?[...hubData.beds.map((bed,i)=>({...bed,kind:'bed',x:3+(i%3)*6,y:3+Math.floor(i/3)*4})),...(root.id==='littlebig-clockwork'?[cauldronFixture(18,5),reagentFixture(18,7)]:[])]: // The LittleBig Inn keeps LittleBigCity's brewing cauldron by its east wall, Bramble two tiles below it.
 kind==='shops'?[...shopFixtures().map((shop,i)=>({...shop,x:[6,14,25,33][i%4],y:6+Math.floor(i/4)*9})),...marketServices().map(service=>({...service,...({bank:{x:30,y:20},dumpster:{x:34,y:20},'curse-remover':{x:9,y:20}})[service.id]})),...(hubData.market_halls.find(h=>h.hub===root.id)?.decorations??[])]:
 [], // Monthly districts supply their own persisted scenery and NPC fixtures; Rose Court's beds live inside The Castle district's dormitory instead of a Resting Hall.
 ...(root.id==='honeydew-lantern'?villageRooms[kind]:{}), // The village's Inn and Community Hall replace the generic annex geometry with the campaign rooms (20x20, authored tiles, door exit).
 ...(root.id==='littlebig-clockwork'&&kind==='beds'?lbcInn:{}), // The LittleBig Inn is a remodelled 24x16 boutique hotel (lbc-inn.mjs): bedrooms, lobby, lounge and washroom.
 ...(root.id==='utopia-arcanum'?utopiaInteriors[kind]:{}), // Utopia's Nap Pods, Artificer's Workshop and Arcanum Tower (utopia-rooms.mjs).
 ...(root.id==='arcadia-foundry'?arcadiaInteriors[kind]:{}), // Arcadia's Boarding House, Rail Depot and Clockmakers' Guildhall (arcadia-rooms.mjs).
 ...(kind==='temple'?templeInteriors[root.id]:{}), // The god's temple: altar, holy person and pews (temple-rooms.mjs).
}))),...storeRooms.map(({slug,shop,room})=>({id:'littlebig-clockwork-store-'+slug,parent:'littlebig-clockwork',kind:'shops',hub:'littlebig_city',theme:'clockwork',name:shop.name+"'s Store",...room}))]; // Each hub has its own presence/chat scope; fixtures are presentation data, never campaign NPCs. LittleBigCity's eight stores are tiny shop rooms entered from their storefront doorsteps.
export const hubPortals=lobby=>{const parent=typeof lobby==='string'?lobby:lobby.id,resolved=typeof lobby==='string'?null:lobby; // Pass the resolved zone where you can: LittleBigCity's storefront doorsteps live in this month's map.
 return parent==='princess-rose'?GARDEN_PORTALS.map(p=>p.target===parent+'-garden'?{...p,name:districtData.districts.find(d=>d.hub===parent)?.name??p.name}:{...p}):parent==='honeydew-lantern'?lobbyPortals(town,resolved):parent==='littlebig-clockwork'?lobbyPortals(city,resolved):parent==='utopia-arcanum'?lobbyPortals(utopia,resolved):parent==='arcadia-foundry'?lobbyPortals(arcadia,resolved):[{x:0,y:5,w:1,h:2,name:districtData.districts.find(d=>d.hub===parent)?.name??'District',target:parent+'-garden',style:'gap',side:'left'},{x:19,y:5,w:1,h:2,name:'Beds',target:parent+'-beds',style:'gap',side:'right'},{x:15,y:8,name:'Shops',target:parent+'-shops',style:'stairs'},{x:9,y:0,w:2,h:1,name:'Dungeon Dive',target:parent+'-dives',style:'gap',side:'top'}];}; // Rose's castle gate (left wall) and Tundra gap (right wall, the old Beds door) replace the old District / Beds openings; the 20x12 default court no longer exists but stays as the fallback shape.
export const inHubGap=(gap,x,y)=>x>=gap.x&&x<gap.x+(gap.w??1)&&y>=gap.y&&y<gap.y+(gap.h??1);
export const contactPortal=p=>p.style==='gap'||p.style==='door'; // Both transfer on contact: a wall opening, or a village building's doorstep (and the door back out of it).
export const hubGaps=z=>[...(z.fullDungeonPortals??[]),...(z.parent?[...(z.exit&&contactPortal(z.exit)?[{...z.exit,target:z.parent}]:[]),...(z.kind==='dives'?dungeonPortals(z.parent).filter(contactPortal):[])]:hubPortals(z).filter(contactPortal))]; // Full dungeon stairs also transfer on contact.
for(const [kind,room] of Object.entries(villageRooms))validateCourtyard(room,kind==='dives'?dungeonPortals('honeydew-lantern'):[]); // Boot fails if a bed, a pad, the innkeeper or the door is walled in or unreachable inside the campaign rooms.
validateCourtyard(lbcInn,[]); // Boot fails if a bed, the concierge, the cauldron, the toilet or the exit is walled in.
for(const [kind,room] of Object.entries(utopiaInteriors))validateCourtyard(room,kind==='dives'?dungeonPortals('utopia-arcanum'):[]); // Every pod, pad, changer and resident in Utopia's interiors is reachable.
for(const room of Object.values(templeInteriors))validateCourtyard(room,[]); // Every pew, the altar and the priest are reachable in each temple.
for(const room of Object.values(arcadiaInteriors))validateCourtyard(room,[]); // Every bunk, bench, counter, cauldron and the pay toilet in Arcadia's interiors is reachable (the Rail Depot has no pads yet).
for(const {room} of storeRooms)validateCourtyard(room,[]); // Every store keeps its keeper reachable through the counter gap and its door open.
export const LOBBY_EXIT=Object.freeze({x:1,y:10,style:'stairs'}); // Bottom-left stairs back to the singleplayer campaign. // Only declared wall openings are traversable; all other perimeter cells remain walls.
export const hubBlocked=(z,x,y)=>z.fixtures?.some(f=>f.solid!==false&&x>=f.x&&y>=f.y&&x<f.x+(f.span_w??1)&&y<f.y+(f.span_h??1))??false;
import {stackable,slotsUsed,addToInventory} from './loadout.mjs'; // Stack-aware capacity and purchases.
export const shopperLevel=state=>Math.max(1,Math.floor(Number(state?.loadout?.player_info?.level)||1)); // The level hub stock is rolled at for this character (clamped per hub by shopLevel).
export function shopOffers(zone,shop,time,level=1){ // `level`: the shopper's level; the item picks are shared per day, only their rolled level differs per shopper.
 const day=Math.floor(time/86400000),rnd=seeded(`${zone}:${shop.id}:${day}`),pool=[...shop.pool],offers=[];
 // Always stocked: a meal at the general merchant and apothecary, arrows wherever arrows are sold (Grog's bows need them).
 const guaranteed=['adult_food','arrows'].filter(id=>pool.includes(id));for(const id of guaranteed)pool.splice(pool.indexOf(id),1);
 const shelf=Number.isInteger(shop.stock_size)&&shop.stock_size>=1&&shop.stock_size<=24?shop.stock_size:c.stock_size; // a merchant's own shelf size (Bramble keeps a small rotating one), else the hub's
 for(let slot=0;slot<shelf&&(slot<guaranteed.length||pool.length);slot++){
  const id=slot<guaranteed.length?guaranteed[slot]:pool.splice(rnd(pool.length),1)[0];let item=structuredClone(hubData.items[id]);
  if(item.atk_min!==undefined){item.atk=item.atk_min+rnd(item.atk_max-item.atk_min+1);item.desc=item.desc?.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
  const roller=shopRoller(),hub=hubRooms.find(r=>r.id===zone)?.parent??zone; // Annex shops use their parent hub's level band.
  item=roller.roll(item,`${zone}:${shop.id}:${day}:${slot}`,{level:roller.shopLevel(hub,level),luck:'shop'}); // Rarity, level and affixes with shop luck (no epics) at the shopper's level clamped into the hub's shop_levels band; the rolled name and value are what the player sees and pays for.
  const price=Math.max(1,Math.ceil(item.value*c.coin_price_multiplier));
  offers.push({id:`${day}-${slot}`,price,item});
 }return offers;
} // Stock is deterministic and inexhaustible; the same eight items greet everyone that day, scaled to each shopper.
export function hubDefinition(z,time,level=1){return {...z,width:z.width??20,height:z.height??12,spawn:z.spawn??{x:10,y:9},exit:z.exit??LOBBY_EXIT,restTickMs:c.rest_tick_ms,portals:[...(z.fullDungeonPortals??[]),...(z.kind==='dives'?dungeonPortals(z.parent):z.parent?[]:hubPortals(z))],fixtures:(z.fixtures??[]).map(f=>f.kind==='shop'?{...f,offers:shopOffers(z.id,findShop(f.id),time,level)}:f)};} // Monthly full-dungeon connectors coexist with every existing hall and wilderness route.
export const besideFixture=(f,p)=>{const dx=p.x<f.x?f.x-p.x:Math.max(0,p.x-(f.x+(f.span_w??1)-1)),dy=p.y<f.y?f.y-p.y:Math.max(0,p.y-(f.y+(f.span_h??1)-1));return dx+dy<=1;}; // Beside any tile of a fixture's footprint (a 2-wide altar, a 1x2 cubicle).
export function nearbyFixture(z,p,id,kind){const f=z.fixtures?.find(f=>f.id===id&&f.kind===kind);if(!f||!besideFixture(f,p))fail('Stand next to that '+kind+'.');return f;}

export function createHubPurchases(db,{now,origins,hooks={}}){ // hooks.duelWager(id,char,state,paid,amount): a duel stake settled through the same durable debit path; hooks.companionShop(...,reservation) delivers a companion roll.
 db.exec(`CREATE TABLE IF NOT EXISTS hub_purchases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,character_id TEXT NOT NULL,item TEXT NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
 CREATE INDEX IF NOT EXISTS hub_pending_purchases ON hub_purchases(owner,status);`);
 function prepare(i,char,state,z,p,input){
  if(state.run||!state.loadout)fail('Leave combat before shopping.');
  nearbyFixture(z,p,input.fixture,'shop');
  const shop=findShop(input.fixture),offer=shopOffers(z.id,shop,now(),shopperLevel(state)).find(o=>o.id===input.offer); // Priced and rolled exactly as this shopper saw it.
  if(!offer)fail('The stock changed. Reopen the shop.');
  if(!stackable(offer.item)&&slotsUsed(state.loadout.inventory)>=c.inventory_capacity)fail('Inventory full. No coins were charged.'); // Stacks (arrows, snacks) never need a free slot.
  let price=offer.price;delete state.littleTaxNote;
  if(inArcadia(z.id)){ // Arcadia's little tax: bigs mark prices up for anyone who looks little, and won't serve anyone visibly wet or messy.
   const tax=littleTax(arcadiaLook(state.loadout,withGenerated(hubData.equipment)),currentTuning());
   if(tax.refuse)fail(shop.name+' wrinkles their nose. "Not in that state. Clean yourself up and come back." No coins were charged.');
   price=taxedPrice(price,tax);if(tax.percent>0)state.littleTaxNote=` (little tax +${tax.percent}% for ${tax.reason})`;
  }
  const id=createHash('sha256').update(char.id+':'+input.request_id).digest('hex');
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,char.id,JSON.stringify(offer.item),price);
  state.pendingPurchase=id;state.hubNotice='Completing purchase…';state.hubNoticeAt=now();
 } // Reserve a slot before payment; all inventory mutations wait until debit delivery is resolved.
 function complete(id,paid){
  db.exec('BEGIN IMMEDIATE');try{
   const row=db.prepare('SELECT * FROM hub_purchases WHERE id=?').get(id);if(!row||row.status!=='pending'){db.exec('COMMIT');return;}
   const char=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(row.character_id),state=JSON.parse(char.state);
   if(state.pendingPurchase!==id)throw Error('Purchase reservation missing');
   const item=JSON.parse(row.item);
   if(item.duel_wager){hooks.duelWager?.(id,char,state,paid,row.price);} // Escrow for a duel: the duel module records the outcome; nothing lands in the bag.
   else if(item.trade_escrow){hooks.tradeEscrow?.(id,char,state,paid,row.price);} // Escrow for a trade, likewise.
   else if(item.companion_shop){hooks.companionShop?.(id,char,state,paid,row.price,item);} // A companion Atelier/Emporium roll: delivered to the bank, not the bag.
   else if(item.hub_service==='curse_remove'){
    const previous=structuredClone(state);
    if(paid){state.loadout=item.loadout;origins.reconcile(char,state,previous);state.loadoutRevision=char.revision+1;}
    state.hubNotice=paid?`Removed ${item.name} for ${row.price} LiDollCoins.${item.disposed?' The used diaper was disposed of.':' The item is in your bag and remains cursed.'}`:'Not enough LiDollCoins. Your equipment was not changed.';
   }else if(item.hub_service==='dedicate'){ // A paid switch of gods: piety starts again at 0.
    if(paid){dedicate(state,item.god,now());state.loadout.faith=combatFaith(state);state.faithNotice=`Your tribute is accepted. You are sworn to ${GODS[item.god].name} now; your old god's favour is gone.`;state.faithNoticeAt=now();}
    state.hubNotice=paid?`Paid ${row.price} ${item.currency} in tribute to ${GODS[item.god].name}.`:`Not enough ${item.currency}. The priest waits patiently.`;
   }else if(item.hub_service==='pay_toilet'){ // Arcadia's coin turnstile: paying unlocks the cubicle; the client runs the relief when it sees the new toiletPaid stamp.
    if(paid)state.toiletPaid={fixture:item.fixture,at:now()};
    state.hubNotice=paid?`You drop ${row.price} LiDollCoins into the slot. The turnstile clunks round.`:'Not enough LiDollCoins. The turnstile will not budge, and you are still desperate.';
   }else if(paid)addToInventory(state.loadout.inventory,origins.mint(char.id,item,row.price)); // Resale never exceeds the actual paid price, even with discounted stock tuning; stackables merge into an existing stack.
   delete state.pendingPurchase;if(!item.hub_service&&!item.duel_wager&&!item.trade_escrow&&!item.companion_shop)state.hubNotice=paid?`Bought ${item.name??item.item_id} for ${row.price} LiDollCoins.${state.littleTaxNote??''}`:'Not enough LiDollCoins. Nothing was purchased.';delete state.littleTaxNote;state.hubNoticeAt=now();
   db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),char.id);
   db.prepare('UPDATE hub_purchases SET status=? WHERE id=?').run(paid?'delivered':'declined',id);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 } // A replayed wallet debit can finish this atomic item grant after any service restart.
 function prepareCurse(i,char,state,z,p,input){
  if(state.run||!state.loadout)fail('Leave combat before removing cursed gear.');
  const npc=nearbyFixture(z,p,input.fixture,'npc');if(npc.service!=='curse_remove')fail('Speak to the Cursebreaker.');
  const result=removeCursedGear(state.loadout,input.slot,input.item_id,hubData.equipment,c.inventory_capacity);
  const id=createHash('sha256').update(char.id+':'+input.request_id).digest('hex');
  const reservation={hub_service:'curse_remove',name:result.item.name,loadout:result.loadout,disposed:result.dispose};
  const price=Math.max(1,Math.ceil(c.curse_removal_price*(1-blessingValue(state,'cursebreaker_discount_pct')/100))); // Orin's devout pay up to half.
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,char.id,JSON.stringify(reservation),price);
  state.pendingPurchase=id;state.hubNotice='Completing curse removal…';state.hubNoticeAt=now();
 } // The existing durable wallet debit and inventory lock also protect this paid service.
 function preparePayToilet(i,char,state,z,p,input){ // Arcadia's pay toilets: the fee goes through the same durable wallet debit as any purchase.
  if(state.run||!state.loadout)fail('Leave combat first.');
  const f=(z.fixtures??[]).find(f=>f.id===input.fixture&&f.kind==='toilet'&&f.style==='paytoilet');if(!f)fail('That is not a pay toilet.');
  const dx=p.x<f.x?f.x-p.x:Math.max(0,p.x-(f.x+(f.span_w??1)-1)),dy=p.y<f.y?f.y-p.y:Math.max(0,p.y-(f.y+(f.span_h??1)-1));if(dx+dy>1)fail('Stand next to the pay toilet.'); // Beside any tile of its 1x2 footprint.
  const price=Math.round(dignityTuning(currentTuning()).arcadiaToiletPrice);
  if(price<=0){state.toiletPaid={fixture:f.id,at:now()};state.hubNotice='The turnstile is propped open today. Free!';state.hubNoticeAt=now();return;} // A GM set the price to 0.
  const id=createHash('sha256').update(char.id+':'+input.request_id).digest('hex');
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,char.id,JSON.stringify({hub_service:'pay_toilet',name:'Pay Toilet',fixture:f.id}),price);
  state.pendingPurchase=id;state.hubNotice='Fumbling for a coin…';state.hubNoticeAt=now();
 }
 function prepareDedication(i,char,state,z,p,input){ // Swear to the god whose holy person you stand beside: the first time is free; switching costs the tribute.
  if(state.run||!state.loadout)fail('Leave combat first.');
  const npc=nearbyFixture(z,p,input.fixture,'npc');if(npc.service!=='dedicate'||!GODS[npc.god])fail('Speak to a temple priest.');
  const god=GODS[npc.god];
  if(state.faith?.god===god.id)fail('You are already sworn to '+god.name+'.');
  if(!(state.faithSworn>0)){dedicate(state,god.id,now());state.loadout.faith=combatFaith(state);state.faithNotice=`You kneel before ${npc.name} and swear yourself to ${god.name}, god of ${god.domain}. Your first vow costs nothing. Keep ${god.name}'s ways and your piety will grow.`;state.faithNoticeAt=now();return;}
  const mode=input.mode;if(mode!=='diamond'&&mode!=='stars')fail(`Switching gods costs a tribute: ${FAITH_SETTINGS.tribute_diamonds} diamond or ${FAITH_SETTINGS.tribute_stars} stars.`);
  const id=createHash('sha256').update(char.id+':'+input.request_id).digest('hex'),currency=mode==='diamond'?'diamonds':'stars',price=mode==='diamond'?FAITH_SETTINGS.tribute_diamonds:FAITH_SETTINGS.tribute_stars;
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,char.id,JSON.stringify({hub_service:'dedicate',name:'Tribute to '+god.name,god:god.id,currency}),price); // service.mjs settles diamonds and stars through the wallet.
  state.pendingPurchase=id;state.hubNotice='Offering your tribute…';state.hubNoticeAt=now();
 }
 return {prepare,prepareCurse,preparePayToilet,prepareDedication,complete};
}

export function hubArrival(destination, source) {
 const z=hubDefinition(destination,0),portal=z.portals.find(p=>p.target===source)??(z.parent===source?z.exit:null);
 if(!portal)return {...z.spawn}; // First entry has no prior doorway to match.
 const x=portal.x,y=portal.y+(portal.h??1)-1;
 const offsets=portal.side==='left'?[[1,0]]:portal.side==='right'?[[-1,0]]:portal.side==='top'?[[0,1]]:portal.side==='bottom'?[[0,-1]]:portal===z.exit?[[0,-1],[1,0],[-1,0],[0,1]]:[[0,1],[1,0],[-1,0],[0,-1]];
 for(const [dx,dy] of offsets){const px=x+dx,py=y+dy;
  if(px>0&&py>0&&px<z.width-1&&py<z.height-1&&!z.walls?.[py]?.[px]&&!hubBlocked(z,px,py)&&![...z.portals,z.exit].some(p=>inHubGap(p,px,py)))return {x:px,y:py};
 }
 throw Error('No walkable arrival beside '+source+' in '+z.id); // Bad authored topology must not silently teleport a player elsewhere.
}
