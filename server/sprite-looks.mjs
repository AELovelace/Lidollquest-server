// Sprite Lab looks: the one validator for every layered appearance (shopkeepers today, player looks next) and the
// account-wide unlocks. Accessories are the catalog slots flagged accessory:true (head, face, neck, back):
// a look may wear at most accessory_limit of them (3), and each one must be unlocked first for one diamond.
// Assets flagged premium:true (any slot: hair, clothes, shoes) need the same one-diamond unlock but no slot limit.
import {createHash} from 'node:crypto';
import {craftingData} from './crafting.mjs';
import {validateSpriteLook} from './sprite-look-validation.mjs';
import {spriteWorkshop} from './sprite-workshop.mjs';

export const lookCatalog=db=>db?spriteWorkshop(db).catalog():craftingData.sprite_lab; // DB-scoped published art supplements the bundled catalog; tests never share mutable catalogs.
export const accessorySlots=(catalog=lookCatalog())=>new Set((catalog.slots??[]).filter(s=>s.accessory).map(s=>s.id));
export const needsUnlock=(asset,accessories=accessorySlots())=>accessories.has(asset.slot)||asset.premium===true; // Every accessory, plus premium items in ordinary slots.
export const UNLOCK_DIAMONDS=1; // settlePurchases debits exactly one diamond per diamond reservation, so the price is fixed here.

export function validateLook(input,options={}){return validateSpriteLook(input,lookCatalog(options.db),options);} // Keep every server caller on the same catalog and validation rules.

export function createLookUnlocks(db,{now=Date.now}={}){
 db.exec('CREATE TABLE IF NOT EXISTS look_unlocks(owner TEXT NOT NULL,asset TEXT NOT NULL,created INTEGER NOT NULL,purchase TEXT NOT NULL,PRIMARY KEY(owner,asset))');
 const fail=(message,status=409)=>{throw Object.assign(Error(message),{status,code:'look_unlock_failed'});};
 const list=owner=>[...db.prepare('SELECT asset FROM look_unlocks WHERE owner=? ORDER BY asset').all(owner).map(r=>r.asset),...spriteWorkshop(db).owned(owner)]; // Personal published art belongs to every character on its creator's account.
 function prepare(i,char,state,input){ // Reserve a one-diamond purchase; settle() grants the unlock once the wallet debit lands.
  const catalog=lookCatalog(db),asset=catalog.assets.find(a=>a.id===input.asset);
  if(!asset||!needsUnlock(asset,accessorySlots(catalog)))fail('Only accessories and premium items are unlocked with diamonds.',400);
  if(list(i.owner).includes(asset.id))fail(`You already own ${asset.name}.`);
  if(state.pendingPurchase)fail('Finish your current purchase first.');
  const id=createHash('sha256').update(char.id+':'+input.request_id).digest('hex'); // Same durable id scheme as every hub purchase.
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,char.id,JSON.stringify({look_unlock:asset.id,name:asset.name,currency:'diamonds'}),UNLOCK_DIAMONDS);
  state.pendingPurchase=id;state.hubNotice=`Unlocking ${asset.name}…`;state.hubNoticeAt=now();
 }
 function prepareAccount(i,input){ // The creation wardrobe: no character exists yet, so the reservation belongs to the account alone (character_id '').
  const id=createHash('sha256').update(i.owner+':'+input.request_id).digest('hex');
  if(db.prepare('SELECT 1 FROM hub_purchases WHERE id=?').get(id))return; // A retried request keeps its first reservation.
  const catalog=lookCatalog(db),asset=catalog.assets.find(a=>a.id===input.asset);
  if(!asset||!needsUnlock(asset,accessorySlots(catalog)))fail('Only accessories and premium items are unlocked with diamonds.',400);
  if(list(i.owner).includes(asset.id))fail(`You already own ${asset.name}.`);
  if(db.prepare("SELECT 1 FROM hub_purchases WHERE owner=? AND character_id='' AND status='pending'").get(i.owner))fail('Finish your current purchase first.');
  db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,'',JSON.stringify({look_unlock:asset.id,name:asset.name,currency:'diamonds'}),UNLOCK_DIAMONDS);
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
  if(!state)return; // An account-level unlock (prepareAccount) has no character to notify; the snapshot's lookUnlocks shows the result.
  state.hubNotice=paid?`Unlocked ${item.name} for ${price} diamond. Every character on this account can wear it.`:'Not enough diamonds. Nothing was charged.';state.hubNoticeAt=now();
 }
 return {list,prepare,prepareAccount,prepareSave,settle,set:owner=>new Set(list(owner))};
}
