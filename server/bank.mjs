import {randomUUID} from 'node:crypto';
import {stackable,slotsUsed,addToInventory} from './loadout.mjs'; // Withdrawing a stack never needs a free slot.
import {hubData,nearbyFixture} from './hubs.mjs';
import {importLoadout} from './loadout.mjs';

export const BANK_CAPACITY=512;
const PAGE_SIZE=16;
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'bank_conflict'});};
export function createBank(db){
 db.exec('CREATE TABLE IF NOT EXISTS quest_bank(character_id TEXT PRIMARY KEY,items TEXT NOT NULL)');
 const items=id=>JSON.parse(db.prepare('SELECT items FROM quest_bank WHERE character_id=?').get(id)?.items??'[]');
 function snapshot(c,p,z,{companion=false,bankPage=null}={}){
  if(!c)return null;
  const stored=items(c.id),available=!!z?.fixtures?.some(f=>f.kind==='bank'&&Math.abs(f.x-p.x)+Math.abs(f.y-p.y)<=1);
  const pages=Math.max(1,Math.ceil(stored.length/PAGE_SIZE));
  const requested=companion&&Number.isInteger(bankPage)?bankPage:JSON.parse(c.state).bankPage??0; // The companion pages without writing the in-game bank page, so it never moves the player's open drawer.
  const page=Math.min(Math.max(0,requested),pages-1);
  return {capacity:BANK_CAPACITY,count:stored.length,available,companion,page,pages,pageSize:PAGE_SIZE,items:available||companion?stored.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE):[]};
 } // Only the owning character sees storage. In-game clients receive item payloads only while beside a bank; the companion reads its own storage from anywhere.
 function locate(c,bankItem){ // Resolve one stored entry by its server-issued id, without exposing neighbouring pages.
  const stored=items(c.id),index=stored.findIndex(entry=>entry.id===bankItem);
  if(index<0)fail('That item is no longer in your bank.');
  return {stored,index,item:stored[index].item};
 }
 const commit=(c,stored)=>db.prepare('INSERT INTO quest_bank VALUES (?,?) ON CONFLICT(character_id) DO UPDATE SET items=excluded.items').run(c.id,JSON.stringify(stored)); // Storage writes stay in this module and join the surrounding command transaction.
 function transfer(c,state,z,p,input){
  if(state.run||!state.loadout)fail('Leave combat before using the bank.');
  nearbyFixture(z,p,input.fixture,'bank');
  const stored=items(c.id),inventory=state.loadout.inventory;
  if(input.action==='bank_page'){
   if(!Number.isInteger(input.page)||input.page<0||input.page>=Math.max(1,Math.ceil(stored.length/PAGE_SIZE)))fail('Choose an available bank page.');
   state.bankPage=input.page;return;
  } // Fixed-size pages keep full banks within the existing gateway response limit.
  if(input.action==='bank_deposit'){
   if(stored.length>=BANK_CAPACITY)fail('Bank full (512 items).');
   if(!Number.isInteger(input.slot)||input.slot<0||input.slot>=inventory.length)fail('Choose an inventory item.');
   stored.push({id:randomUUID(),item:inventory.splice(input.slot,1)[0]});
  }else{
   const index=stored.findIndex(entry=>entry.id===input.bank_item);
   if(index<0)fail('That item is no longer in your bank.');
   if(!stackable(stored[index].item)&&slotsUsed(inventory)>=hubData.config.inventory_capacity)fail('Inventory full. The item stays in your bank.');
   addToInventory(inventory,stored.splice(index,1)[0].item); // A withdrawn consumable rejoins its stack (rights included) instead of opening a second row.
   importLoadout(state.loadout); // Reject a withdrawal that would exceed reconnect payload/complexity limits.
  }
  db.prepare('INSERT INTO quest_bank VALUES (?,?) ON CONFLICT(character_id) DO UPDATE SET items=excluded.items').run(c.id,JSON.stringify(stored));
 } // Storage, inventory, character revision and request receipt commit in the surrounding command transaction.
 return {snapshot,transfer,locate,commit};
}
