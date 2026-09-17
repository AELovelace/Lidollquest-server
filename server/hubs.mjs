import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {seeded} from './dive-generation.mjs';

export const hubData=JSON.parse(readFileSync(new URL('./hub-data.json',import.meta.url),'utf8'));
const c=hubData.config;
if(!Number.isInteger(c.stock_size)||c.stock_size<1||c.stock_size>24||!Number.isFinite(c.coin_price_multiplier)||c.coin_price_multiplier<=0||c.coin_price_multiplier>100||!Number.isInteger(c.inventory_capacity)||c.inventory_capacity<1||c.inventory_capacity>512||!Number.isInteger(c.rest_tick_ms)||c.rest_tick_ms<500)throw Error('Invalid online hub tuning');
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'hub_conflict'});};
const gardenWidth=c.garden_width??40,gardenHeight=c.garden_height??24;
if(![gardenWidth,gardenHeight].every(n=>Number.isInteger(n)&&n>=20&&n<=80))throw Error('Invalid garden dimensions');
export const hubCatalog=Object.freeze([
 {id:'honeydew-lantern',hub:'town',theme:'lantern',prefix:'Lantern',name:'Lantern Court'},
 {id:'littlebig-clockwork',hub:'littlebig_city',theme:'clockwork',prefix:'Clockwork',name:'Clockwork Coliseum'},
 {id:'princess-rose',hub:'princess_quarters',theme:'rose',prefix:'Rose',name:'Rose Court'},
]); // A single catalog supplies lobby identity, annexes and legacy entry validation.
export function dungeonPortals(parent){
 const quarters={x:6,y:4,name:"Princess' Quarters",target:'dive-quarters',style:'warp'};
 const desert={x:14,y:4,name:'Dustbreak Desert',target:'dive-desert',style:'warp'};
 const tundra={x:14,y:4,name:'Frostveil Tundra',target:'dive-tundra',style:'warp'};
 if(parent==='princess-rose')return [quarters,tundra];
 if(parent==='honeydew-lantern')return [quarters,desert,{...tundra,x:10,y:6}];
 if(parent==='littlebig-clockwork')return [quarters,desert];
 return [];
} // Only adjacent routes are offered; keep the two established pad positions stable.
export const hubRooms=hubCatalog.flatMap(root=>['garden','beds','shops','dives'].map(kind=>({
 id:root.id+'-'+kind,parent:root.id,kind,hub:root.hub,theme:root.theme,
 name:root.prefix+' '+({garden:'Garden',beds:'Resting Hall',shops:'Market Hall',dives:'Dive Hall'})[kind],
 width:kind==='garden'?gardenWidth:20,height:kind==='garden'?gardenHeight:12,
 spawn:kind==='garden'?{x:gardenWidth-2,y:Math.floor(gardenHeight/2)}:kind==='beds'?{x:1,y:6}:{x:10,y:9},
 exit:kind==='garden'?{x:gardenWidth-1,y:Math.floor(gardenHeight/2)-1,w:1,h:2,style:'gap',side:'right'}:kind==='beds'?{x:0,y:5,w:1,h:2,style:'gap',side:'left'}:{x:10,y:10,style:kind==='shops'?'stairs':'door'},
 fixtures:kind==='beds'?hubData.beds.map((bed,i)=>({...bed,kind:'bed',x:3+(i%3)*6,y:3+Math.floor(i/3)*4})):
 kind==='shops'?[...hubData.shops.map((shop,i)=>({id:shop.id,name:shop.name,sprite:shop.sprite,kind:'shop',x:3+(i%4)*4,y:3+Math.floor(i/4)*4})),{id:'bank',name:'Bank',kind:'bank',x:17,y:9}]:
 kind==='garden'?[{id:'fountain',name:'',kind:'scenery',sprite:'sprTownEnvFountain',x:Math.floor(gardenWidth/2),y:Math.floor(gardenHeight/3)},
 ...[[0.3,0.5],[0.7,0.5],[0.2,0.75],[0.8,0.75]].map(([x,y],i)=>({id:'bench-'+i,name:'',kind:'scenery',sprite:'sprTownEnvBench',x:Math.floor(gardenWidth*x),y:Math.floor(gardenHeight*y)}))]:[], // Spread social seating across the larger garden; clients use the same fixture coordinates as collision.
}))); // Each hub has its own presence/chat scope; fixtures are presentation data, never campaign NPCs.
export const hubPortals=parent=>[{x:0,y:5,w:1,h:2,name:'Garden',target:parent+'-garden',style:'gap',side:'left'},{x:19,y:5,w:1,h:2,name:'Beds',target:parent+'-beds',style:'gap',side:'right'},{x:15,y:8,name:'Shops',target:parent+'-shops',style:'stairs'},{x:10,y:2,name:'Dungeon Dive',target:parent+'-dives',style:'door'}];
export const inHubGap=(gap,x,y)=>x>=gap.x&&x<gap.x+(gap.w??1)&&y>=gap.y&&y<gap.y+(gap.h??1);
export const hubGaps=z=>z.parent?(z.exit?.style==='gap'?[{...z.exit,target:z.parent}]:[]):hubPortals(z.id).filter(p=>p.style==='gap'); // Only declared wall openings are traversable; all other perimeter cells remain walls.
export const hubBlocked=(z,x,y)=>z.fixtures?.some(f=>f.x===x&&f.y===y)??false;
export function shopOffers(zone,shop,time){
 const day=Math.floor(time/86400000),rnd=seeded(`${zone}:${shop.id}:${day}`),pool=[...shop.pool],offers=[];
 // Keep a meal available at the general merchant and apothecary every day.
 const food=pool.includes('adult_food')?'adult_food':null;if(food)pool.splice(pool.indexOf(food),1);
 for(let slot=0;slot<c.stock_size&&(pool.length||slot===0&&food);slot++){
  const id=slot===0&&food?food:pool.splice(rnd(pool.length),1)[0],item=structuredClone(hubData.items[id]);
  if(item.atk_min!==undefined){item.atk=item.atk_min+rnd(item.atk_max-item.atk_min+1);item.desc=item.desc?.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
  const price=Math.max(1,Math.ceil(item.value*c.coin_price_multiplier));
  offers.push({id:`${day}-${slot}`,price,item});
 }return offers;
} // Stock is shared, deterministic and inexhaustible; purchases never consume somebody else's offer.
export function hubDefinition(z,time){return {...z,width:z.width??20,height:z.height??12,spawn:z.spawn??{x:10,y:9},exit:z.exit??{x:10,y:10,style:'stairs'},restTickMs:c.rest_tick_ms,portals:z.kind==='dives'?dungeonPortals(z.parent):z.parent?[]:hubPortals(z.id),fixtures:(z.fixtures??[]).map(f=>f.kind==='shop'?{...f,offers:shopOffers(z.id,hubData.shops.find(s=>s.id===f.id),time)}:f)};}
export function nearbyFixture(z,p,id,kind){const f=z.fixtures?.find(f=>f.id===id&&f.kind===kind);if(!f||Math.abs(f.x-p.x)+Math.abs(f.y-p.y)>1)fail('Stand next to that '+kind+'.');return f;}

export function createHubPurchases(db,{now,origins}){
 db.exec(`CREATE TABLE IF NOT EXISTS hub_purchases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,character_id TEXT NOT NULL,item TEXT NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
 CREATE INDEX IF NOT EXISTS hub_pending_purchases ON hub_purchases(owner,status);`);
 function prepare(i,char,state,z,p,input){
  if(state.run||!state.loadout)fail('Leave combat before shopping.');
  nearbyFixture(z,p,input.fixture,'shop');
  const shop=hubData.shops.find(s=>s.id===input.fixture),offer=shopOffers(z.id,shop,now()).find(o=>o.id===input.offer);
  if(!offer)fail('The stock changed. Reopen the shop.');
  if(state.loadout.inventory.length>=c.inventory_capacity)fail('Inventory full. No coins were charged.');
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
   if(paid)state.loadout.inventory.push(origins.mint(char.id,item,row.price)); // Resale never exceeds the actual paid price, even with discounted stock tuning.
   delete state.pendingPurchase;state.hubNotice=paid?`Bought ${item.name??item.item_id} for ${row.price} LiDollCoins.`:'Not enough LiDollCoins. Nothing was purchased.';state.hubNoticeAt=now();
   db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),char.id);
   db.prepare('UPDATE hub_purchases SET status=? WHERE id=?').run(paid?'delivered':'declined',id);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 } // A replayed wallet debit can finish this atomic item grant after any service restart.
 return {prepare,complete};
}
