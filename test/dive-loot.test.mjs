import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';
import {seeded} from '../server/dive-generation.mjs';
const catalog=name=>JSON.parse(readFileSync(new URL('../server/'+name,import.meta.url),'utf8'));
const routes=[catalog('dive-data.json'),catalog('desert-data.json'),catalog('tundra-data.json'),...catalog('campaign-dives-data.json').routes];
const plain=item=>item.category==='panties'&&!item.is_diaper;
function original(data,edition,character,chest){
 const rnd=seeded(`${data.config.route}:${edition}:1:${character}:${chest.id}`),pool=chest.kind==='food'?data.food_pool:chest.kind==='potion'?data.potion_pool:(data.item_pool??Object.keys(data.items).sort());
 const item=structuredClone(data.items[pool[rnd(pool.length)]]);
 if(item.atk_min!==undefined){item.atk=item.atk_min+rnd(item.atk_max-item.atk_min+1);if(typeof item.desc==='string')item.desc=item.desc.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
 return item;
}
test('nine online routes cap panties across chests and pickups, replacing only extra panty rolls',()=>{
 let replacements=0;
 for(const data of routes)for(let seed=0;seed<100;seed++){
  const roll=createDiveLootRoller(data),rolls={},edition='seed-'+seed;
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
 const data=routes[0],roll=createDiveLootRoller(data),panties=Object.values(data.items).find(plain),old={old1:structuredClone(panties),old2:structuredClone(panties)};
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
 const zero=createDiveLootRoller(data);for(let n=0;n<50;n++)assert.equal(zero('week','alice',{id:String(n)},{}).is_diaper,true);
 data.config.non_diaper_panties_per_floor=2;const two=createDiveLootRoller(data),rolls={};
 for(let n=0;n<50;n++)rolls[n]=two('week','alice',{id:String(n)},rolls);assert.equal(Object.values(rolls).filter(plain).length,2);
 data.item_pool=['p'];assert.throws(()=>createDiveLootRoller(data),/at least one diaper/);
 data.config.non_diaper_panties_per_floor=-1;assert.throws(()=>createDiveLootRoller(data),/integer/);
});
