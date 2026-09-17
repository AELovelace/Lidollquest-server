import {randomUUID} from 'node:crypto';
import {hubData,nearbyFixture} from './hubs.mjs';
import {importLoadout} from './loadout.mjs';

export const BANK_CAPACITY=512;
const PAGE_SIZE=16;
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'bank_conflict'});};
export function createBank(db){
 db.exec('CREATE TABLE IF NOT EXISTS quest_bank(character_id TEXT PRIMARY KEY,items TEXT NOT NULL)');
 const items=id=>JSON.parse(db.prepare('SELECT items FROM quest_bank WHERE character_id=?').get(id)?.items??'[]');
 function snapshot(c,p,z){
  if(!c)return null;
  const stored=items(c.id),available=!!z?.fixtures?.some(f=>f.kind==='bank'&&Math.abs(f.x-p.x)+Math.abs(f.y-p.y)<=1);
  const pages=Math.max(1,Math.ceil(stored.length/PAGE_SIZE)),page=Math.min(JSON.parse(c.state).bankPage??0,pages-1);
  return {capacity:BANK_CAPACITY,count:stored.length,available,page,pages,pageSize:PAGE_SIZE,items:available?stored.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE):[]};
 } // Only the owning character sees storage; send item payloads only while beside a bank.
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
   if(inventory.length>=hubData.config.inventory_capacity)fail('Inventory full. The item stays in your bank.');
   inventory.push(stored.splice(index,1)[0].item);
   importLoadout(state.loadout); // Reject a withdrawal that would exceed reconnect payload/complexity limits.
  }
  db.prepare('INSERT INTO quest_bank VALUES (?,?) ON CONFLICT(character_id) DO UPDATE SET items=excluded.items').run(c.id,JSON.stringify(stored));
 } // Storage, inventory, character revision and request receipt commit in the surrounding command transaction.
 return {snapshot,transfer};
}
