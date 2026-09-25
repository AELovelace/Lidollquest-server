import {seeded} from './dive-generation.mjs';
import {createEnchanter} from './enchantment.mjs';
import {createLootRoller} from './loot.mjs';

const plainPanties=item=>item?.category==='panties'&&!item.is_diaper;
// Alchemy ingredient bundles (2026-09-24): a chest may also hold a bundle of ONE ingredient, on top of its item.
// Same table and maths as alchemy_chest_roll() in scrLootChestSystem.gml, but seeded from the chest's own key so a
// reconnect or duplicate command always finds the same bundle. `alchemy` is dive-data.json's {chest_loot, ingredients}.
export function rollIngredient(alchemy,zoneId,key){
 const table=alchemy?.chest_loot,items=alchemy?.ingredients??{};if(!table)return null; // no table shipped: no bundles
 const rnd=seeded(key+':ingredient'); // its own stream, so the chest's item roll is untouched
 if(rnd(10000)>=Math.round((Number(table.chance)||0)*100))return null; // most chests hold only their item
 const zone=table.online_zones?.[zoneId],list=v=>Array.isArray(v)?v:[];
 const ids=[...new Set([...list(table.zones?.[zone]),...list(table.everywhere)])].filter(id=>items[id]?.category==='ingredient'); // unknown routes fall back to "everywhere" only
 const tier=id=>Math.min(5,Math.max(1,Math.floor(Number(items[id].alchemy?.tier)||1)));
 const weights=ids.map(id=>Math.max(0,Number(table.tier_weights?.[String(tier(id))])||0)),total=weights.reduce((a,b)=>a+b,0);if(total<=0)return null;
 let left=rnd(1000000)/1000000*total,pick=ids.length-1;for(let i=0;i<ids.length;i++){left-=weights[i];if(left<0){pick=i;break;}} // weighted by tier: herbs often, star shards rarely
 const min=Math.max(1,Math.floor(Number(table.qty_min)||1)),max=Math.max(min,Math.floor(Number(table.qty_max)||min));
 const quantity=tier(ids[pick])>=(Number(table.single_from_tier)||99)?1:min+rnd(max-min+1); // rare ingredients always come alone
 return {...structuredClone(items[ids[pick]]),quantity};
}

export function createDiveLootRoller(data,{enchantments=null,table=data.enchantments,loot=null,lootTable=data.loot??null,lootBases=data.bases??null,alchemy=data.alchemy??null,alchemyStore=null,alchemyZone=data.config.zone_id??data.config.route}={}){
 const limit=data.config.non_diaper_panties_per_floor??1;
 if(!Number.isInteger(limit)||limit<0||limit>99)throw Error('Online non-diaper panties per floor must be an integer from 0 to 99.');
 const general=data.item_pool??Object.keys(data.items).sort();
 const diapers=general.filter(id=>data.items[id]?.category==='panties'&&data.items[id].is_diaper&&!data.items[id].quest_item);
 if(general.some(id=>plainPanties(data.items[id]))&&!diapers.length)throw Error('Online panty replacement needs at least one diaper in the loot pool.');
 // Shared 50-curse / 50-blessing table, exported alongside the item catalog. When
 // a gamemaster store is supplied, its live overrides are layered on top and the
 // enchanter is rebuilt whenever they change, so a /gm edit lands on the next
 // chest without a restart. Already-claimed rolls are served from the visit's own
 // receipts below, so retuning never rewrites loot a player has in hand.
 let cache={revision:null,enchant:createEnchanter(table)};
 const enchanter=()=>{
  if(!enchantments)return cache.enchant;
  const revision=enchantments.revision();
  if(revision!==cache.revision)cache={revision,enchant:createEnchanter(enchantments.apply(table))};
  return cache.enchant;
 };
 // Adjective + Item + Rarity: the same live-override pattern for the loot table, so a
 // /gm retune of rarity weights or a new affix lands on the next chest too.
 let lootCache={revision:null,roller:createLootRoller(lootTable,lootBases)};
 const lootRoller=()=>{
  if(!loot)return lootCache.roller;
  const revision=loot.revision();
  if(revision!==lootCache.revision)lootCache={revision,roller:createLootRoller(loot.apply(lootTable),loot.applyBases(lootBases))};
  return lootCache.roller;
 };
 const routeKey=data.config.zone_id??data.config.route??'default';
 function roll(edition,character,chest,rolls,depth=1){
  if(rolls[chest.id])return structuredClone(rolls[chest.id]); // Preserve receipts and older rolls even when previous tuning allowed more panties.
  const key=`${data.config.route}:${edition}:${depth}:${character}:${chest.id}`,rnd=seeded(key);
  const preferred=data.priority_pool?.length&&rnd(100)<(data.campaign?.loot_priority_chance??0)?data.priority_pool:general;
  const pool=chest.item_id?[chest.item_id]:chest.loot_pool??(chest.kind==='food'?data.food_pool:chest.kind==='potion'?data.potion_pool:preferred);
  let item=structuredClone(data.items[pool[rnd(pool.length)]]);
  if(plainPanties(item)&&Object.values(rolls).filter(plainPanties).length>=limit){
   item=structuredClone(data.items[diapers[seeded(key+':diaper-replacement')(diapers.length)]]);
  } // Chests and loose treasure share one personal floor allowance; excess panty rolls become existing diapers.
  if(item.atk_min!==undefined){item.atk=item.atk_min+rnd(item.atk_max-item.atk_min+1);if(typeof item.desc==='string')item.desc=item.desc.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
  const roller=lootRoller();
 item=roller.roll(item,key,{level:roller.routeLevel(routeKey,depth,chest.level),luck:chest.luck??'chest'}); // Rarity tier, item level, scaled stats, affixes and the new name (loot.mjs).
 enchanter()(item,key,roller.enchantMods(item)); // Two rarity-scaled ramps decide a curse, a blessing or nothing at all for this copy; the loot tier may double or force a blessing.
  return item; // All other loot retains its original seeded selection and stat roll.
 };
 let alchemyCache={revision:null,table:alchemy};
 const liveAlchemy=()=>{ // /gm Alchemy overrides (alchemy-store.mjs) reach the next claim; re-merged only when they change.
  if(!alchemyStore||!alchemy)return alchemy;
  const revision=alchemyStore.revision();
  if(revision!==alchemyCache.revision)alchemyCache={revision,table:alchemyStore.apply(alchemy)};
  return alchemyCache.table;
 };
 roll.ingredient=(edition,character,chest,depth=1)=>rollIngredient(liveAlchemy(),alchemyZone,`${data.config.route}:${edition}:${depth}:${character}:${chest.id}`); // the chest's bundle, or null
 return roll;
}
