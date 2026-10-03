import {randomUUID,createHash} from 'node:crypto';
import {craftingData,resolveCraftItem} from './crafting.mjs';
import {validBusinessTile,reachableTiles} from './crafting-service.mjs';
import {stackable,stackTokens,setStackTokens,addToInventory,slotsUsed} from './loadout.mjs';
import {validateLook} from './sprite-looks.mjs';

const fail=message=>{throw Object.assign(Error(message),{status:409,code:'player_store_failed'});};
const integer=(v,min,max,label)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(label+' must be between '+min+' and '+max+'.');return v;};
const publicItem=item=>{const copy={...item};delete copy.online_item;delete copy.online_items;delete copy.online_sell_price;return copy;}; // Public cards describe stock without publishing its ownership tokens.
const text=(v,max)=>String(v??'').replace(/[\x00-\x1f<>]/g,'').trim().slice(0,max);
export const STORE_ACTIONS=['store_create','store_move','store_style','store_close','store_open','store_deposit','store_withdraw','store_list','store_unlist','store_order','store_cancel_order','store_buy','store_sell'];
export function validateShopAppearance(input,unlocked=null){return validateLook(input,{unlocked,fail});} // Shopkeepers follow the same look rules as players (registered layers, accessory limit and unlocks) with store errors.
export function createPlayerStores(db,{now=Date.now,origins,adjust,zone,unlocks=()=>null}){ // unlocks(owner): Set of accessory ids the account owns (sprite-looks.mjs).
 db.exec(`CREATE TABLE IF NOT EXISTS player_stores(id TEXT PRIMARY KEY,character_id TEXT NOT NULL UNIQUE,owner TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS player_store_receipts(id TEXT PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS player_stores_zone ON player_stores(json_extract(body,'$.zone'));`);
 const save=s=>db.prepare('UPDATE player_stores SET body=? WHERE id=?').run(JSON.stringify(s),s.id);
 const get=id=>{const row=db.prepare('SELECT body FROM player_stores WHERE id=?').get(id);return row?JSON.parse(row.body):null;};
 const own=c=>{const row=db.prepare('SELECT body FROM player_stores WHERE character_id=?').get(c.id);return row?JSON.parse(row.body):null;};
 const all=z=>db.prepare("SELECT body FROM player_stores WHERE json_extract(body,'$.zone')=? ORDER BY id").all(z).map(r=>JSON.parse(r.body));
 function fixture(s){return {id:s.id,kind:'player_store',name:s.name,shopkeeper:s.shopkeeper,appearance:s.appearance,x:s.x,y:s.y,solid:true,span_w:1,span_h:1,owner_character:s.character};}
 function decorate(base){
  const z={...base,fixtures:[...(base.fixtures??[])]};for(const s of all(z.id)){if(!s.active)continue;let position={x:s.x,y:s.y};
   if(!validBusinessTile(z,s.x,s.y)){position=reachableTiles(z).sort((a,b)=>Math.abs(a.x-s.x)+Math.abs(a.y-s.y)-Math.abs(b.x-s.x)-Math.abs(b.y-s.y)||a.y-b.y||a.x-b.x).find(p=>validBusinessTile(z,p.x,p.y));}
   if(position)z.fixtures.push({...fixture(s),...position});
  }return z;
 } // Monthly maps realize the saved preferred position safely; unavailable stores retain their property.
 function accessible(c,s,p){if(s.owner===c.owner)fail('Use My Shop to withdraw your own stock.');const z=zone(p.zone),f=z.fixtures?.find(f=>f.id===s.id);if(!s.active||!f||Math.abs(f.x-p.x)+Math.abs(f.y-p.y)>1)fail('Stand beside that shopkeeper.');}
 function take(c,state,index,count){
  const row=state.loadout.inventory[index];if(!row)fail('Choose an inventory item.');const quantity=integer(count,1,512,'Quantity');
  if((row.quantity??1)<quantity||(!stackable(row)&&quantity!==1))fail('Not enough of that item.');const tokens=stackTokens(row).slice(0,quantity);if(tokens.length!==quantity)fail('Only verified goods can be deposited or sold.');
  const units=tokens.map(token=>{const origin=origins.sale(c,row,token);if(!origin)fail('That item is no longer available.');const definition=JSON.parse(origin.item);if(definition.quest_item||['quest','quest_item'].includes(definition.category)||!(definition.value>0))fail('That item cannot be traded.');return {...definition,online_item:token,online_sell_price:origin.price};});
  if((row.quantity??1)===quantity)state.loadout.inventory.splice(index,1);else{row.quantity-=quantity;setStackTokens(row,stackTokens(row).slice(quantity));}
  for(const unit of units)if(!origins.park(unit.online_item,c.id))fail('That item is reserved elsewhere.');return units;
 }
 function put(s,units){for(const unit of units){const match=stackable(unit)?s.stock.find(r=>!r.price&&!r.pending&&r.item.item_id===unit.item_id&&r.tokens.length<512):null;if(match)match.tokens.push(unit.online_item);else s.stock.push({id:randomUUID(),item:unit,tokens:[unit.online_item],price:0});}if(s.stock.length>512)fail('Shop storage is full.');}
 function charge(c,state,input,price,reservation){
  const id=createHash('sha256').update(c.id+':'+input.request_id).digest('hex');
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,c.owner,c.id,JSON.stringify({player_store:true,...reservation}),price);
  state.pendingPurchase=id;state.hubNotice='Completing shop payment…';state.hubNoticeAt=now();return id;
 }
 function act(c,state,input,p){
  if(!state.loadout||state.run||state.pendingPurchase||state.pendingDefeat)fail('Finish the current activity first.');
  let s=own(c);const kind=input.action;
  if(kind==='store_create'){
   if(s)fail('This character already owns a shop.');const z=zone(p.zone);if(z.kind==='dungeon'||!validBusinessTile(z,input.x,input.y))fail('Choose an open hub tile that preserves paths and services.');
   if(db.prepare("SELECT 1 FROM player_store_receipts WHERE kind='create' AND status='pending' AND json_extract(body,'$.zone')=? AND json_extract(body,'$.x')=? AND json_extract(body,'$.y')=?").get(p.zone,input.x,input.y))fail('Another shop is reserving that tile.');
   const appearance=validateShopAppearance(input.appearance,unlocks(c.owner)),name=text(input.name,48)||c.name+"'s Shop",shopkeeper=text(input.shopkeeper,32)||'Shopkeeper';
   const draft={id:'store_'+randomUUID(),character:c.id,owner:c.owner,zone:p.zone,x:input.x,y:input.y,name,shopkeeper,appearance,active:true,stock:[],orders:[],created:now()};
   const id=charge(c,state,input,1000,{kind:'create',draft});db.prepare('INSERT INTO player_store_receipts VALUES (?,?,?,?)').run(id,'create',JSON.stringify(draft),'pending');return;
  }
  if(['store_buy','store_sell'].includes(kind)){
   s=get(input.shop);if(!s)fail('That shop no longer exists.');accessible(c,s,p);
   const count=integer(input.amount??1,1,512,'Quantity');
   if(kind==='store_buy'){
    const row=s.stock.find(r=>r.id===input.offer&&r.price>0);if(!row||row.price!==input.price||row.tokens.length<count)fail('The listing changed. Refresh the shop.');
    if((!stackable(row.item)&&slotsUsed(state.loadout.inventory)+count>99)||state.loadout.inventory.length>=512)fail('Make room before buying.');
    const tokens=row.tokens.splice(0,count),id=charge(c,state,input,row.price*count,{kind:'buy',shop:s.id,listing:row.id,item:row.item,tokens,unit_price:row.price});
    row.pending=(row.pending??0)+count;db.prepare('INSERT INTO player_store_receipts VALUES (?,?,?,?)').run(id,'buy',JSON.stringify({shop:s.id}),'pending');save(s);return;
   }
   const order=s.orders.find(o=>o.id===input.offer);if(!order||order.price!==input.price||order.remaining<count)fail('The buy order changed.');
   if(state.loadout.inventory[input.index]?.item_id!==order.item_id)fail('The buy order requires this exact item type.');
   const units=take(c,state,input.index,count);put(s,units);order.remaining-=count;order.funds-=count*order.price;
   adjust(c.owner,'coins',count*order.price,'store-order-'+c.id+'-'+input.request_id,'Sold to '+s.name);s.orders=s.orders.filter(o=>o.remaining>0);save(s);return;
  }
  if(!s)fail('Open a shop first.');
  if(kind==='store_style'){s.appearance=validateShopAppearance(input.appearance,unlocks(c.owner));s.name=text(input.name,48)||s.name;s.shopkeeper=text(input.shopkeeper,32)||s.shopkeeper;}
  else if(kind==='store_move'){const z=zone(p.zone),without={...z,fixtures:z.fixtures.filter(f=>f.id!==s.id)};if(z.kind==='dungeon'||!validBusinessTile(without,input.x,input.y))fail('Choose a valid hub tile.');s.zone=p.zone;s.x=input.x;s.y=input.y;}
  else if(kind==='store_close')s.active=false;
  else if(kind==='store_open')s.active=true;
  else if(kind==='store_deposit')put(s,take(c,state,input.index,input.amount??1));
  else if(kind==='store_withdraw'){
   const row=s.stock.find(r=>r.id===input.offer),count=integer(input.amount??1,1,512,'Quantity');if(!row||row.price||row.tokens.length<count)fail('Unlist the goods before withdrawing them.');
   if(!stackable(row.item)&&slotsUsed(state.loadout.inventory)+count>99)fail('Make room in your bag.');for(const token of row.tokens.splice(0,count)){if(!origins.release(token,c.id))fail('The item is still reserved.');addToInventory(state.loadout.inventory,{...row.item,quantity:1,online_items:[token],online_item:token});}if(state.loadout.inventory.length>512)fail('Make room in your bag.');s.stock=s.stock.filter(r=>r.tokens.length||r.pending);
  }else if(kind==='store_list'){
   const row=s.stock.find(r=>r.id===input.offer);if(!row||row.pending)fail('Choose available stored goods.');if(!row.price&&s.stock.filter(r=>r.price>0).length>=40)fail('A shop has at most 40 sale listings.');
   const count=integer(input.amount??row.tokens.length,1,row.tokens.length,'Quantity'),price=integer(input.price,1,1000000,'Unit price');
   if(!row.price&&count<row.tokens.length){if(s.stock.length>=512)fail('Shop storage is full.');s.stock.push({id:randomUUID(),item:row.item,tokens:row.tokens.splice(0,count),price});}else row.price=price; // A partial listing leaves the remainder available for withdrawal.
  }else if(kind==='store_unlist'){const row=s.stock.find(r=>r.id===input.offer);if(!row)fail('Choose a listing.');row.price=0;}
  else if(kind==='store_order'){
   if(s.orders.length>=20)fail('A shop has at most 20 buy orders.');const item=resolveCraftItem(input.item_id);if(!item||!['ingredient','food','drink','ammo'].includes(item.category)||!item.value||item.quest_item)fail('Buy orders support materials and consumables.');
   const count=integer(input.amount,1,512,'Quantity'),price=integer(input.price,1,1000000,'Unit price');charge(c,state,input,count*price,{kind:'order',shop:s.id,order:{id:randomUUID(),item_id:item.item_id,name:item.name,remaining:count,price,funds:count*price}});
  }else if(kind==='store_cancel_order'){
   const order=s.orders.find(o=>o.id===input.offer);if(!order)fail('Choose a buy order.');if(order.funds)adjust(c.owner,'coins',order.funds,'store-cancel-'+order.id,'Unused buy order funds');s.orders=s.orders.filter(o=>o.id!==order.id);
  }else fail('Unknown shop action.');save(s);
 }
 function settle(id,c,state,paid,amount,r){
  if(r.kind==='create'){
   if(paid&&!own(c)){db.prepare('INSERT INTO player_stores VALUES (?,?,?,?)').run(r.draft.id,c.id,c.owner,JSON.stringify(r.draft));state.hubNotice='Your shop is open.';}else if(paid)adjust(c.owner,'coins',amount,'store-refund-'+id,'Shop fee returned');
  }else if(r.kind==='order'){
   const s=get(r.shop);if(paid&&s){s.orders.push(r.order);save(s);}else if(paid)adjust(c.owner,'coins',amount,'store-refund-'+id,'Buy order funds returned');
  }else if(r.kind==='buy'){
   const s=get(r.shop);if(!s)throw Error('Reserved store disappeared');const row=s.stock.find(row=>row.id===r.listing);if(!row)throw Error('Reserved stock disappeared');row.pending-=r.tokens.length;
   if(paid){for(const token of r.tokens){if(!origins.release(token,c.id))throw Error('Reserved item identity missing');addToInventory(state.loadout.inventory,{...r.item,quantity:1,online_item:token,online_items:[token]});}adjust(s.owner,'coins',amount,'store-sale-'+id,'Sale at '+s.name);state.hubNotice='Purchased from '+s.name+'.';}
   else row.tokens.unshift(...r.tokens);s.stock=s.stock.filter(row=>row.tokens.length||row.pending);save(s);
  }
  if(!paid)state.hubNotice='Payment declined. No coins or goods were lost.';state.hubNoticeAt=now();db.prepare("UPDATE player_store_receipts SET status=? WHERE id=?").run(paid?'done':'declined',id);
 } // Called inside the existing durable wallet-delivery transaction, once per purchase receipt.
 function view(c,p){
  const mine=c?own(c):null,publicStores=p?all(p.zone).filter(s=>s.active).map(s=>({id:s.id,name:s.name,shopkeeper:s.shopkeeper,character:s.character,listings:s.stock.filter(r=>r.price&&r.tokens.length).map(r=>({id:r.id,item:publicItem(r.item),quantity:r.tokens.length,price:r.price})),orders:s.orders.map(({funds,...o})=>o)})):[];
  return {version:1,cost:1000,mine:mine?{...mine,stock:mine.stock.map(r=>({...r,quantity:r.tokens.length,tokens:undefined}))}:null,stores:publicStores};
 }
 return {act,settle,decorate,view};
}
