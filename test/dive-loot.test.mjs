import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';
import {seeded} from '../server/dive-generation.mjs';
import {createEnchanter} from '../server/enchantment.mjs';
import {createLootRoller} from '../server/loot.mjs';
const catalog=name=>JSON.parse(readFileSync(new URL('../server/'+name,import.meta.url),'utf8'));
const routes=[catalog('dive-data.json'),catalog('desert-data.json'),catalog('tundra-data.json'),...catalog('campaign-dives-data.json').routes];
const plain=item=>item.category==='panties'&&!item.is_diaper;
function original(data,edition,character,chest){
 const rnd=seeded(`${data.config.route}:${edition}:1:${character}:${chest.id}`),pool=chest.kind==='food'?data.food_pool:chest.kind==='potion'?data.potion_pool:(data.item_pool??Object.keys(data.items).sort());
 let item=structuredClone(data.items[pool[rnd(pool.length)]]);
 if(item.atk_min!==undefined){item.atk=item.atk_min+rnd(item.atk_max-item.atk_min+1);if(typeof item.desc==='string')item.desc=item.desc.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
 const key=`${data.config.route}:${edition}:1:${character}:${chest.id}`,loot=createLootRoller(data.loot??routes[0].loot,data.bases??routes[0].bases);
 item=loot.roll(item,key,{level:loot.routeLevel(data.config.zone_id??data.config.route??'default',1)}); // Rarity, level and affixes are part of the loot contract too (loot.mjs).
 createEnchanter(data.enchantments)(item,key,loot.enchantMods(item)); // The curse/blessing roll is part of the loot contract, not a mutation of it.
 return item;
}
test('nine online routes cap panties across chests and pickups, replacing only extra panty rolls',()=>{
 let replacements=0;
 for(const data of routes)for(let seed=0;seed<100;seed++){
  const roll=createDiveLootRoller(data,{lootTable:data.loot??routes[0].loot}),rolls={},edition='seed-'+seed;
  for(let n=0;n<80;n++){
   const chest={id:(n%2?'treasure-':'chest-')+n},before=original(data,edition,'alice',chest),used=Object.values(rolls).filter(plain).length;
   const item=roll(edition,'alice',chest,rolls);
   if(plain(before)&&used>=1){assert.equal(item.is_diaper,true);assert.equal(item.category,'panties');replacements++;}
   else assert.deepEqual(item,before,'other items and weapon stats keep their original values');
   rolls[chest.id]=item;assert.deepEqual(roll(edition,'alice',chest,rolls),item,'duplicates retain their recorded item');
  }
  assert.ok(Object.values(rolls).filter(plain).length<=1);assert.equal(Object.keys(rolls).length,80);
  for(const kind of ['food','potion'])assert.deepEqual(roll(edition,'alice',{id:kind,kind},rolls),original(data,edition,'alice',{id:kind,kind}));
 }
 assert.ok(replacements>1000);
});
test('older rolls survive and fresh progress records get their own allowance',()=>{
 const data=routes[0],roll=createDiveLootRoller(data,{lootTable:data.loot??routes[0].loot}),panties=Object.values(data.items).find(plain),old={old1:structuredClone(panties),old2:structuredClone(panties)};
 assert.deepEqual(roll('new','alice',{id:'old2'},old),panties);
 for(let n=0;n<2000;n++){
  const chest={id:'chest-'+n},before=original(data,'new','alice',chest);if(!plain(before))continue;
  assert.equal(roll('new','alice',chest,old).is_diaper,true);
  assert.deepEqual(roll('new','alice',chest,{}),before);
  const copy=roll('new','alice',{id:'old2'},old);copy.name='Changed';assert.notEqual(old.old2.name,'Changed');return;
 }
 assert.fail('No deterministic panty candidate found');
});
test('editable limits support zero or two; invalid limits and missing diapers fail clearly',()=>{
 const base=routes[0],panties=Object.values(base.items).find(plain),diaper=Object.values(base.items).find(i=>i.is_diaper);
 const data={config:{route:'test',non_diaper_panties_per_floor:0},items:{p:panties,d:diaper},item_pool:['p','d']};
 const zero=createDiveLootRoller(data,{lootTable:data.loot??routes[0].loot});for(let n=0;n<50;n++)assert.equal(zero('week','alice',{id:String(n)},{}).is_diaper,true);
 data.config.non_diaper_panties_per_floor=2;const two=createDiveLootRoller(data,{lootTable:data.loot??routes[0].loot}),rolls={};
 for(let n=0;n<50;n++)rolls[n]=two('week','alice',{id:String(n)},rolls);assert.equal(Object.values(rolls).filter(plain).length,2);
 data.item_pool=['p'];assert.throws(()=>createDiveLootRoller(data,{lootTable:data.loot??routes[0].loot}),/at least one diaper/);
 data.config.non_diaper_panties_per_floor=-1;assert.throws(()=>createDiveLootRoller(data,{lootTable:data.loot??routes[0].loot}),/integer/);
});

test('alchemy bundles: seeded per chest, about chance% of chests, zone plus everywhere ingredients, rare ones alone',async()=>{
 const {rollIngredient}=await import('../server/dive-loot.mjs');
 const alchemy=routes[0].alchemy,table=alchemy.chest_loot;assert.ok(table&&Object.keys(alchemy.ingredients).length>=50,'dive-data.json ships the alchemy block');
 for(const data of routes){ // every route's zone maps to a real ingredient list
  const zone=data.config.zone_id??'dive-quarters';assert.ok(table.zones[table.online_zones[zone]],zone+' has an ingredient zone');
 }
 const allowed=new Set([...table.zones.desert,...table.everywhere]);let hits=0;
 for(let n=0;n<4000;n++){
  const key='dustbreak-crossing:ed:1:alice:chest-'+n,bundle=rollIngredient(alchemy,'overworld-desert',key);
  assert.deepEqual(rollIngredient(alchemy,'overworld-desert',key),bundle,'the same chest always holds the same bundle');
  if(!bundle)continue;hits++;
  assert.ok(allowed.has(bundle.item_id),bundle.item_id+' belongs in desert chests');assert.equal(bundle.category,'ingredient');
  assert.ok(bundle.quantity>=table.qty_min&&bundle.quantity<=table.qty_max);
  if(bundle.alchemy.tier>=table.single_from_tier)assert.equal(bundle.quantity,1,'rare ingredients come alone');
 }
 assert.ok(Math.abs(hits/4000-table.chance/100)<0.03,`about ${table.chance}% of chests (${hits}/4000)`);
 const stray=rollIngredient(alchemy,'no-such-route','x:1');if(stray)assert.ok(table.everywhere.includes(stray.item_id),'unknown routes only get everywhere ingredients');
 assert.equal(rollIngredient(null,'overworld-desert','k'),null,'no table shipped means no bundles');
 const roll=createDiveLootRoller(routes[1],{lootTable:routes[0].loot,alchemy});assert.equal(typeof roll.ingredient,'function');
 const chest={id:'chest-3'};assert.deepEqual(roll.ingredient('ed','alice',chest),rollIngredient(alchemy,routes[1].config.zone_id,`${routes[1].config.route}:ed:1:alice:chest-3`));
});
