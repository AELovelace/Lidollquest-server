// Below-blue items carry a bounded sale count instead of per-unit resale UUIDs in character data.
export const itemRarity=item=>item?.loot?.rolled===true?item.loot.rarity:(item?.rarity??item?.loot?.rarity??'common');
export const compactIdentity=item=>!!item&&['common','uncommon'].includes(itemRarity(item));
export function compactItemIdentities(value,depth=0){
 if(!value||typeof value!=='object')return value;
 if(depth>20)throw Object.assign(Error('Character data is too complex.'),{status:400,code:'invalid_loadout'}); // Bound the migration walk before ordinary depth-16 import validation.
 if(typeof value.item_id==='string'&&compactIdentity(value)){
  const count=Array.isArray(value.online_items)?value.online_items.length:value.online_item?1:0;
  if(count)value.online_sale_quantity=Math.min(Math.max(1,Number(value.quantity)||1),count);
  delete value.online_item;delete value.online_items;
 }
 for(const child of Object.values(value))if(child&&typeof child==='object')compactItemIdentities(child,depth+1);
 return value; // Mutate only the caller's copy; generated stats, quantities, prices and high-rarity identities survive.
}
