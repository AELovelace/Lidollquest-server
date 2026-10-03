import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCraftingStore} from '../server/crafting-store.mjs';

test('crafting form choices and validation protect every editable section without losing saved content',()=>{
 const db=new DatabaseSync(':memory:'),store=createCraftingStore(db);
 try{
  const before=store.view();assert.ok(before.options.items.some(i=>i.id==='crafted_longsword'&&i.category==='weapon'));assert.ok(before.options.garments.some(g=>g.id==='hat'));
  const invalid=[
   ['recipes',rows=>{rows[0].variants=['wood'];}],
   ['recipes',rows=>{rows[0].station='';}],
   ['materials',rows=>{rows.wood.value=-1;}],
   ['culinary',rows=>{rows.nonexistent_ingredient=['water'];}],
   ['cooking',rows=>{rows[0].tags=['meat',''];}],
   ['cooking',rows=>{rows[1].id=rows[0].id;}],
   ['regions',rows=>{Object.values(rows)[0].animals=['missing_animal'];}],
   ['wildlife',rows=>{Object.values(rows)[0].hp=null;}],
   ['tuning',rows=>{rows.weights_low=[1,2,3,4,5];}],
   ['catalysts',rows=>{Object.values(rows)[0].effect='unknown_effect';}],
  ];
  for(const [section,mutate] of invalid){const value=structuredClone(before.data[section]);mutate(value);assert.throws(()=>store.save(section,value,0),e=>e.status===400,section);assert.deepEqual(store.view().data,before.data);assert.equal(store.view().revision,0);}
  const material=structuredClone(before.data.materials);material.wood.name='Workshop Wood';assert.equal(store.save('materials',material,0).revision,1);
  assert.throws(()=>store.save('materials',before.data.materials,0),e=>e.status===409);
  assert.equal(store.view().data.materials.wood.name,'Workshop Wood');
 }finally{db.close();}
});
