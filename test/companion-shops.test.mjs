import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {GENERATED_CATEGORIES,DEFAULT_TUNING} from '../server/loot.mjs';
import {inspectionProjection} from '../server/inspection.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.UTC(2026,8,24),c,owner='alice';const paid=[];
 const zones=createQuestZones(db,{grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:(...args)=>paid.push(args),now:()=>time,diveOptions:{log:()=>{}}});
 const body=(action,extra={})=>({action,character_id:c?.id,revision:c?.revision,request_id:randomUUID(),controller:owner,...extra});
 const send=input=>{time+=1500;const result=zones.act('token',input);c=result.character;return result;};
 const act=(action,extra)=>send(body(action,extra));
 const companion=()=>{const view=zones.read('token',c.id,{companion:true});c={...c,revision:view.character.revision};return view;};
 const refresh=()=>{c=zones.read('token',c.id).character;return c;};
 act('create',{name:'Roller'});act('enter',{zone:'princess-rose',loadout:{player_info:{level:12},inventory:[]}});
 return {db,zones,act,send,body,companion,refresh,paid,get c(){return c;},owner(value){owner=value;}};
}
const purchases=db=>db.prepare('SELECT COUNT(*) AS n FROM hub_purchases').get().n;

test('atelier roll: priced, fixed before payment, delivered once to the bank as a sellable generated diaper',()=>{
 const f=fixture();
 try{
  const view=f.companion().shops;
  assert.deepEqual(view.shops.map(s=>[s.id,s.price,s.available]),[['atelier',3,true],['emporium',3,true]]);
  assert.equal(view.bankFree,512);assert.equal(view.pending,false);
  assert.ok(Math.abs(view.shops[0].odds.reduce((sum,o)=>sum+o.chance,0)-100)<0.1);

  assert.throws(()=>f.act('companion_roll',{shop:'atelier',price:2}),e=>e.code==='price_changed'&&/3 LiDollCoins/.test(e.message));
  assert.throws(()=>f.act('companion_roll',{shop:'boutique',price:3}),e=>e.status===400);
  assert.equal(purchases(f.db),0);

  const roll=f.body('companion_roll',{shop:'atelier',price:3});f.send(roll);
  const id=f.c.pendingPurchase;assert.ok(id);
  const reserved=JSON.parse(f.db.prepare('SELECT item FROM hub_purchases WHERE id=?').get(id).item);
  assert.equal(reserved.companion_shop,'atelier');
  assert.equal(f.companion().shops.last.status,'pending');assert.equal(f.companion().shops.last.item,undefined); // Nothing revealed before payment.
  assert.throws(()=>f.act('companion_roll',{shop:'atelier',price:3}),e=>e.code==='purchase_pending');
  assert.equal(f.send(roll).receipt.request_id,roll.request_id); // A replay returns the stored receipt instead of reserving again.
  assert.equal(purchases(f.db),1);

  f.zones.completePurchase(id,true);f.zones.completePurchase(id,true);f.refresh();
  assert.equal(f.c.pendingPurchase,undefined);
  const after=f.companion(),stored=after.bank.items;
  assert.equal(stored.length,1);
  const item=stored[0].item;
  assert.equal(item.item_id,reserved.item.item_id);assert.equal(item.name,reserved.item.name); // Delivered exactly as reserved.
  assert.match(item.item_id,/^gen_/);assert.equal(item.is_diaper,true);assert.equal(item.category,'panties');
  assert.equal(item.loot.rolled,true);assert.ok(item.online_item);assert.ok(item.online_sell_price>=1&&item.online_sell_price<=3); // Resale never exceeds the price paid.
  assert.equal(after.shops.last.status,'delivered');assert.equal(after.shops.last.bank_item,stored[0].id);
  assert.equal(after.shops.last.item.name,item.name);assert.equal(after.shops.last.item.sell,item.online_sell_price);
  assert.equal(after.shops.bankFree,511);
  assert.equal(after.shops.last.in_bank,true);assert.equal(after.shops.last.item_instance,item.online_item);

  f.act('bank_sell',{bank_item:stored[0].id,item_instance:item.online_item});
  assert.equal(f.companion().bank.count,0);assert.equal(f.companion().shops.last.in_bank,false);
  assert.deepEqual(f.paid.at(-1).slice(1,3),['coins',item.online_sell_price]);
 }finally{f.db.close();}
});

test('emporium rolls clothing only; a declined payment delivers nothing',()=>{
 const f=fixture();
 try{
  for(let n=0;n<12;n++){
   f.act('companion_roll',{shop:'emporium',price:3});f.zones.completePurchase(f.c.pendingPurchase,true);f.refresh();
  }
  const items=f.companion().bank.items.map(e=>e.item);
  assert.equal(items.length,12);
  for(const item of items){assert.notEqual(item.is_diaper,true);assert.ok(GENERATED_CATEGORIES.includes(item.category),item.category);}
  f.act('companion_roll',{shop:'atelier',price:3});f.zones.completePurchase(f.c.pendingPurchase,false);f.refresh();
  const view=f.companion();
  assert.equal(view.bank.count,12);assert.equal(view.shops.last.status,'declined');assert.equal(view.shops.last.item,undefined);
 }finally{f.db.close();}
});

test('a full bank refuses before anything is reserved',()=>{
 const f=fixture();
 try{
  f.db.prepare('INSERT INTO quest_bank VALUES (?,?)').run(f.c.id,JSON.stringify(Array.from({length:512},(_,i)=>({id:'s'+i,item:{item_id:'adult_food'}}))));
  assert.throws(()=>f.act('companion_roll',{shop:'atelier',price:3}),/Bank full/);
  assert.equal(purchases(f.db),0);assert.equal(f.companion().shops.bankFree,0);
 }finally{f.db.close();}
});

test('gamemaster tuning sets the price, odds and level band',()=>{
 const f=fixture(),onlyLegendary=Object.fromEntries(Object.entries(DEFAULT_TUNING.rarity).map(([tier,row])=>[tier,{...row,weight:tier==='legendary'?1:0}]));
 try{
  f.zones.loot.tune({atelier_price:7,luck_profiles:{atelier:{uncommon:1,rare:1,epic:1,legendary:20}},shop_levels:{default:{min:1,max:100},atelier:{min:30,max:40}}});
  const shops=f.companion().shops.shops,shop=shops.find(s=>s.id==='atelier'),chance=(s,tier)=>s.odds.find(o=>o.rarity===tier).chance;
  assert.equal(shop.price,7);assert.equal(chance(shop,'legendary'),16.81); // 1x20 of 60+25+10+4+20.
  assert.equal(chance(shops.find(s=>s.id==='emporium'),'legendary'),1); // No emporium profile: the plain rarity weights.
  f.zones.loot.tune({rarity:onlyLegendary}); // Force the tier so the roll itself can be checked.
  assert.throws(()=>f.act('companion_roll',{shop:'atelier',price:3}),e=>e.code==='price_changed');
  f.act('companion_roll',{shop:'atelier',price:7});f.zones.completePurchase(f.c.pendingPurchase,true);f.refresh();
  const item=f.companion().bank.items[0].item;
  assert.equal(item.loot.rarity,'legendary');
  assert.ok(item.loot.ilvl>=29&&item.loot.ilvl<=42,String(item.loot.ilvl)); // Level 12 clamped up into 30-40, plus the roller's jitter.
  assert.ok(item.online_sell_price<=7);
 }finally{f.db.close();}
});

test('a rolled diaper can be withdrawn and worn from the companion, and inspects by its generated id',()=>{
 const f=fixture();
 try{
  f.act('companion_roll',{shop:'atelier',price:3});f.zones.completePurchase(f.c.pendingPurchase,true);f.refresh();
  let view=f.companion();const entry=view.bank.items[0];
  assert.throws(()=>f.act('companion_withdraw',{bank_item:entry.id,equipment_version:'stale'}),/equipment changed/);
  assert.throws(()=>f.act('companion_withdraw',{bank_item:'missing',equipment_version:view.sheet.equipment_version}),/no longer in your bank/);
  f.act('companion_withdraw',{bank_item:entry.id,equipment_version:view.sheet.equipment_version});
  view=f.companion();
  assert.equal(view.bank.count,0);
  const carried=view.sheet.inventory.find(i=>i.item_id===entry.item.item_id);
  assert.ok(carried?.equippable,'the generated diaper is equippable');
  f.act('companion_equip',{slot:carried.index,item_id:carried.item_id,equipment_version:view.sheet.equipment_version});
  f.refresh();
  assert.equal(f.c.loadout.player_info.equipped_panties,entry.item.item_id);
  assert.equal(f.c.loadout.player_info.equipped_item_data.panties.online_item,entry.item.online_item); // The resale right travels with the worn copy.
  const row=f.db.prepare('SELECT * FROM quest_characters WHERE id=?').get(f.c.id);
  const panties=inspectionProjection(row).equipment.find(s=>s.slot==='panties');
  assert.equal(panties.item_id,entry.item.item_id);assert.notEqual(panties.name,'(empty)');
 }finally{f.db.close();}
});
