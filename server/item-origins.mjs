import {randomUUID} from 'node:crypto';
import {stackable,stackTokens,setStackTokens} from './loadout.mjs';
import {compactIdentity,compactItemIdentities,itemRarity} from './item-identity.mjs';

const slots=['weapon','head','mouth','torso','pants','panties','plug','socks','shoes','gloves','bra','diaper_cover','special','accessory_1','accessory_2','accessory_3'].map(s=>'equipped_'+s);
const canonical=(item,definition)=>{if(!definition.crafted&&!definition.cooked&&!definition.brewed)return;const mutable={};for(const k of ['quantity','online_item','online_items','online_sell_price','wetness','messiness','wet_absorbed','tum_absorbed'])if(item[k]!==undefined)mutable[k]=item[k];for(const k of Object.keys(item))delete item[k];Object.assign(item,structuredClone(definition),mutable);}; // Rolled properties are restored from the issued item, preserving garment wear and stack identity.
const strip=item=>{delete item.online_item;delete item.online_items;delete item.online_sell_price;delete item.online_sale_quantity;};
const matches=(item,definition)=>definition.item_id===item.item_id&&compactIdentity(definition)&&itemRarity(definition)===itemRarity(item)&&(stackable(item)||!definition.loot?.seed||definition.loot.seed===item.loot?.seed); // Rolled copies retain their authored seed; ordinary stacks share one item type.
const lowRaritySql="(CASE WHEN json_extract(item,'$.loot.rolled')=1 THEN COALESCE(json_extract(item,'$.loot.rarity'),'unknown') ELSE COALESCE(json_extract(item,'$.rarity'),json_extract(item,'$.loot.rarity'),'common') END) IN ('common','uncommon')";
export function createItemOrigins(db){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_item_origins(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,item TEXT NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS quest_owned_items ON quest_item_origins(character_id,status);`);
 function mint(character,item,paid=Infinity){ // Only committed server loot and paid purchases create sale rights; client metadata never does.
  strip(item);const price=Math.min(paid,item.quest_item||item.bound||item.soulbound||item.tradeable===false||['quest','quest_item'].includes(item.category)||!(item.value>0)?0:item.cursed?1:Math.max(1,Math.floor(item.value*0.5)));
  if(!Number.isSafeInteger(price)||price<=0)return item;
  const id=randomUUID();db.prepare('INSERT INTO quest_item_origins VALUES (?,?,?,?,?)').run(id,character,JSON.stringify(item),price,'held');
  item.online_item=id;item.online_sell_price=price;return item;
 }
 function reconcile(c,state,previous){ // Reconcile imported loadouts against existing rights, never against client-supplied prices or claimed history.
  if(!state.loadout)return;
  const rows=db.prepare("SELECT * FROM quest_item_origins WHERE character_id=? AND status='held' AND NOT ("+lowRaritySql+")").all(c.id);
  const common=db.prepare("SELECT item,price,COUNT(*) quantity FROM quest_item_origins WHERE character_id=? AND status='held' AND "+lowRaritySql+" GROUP BY item,price ORDER BY MIN(rowid)").all(c.id).map(r=>({...r,remaining:r.quantity,definition:JSON.parse(r.item)})); // Aggregate identical common units in SQLite instead of loading thousands of UUIDs per movement turn.
  const owned=new Map(rows.map(r=>[r.id,{...r,definition:JSON.parse(r.item)}])),seen=new Set(),next=state.loadout.inventory,pi=state.loadout.player_info;
  const accept=(item,limit=Infinity)=>{
   if(compactIdentity(item)){
    let need=Math.min(limit,stackable(item)?Math.max(1,Math.floor(Number(item.quantity)||1)):1),count=0,first=null;
    for(const r of common){if(!need)break;if(!r.remaining||!matches(item,r.definition))continue;const used=Math.min(need,r.remaining);first??=r;count+=used;r.remaining-=used;need-=used;}
    strip(item);if(!first)return false;
    canonical(item,first.definition);item.online_sell_price=first.price;item.online_sale_quantity=count;return true; // Ownership records remain server-side; no UUID array returns to the character.
   }
   if(stackable(item)){ // A stack keeps one right per tracked unit, in purchase order, never more rights than units; the rest (eaten, thrown away, lost) are retired below like any missing single.
    const quantity=Math.max(1,Math.floor(Number(item.quantity)||1)),kept=[];
    for(const id of stackTokens(item)){const r=owned.get(id);if(!r||r.definition.item_id!==item.item_id||seen.has(id)||kept.length>=quantity)continue;seen.add(id);kept.push(id);}
    if(kept.length)canonical(item,owned.get(kept[0]).definition);setStackTokens(item,kept,new Map(kept.map(id=>[id,owned.get(id).price])));return kept.length>0;
   }
   const r=owned.get(item.online_item);if(!r||r.definition.item_id!==item.item_id||seen.has(r.id)){strip(item);return false;}canonical(item,r.definition);item.online_sell_price=r.price;seen.add(r.id);return true;};
  // Bank contents are server-owned: imported copies of a banked token cannot displace the stored original.
  const bank=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quest_bank'").get()?db.prepare('SELECT items FROM quest_bank WHERE character_id=?').get(c.id):null;
  if(bank){const stored=JSON.parse(bank.items);for(const entry of stored)accept(entry.item,Number(entry.item.online_sale_quantity)||stackTokens(entry.item).length);db.prepare('UPDATE quest_bank SET items=? WHERE character_id=?').run(JSON.stringify(stored),c.id);} // Unverified bank copies cannot absorb sale rights from a newly purchased bag item.
  for(const item of next)accept(item);
  const equipment={};
  for(const key of slots){const item=pi.equipped_item_data?.[key.slice(9)];
   if(key==='equipped_pants'&&item?.category==='dress'&&pi.equipped_item_data?.torso?.item_id===item.item_id&&compactIdentity(item))continue; // One dress mirrored across two slots owns one common entitlement.
   if(item&&item.item_id===pi[key]&&accept(item)&&item.online_item)equipment[key]=item.online_item;
   if(!item&&pi[key]){
    const group=common.find(r=>r.remaining&&r.definition.item_id===pi[key]);
    if(group){const restored={...structuredClone(group.definition),quantity:1};if(accept(restored)){pi.equipped_item_data??={};pi.equipped_item_data[key.slice(9)]=restored;if(restored.category==='dress'&&key==='equipped_torso'&&pi.equipped_pants===restored.item_id)pi.equipped_item_data.pants=structuredClone(restored);}}
   } // Older clients saved equipment IDs alone; restore a compact item copy before retiring unused rights.
  } // Only existing, unclaimed provenance survives; mirrored dresses retain one right.

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
  for(const r of common)if(r.remaining)db.prepare("UPDATE quest_item_origins SET status='spent' WHERE id IN (SELECT id FROM quest_item_origins WHERE character_id=? AND status='held' AND item=? AND price=? ORDER BY rowid DESC LIMIT ?)").run(c.id,r.item,r.price,r.remaining); // Retire only the consumed aggregate count, preserving older units first.
  compactItemIdentities(state.loadout);state.itemIdentityVersion=1; // Also compact any legacy equipment metadata restored by the fallback paths.
 }
 function sale(c,item,token=item?.online_item){ // The right being sold: a single item's own token, or any token a stack carries (the client offers its front unit).
  if(compactIdentity(item)&&!token)return sales(c,item,1)[0]??null;
  const id=stackable(item)?(stackTokens(item).includes(token)?token:''):(token===item?.online_item?token:'');
  const row=db.prepare("SELECT * FROM quest_item_origins WHERE id=? AND character_id=? AND status='held'").get(id??'',c.id);if(!row)return null;const definition=JSON.parse(row.item);return definition.item_id===item.item_id&&!definition.quest_item&&!definition.bound&&!definition.soulbound&&definition.tradeable!==false&&!['quest','quest_item'].includes(definition.category)?row:null;
 }
 function sales(c,item,count,first=item?.online_item,excluded=new Set()){
  if(!item)return [];
  if(compactIdentity(item)){
   if(count>Math.min(Math.max(1,Number(item.quantity)||1),Number(item.online_sale_quantity)||stackTokens(item).length))return [];
   return db.prepare("SELECT * FROM quest_item_origins WHERE character_id=? AND status='held' AND json_extract(item,'$.item_id')=? ORDER BY (price=?) DESC,rowid").all(c.id,item.item_id,item.online_sell_price??0).filter(r=>!excluded.has(r.id)&&matches(item,JSON.parse(r.item))).slice(0,count); // Prefer the displayed server price when identical goods were acquired at different prices.
  } // Only the committed eligible count may sell; an imported copy cannot claim a banked item's records.
  const tokens=stackTokens(item);if(!tokens.includes(first))return [];
  return [first,...tokens.filter(t=>t!==first)].slice(0,count).map(t=>sale(c,item,t)).filter(Boolean);
 } // Bulk sale and escrow select authoritative records by committed item/quantity, never by a client price.
 function attach(c,item,excluded=new Set()){
  if(!compactIdentity(item))return stackTokens(item);
  const count=Math.min(Math.max(1,Math.floor(Number(item.quantity)||1)),Number(item.online_sale_quantity)||stackTokens(item).length),rows=sales(c,item,count,item.online_item,excluded);
  if(rows.length){item.online_item=rows[0].id;if(stackable(item))item.online_items=rows.map(r=>r.id);}
  return rows.map(r=>r.id); // UUIDs exist transiently inside server-owned escrow, not inside the saved character's bag.
 }
 function park(id,character){return db.prepare("UPDATE quest_item_origins SET status='escrow' WHERE id=? AND character_id=? AND status='held'").run(id??'',character).changes>0;} // An item on a trade table or in a duel pot keeps its right in escrow: reconcile() only judges held rows, so it is not marked spent while out of the bag.
 function release(id,character){return db.prepare("UPDATE quest_item_origins SET status='held',character_id=? WHERE id=? AND status='escrow'").run(character,id??'').changes>0;} // Back to a bag: the original owner on a refund, the new owner on a completed swap or a won pot.
 function transfer(id,from,to){return db.prepare("UPDATE quest_item_origins SET character_id=? WHERE id=? AND character_id=? AND status='held'").run(to,id,from).changes>0;} // A trade moves the resale right to the new owner; nothing else can re-home a right.
 return {mint,reconcile,sale,sales,attach,transfer,park,release};
}
