// Expand a small, revision-bound character update against the already committed loadout.
// This changes transport only: ordinary import, entitlement and inventory validation still run afterward.
const roots=new Set(['player_info','inventory','world','childish','player_spells','player_mp','player_mp_max','attack']);
const forbidden=new Set(['__proto__','prototype','constructor']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'loadout_conflict'});};
export const LOADOUT_DELTA_ACTIONS=new Set(['enter','dive_enter','loadout','world_turn','walk','hub_rest','use_item','turn_ready']);

export function expandLoadoutDelta(loadout,changes){
 if(!object(loadout)||!Array.isArray(changes)||changes.length>512||Buffer.byteLength(JSON.stringify(changes))>192*1024)fail('Invalid character changes.');
 const result=structuredClone(loadout); // Never mutate the saved character before the command transaction succeeds.
 for(const op of changes){
  if(!object(op)||!Array.isArray(op.path)||!op.path.length||op.path.length>17||!roots.has(op.path[0])||op.path.some(k=>typeof k!=='string'||forbidden.has(k)))fail('Invalid character field.');
  if(op.path.length===1&&op.path[0]==='inventory'&&Number.isSafeInteger(op.index)){
   if(object(op.fields)){
    const item=result.inventory?.[op.index];
    if(op.index<0||!object(item)||Object.keys(op.fields).length>512)fail('Invalid inventory fields.');
    for(const [key,change] of Object.entries(op.fields)){
     if(forbidden.has(key)||!object(change)||!same(Object.hasOwn(item,key)?item[key]:null,change.before))fail('This inventory changed; refresh before continuing.');
     if(change.remove===true)delete item[key];
     else {if(!Object.hasOwn(change,'after'))fail('Missing inventory field value.');item[key]=structuredClone(change.after);}
    }
    continue; // Runtime defaults and garment changes do not resend unchanged item descriptions.
   }
   if(!Array.isArray(op.before)||!Array.isArray(op.after)||op.index<0||op.index>result.inventory.length||op.index+op.before.length>result.inventory.length||!same(result.inventory.slice(op.index,op.index+op.before.length),op.before))fail('This inventory changed; refresh before continuing.');
   result.inventory.splice(op.index,op.before.length,...structuredClone(op.after));continue; // One used item is one splice, even when the rest of the bag is large.
  }
  let dest=result;
  for(const key of op.path.slice(0,-1)){if(!Object.hasOwn(dest,key)||!object(dest[key]))fail('This character field changed; refresh before continuing.');dest=dest[key];}
  const key=op.path.at(-1);
  if(!same(Object.hasOwn(dest,key)?dest[key]:null,op.before))fail('This character field changed; refresh before continuing.');
  if(op.remove===true)delete dest[key];
  else {if(!Object.hasOwn(op,'after'))fail('Missing character field value.');dest[key]=structuredClone(op.after);} // Replacements are exact; replay receipts and revision checks prevent applying a turn twice.
 }
 return result;
}
