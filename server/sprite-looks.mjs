// Sprite Lab looks: the one validator for every layered appearance (shopkeepers today, player looks next) and the
// account-wide accessory unlocks. Accessories are the catalog slots flagged accessory:true (head, face, neck, back):
// a look may wear at most accessory_limit of them (3), and each one must be unlocked first for one diamond.
import {createHash} from 'node:crypto';
import {craftingData} from './crafting.mjs';

export const lookCatalog=()=>craftingData.sprite_lab; // Exported from the game's layered_sprite_lab.json by python/export_crafting.py.
export const accessorySlots=(catalog=lookCatalog())=>new Set((catalog.slots??[]).filter(s=>s.accessory).map(s=>s.id));
export const UNLOCK_DIAMONDS=1; // settlePurchases debits exactly one diamond per diamond reservation, so the price is fixed here.

export function validateLook(input,{unlocked=null,fail=message=>{throw Object.assign(Error(message),{status:400,code:'look_invalid'});}}={}){
 // unlocked: a Set of accessory ids this account owns, or null to skip the ownership check (GM previews never save).
 const integer=(v,min,max,label)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(label+' must be between '+min+' and '+max+'.');return v;};
 if(!input||input.version!==1||!input.slots)fail('Design a look in the wardrobe first.');
 const catalog=lookCatalog(),accessories=accessorySlots(catalog),limit=catalog.accessory_limit??3;
 const out={version:1,slots:{},colors:{},strength:{},enabled:{},visible:{},facing:integer(input.facing??0,0,3,'Direction')};
 let worn=0;
 for(const slot of catalog.order){
  const id=input.slots[slot]??'',asset=catalog.assets.find(a=>a.id===id&&a.slot===slot);
  if(!asset){if(slot==='base'||id)fail('Unsupported look layer.');out.slots[slot]='';out.colors[slot]=[];out.strength[slot]=[];out.enabled[slot]=[];out.visible[slot]=true;continue;}
  if(accessories.has(slot)){
   worn++;if(worn>limit)fail(`You can wear up to ${limit} accessories at once.`);
   if(unlocked&&!unlocked.has(id))fail(`Unlock ${asset.name} (1 diamond) before wearing it.`);
  }
  out.slots[slot]=id;out.visible[slot]=slot==='base'||input.visible?.[slot]!==false;
  out.colors[slot]=asset.channels.map((c,i)=>{const rgb=input.colors?.[slot]?.[i]??c.default_rgb??[255,255,255];if(!Array.isArray(rgb)||rgb.length!==3)fail('Choose valid RGB colours.');return rgb.map(v=>integer(v,0,255,'Colour'));});
  out.strength[slot]=asset.channels.map((_,i)=>{const n=input.strength?.[slot]?.[i]??1;if(!Number.isFinite(n)||n<0||n>1)fail('Invalid tint strength.');return n;});
  out.enabled[slot]=asset.channels.map((_,i)=>input.enabled?.[slot]?.[i]===true);
 }
 return out;
} // Only registered layers and numeric tint channels are published; no client asset URLs or shader code.

export function createLookUnlocks(db,{now=Date.now}={}){
 db.exec('CREATE TABLE IF NOT EXISTS look_unlocks(owner TEXT NOT NULL,asset TEXT NOT NULL,created INTEGER NOT NULL,purchase TEXT NOT NULL,PRIMARY KEY(owner,asset))');
 const fail=(message,status=409)=>{throw Object.assign(Error(message),{status,code:'look_unlock_failed'});};
 const list=owner=>db.prepare('SELECT asset FROM look_unlocks WHERE owner=? ORDER BY asset').all(owner).map(r=>r.asset); // Account-wide: every character shares the collection.
 function prepare(i,char,state,input){ // Reserve a one-diamond purchase; settle() grants the unlock once the wallet debit lands.
  const catalog=lookCatalog(),asset=catalog.assets.find(a=>a.id===input.asset);
  if(!asset||!accessorySlots(catalog).has(asset.slot))fail('Only accessories are unlocked with diamonds.',400);
  if(list(i.owner).includes(asset.id))fail(`You already own ${asset.name}.`);
  if(state.pendingPurchase)fail('Finish your current purchase first.');
  const id=createHash('sha256').update(char.id+':'+input.request_id).digest('hex'); // Same durable id scheme as every hub purchase.
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,char.id,JSON.stringify({look_unlock:asset.id,name:asset.name,currency:'diamonds'}),UNLOCK_DIAMONDS);
  state.pendingPurchase=id;state.hubNotice=`Unlocking ${asset.name}…`;state.hubNoticeAt=now();
 }
 function prepareSave(i,char,state,input,look){ // Away from a mirror a new look costs one diamond; the validated look waits in the reservation.
  if(state.pendingPurchase)fail('Finish your current purchase first.');
  const id=createHash('sha256').update(char.id+':'+input.request_id).digest('hex');
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,char.id,JSON.stringify({look_save:true,look,name:'new look',currency:'diamonds'}),UNLOCK_DIAMONDS);
  state.pendingPurchase=id;state.hubNotice='Saving your new look…';state.hubNoticeAt=now();
 }
 function settle(id,char,state,paid,price,item){ // purchaseHooks.lookUnlock, inside hubs.mjs complete()'s transaction.
  if(item.look_save){if(paid){state.look=item.look;state.avatar='look';}state.hubNotice=paid?`New look saved for ${price} diamond. Hub mirrors are free.`:'Not enough diamonds. Your look did not change.';state.hubNoticeAt=now();return;} // A paid wardrobe save.
  if(paid)db.prepare('INSERT OR IGNORE INTO look_unlocks VALUES (?,?,?,?)').run(char.owner,item.look_unlock,now(),id);
  state.hubNotice=paid?`Unlocked ${item.name} for ${price} diamond. Every character on this account can wear it.`:'Not enough diamonds. Nothing was charged.';state.hubNoticeAt=now();
 }
 return {list,prepare,prepareSave,settle,set:owner=>new Set(list(owner))};
}
