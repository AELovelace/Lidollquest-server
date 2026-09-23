import {syncCrawl} from './crawl.mjs';
import {refreshMana} from './magic-balance.mjs';

const fail=message=>{throw Object.assign(Error(message),{status:400,code:'invalid_loadout'});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const currencies=new Set(['gold','coins','diamonds','wallet','balance','lidollcoins','lidollcoin']);
const number=(value,fallback,min=0,max=1000000)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;

export function importLoadout(input) { // Campaign data is intentionally client-trusted; bounds protect storage and transport, not competitive integrity.
 if(!object(input)||!object(input.player_info)||!Array.isArray(input.inventory)||input.inventory.length>512)fail('Send character stats and at most 512 inventory slots.');
 if(Buffer.byteLength(JSON.stringify(input))>192*1024)fail('Character data is too large.');
 let nodes=0;
 function copy(value,depth=0){
  if(++nodes>20000||depth>16)fail('Character data is too complex.');
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))fail('Character numbers must be finite.');return value;}
  if(Array.isArray(value))return value.map(v=>copy(v,depth+1));
  if(object(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!currencies.has(key.toLowerCase())&&!['__proto__','prototype','constructor'].includes(key)).map(([key,v])=>[key,copy(v,depth+1)]));
  fail('Unsupported character data.');
 }
 const result=copy({player_info:input.player_info,inventory:input.inventory,...(object(input.world)?{world:input.world}:{}),childish:number(input.childish,0,0,10),player_spells:input.player_spells??[],player_mp:input.player_mp??0,player_mp_max:input.player_mp_max??0,attack:input.attack??Math.max(1,number(input.player_info.str,0)*2)});
 const p=result.player_info;
 syncCrawl(result); // Create forced legacy stance before filling the client's required world fields.
 if(result.world){const w=result.world;result.world={turn_count:number(w.turn_count,0),crawling:w.crawling===true,wet_only_mode:w.wet_only_mode===true,pending_popup_turns:number(w.pending_popup_turns,0,0,10000),pending_popup_title:typeof w.pending_popup_title==='string'?w.pending_popup_title.slice(0,500):'',pending_popup_text:typeof w.pending_popup_text==='string'?w.pending_popup_text.slice(0,20000):''};} // Persist only known needs-runtime fields, never arbitrary global state.
 p.playerHealthMax=number(p.playerHealthMax,70,1);p.playerHealth=number(p.playerHealth,p.playerHealthMax,0,p.playerHealthMax);
 for(const key of ['str','def','dex','int','cha'])p[key]=number(p[key],0,-1000000); // Preserve campaign curse/equipment penalties as well as bonuses.
 p.level=number(p.level,1,1);p.xp=number(p.xp,0);
 result.attack=number(result.attack,Math.max(1,p.str*2),1); // The client includes its existing class damage multiplier.
 result.player_mp_max=number(result.player_mp_max,0);result.player_mp=number(result.player_mp,0,0,result.player_mp_max);
 refreshMana(result); // Mage capacity derives from INT, so old and new imports cannot double it repeatedly.
 if(!Array.isArray(result.player_spells)||result.player_spells.length>512||result.inventory.some(item=>!object(item)||typeof item.item_id!=='string'))fail('Invalid inventory or learned spells.');
 return result;
}

export function applyRunLoadout(run,loadout) { // Handicaps remain attached to this run when equipment or consumables change base stats.
 const p=loadout.player_info,weakened=run.handicaps.filter(h=>h==='Weakened strikes').length,vitality=run.handicaps.filter(h=>h==='Reduced vitality').length;
 run.maxHp=Math.max(1,p.playerHealthMax-vitality*5);run.hp=Math.min(run.maxHp,p.playerHealth);
 run.attack=Math.max(1,loadout.attack-weakened);run.defense=p.def-run.handicaps.filter(h=>h==='Reduced armor').length;run.level=p.level;
}

export function syncRunHealth(state,run) { // Save current HP without permanently applying temporary arena maximum-HP penalties.
 if(state.loadout)state.loadout.player_info.playerHealth=run.hp;
}

// ── Stacks: consumables and ammo share one bag entry with a quantity; only unstackable entries count toward the slot cap ──
export const stackable=item=>!!item&&typeof item==='object'&&(item.stackable===true||['food','drink','ammo'].includes(item.category)); // Same rule as inv_item_stackable() in scrInventory.gml.
export const slotsUsed=inventory=>(inventory??[]).filter(item=>!stackable(item)).length; // What "N / 99" counts: gear, quest items and other singles.
export function addToInventory(inventory,item,stackMax=512){ // Merge into an existing stack when the item stacks; otherwise append. Returns the entry that grew.
 if(stackable(item)){
  const max=Math.max(1,Math.floor(Number(item.stack_max)||stackMax)),add=Math.max(1,Math.floor(Number(item.quantity)||1));
  const stack=inventory.find(other=>stackable(other)&&other.item_id===item.item_id&&(other.online_item??null)===(item.online_item??null)&&(Number(other.quantity)||1)+add<=max); // Server-minted resale rights are per purchase, so a tracked unit only joins a stack with the same rights; campaign pickups merge freely.
  if(stack){stack.quantity=(Number(stack.quantity)||1)+add;return stack;}
  item.quantity=add;
 }
 inventory.push(item);return item;
}
export function takeFromStack(inventory,match,count=1){ // Consume `count` units from the first matching stack; the entry disappears at zero. Returns true when enough was there.
 const index=inventory.findIndex(item=>stackable(item)&&match(item));if(index<0)return false;
 const item=inventory[index],have=Math.max(1,Math.floor(Number(item.quantity)||1));if(have<count)return false;
 if(have===count)inventory.splice(index,1);else item.quantity=have-count;return true;
}
