import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {validateLook,lookCatalog,accessorySlots} from '../server/sprite-looks.mjs';
import {validateShopAppearance} from '../server/player-stores.mjs';

const base={version:1,slots:{base:'piko_woman',hair:'pixie_cut',torso:'hoodie'},facing:0};
const withAccessories=(...ids)=>{const slots={...base.slots};for(const id of ids)slots[lookCatalog().assets.find(a=>a.id===id).slot]=id;return {...base,slots};};

test('the catalog marks head, face, neck and back as accessories with a limit of three',()=>{
 assert.deepEqual([...accessorySlots()].sort(),['back','face','head','neck']);
 assert.equal(lookCatalog().accessory_limit,3);
 for(const slot of ['head','face','neck','back'])assert.ok(lookCatalog().assets.some(a=>a.slot===slot),slot+' has art');
});

test('a look wears at most three accessories, and only unlocked ones when ownership is checked',()=>{
 const three=withAccessories('cat_ears','round_glasses','knit_scarf');
 assert.equal(validateLook(three).slots.head,'cat_ears','previews (no ownership check) accept any three');
 assert.throws(()=>validateLook(withAccessories('cat_ears','round_glasses','knit_scarf','backpack')),/up to 3 accessories/);
 assert.throws(()=>validateLook(three,{unlocked:new Set(['cat_ears','round_glasses'])}),/Unlock Knit Scarf/);
 assert.equal(validateLook(three,{unlocked:new Set(['cat_ears','round_glasses','knit_scarf'])}).slots.neck,'knit_scarf');
 assert.equal(validateLook(base,{unlocked:new Set()}).slots.head,'','clothes and hair never need unlocking');
 assert.throws(()=>validateLook({...base,slots:{...base.slots,head:'hoodie'}}),/Unsupported/,'items only fit their own slot');
});

test('shopkeepers follow the same accessory rules',()=>{
 assert.throws(()=>validateShopAppearance(withAccessories('tiara'),new Set()),/Unlock Tiara/);
 assert.equal(validateShopAppearance(withAccessories('tiara'),new Set(['tiara'])).slots.head,'tiara');
});

function world(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-02T12:00:00Z');
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner:'doll',id:'doll',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const loadout={player_info:{class_id:'fighter',playerHealth:100,playerHealthMax:100,str:5,def:5,dex:5,int:5,cha:5,level:1,xp:0,stat_points:0},inventory:[],player_spells:[],player_mp:0,player_mp_max:0};
 const c=zones.act('',{action:'create',request_id:randomUUID(),controller:'w',name:'Lumi'}).character;
 const act=(action,extra={})=>{time+=1000;return zones.act('',{action,request_id:randomUUID(),controller:'w',character_id:c.id,revision:zones.read('',c.id).character.revision,...extra});};
 act('enter',{zone:'honeydew-lantern',loadout,combat_version:3,content_version:1,quest_version:1});
 const pending=()=>JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state).pendingPurchase;
 return {db,zones,act,pending,read:()=>zones.read('',c.id),close:()=>{zones.close();db.close();}};
}

test('one diamond unlocks an accessory for the whole account; declines and repeats are safe',()=>{
 const w=world();
 try{
  assert.deepEqual(w.read().lookUnlocks,[],'nothing is unlocked at first');
  assert.equal(w.read().lookRules.accessoryLimit,3);
  w.act('look_unlock',{asset:'cat_ears'});
  const id=w.pending();assert.ok(id,'the unlock waits on a reserved purchase');
  const row=w.db.prepare('SELECT * FROM hub_purchases WHERE id=?').get(id);
  assert.deepEqual({item:JSON.parse(row.item).currency,price:row.price},{item:'diamonds',price:1},'charged as one diamond through the durable debit');
  assert.throws(()=>w.act('look_unlock',{asset:'tiara'}),/purchase/,'one purchase at a time (the existing settling guard)');
  w.zones.completePurchase(id,true);
  assert.deepEqual(w.read().lookUnlocks,['cat_ears']);
  assert.match(w.read().character.hubNotice??'',/Unlocked Cat Ears/);
  w.zones.completePurchase(id,true);assert.deepEqual(w.read().lookUnlocks,['cat_ears'],'a replayed settlement grants nothing twice');
  assert.throws(()=>w.act('look_unlock',{asset:'cat_ears'}),/already own/);
  assert.throws(()=>w.act('look_unlock',{asset:'hoodie'}),/Only accessories/,'clothes are never sold this way');
  w.act('look_unlock',{asset:'pacifier'});w.zones.completePurchase(w.pending(),false);
  assert.deepEqual(w.read().lookUnlocks,['cat_ears'],'a declined debit unlocks nothing');
  assert.match(w.read().character.hubNotice??'',/Not enough diamonds/);
 }finally{w.close();}
});
