import {seeded} from './dive-generation.mjs';

const plainPanties=item=>item?.category==='panties'&&!item.is_diaper;
export function createDiveLootRoller(data){
 const limit=data.config.non_diaper_panties_per_floor??1;
 if(!Number.isInteger(limit)||limit<0||limit>99)throw Error('Online non-diaper panties per floor must be an integer from 0 to 99.');
 const general=data.item_pool??Object.keys(data.items).sort();
 const diapers=general.filter(id=>data.items[id]?.category==='panties'&&data.items[id].is_diaper&&!data.items[id].quest_item);
 if(general.some(id=>plainPanties(data.items[id]))&&!diapers.length)throw Error('Online panty replacement needs at least one diaper in the loot pool.');
 return function roll(edition,character,chest,rolls,depth=1){
  if(rolls[chest.id])return structuredClone(rolls[chest.id]); // Preserve receipts and older rolls even when previous tuning allowed more panties.
  const key=`${data.config.route}:${edition}:${depth}:${character}:${chest.id}`,rnd=seeded(key);
  const pool=chest.kind==='food'?data.food_pool:chest.kind==='potion'?data.potion_pool:general;
  let item=structuredClone(data.items[pool[rnd(pool.length)]]);
  if(plainPanties(item)&&Object.values(rolls).filter(plainPanties).length>=limit){
   item=structuredClone(data.items[diapers[seeded(key+':diaper-replacement')(diapers.length)]]);
  } // Chests and loose treasure share one personal floor allowance; excess panty rolls become existing diapers.
  if(item.atk_min!==undefined){item.atk=item.atk_min+rnd(item.atk_max-item.atk_min+1);if(typeof item.desc==='string')item.desc=item.desc.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
  return item; // All other loot retains its original seeded selection and stat roll.
 };
}
