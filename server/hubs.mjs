import {removeCursedGear} from './curse-removal.mjs';
import {districtData,districtZone,shopFixtures,marketServices} from './hub-districts.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {seeded} from './dive-generation.mjs';
import {createLootRoller} from './loot.mjs';
import {roseCourtyard,GARDEN_PORTALS,validateCourtyard} from './hub-garden.mjs';

export const hubData=JSON.parse(readFileSync(new URL('./hub-data.json',import.meta.url),'utf8'));
export const campaignDives=JSON.parse(readFileSync(new URL('./campaign-dives-data.json',import.meta.url),'utf8')).routes;
const c=hubData.config;
// Shop stock rolls through the same Adjective + Item + Rarity table as chests (shipped as `loot`
// inside dive-data.json). zones.mjs hands over the live gamemaster store so a /gm retune reaches
// the next day's stock; without it the shipped table alone is used (tests, tools).
const shopLootData=(()=>{try{return JSON.parse(readFileSync(new URL('./dive-data.json',import.meta.url),'utf8'));}catch{return {};}})();
const shopLootTable=shopLootData.loot??null,shopLootBases=shopLootData.bases??null;
let shopLoot={store:null,revision:null,roller:createLootRoller(shopLootTable,shopLootBases)};
export function configureShopLoot(store){shopLoot={store,revision:null,roller:createLootRoller(store?store.apply(shopLootTable):shopLootTable,store?store.applyBases(shopLootBases):shopLootBases)};}
function shopRoller(){
 if(!shopLoot.store)return shopLoot.roller;
 const revision=shopLoot.store.revision();
 if(revision!==shopLoot.revision)shopLoot={...shopLoot,revision,roller:createLootRoller(shopLoot.store.apply(shopLootTable),shopLoot.store.applyBases(shopLootBases))};
 return shopLoot.roller;
}
if(!Number.isInteger(c.stock_size)||c.stock_size<1||c.stock_size>24||!Number.isFinite(c.coin_price_multiplier)||c.coin_price_multiplier<=0||c.coin_price_multiplier>100||!Number.isInteger(c.inventory_capacity)||c.inventory_capacity<1||c.inventory_capacity>512||!Number.isInteger(c.rest_tick_ms)||c.rest_tick_ms<500)throw Error('Invalid online hub tuning');
export const DAILY_COIN_CAP=c.daily_coin_cap??250;
if(!Number.isInteger(DAILY_COIN_CAP)||DAILY_COIN_CAP<1||DAILY_COIN_CAP>100000)throw Error('Invalid daily coin cap'); // One account-wide UTC earnings allowance shared by arena payouts, dungeon bosses and item sales.
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'hub_conflict'});};
if(c.shop_width!==40||c.shop_height!==24||c.curse_removal_price!==20)throw Error('Invalid market dimensions or curse service price');
const gardenWidth=districtData.width,gardenHeight=districtData.height;
if(![gardenWidth,gardenHeight].every(n=>Number.isInteger(n)&&n>=20&&n<=80))throw Error('Invalid garden dimensions');
const roseGarden=roseCourtyard(hubData.courtyards?.find(h=>h.hub==='princess-rose')?.decorations); // Rose Court's lobby is a walled 20x20 garden; the other courts keep their 20x12 halls. Boot fails if the authored props trap anyone.
const town=districtData.districts.find(d=>d.hub==='honeydew-lantern'); // Honeydew Village: the lobby is the 50x50 monthly town itself (hub-districts.mjs resolves its map onto the catalog entry below).
if(!town?.lobby?.buildings?.length)throw Error('Honeydew Village must be exported as a lobby town (online_districts.json lobby, export_online_districts.py)');
const campaignRoom=(key,label)=>{const r=hubData[key];if(!r||r.width!==20||r.height!==20||!Array.isArray(r.walls))throw Error('hub-data.json needs the 20x20 '+label+' export (export_online_hubs.py)');return r;}; // Both village interiors are the campaign rooms, tile for tile.
const communityHall=campaignRoom('community_hall','Community Hall'),innRoom=campaignRoom('inn','Inn');
export const TOWN_PORTALS=Object.freeze([ // Honeydew Village's lobby openings: two wilderness gates in the boundary walls plus the doorstep of each civic building.
 {x:0,y:24,w:1,h:2,name:'Frostveil Tundra',target:'dive-tundra',style:'gap',side:'left'},
 {x:49,y:24,w:1,h:2,name:'Dustbreak Desert',target:'dive-desert',style:'gap',side:'right'},
 ...town.lobby.buildings.map(b=>({x:b.door.x,y:b.door.y,name:b.name,target:'honeydew-lantern-'+b.target,style:'door',threshold:true})), // Stepping onto the doorstep transfers, like a wall gap; the client draws a mat rather than a doorway because the facade already shows the door.
]);
const VILLAGE_ROOM_EXIT=Object.freeze({x:10,y:18,style:'door'}); // Where town_subroom_generate() puts the campaign stairs: bottom centre, one tile above the wall. Walking onto it steps back outside.
const VILLAGE_ROOM_SPAWN=Object.freeze({x:10,y:17}); // Arrivals stand just inside the door.
export const INN_BEDS=Object.freeze([{x:2,y:3},{x:5,y:3},{x:9,y:3},{x:12,y:3},{x:16,y:3},{x:3,y:15}]); // One or two beds per Inn bedroom, three tiles apart so labels stay readable.
const villageRoom=(art,fixtures)=>({width:art.width,height:art.height,spawn:{...VILLAGE_ROOM_SPAWN},exit:{...VILLAGE_ROOM_EXIT},walls:art.walls,floors:art.floors,wallTiles:art.wallTiles,decorTiles:art.decorTiles,tilesets:art.tilesets,fixtures,authored:true}); // authored: the client paints these tile grids instead of a generic interior.
const innFixtures=[...hubData.beds.map((bed,i)=>({...bed,kind:'bed',...INN_BEDS[i],span_w:1,span_h:1,solid:true})),{id:'innkeeper',name:'Innkeeper',kind:'npc',avatar:'objNPCInnkeeper',x:12,y:15,span_w:1,span_h:1,solid:true,line:'Welcome to the Honeydew Inn, sweetheart. Pick any bed you like and rest as long as you need. Nobody here minds a little accident.'}]; // The innkeeper stands where the campaign places her.
export const villageRooms=Object.freeze({dives:villageRoom(communityHall,[]),beds:villageRoom(innRoom,innFixtures)}); // Community Hall (Dive pads in the old companion room, top-left) and Inn (six beds in its bedrooms).
export const hubCatalog=Object.freeze([
 {id:'honeydew-lantern',hub:'town',theme:'lantern',prefix:'Lantern',name:town.name,width:50,height:50,spawn:{...town.lobby.spawn},exit:{...town.lobby.stairs,style:'stairs'},town:true}, // Walls, floors, fixtures and the monthly edition are merged in by hub-districts.mjs at request time.
 {id:'littlebig-clockwork',hub:'littlebig_city',theme:'clockwork',prefix:'Clockwork',name:'Clockwork Coliseum'},
 {id:'princess-rose',hub:'princess_quarters',theme:'rose',prefix:'Rose',name:'Rose Court',...roseGarden}, // width/height/spawn/exit/walls/floors/wallTiles/treeTiles/tilesets/fixtures come from the courtyard map.
]); // A single catalog supplies lobby identity, annexes and legacy entry validation.
export function dungeonPortals(parent){
 const quarters={x:6,y:4,name:"Princess' Quarters",target:'dive-quarters',style:'warp'};
 const west={x:0,y:5,w:1,h:2,style:'gap',side:'left'},east={x:19,y:5,w:1,h:2,style:'gap',side:'right'}; // Wall openings matching the lobby's Beds/District gaps.
 const desert={name:'Dustbreak Desert',target:'dive-desert'};
 const existing=parent==='princess-rose'?[quarters]:parent==='littlebig-clockwork'?[{...desert,...west}]:[]; // West-to-east: Rose | Tundra | Honeydew | Desert | LittleBig. Rose and Honeydew reach the wilderness from their own lobby walls (wildernessGates), so their halls have no side gaps; only Clockwork's hall keeps its Desert gap.
 return [...existing,...campaignDives.filter(d=>d.config.hub===parent).map(({config:c})=>({...c.pad,name:c.name,target:c.zone_id,style:'warp'}))];
} // Princess' Quarters belongs only to Rose Court; these coordinates also drive client labels and return arrivals.
export const wildernessGates=parent=>parent==='princess-rose'?GARDEN_PORTALS.filter(p=>p.target.startsWith('dive-')):parent==='honeydew-lantern'?TOWN_PORTALS.filter(p=>p.target.startsWith('dive-')):[]; // Overworld routes that open straight from a lobby's own wall instead of its Dive Hall (Rose: Tundra; Honeydew: Tundra west, Desert east).
export const routePortals=room=>room.parent?dungeonPortals(room.parent):[...dungeonPortals(room.id),...wildernessGates(room.id)]; // Every route a Dive Hall or lobby can enter directly; lobbies keep accepting legacy pad entries for their hall's routes.
export const routeHome=(hub,route,{returnZone='',gate=false}={})=>wildernessGates(hub).some(g=>g.target===route)?hub:(returnZone===''||returnZone.endsWith('-dives')||gate?hub+'-dives':hub); // The room a traveller lands in when a route delivers them to this hub: its garden gate if it has one, its Dive Hall for hall and gate entries, or its lobby for legacy pad entries made from a lobby.
export const returnSource=(origin,route)=>origin.endsWith('-dives')||wildernessGates(origin).some(g=>g.target===route)?route:origin+'-dives'; // Which doorway hubArrival should stand beside when leaving a route into `origin`.
const annexKinds=root=>root.id==='princess-rose'?['garden','shops','dives']:root.id==='honeydew-lantern'?['beds','dives']:['garden','beds','shops','dives']; // Rose's beds are in The Castle; Honeydew's town is its own garden and market, so it keeps only the Inn and the Community Hall.
export const hubRooms=hubCatalog.flatMap(root=>annexKinds(root).map(kind=>({
 id:root.id+'-'+kind,parent:root.id,kind,hub:root.hub,theme:root.theme,
 name:kind==='garden'?districtData.districts.find(d=>d.hub===root.id).name:root.id==='honeydew-lantern'?({beds:'Honeydew Inn',dives:'Community Hall'})[kind]:root.prefix+' '+({garden:'Garden',beds:'Resting Hall',shops:'Market Hall',dives:'Dive Hall'})[kind],
 width:kind==='garden'?gardenWidth:kind==='shops'?c.shop_width:20,height:kind==='garden'?gardenHeight:kind==='shops'?c.shop_height:12,
 spawn:kind==='garden'?{x:gardenWidth-2,y:Math.floor(gardenHeight/2)}:kind==='beds'?{x:1,y:6}:kind==='shops'?{x:20,y:21}:{x:9,y:10}, // Dive Hall arrivals stand just inside its bottom-wall opening.
 exit:kind==='garden'?{x:gardenWidth-1,y:Math.floor(gardenHeight/2)-1,w:1,h:2,style:'gap',side:'right'}:kind==='beds'?{x:0,y:5,w:1,h:2,style:'gap',side:'left'}:kind==='shops'?{x:20,y:22,style:'stairs'}:{x:9,y:11,w:2,h:1,style:'gap',side:'bottom'}, // Market Halls keep their stairs; the Dive Hall returns through a bottom-wall opening.
 fixtures:kind==='beds'?hubData.beds.map((bed,i)=>({...bed,kind:'bed',x:3+(i%3)*6,y:3+Math.floor(i/3)*4})):
 kind==='shops'?[...shopFixtures().map((shop,i)=>({...shop,x:[6,14,25,33][i%4],y:6+Math.floor(i/4)*9})),...marketServices().map(service=>({...service,...({bank:{x:30,y:20},dumpster:{x:34,y:20},'curse-remover':{x:9,y:20}})[service.id]})),...(hubData.market_halls.find(h=>h.hub===root.id)?.decorations??[])]:
 [], // Monthly districts supply their own persisted scenery and NPC fixtures; Rose Court's beds live inside The Castle district's dormitory instead of a Resting Hall.
 ...(root.id==='honeydew-lantern'?villageRooms[kind]:{}), // The village's Inn and Community Hall replace the generic annex geometry with the campaign rooms (20x20, authored tiles, door exit).
}))); // Each hub has its own presence/chat scope; fixtures are presentation data, never campaign NPCs.
export const hubPortals=parent=>parent==='princess-rose'?GARDEN_PORTALS.map(p=>p.target===parent+'-garden'?{...p,name:districtData.districts.find(d=>d.hub===parent)?.name??p.name}:{...p}):parent==='honeydew-lantern'?TOWN_PORTALS.map(p=>({...p})):[{x:0,y:5,w:1,h:2,name:districtData.districts.find(d=>d.hub===parent)?.name??'District',target:parent+'-garden',style:'gap',side:'left'},{x:19,y:5,w:1,h:2,name:'Beds',target:parent+'-beds',style:'gap',side:'right'},{x:15,y:8,name:'Shops',target:parent+'-shops',style:'stairs'},{x:9,y:0,w:2,h:1,name:'Dungeon Dive',target:parent+'-dives',style:'gap',side:'top'}]; // Rose's castle gate (left wall) and Tundra gap (right wall, the old Beds door) replace the old District / Beds openings.
export const inHubGap=(gap,x,y)=>x>=gap.x&&x<gap.x+(gap.w??1)&&y>=gap.y&&y<gap.y+(gap.h??1);
export const contactPortal=p=>p.style==='gap'||p.style==='door'; // Both transfer on contact: a wall opening, or a village building's doorstep (and the door back out of it).
export const hubGaps=z=>z.parent?[...(z.exit&&contactPortal(z.exit)?[{...z.exit,target:z.parent}]:[]),...(z.kind==='dives'?dungeonPortals(z.parent).filter(contactPortal):[])]:hubPortals(z.id).filter(contactPortal); // Dive Hall side walls open onto the wilderness routes; village doorsteps open into the Inn and Community Hall.
for(const [kind,room] of Object.entries(villageRooms))validateCourtyard(room,kind==='dives'?dungeonPortals('honeydew-lantern'):[]); // Boot fails if a bed, a pad, the innkeeper or the door is walled in or unreachable inside the campaign rooms.
export const LOBBY_EXIT=Object.freeze({x:1,y:10,style:'stairs'}); // Bottom-left stairs back to the singleplayer campaign. // Only declared wall openings are traversable; all other perimeter cells remain walls.
export const hubBlocked=(z,x,y)=>z.fixtures?.some(f=>f.solid!==false&&x>=f.x&&y>=f.y&&x<f.x+(f.span_w??1)&&y<f.y+(f.span_h??1))??false;
import {stackable,slotsUsed,addToInventory} from './loadout.mjs'; // Stack-aware capacity and purchases.
export const shopperLevel=state=>Math.max(1,Math.floor(Number(state?.loadout?.player_info?.level)||1)); // The level hub stock is rolled at for this character (clamped per hub by shopLevel).
export function shopOffers(zone,shop,time,level=1){ // `level`: the shopper's level; the item picks are shared per day, only their rolled level differs per shopper.
 const day=Math.floor(time/86400000),rnd=seeded(`${zone}:${shop.id}:${day}`),pool=[...shop.pool],offers=[];
 // Keep a meal available at the general merchant and apothecary every day.
 const food=pool.includes('adult_food')?'adult_food':null;if(food)pool.splice(pool.indexOf(food),1);
 for(let slot=0;slot<c.stock_size&&(pool.length||slot===0&&food);slot++){
  const id=slot===0&&food?food:pool.splice(rnd(pool.length),1)[0];let item=structuredClone(hubData.items[id]);
  if(item.atk_min!==undefined){item.atk=item.atk_min+rnd(item.atk_max-item.atk_min+1);item.desc=item.desc?.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
  const roller=shopRoller(),hub=hubRooms.find(r=>r.id===zone)?.parent??zone; // Annex shops use their parent hub's level band.
  item=roller.roll(item,`${zone}:${shop.id}:${day}:${slot}`,{level:roller.shopLevel(hub,level),luck:'shop'}); // Rarity, level and affixes with shop luck (no epics) at the shopper's level clamped into the hub's shop_levels band; the rolled name and value are what the player sees and pays for.
  const price=Math.max(1,Math.ceil(item.value*c.coin_price_multiplier));
  offers.push({id:`${day}-${slot}`,price,item});
 }return offers;
} // Stock is deterministic and inexhaustible; the same eight items greet everyone that day, scaled to each shopper.
export function hubDefinition(z,time,level=1){return {...z,width:z.width??20,height:z.height??12,spawn:z.spawn??{x:10,y:9},exit:z.exit??LOBBY_EXIT,restTickMs:c.rest_tick_ms,portals:z.kind==='dives'?dungeonPortals(z.parent):z.parent?[]:hubPortals(z.id),fixtures:(z.fixtures??[]).map(f=>f.kind==='shop'?{...f,offers:shopOffers(z.id,hubData.shops.find(s=>s.id===f.id),time,level)}:f)};} // `level`: the viewing character's level, so merchants show that shopper's scaled stock.
export function nearbyFixture(z,p,id,kind){const f=z.fixtures?.find(f=>f.id===id&&f.kind===kind);if(!f||Math.abs(f.x-p.x)+Math.abs(f.y-p.y)>1)fail('Stand next to that '+kind+'.');return f;}

export function createHubPurchases(db,{now,origins,hooks={}}){ // hooks.duelWager(id,char,state,paid,amount): a duel stake settled through the same durable debit path.
 db.exec(`CREATE TABLE IF NOT EXISTS hub_purchases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,character_id TEXT NOT NULL,item TEXT NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
 CREATE INDEX IF NOT EXISTS hub_pending_purchases ON hub_purchases(owner,status);`);
 function prepare(i,char,state,z,p,input){
  if(state.run||!state.loadout)fail('Leave combat before shopping.');
  nearbyFixture(z,p,input.fixture,'shop');
  const shop=hubData.shops.find(s=>s.id===input.fixture),offer=shopOffers(z.id,shop,now(),shopperLevel(state)).find(o=>o.id===input.offer); // Priced and rolled exactly as this shopper saw it.
  if(!offer)fail('The stock changed. Reopen the shop.');
  if(!stackable(offer.item)&&slotsUsed(state.loadout.inventory)>=c.inventory_capacity)fail('Inventory full. No coins were charged.'); // Stacks (arrows, snacks) never need a free slot.
  const id=createHash('sha256').update(char.id+':'+input.request_id).digest('hex');
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,char.id,JSON.stringify(offer.item),offer.price);
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
   else if(item.hub_service==='curse_remove'){
    const previous=structuredClone(state);
    if(paid){state.loadout=item.loadout;origins.reconcile(char,state,previous);state.loadoutRevision=char.revision+1;}
    state.hubNotice=paid?`Removed ${item.name} for ${row.price} LiDollCoins.${item.disposed?' The used diaper was disposed of.':' The item is in your bag and remains cursed.'}`:'Not enough LiDollCoins. Your equipment was not changed.';
   }else if(paid)addToInventory(state.loadout.inventory,origins.mint(char.id,item,row.price)); // Resale never exceeds the actual paid price, even with discounted stock tuning; stackables merge into an existing stack.
   delete state.pendingPurchase;if(item.hub_service!=='curse_remove'&&!item.duel_wager&&!item.trade_escrow)state.hubNotice=paid?`Bought ${item.name??item.item_id} for ${row.price} LiDollCoins.`:'Not enough LiDollCoins. Nothing was purchased.';state.hubNoticeAt=now();
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
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,char.id,JSON.stringify(reservation),c.curse_removal_price);
  state.pendingPurchase=id;state.hubNotice='Completing curse removal…';state.hubNoticeAt=now();
 } // The existing durable wallet debit and inventory lock also protect this paid service.
 return {prepare,prepareCurse,complete};
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
