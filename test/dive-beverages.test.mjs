import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';
const read=name=>JSON.parse(readFileSync(new URL('../server/'+name,import.meta.url),'utf8'));
const routes=[read('dive-data.json'),read('desert-data.json'),read('tundra-data.json'),...read('campaign-dives-data.json').routes];

test('all nine routes roll ordinary beverages from supply pickups while retaining old receipts and potion pools',()=>{
 const expected=['water_bottle','bottle','sippy_juice','nanny_juice_box','formula_bottle_an','ghost_milk'].sort();
 for(const data of routes){
  const roll=createDiveLootRoller(data),seen=new Set();let drinks=0;
  for(let n=0;n<1000;n++){
   const chest={id:'food-'+n,kind:'food'},item=roll('beverage-week','alice',chest,{});
   assert.equal(item.category,'food');
   if(item.is_drink){seen.add(item.item_id);drinks++;assert.ok(item.thirst_restore>0);}
   const receipt={[chest.id]:structuredClone(item)};
   assert.deepEqual(roll('beverage-week','alice',chest,receipt),item); // Committed loot survives retries and later table edits.
   const potion=roll('beverage-week','alice',{id:'potion-'+n,kind:'potion'},{});
   assert.ok(data.potion_pool.includes(potion.item_id));assert.ok(!expected.includes(potion.item_id));
  }
  assert.deepEqual([...seen].sort(),expected,data.config.route);
  assert.ok(drinks>400&&drinks<600,`${data.config.route}: ${drinks}/1000 drinks`);
  const old={legacy:structuredClone(data.items.adult_food)};
  assert.deepEqual(roll('old-week','alice',{id:'legacy',kind:'food'},old),old.legacy);
 }
});
