import {craftingCatalog} from './crafting.mjs';
import {currentCraftingData} from './crafting-store.mjs';
import {addToInventory,stackable,stackLimit} from './loadout.mjs';

export function deliverCraftingRewards(c,state,origins){
 const pending=state.pendingCraftingMaterials;if(!pending||!state.loadout||state.run||state.pendingPurchase)return;
 const catalog=craftingCatalog(currentCraftingData()),bag=state.loadout.inventory;
 for(const [id,count] of Object.entries(pending)){
  const definition=catalog[id];if(!definition)continue;
  let left=count;
  while(left>0){
   const room=bag.length<512||stackable(definition)&&bag.some(row=>row.item_id===id&&stackable(row)&&(row.quantity??1)<stackLimit(definition,512));
   if(!room)break;
   const item=structuredClone(definition);addToInventory(bag,origins?origins.mint(c.id,item):item);left--;
  }
  if(left)pending[id]=left;else delete pending[id];
 }
 if(Object.keys(pending).length)state.hubNotice='Earned crafting materials are waiting for inventory space. They arrive automatically after you make room.';
 else delete state.pendingCraftingMaterials;
} // Deferred rewards stay in authoritative character state; origins are issued only when delivery fits.

export function queueCraftingRewards(c,state,drops,origins){
 state.pendingCraftingMaterials??={};
 for(const [id,count] of Object.entries(drops))state.pendingCraftingMaterials[id]=(state.pendingCraftingMaterials[id]??0)+count;
 const run=state.run;state.run=null;try{deliverCraftingRewards(c,state,origins);}finally{state.run=run;}
} // Settlement may still hold its finished run while it delivers the bundle.
