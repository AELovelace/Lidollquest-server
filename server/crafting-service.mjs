import {logBalance} from './balance-stats.mjs'; // Balance statistics (balance.sqlite): no-ops on databases without attached stats.
import {createCraftingStore,useCraftingData,currentCraftingData} from './crafting-store.mjs';
import {preserveCraftingState} from './crafting-state.mjs';
import {deliverCraftingRewards} from './crafting-rewards.mjs';
import {craftingData,craftCatalog,planCraft,applyCraft,resolveCraftItem,craftingFields,craftingCatalog} from './crafting.mjs';
import {addToInventory,stackTokens,setStackTokens} from './loadout.mjs';
import {seeded} from './dive-generation.mjs';
import {consumeFromBag} from './companion-consume.mjs';

const fail=message=>{throw Object.assign(Error(message),{status:409,code:'crafting_failed'});};
const day=time=>Math.floor(time/86400000);
export const CRAFT_ACTIONS=['craft_make','craft_harvest','craft_eat'];
export function regionFor(zone){if(/taiga/.test(zone))return 'taiga';if(/tundra/.test(zone))return 'tundra';if(/forest|woods/.test(zone))return 'forest';if(/plains|farmstead/.test(zone))return 'plains';if(/gulch|desert/.test(zone))return 'gulch';if(/caldera/.test(zone))return 'caldera';if(/coast/.test(zone))return 'coast';return '';}
export function reachableTiles(z){
 const occupied=new Set((z.fixtures??[]).filter(f=>f.solid!==false).flatMap(f=>Array.from({length:f.span_h??1},(_,dy)=>Array.from({length:f.span_w??1},(_,dx)=>(f.x+dx)+','+(f.y+dy))).flat()));
 for(const p of z.managedOccupancy??[])occupied.add(p.x+','+p.y);
 const blocked=(x,y)=>x<1||y<1||x>=(z.width??20)-1||y>=(z.height??12)-1||z.walls?.[y]?.[x]===1||z.props?.[y]?.[x]||occupied.has(x+','+y);
 const start=z.spawn??z.entrance??{x:10,y:9},queue=[start],seen=new Set(),tiles=[];
 for(let i=0;i<queue.length;i++){const {x,y}=queue[i],key=x+','+y;if(seen.has(key)||blocked(x,y))continue;seen.add(key);tiles.push({x,y});queue.push({x:x-1,y},{x:x+1,y},{x,y:y-1},{x,y:y+1});}return tiles;
} // Flood-fill through the real map; every new fixture must preserve existing service access.
export function validBusinessTile(z,x,y){
 if(!Number.isInteger(x)||!Number.isInteger(y))return false;
 const fixtures=z.fixtures??[],protectedPoints=[z.spawn,z.entrance,z.exit,...(z.portals??[]),...(z.exits??[])].filter(Boolean);
 if(protectedPoints.some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=2)||fixtures.some(f=>Math.abs(f.x-x)+Math.abs(f.y-y)<=1))return false;
 const original=reachableTiles(z);if(!original.some(p=>p.x===x&&p.y===y))return false;
 const reachable=new Set(reachableTiles({...z,fixtures:[...fixtures,{x,y,solid:true}]}).map(p=>p.x+','+p.y));
 return original.every(p=>p.x===x&&p.y===y||reachable.has(p.x+','+p.y));
} // Requiring all previously reachable floor to remain reachable also protects narrow corridors.
const stationCache=new Map(),resourceCache=new Map(); // Stable geometry avoids repeated flood fills on heartbeat snapshots.
export function craftingStations(z){
 if(!(z.fixtures??[]).some(f=>f.kind==='cauldron'))return z;
 const cacheKey=z.id+':'+(z.district?.layoutKey??'')+':'+JSON.stringify(z.fixtures.map(f=>[f.id,f.x,f.y,f.kind]));
 if(stationCache.has(cacheKey))return {...z,fixtures:[...z.fixtures,...stationCache.get(cacheKey)]};
 const result={...z,fixtures:[...z.fixtures]},anchor=z.fixtures.find(f=>f.kind==='cauldron');
 for(const [kind,name] of [['forge','Forge'],['sewing_table','Sewing Table'],['kitchen','Kitchen']]){
  if(result.fixtures.some(f=>f.kind===kind))continue;
  const spot=reachableTiles(result).sort((a,b)=>Math.abs(a.x-anchor.x)+Math.abs(a.y-anchor.y)-Math.abs(b.x-anchor.x)-Math.abs(b.y-anchor.y)||a.y-b.y||a.x-b.x).find(p=>validBusinessTile(result,p.x,p.y));
  if(spot)result.fixtures.push({...spot,id:'craft_'+kind,kind,name,solid:true,span_w:1,span_h:1});
 }if(stationCache.size>100)stationCache.clear();stationCache.set(cacheKey,result.fixtures.slice(z.fixtures.length));return result;
}
export function resourceNodes(zone,floor){
 const craftingData=currentCraftingData();
 const region=craftingData.regions[regionFor(zone)];if(!region||!floor)return []; // Hubs pass no floor: answer before any catalog work.
 const cacheKey=JSON.stringify(craftingData.regions)+':'+zone+':'+floor.edition+':'+(floor.geometryVersion??0)+':'+(floor.contentVersion??0);if(resourceCache.has(cacheKey))return resourceCache.get(cacheKey);
 const craftCatalog=craftingCatalog(craftingData); // Built only on a cache miss: copying every item and material was ~20% of a snapshot when it ran on every call.
 const rnd=seeded(zone+':resources'),tiles=reachableTiles(floor).filter(p=>(floor.chests??[]).every(c=>c.x!==p.x||c.y!==p.y));if(!tiles.length)return [];
 const materials=[...region.nodes,...region.nodes,...(region.rare??[])],nodes=[];
 for(let i=0;i<materials.length;i++){const at=rnd(tiles.length),p=tiles.splice(at,1)[0];if(!p)break;nodes.push({...p,id:'resource_'+i,item:materials[i],name:craftCatalog[materials[i]]?.name??materials[i],quantity:region.rare?.includes(materials[i])?1:2+rnd(3)});}
 const spot=tiles.find(p=>Math.abs(p.x-(floor.entrance?.x??0))+Math.abs(p.y-(floor.entrance?.y??0))>3);if(spot)nodes.push({...spot,id:'craft_campfire',kind:'campfire',name:'Campfire'});
 if(resourceCache.size>100)resourceCache.clear();resourceCache.set(cacheKey,nodes);return nodes;
}
export function createCraftingService(db,{now=Date.now,origins,loot,alchemyStore}){
 const settings=createCraftingStore(db);useCraftingData(settings.read);
 db.exec(`CREATE TABLE IF NOT EXISTS crafting_harvests(character_id TEXT NOT NULL,zone TEXT NOT NULL,node TEXT NOT NULL,day INTEGER NOT NULL,PRIMARY KEY(character_id,zone,node));
 CREATE TABLE IF NOT EXISTS crafting_migrations(id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS crafting_legacy(character_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
 if(!db.prepare("SELECT 1 FROM crafting_migrations WHERE id='legacy-capture-v1'").get()){
  const hasBank=!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quest_bank'").get();
  for(const row of db.prepare('SELECT id,state FROM quest_characters').all()){const payload=JSON.parse(row.state);if(hasBank){const bank=db.prepare('SELECT items FROM quest_bank WHERE character_id=?').get(row.id);if(bank)payload.crafting_legacy_bank=JSON.parse(bank.items);}db.prepare('INSERT OR IGNORE INTO crafting_legacy VALUES (?,?)').run(row.id,JSON.stringify(payload));}
  db.prepare("INSERT INTO crafting_migrations VALUES ('legacy-capture-v1')").run();
 } // Capture existing saved inventories once, before any newly imported client stock can enter this migration.
 const spend=token=>db.prepare("UPDATE quest_item_origins SET status='spent' WHERE id=? AND status='held'").run(token);
 function migrate(c,s){
  const legacy=db.prepare('SELECT payload FROM crafting_legacy WHERE character_id=?').get(c.id);if(!legacy||!s.loadout)return;
  const saved=JSON.parse(legacy.payload),counts=new Map();for(const item of saved.loadout?.inventory??[]){if(!Number.isSafeInteger(item.quantity??1)||(item.quantity??1)<1||(item.quantity??1)>512)continue;counts.set(item.item_id,(counts.get(item.item_id)??0)+(item.quantity??1));}
  const migrateItem=(item,available)=>{const definition=resolveCraftItem(item.item_id);if(!definition||definition.quest_item||definition.bound||definition.soulbound||['quest','quest_item'].includes(definition.category)||!definition.value)return;const have=Math.min(available.get(item.item_id)??0,item.quantity??1),tokens=stackTokens(item),prices=new Map();for(let n=tokens.length;n<have;n++){const copy=origins.mint(c.id,structuredClone(definition));if(copy.online_item){tokens.push(copy.online_item);prices.set(copy.online_item,copy.online_sell_price);}}setStackTokens(item,tokens,prices);available.set(item.item_id,Math.max(0,(available.get(item.item_id)??0)-have));};
  for(const item of s.loadout.inventory)migrateItem(item,counts);
  if(saved.crafting_legacy_bank){const row=db.prepare('SELECT items FROM quest_bank WHERE character_id=?').get(c.id);if(row){const bank=JSON.parse(row.items),available=new Map();for(const entry of saved.crafting_legacy_bank){const item=entry.item,n=item?.quantity??1;if(item&&Number.isSafeInteger(n)&&n>0&&n<=512)available.set(item.item_id,(available.get(item.item_id)??0)+n);}for(const entry of bank)migrateItem(entry.item,available);db.prepare('UPDATE quest_bank SET items=? WHERE character_id=?').run(JSON.stringify(bank),c.id);}}
  db.prepare('DELETE FROM crafting_legacy WHERE character_id=?').run(c.id);
 } // Legacy goods use reconstructed definitions; historical client prices and effects never become sale authority.
 function protect(input,s){if(!input.loadout)return input;const next=structuredClone(input),old=s.loadout?.player_info??{},p=next.loadout.player_info;
  if(p)for(const key of ['smithing_level','smithing_xp','tailoring_level','tailoring_xp','cooking_level','cooking_xp','alchemy_level','alchemy_xp','crafting_journal','alchemy_journal','meal_buff']){if(old[key]===undefined)delete p[key];else p[key]=structuredClone(old[key]);}
  preserveCraftingState(s.loadout,next.loadout,{consume:input.action==='use_item'});return next;
 }
 function requireRights(c,inventory,materials){const verified=new Set();for(const [id,n] of Object.entries(materials)){let have=0;const seen=new Set();for(const row of inventory.filter(v=>v.item_id===id))for(const token of stackTokens(row)){if(seen.has(token))continue;const owned=origins.sale(c,row,token);if(owned){seen.add(token);verified.add(token);have++;}}if(have<n)fail('This craft needs verified '+(craftCatalog[id]?.name??id)+'.');}return verified;}
 function act(c,s,input,p,z,floor){
  const craftingData=settings.read(),craftCatalog=craftingCatalog(craftingData);
  if(!s.loadout||s.run||s.pendingPurchase||s.pendingDefeat)fail('Finish the current activity first.');migrate(c,s);
  if(input.action==='craft_make'){
   let station=input.station;
   if(station==='alchemy_kit'){if(!s.loadout.inventory.some(v=>v.item_id==='alchemy_kit'))fail('Carry an alchemy kit.');}
   else{const fixture=(z?.fixtures??resourceNodes(p.zone,floor)).find(f=>f.id===input.fixture&&f.kind===station);if(!fixture||Math.abs(fixture.x-p.x)+Math.abs(fixture.y-p.y)>1)fail('Stand next to the crafting station.');}
   const result=planCraft(s.loadout,input,c.id+':'+input.request_id,{data:craftingData,loot:loot.apply(craftingData.loot),alchemy:alchemyStore.apply?.(craftingData.alchemy)??craftingData.alchemy});
   const verified=requireRights(c,s.loadout.inventory,result.consumed);applyCraft(s.loadout,result,{mint:item=>origins.mint(c.id,item),spend,verified});
   logBalance('craft',s,{value:1,item:result.item?.item_id??null,station,xp:result.xp??0,burnt:result.burnt?1:0});
   s.craftResult={request:input.request_id,message:result.message,item:result.item,xp:result.xp,burnt:result.burnt};s.hubNotice=result.message;s.hubNoticeAt=now();
  }else if(input.action==='craft_harvest'){
   const node=resourceNodes(p.zone,floor).find(n=>n.id===input.fixture&&!n.kind);if(!node||Math.abs(node.x-p.x)+Math.abs(node.y-p.y)>1)fail('Stand next to the resource.');
   if(db.prepare('SELECT day FROM crafting_harvests WHERE character_id=? AND zone=? AND node=?').get(c.id,p.zone,node.id)?.day===day(now()))fail('You have harvested this node today.');
   const rnd=seeded(c.id+':'+p.zone+':'+node.id+':'+day(now())),buff=s.loadout.player_info.meal_buff,plant=!['iron','wood','meteorite'].includes(node.item),bonus=plant&&buff?.kind==='gather'&&buff.turns>0&&rnd(100)<buff.amount?1:0;
   for(let n=0;n<node.quantity+bonus;n++)addToInventory(s.loadout.inventory,origins.mint(c.id,structuredClone(craftCatalog[node.item])));
   if(s.loadout.inventory.length>512)fail('Make room in your inventory.');db.prepare('INSERT INTO crafting_harvests VALUES (?,?,?,?) ON CONFLICT(character_id,zone,node) DO UPDATE SET day=excluded.day').run(c.id,p.zone,node.id,day(now()));s.hubNotice='Gathered '+(node.quantity+bonus)+' '+node.name+'.';s.hubNoticeAt=now();
  }else{
   const item=s.loadout.inventory[input.index],definition=item&&resolveCraftItem(item.item_id);if(!definition?.cooked||!origins.sale(c,item))fail('Choose a verified cooked meal.');
   const token=stackTokens(item).at(-1);Object.assign(item,definition);consumeFromBag(s.loadout,input.index,item.item_id,{[item.item_id]:definition},{tuning:loot.apply(craftingData.loot).tuning});spend(token);
   if(definition.meal_buff)s.loadout.player_info.meal_buff=structuredClone(definition.meal_buff);
  }
 }
 function view(c,s,p,floor){if(!c)return {version:1};const claims=p?new Set(db.prepare('SELECT node FROM crafting_harvests WHERE character_id=? AND zone=? AND day=?').all(c.id,p.zone,day(now())).map(r=>r.node)):new Set();return {version:1,config:settings.view({editor:false}),result:s?.craftResult??null,nodes:p?resourceNodes(p.zone,floor).map(n=>({...n,claimed:claims.has(n.id)})):[]};} // Player polls need recipe settings, not the GM editor's complete item picker.
 return {act,view,migrate,protect,deliver:(c,s)=>deliverCraftingRewards(c,s,origins),decorate:craftingStations}; // Delivery runs after imports so a stale client bag cannot discard freshly earned goods.
}
