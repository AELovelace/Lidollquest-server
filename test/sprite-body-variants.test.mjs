import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {lookCatalog,validateLook} from '../server/sprite-looks.mjs';

const catalog=lookCatalog(),context=vm.createContext({});
vm.runInContext(readFileSync(new URL('../server/gm-sprite-lab.js',import.meta.url),'utf8'),context);
const resolve=context.spriteLabBodySprite;

test('twenty body fits have sheets but remain single wardrobe items and unlocks',()=>{
 const sheets=JSON.parse(readFileSync(new URL('../server/sprite-lab-sheets.json',import.meta.url),'utf8')).sheets;
 const variants=catalog.assets.filter(a=>a.body_sprites);assert.equal(variants.length,20);
 for(const asset of variants){
  assert.equal(resolve(catalog,asset,'piko_base'),asset.body_sprites.masc);
  assert.equal(resolve(catalog,asset,'piko_woman'),asset.sprite);
  assert.ok(sheets[asset.body_sprites.masc]);assert.ok(sheets[asset.sprite]);
  assert.ok(!catalog.assets.some(a=>a.id===asset.id+'_masc'),'no second purchase or saved item');
  for(const base of ['piko_base','piko_woman']){
   const look=validateLook({version:1,slots:{base,torso:asset.id},colors:{torso:[[24,160,210]]},enabled:{torso:[true]},strength:{torso:[0.5]}},{unlocked:new Set([asset.id])});
   assert.equal(look.slots.torso,asset.id);assert.deepEqual(look.colors.torso[0],[24,160,210]);assert.equal(look.strength.torso[0],0.5);
  }
 }
});

test('unisex and explicit custom artwork do not borrow another garments texture',()=>{
 const tee=catalog.assets.find(a=>a.id==='tee'),dress=catalog.assets.find(a=>a.id==='piko_dress');
 assert.equal(resolve(catalog,dress,'piko_base'),dress.sprite);
 assert.equal(resolve(catalog,{...tee,hash:'published',sprite:'custom'},'piko_base'),'custom');
 assert.equal(resolve(catalog,tee,'missing_base'),tee.sprite);
 const customBase={...catalog.assets.find(a=>a.id==='piko_base'),id:'custom_base'};
 assert.equal(resolve({...catalog,assets:[...catalog.assets,customBase]},tee,'custom_base'),tee.body_sprites.masc);
});
