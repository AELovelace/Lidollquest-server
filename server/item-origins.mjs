import {randomUUID} from 'node:crypto';

const slots=['weapon','head','mouth','torso','pants','panties','plug','socks','shoes','gloves','bra','diaper_cover','special','accessory_1','accessory_2','accessory_3'].map(s=>'equipped_'+s);
const strip=item=>{delete item.online_item;delete item.online_sell_price;};
export function createItemOrigins(db){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_item_origins(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,item TEXT NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS quest_owned_items ON quest_item_origins(character_id,status);`);
 function mint(character,item,paid=Infinity){ // Only committed server loot and paid purchases create sale rights; client metadata never does.
  strip(item);const price=Math.min(paid,item.category==='quest_item'||!(item.value>0)?0:item.cursed?1:Math.max(1,Math.floor(item.value*0.5)));
  if(!Number.isSafeInteger(price)||price<=0)return item;
  const id=randomUUID();db.prepare('INSERT INTO quest_item_origins VALUES (?,?,?,?,?)').run(id,character,JSON.stringify(item),price,'held');
  item.online_item=id;item.online_sell_price=price;return item;
 }
 function reconcile(c,state,previous){ // Reconcile imported loadouts against existing rights, never against client-supplied prices or claimed history.
  if(!state.loadout)return;
  const rows=db.prepare("SELECT * FROM quest_item_origins WHERE character_id=? AND status='held'").all(c.id);
  const owned=new Map(rows.map(r=>[r.id,{...r,definition:JSON.parse(r.item)}])),seen=new Set(),next=state.loadout.inventory,pi=state.loadout.player_info;
  const accept=item=>{const r=owned.get(item.online_item);if(!r||r.definition.item_id!==item.item_id||seen.has(r.id)){strip(item);return false;}item.online_sell_price=r.price;seen.add(r.id);return true;};
  // Bank contents are server-owned: imported copies of a banked token cannot displace the stored original.
  const bank=db.prepare('SELECT items FROM quest_bank WHERE character_id=?').get(c.id);
  if(bank){const stored=JSON.parse(bank.items);for(const entry of stored)accept(entry.item);db.prepare('UPDATE quest_bank SET items=? WHERE character_id=?').run(JSON.stringify(stored),c.id);}
  for(const item of next)accept(item);
  const equipment={};
  const prior=previous.loadout?.inventory??[],oldPi=previous.loadout?.player_info??{};
  const returned=new Map(); // Only newly returned untagged items may regain a removed piece of equipment's identity.
  for(const item of prior)if(!item.online_item)returned.set(item.item_id,(returned.get(item.item_id)??0)+1);
  const candidates=[];
  for(const item of next)if(!item.online_item){const count=returned.get(item.item_id)??0;if(count)returned.set(item.item_id,count-1);else candidates.push(item);}
  for(const [key,id] of Object.entries(previous.equipmentOrigins??{})){
   const r=owned.get(id);if(!r||seen.has(id)||!slots.includes(key))continue;
   if(pi[key]===r.definition.item_id){
    const replacement=prior.find(item=>item.item_id===r.definition.item_id&&item.online_item!==id&&owned.has(item.online_item)&&!seen.has(item.online_item));
    const returnedItem=candidates.find(item=>!item.online_item&&item.item_id===r.definition.item_id);
    if(replacement&&returnedItem){returnedItem.online_item=id;accept(returnedItem);equipment[key]=replacement.online_item;seen.add(replacement.online_item);} // Swapping two copies of the same equipment ID must retain both distinct rights.
    else{equipment[key]=id;seen.add(id);}
   }
   else {const item=candidates.find(item=>!item.online_item&&item.item_id===r.definition.item_id);if(item){item.online_item=id;accept(item);}}
  }
  for(const item of prior){
   const r=owned.get(item.online_item);if(!r||seen.has(r.id)||r.definition.item_id!==item.item_id)continue;
   const key=slots.find(key=>pi[key]===item.item_id&&oldPi[key]!==item.item_id&&!equipment[key]);
   if(key){equipment[key]=r.id;seen.add(r.id);} // Ordinary equip stores an item ID rather than its full inventory struct.
  }
  if(Object.keys(equipment).length)state.equipmentOrigins=equipment;else delete state.equipmentOrigins;
  for(const r of rows)if(!seen.has(r.id))db.prepare("UPDATE quest_item_origins SET status='spent' WHERE id=?").run(r.id); // Consumed/disposed/lost rights cannot be resurrected by replaying an old inventory.
 }
 function sale(c,item){const row=db.prepare("SELECT * FROM quest_item_origins WHERE id=? AND character_id=? AND status='held'").get(item?.online_item??'',c.id);return row&&JSON.parse(row.item).item_id===item.item_id?row:null;}
 return {mint,reconcile,sale};
}
