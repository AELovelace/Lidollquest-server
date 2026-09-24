import {createHash} from 'node:crypto';
import {seeded} from './dive-generation.mjs';
import {rarityConfig,RARITY_ORDER} from './loot.mjs';
import {BANK_CAPACITY} from './bank.mjs';

// Diaper Atelier and Clothes Emporium: paid gacha rolls a player makes from the tracker's
// LidollQuest companion. Each roll is a generated base (a style dressing a garment,
// loot.mjs createBaseGenerator) put through the same rarity + affix roller as chests
// and hub stock, so a gamemaster tunes it in the /gm Loot tab:
//   * price     atelier_price / emporium_price
//   * odds      luck profile `atelier` / `emporium` (missing: the plain rarity weights)
//   * level     shop_levels.atelier / .emporium clamps the character's level (missing: default)
// Diamond roll mode (input.mode 'diamond'): exactly one diamond (the wallet's diamond debit only
// ever moves one), never below the `diamond_roll_floor` rarity (default rare), weighted by the
// `atelier_diamond` / `emporium_diamond` luck profiles, and paid through the same durable
// hub_purchases row with currency:'diamonds' (service.mjs settlePurchases). It needs the
// diamonds:write consent scope, like private sprites. The reveal resells for half its value.
// The roll is fixed when the purchase is reserved, so a retried payment can never re-roll.
// Payment runs through the existing durable hub_purchases debit; delivery mints a resale
// right capped at the price paid and stores the item in the chosen character's bank.

export const COMPANION_SHOPS=Object.freeze({
 atelier:Object.freeze({id:'atelier',name:'Diaper Atelier',diaper:true}),
 emporium:Object.freeze({id:'emporium',name:'Clothes Emporium',diaper:false}), // Every other generated garment, diaper covers included.
});
export const DIAMOND_PRICE=1; // The wallet API validates diamond debits as exactly one diamond (wallet.mjs diamonds()), so the premium roll cannot be priced otherwise.
const VIEW_STATS=['atk','def','bulk','bulk_threshold','childish','wet_resist','tum_resist','hp_regen','atk_mod','def_mod','dex_mod','int_mod','cha_mod','hp_max_mod','shame_delta'];
const fail=(message,status=409,code='shop_conflict')=>{throw Object.assign(Error(message),{status,code});};
const num=(value,fallback)=>Number.isFinite(Number(value))&&value!==null&&value!==''&&typeof value!=='boolean'?Number(value):fallback;

export function createCompanionShops(db,{roller,templates,bank,origins,level}){
 const pools=new Map(); // Template lists per category and diaper flag; the equipment catalog is static for the process.
 const templatesFor=(category,diaper)=>{
  const key=category+':'+diaper;
  if(!pools.has(key))pools.set(key,Object.values(templates).filter(item=>item?.pool_template===true&&!item.quest_item&&item.category===category&&(item.is_diaper===true)===diaper));
  return pools.get(key);
 };
 const stock=(shop,live)=>[...live.generator.pool(shop.diaper)].filter(([category])=>templatesFor(category,shop.diaper).length); // [category, weight] a roll can land on.
 const price=(shop,live)=>Math.max(1,Math.floor(num(live.tuning[shop.id+'_price'],3)));
 const floorIndex=live=>Math.max(0,Math.min(RARITY_ORDER.length-1,Math.floor(num(live.tuning.diamond_roll_floor,2)))); // diamond_roll_floor as a tier index, clamped
 const luckFor=(shop,mode,live)=>mode==='diamond'&&live.tuning.luck_profiles?.[shop.id+'_diamond']?shop.id+'_diamond':shop.id; // Diamond rolls prefer their own luck profile, else the shop's.
 const modeOf=input=>input.mode===undefined||input.mode==='coins'?'coins':input.mode==='diamond'?'diamond':fail('Choose a coin roll or a diamond roll.',400,'shop_invalid');

 function odds(shop,live,mode='coins'){ // The exact weights pickRarity() uses, as percentages; diamond rolls zero every tier below the floor.
  const luck=live.tuning.luck_profiles?.[luckFor(shop,mode,live)]??{},low=mode==='diamond'?floorIndex(live):0;
  const weights=live.order.map((tier,i)=>[tier,i<low?0:Math.max(0,rarityConfig(live.tuning,tier).weight*num(luck[tier],1))]);
  const total=weights.reduce((sum,[,w])=>sum+w,0)||1;
  return weights.map(([tier,w])=>({rarity:tier,chance:Math.round(w/total*10000)/100,colour:rarityConfig(live.tuning,tier).colour}));
 }

 function rollView(item,live){ // The reveal: rolled name, tier, level and stat lines, never the raw struct.
  const tier=item.loot?.rarity??item.rarity??'common',stats={};
  for(const key of VIEW_STATS)if(Number.isFinite(item[key])&&item[key]!==0)stats[key]=item[key];
  return {item_id:String(item.item_id??''),name:String(item.name??item.item_id).slice(0,96),category:String(item.category??''),rarity:tier,colour:rarityConfig(live.tuning,tier).colour,
   ilvl:item.loot?.ilvl??null,desc:String(item.desc??'').slice(0,400),is_diaper:item.is_diaper===true,stats,value:num(item.value,0),sell:num(item.online_sell_price,0)};
 }

 function roll(shop,key,state,mode='coins'){ // `mode`: 'coins' (shop price, plain weights) or 'diamond' (one diamond, rarity floor).
  const live=roller(),rows=stock(shop,live);
  if(!rows.length)fail(shop.name+' has nothing to roll right now.',503,'shop_unavailable');
  const rnd=seeded(key+':pick'),total=rows.reduce((sum,[,w])=>sum+w,0);
  let pick=rnd(1000000)/1000000*total,category=rows.at(-1)[0];
  for(const [cat,weight] of rows){pick-=weight;if(pick<0){category=cat;break;}}
  const list=templatesFor(category,shop.diaper),template=structuredClone(list[rnd(list.length)]);
  return live.roll(template,key,{level:live.shopLevel(shop.id,level(state)),luck:luckFor(shop,mode,live),floor:mode==='diamond'?floorIndex(live):0}); // Same style + garment generator and affix roller as chest loot.
 }

 return {
  view(c,state){ // Shown by the companion: prices, odds, room left and the last roll's outcome.
   const live=roller();
   const last=state.shopRoll?{...state.shopRoll,...(state.shopRoll.bank_item?{in_bank:bank.has(c,state.shopRoll.bank_item)}:{})}:null; // in_bank: whether the reveal can still offer Sell / Wear now.
   return {bankFree:Math.max(0,BANK_CAPACITY-bank.count(c)),pending:Boolean(state.pendingPurchase),last,
    shops:Object.values(COMPANION_SHOPS).map(shop=>({id:shop.id,name:shop.name,price:price(shop,live),available:stock(shop,live).length>0,odds:odds(shop,live),
     diamond:{price:DIAMOND_PRICE,floor:live.order[floorIndex(live)],odds:odds(shop,live,'diamond')}}))}; // diamond: the 1-diamond roll mode's price, rarity floor and odds.
  },
  prepare(i,c,state,input){
   const shop=Object.hasOwn(COMPANION_SHOPS,input.shop)?COMPANION_SHOPS[input.shop]:fail('Choose the Diaper Atelier or the Clothes Emporium.',400,'shop_invalid');
   if(state.run)fail('Leave combat before shopping.');
   const mode=modeOf(input);
   if(mode==='diamond'&&!String(i.scope??'').split(' ').includes('diamonds:write'))fail('Reconnect and approve diamond spending.',403,'insufficient_scope'); // Same consent gate as private sprites.
   if(bank.count(c)>=BANK_CAPACITY)fail('Bank full (512 items). Sell or withdraw something first. Nothing was charged.');
   const live=roller(),cost=mode==='diamond'?DIAMOND_PRICE:price(shop,live);
   if(input.price!==cost)fail(mode==='diamond'?'A diamond roll costs exactly 1 diamond. Review it and roll again.':'The price changed to '+cost+' LiDollCoins. Review it and roll again.',409,'price_changed'); // The player confirms the amount they will be charged.
   const id=createHash('sha256').update(c.id+':'+input.request_id).digest('hex');
   const item=roll(shop,'companion-shop:'+id,state,mode);
   db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,c.id,JSON.stringify({companion_shop:shop.id,...(mode==='diamond'?{currency:'diamonds'}:{}),item}),cost); // currency tells settlePurchases which wallet debit to run.
   state.pendingPurchase=id;state.shopRoll={id,shop:shop.id,mode,currency:mode==='diamond'?'diamonds':'coins',status:'pending',price:cost}; // Nothing is revealed until the debit settles.
  },
  deliver(id,char,state,paid,cost,reservation){ // hub_purchases complete() hook: one transaction with the purchase status and character revision.
   const shop=COMPANION_SHOPS[reservation.companion_shop],diamond=reservation.currency==='diamonds',mode=diamond?'diamond':'coins',currency=diamond?'diamonds':'coins';
   if(!paid){state.shopRoll={id,shop:shop.id,mode,currency,status:'declined',price:cost};state.hubNotice=diamond?'Not enough diamonds. Nothing was rolled.':'Not enough LiDollCoins. Nothing was rolled.';return;}
   const item=origins.mint(char.id,reservation.item,diamond?Infinity:cost),entry=bank.deposit(char,item); // Coin rolls: resale right = min(price paid, half the rolled value). Diamond rolls: half the rolled value, since a diamond has no coin price.
   state.shopRoll={id,shop:shop.id,mode,currency,status:'delivered',price:cost,bank_item:entry.id,item_instance:item.online_item??null,item:rollView(item,roller())}; // item_instance: the sale right bank_sell expects.
   state.hubNotice=shop.name+': '+state.shopRoll.item.name+' was sent to your bank.';
  },
 };
}
