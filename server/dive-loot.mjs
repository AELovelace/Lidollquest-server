import {seeded} from './dive-generation.mjs';
import {createEnchanter} from './enchantment.mjs';
import {createLootRoller} from './loot.mjs';

const plainPanties=item=>item?.category==='panties'&&!item.is_diaper;
export function createDiveLootRoller(data,{enchantments=null,table=data.enchantments,loot=null,lootTable=data.loot??null}={}){
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
 let lootCache={revision:null,roller:createLootRoller(lootTable)};
 const lootRoller=()=>{
  if(!loot)return lootCache.roller;
  const revision=loot.revision();
  if(revision!==lootCache.revision)lootCache={revision,roller:createLootRoller(loot.apply(lootTable))};
  return lootCache.roller;
 };
 const routeKey=data.config.zone_id??data.config.route??'default';
 return function roll(edition,character,chest,rolls,depth=1){
  if(rolls[chest.id])return structuredClone(rolls[chest.id]); // Preserve receipts and older rolls even when previous tuning allowed more panties.
  const key=`${data.config.route}:${edition}:${depth}:${character}:${chest.id}`,rnd=seeded(key);
  const pool=chest.kind==='food'?data.food_pool:chest.kind==='potion'?data.potion_pool:general;
  let item=structuredClone(data.items[pool[rnd(pool.length)]]);
  if(plainPanties(item)&&Object.values(rolls).filter(plainPanties).length>=limit){
   item=structuredClone(data.items[diapers[seeded(key+':diaper-replacement')(diapers.length)]]);
  } // Chests and loose treasure share one personal floor allowance; excess panty rolls become existing diapers.
  if(item.atk_min!==undefined){item.atk=item.atk_min+rnd(item.atk_max-item.atk_min+1);if(typeof item.desc==='string')item.desc=item.desc.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
  const roller=lootRoller();
 roller.roll(item,key,{level:roller.routeLevel(routeKey,depth,chest.level),luck:chest.luck??'chest'}); // Rarity tier, item level, scaled stats, affixes and the new name (loot.mjs).
 enchanter()(item,key,roller.enchantMods(item)); // Two rarity-scaled ramps decide a curse, a blessing or nothing at all for this copy; the loot tier may double or force a blessing.
  return item; // All other loot retains its original seeded selection and stat roll.
 };
}
