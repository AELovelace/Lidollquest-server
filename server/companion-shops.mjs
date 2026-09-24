import {createHash} from 'node:crypto';
import {seeded} from './dive-generation.mjs';
import {rarityConfig} from './loot.mjs';
import {BANK_CAPACITY} from './bank.mjs';

// Diaper Atelier and Clothes Emporium: paid gacha rolls a player makes from the tracker's
// LidollQuest companion. Each roll is a generated base (a style dressing a garment,
// loot.mjs createBaseGenerator) put through the same rarity + affix roller as chests
// and hub stock, so a gamemaster tunes it in the /gm Loot tab:
//   * price     atelier_price / emporium_price
//   * odds      luck profile `atelier` / `emporium` (missing: the plain rarity weights)
//   * level     shop_levels.atelier / .emporium clamps the character's level (missing: default)
// The roll is fixed when the purchase is reserved, so a retried payment can never re-roll.
// Payment runs through the existing durable hub_purchases debit; delivery mints a resale
// right capped at the price paid and stores the item in the chosen character's bank.

export const COMPANION_SHOPS=Object.freeze({
 atelier:Object.freeze({id:'atelier',name:'Diaper Atelier',diaper:true}),
 emporium:Object.freeze({id:'emporium',name:'Clothes Emporium',diaper:false}), // Every other generated garment, diaper covers included.
});
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

 function odds(shop,live){ // The exact weights pickRarity() uses, as percentages.
  const luck=live.tuning.luck_profiles?.[shop.id]??{};
  const weights=live.order.map(tier=>[tier,Math.max(0,rarityConfig(live.tuning,tier).weight*num(luck[tier],1))]);
  const total=weights.reduce((sum,[,w])=>sum+w,0)||1;
  return weights.map(([tier,w])=>({rarity:tier,chance:Math.round(w/total*10000)/100,colour:rarityConfig(live.tuning,tier).colour}));
 }

 function rollView(item,live){ // The reveal: rolled name, tier, level and stat lines, never the raw struct.
  const tier=item.loot?.rarity??item.rarity??'common',stats={};
  for(const key of VIEW_STATS)if(Number.isFinite(item[key])&&item[key]!==0)stats[key]=item[key];
  return {item_id:String(item.item_id??''),name:String(item.name??item.item_id).slice(0,96),category:String(item.category??''),rarity:tier,colour:rarityConfig(live.tuning,tier).colour,
   ilvl:item.loot?.ilvl??null,desc:String(item.desc??'').slice(0,400),is_diaper:item.is_diaper===true,stats,value:num(item.value,0),sell:num(item.online_sell_price,0)};
 }

 function roll(shop,key,state){
  const live=roller(),rows=stock(shop,live);
  if(!rows.length)fail(shop.name+' has nothing to roll right now.',503,'shop_unavailable');
  const rnd=seeded(key+':pick'),total=rows.reduce((sum,[,w])=>sum+w,0);
  let pick=rnd(1000000)/1000000*total,category=rows.at(-1)[0];
  for(const [cat,weight] of rows){pick-=weight;if(pick<0){category=cat;break;}}
  const list=templatesFor(category,shop.diaper),template=structuredClone(list[rnd(list.length)]);
  return live.roll(template,key,{level:live.shopLevel(shop.id,level(state)),luck:shop.id}); // Same style + garment generator and affix roller as chest loot.
 }

 return {
  view(c,state){ // Shown by the companion: prices, odds, room left and the last roll's outcome.
   const live=roller();
   const last=state.shopRoll?{...state.shopRoll,...(state.shopRoll.bank_item?{in_bank:bank.has(c,state.shopRoll.bank_item)}:{})}:null; // in_bank: whether the reveal can still offer Sell / Wear now.
   return {bankFree:Math.max(0,BANK_CAPACITY-bank.count(c)),pending:Boolean(state.pendingPurchase),last,
    shops:Object.values(COMPANION_SHOPS).map(shop=>({id:shop.id,name:shop.name,price:price(shop,live),available:stock(shop,live).length>0,odds:odds(shop,live)}))};
  },
  prepare(i,c,state,input){
   const shop=Object.hasOwn(COMPANION_SHOPS,input.shop)?COMPANION_SHOPS[input.shop]:fail('Choose the Diaper Atelier or the Clothes Emporium.',400,'shop_invalid');
   if(state.run)fail('Leave combat before shopping.');
   if(bank.count(c)>=BANK_CAPACITY)fail('Bank full (512 items). Sell or withdraw something first. No coins were charged.');
   const live=roller(),cost=price(shop,live);
   if(input.price!==cost)fail('The price changed to '+cost+' LiDollCoins. Review it and roll again.',409,'price_changed'); // The player confirms the amount they will be charged.
   const id=createHash('sha256').update(c.id+':'+input.request_id).digest('hex');
   const item=roll(shop,'companion-shop:'+id,state);
   db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,i.owner,c.id,JSON.stringify({companion_shop:shop.id,item}),cost);
   state.pendingPurchase=id;state.shopRoll={id,shop:shop.id,status:'pending',price:cost}; // Nothing is revealed until the debit settles.
  },
  deliver(id,char,state,paid,cost,reservation){ // hub_purchases complete() hook: one transaction with the purchase status and character revision.
   const shop=COMPANION_SHOPS[reservation.companion_shop];
   if(!paid){state.shopRoll={id,shop:shop.id,status:'declined',price:cost};state.hubNotice='Not enough LiDollCoins. Nothing was rolled.';return;}
   const item=origins.mint(char.id,reservation.item,cost),entry=bank.deposit(char,item); // Resale right = min(price paid, half the rolled value).
   state.shopRoll={id,shop:shop.id,status:'delivered',price:cost,bank_item:entry.id,item_instance:item.online_item??null,item:rollView(item,roller())}; // item_instance: the sale right bank_sell expects.
   state.hubNotice=shop.name+': '+state.shopRoll.item.name+' was sent to your bank.';
  },
 };
}
