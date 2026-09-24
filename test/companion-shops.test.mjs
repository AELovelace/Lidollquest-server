import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {GENERATED_CATEGORIES,DEFAULT_TUNING} from '../server/loot.mjs';
import {inspectionProjection} from '../server/inspection.mjs';
import {createQuestService} from '../server/service.mjs';
import {DAILY_COIN_CAP,dailyCoinCap} from '../server/hubs.mjs';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.UTC(2026,8,24),c,owner='alice',scope='wallet:read wallet:write diamonds:read diamonds:write';const paid=[];
 const zones=createQuestZones(db,{grant:()=>({owner,id:owner,client:'lidollquest',scope}),wallet:()=>({coins:1000}),adjust:(...args)=>paid.push(args),now:()=>time,diveOptions:{log:()=>{}}});
 const body=(action,extra={})=>({action,character_id:c?.id,revision:c?.revision,request_id:randomUUID(),controller:owner,...extra});
 const send=input=>{time+=1500;const result=zones.act('token',input);c=result.character;return result;};
 const act=(action,extra)=>send(body(action,extra));
 const companion=()=>{const view=zones.read('token',c.id,{companion:true});c={...c,revision:view.character.revision};return view;};
 const refresh=()=>{c=zones.read('token',c.id).character;return c;};
 act('create',{name:'Roller'});act('enter',{zone:'princess-rose',loadout:{player_info:{level:12},inventory:[]}});
 return {db,zones,act,send,body,companion,refresh,paid,get c(){return c;},owner(value){owner=value;},scope(value='wallet:read wallet:write diamonds:read diamonds:write'){scope=value;}};
}
const purchases=db=>db.prepare('SELECT COUNT(*) AS n FROM hub_purchases').get().n;

test('atelier roll: priced, fixed before payment, delivered once to the bank as a sellable generated diaper',()=>{
 const f=fixture();
 try{
  const view=f.companion().shops;
  assert.deepEqual(view.shops.map(s=>[s.id,s.price,s.available]),[['atelier',3,true],['emporium',3,true]]);
  assert.deepEqual(view.shops.map(s=>[s.diamond.price,s.diamond.floor]),[[1,'rare'],[1,'rare']]); // The 1-diamond mode rides along with every shop.
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

test('diamond roll: exactly one diamond, consent scope, rarity floor, delivered to the bank with a half-value resale right',()=>{
 const f=fixture();
 try{
  const view=f.companion().shops;
  for(const shop of view.shops){ // Nothing below the floor, and the shown odds still sum to 100.
   assert.ok(shop.diamond.odds.every(o=>o.chance===0||!['common','uncommon'].includes(o.rarity)),shop.id+' shows odds below the floor');
   assert.ok(shop.diamond.odds.some(o=>o.rarity==='rare'&&o.chance>0));
   assert.ok(Math.abs(shop.diamond.odds.reduce((sum,o)=>sum+o.chance,0)-100)<0.1);
  }
  assert.throws(()=>f.act('companion_roll',{shop:'atelier',mode:'diamond',price:3}),e=>e.code==='price_changed'&&/exactly 1 diamond/.test(e.message)); // Coins are not accepted for the diamond mode.
  assert.throws(()=>f.act('companion_roll',{shop:'atelier',mode:'stars',price:1}),e=>e.status===400);
  f.scope('wallet:read wallet:write');assert.throws(()=>f.act('companion_roll',{shop:'atelier',mode:'diamond',price:1}),e=>e.status===403&&e.code==='insufficient_scope');f.scope(); // No consent, no reservation.
  assert.equal(purchases(f.db),0);

  const roll=f.body('companion_roll',{shop:'atelier',mode:'diamond',price:1});f.send(roll);
  const id=f.c.pendingPurchase;assert.ok(id);
  const row=f.db.prepare('SELECT item,price FROM hub_purchases WHERE id=?').get(id),reserved=JSON.parse(row.item);
  assert.equal(row.price,1);assert.equal(reserved.currency,'diamonds');assert.equal(reserved.companion_shop,'atelier'); // settlePurchases reads currency to pick the diamond debit.
  assert.ok(['rare','epic','legendary'].includes(reserved.item.loot.rarity),'floored at rare, got '+reserved.item.loot.rarity);
  const pending=f.companion().shops.last;assert.equal(pending.status,'pending');assert.equal(pending.mode,'diamond');assert.equal(pending.currency,'diamonds');assert.equal(pending.price,1);
  assert.equal(f.send(roll).receipt.request_id,roll.request_id); // Replays never reserve twice.
  assert.equal(purchases(f.db),1);

  f.zones.completePurchase(id,true);f.refresh();
  const after=f.companion(),item=after.bank.items[0].item;
  assert.equal(item.item_id,reserved.item.item_id);assert.equal(item.is_diaper,true);
  if(item.value>0)assert.equal(item.online_sell_price,item.cursed?1:Math.max(1,Math.floor(item.value*0.5)),'a diamond roll resells for half its value, not for one coin');
  assert.equal(after.shops.last.status,'delivered');assert.equal(after.shops.last.currency,'diamonds');assert.equal(after.shops.last.mode,'diamond');
  assert.equal(after.shops.last.item.sell,item.online_sell_price);

  f.send(f.body('companion_roll',{shop:'emporium',mode:'diamond',price:1}));f.zones.completePurchase(f.c.pendingPurchase,false);f.refresh();
  assert.match(f.c.hubNotice,/Not enough diamonds/);assert.equal(f.companion().shops.last.status,'declined');assert.equal(f.companion().bank.count,1); // Declined diamonds deliver nothing.
 }finally{f.db.close();}
});

test('diamond roll settles through the wallet diamond debit: one diamond, coins untouched, lost replies retry once, no diamonds declines',async()=>{
 mkdirSync('artifacts',{recursive:true});const directory=mkdtempSync(resolve('artifacts/diamond-roll-')),token='a'.repeat(43),owner='b'.repeat(64);
 let time=1000000,diamonds=2,lose=true,service,url,c;const receipts=new Map(),coinDebits=[];
 const walletClient={
  authenticate:async()=>({owner,id:'a',client:'lidollquest',coins:100,scope:'wallet:read wallet:write diamonds:read diamonds:write'}),
  credit:async(_,body)=>{if(body.kind==='debit')coinDebits.push(body);return {request_id:body.request_id,currency:'LiDollCoin',amount:body.amount,balance:100};},
  diamonds:async(_,body)=>{assert.deepEqual([body.asset,body.kind,body.amount],['diamonds','debit',1]);let receipt=receipts.get(body.request_id);
   if(!receipt){if(diamonds<1)throw Object.assign(Error('Not enough diamonds.'),{code:'insufficient_balance',status:409});diamonds--;receipt={request_id:body.request_id,currency:'Diamonds',kind:'debit',amount:1,balance:diamonds};receipts.set(body.request_id,receipt);}
   if(lose){lose=false;throw Error('Lost response');}return receipt;}, // The first reply is lost after the debit committed; the durable id makes the retry idempotent.
 };
 const start=async()=>{service=createQuestService({filename:resolve(directory,'quest.sqlite'),walletClient,now:()=>time,log:()=>{}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+service.server.address().port;};
 const stop=()=>new Promise(r=>service.server.close(r));
 const send=async body=>{time+=1500;const r=await fetch(url+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const command=(action,extra={})=>({action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});
 const act=async(action,extra={})=>{const r=await send(command(action,extra));assert.equal(r.status,200,JSON.stringify(r.data));c=r.data.character;return r.data;};
 await start();try{
  await act('create',{name:'Sparkles'});const entered=await act('enter',{zone:'princess-rose',loadout:{player_info:{level:12},inventory:[]}});
  assert.equal(entered.capabilities.companionDiamondRolls,true);
  const roll=command('companion_roll',{shop:'atelier',mode:'diamond',price:1});let r=await send(roll);assert.equal(r.status,200,JSON.stringify(r.data));c=r.data.character;
  assert.equal(r.data.shops.pending,true);assert.equal(diamonds,1);assert.equal(r.data.shops.last.status,'pending'); // Debited once; the reply was lost, so nothing is revealed yet. (Companion actions answer with the companion view.)
  r=await send(roll);assert.equal(r.status,200);c=r.data.character;
  assert.equal(r.data.shops.pending,false);assert.equal(receipts.size,1);assert.equal(diamonds,1); // The retry replays the same debit id: still one diamond.
  assert.equal(r.data.shops.last.status,'delivered');assert.equal(r.data.shops.last.currency,'diamonds');assert.equal(r.data.coins,100);assert.equal(coinDebits.length,0); // Coins untouched.
  await act('companion_roll',{shop:'emporium',mode:'diamond',price:1});assert.equal(diamonds,0);
  const declined=await act('companion_roll',{shop:'emporium',mode:'diamond',price:1});
  assert.equal(declined.shops.last.status,'declined');assert.equal(declined.shops.last.currency,'diamonds');assert.equal(declined.shops.bankFree,510); // Two delivered, the third declined.
 }finally{await stop();}
});

test('daily coin cap ships at 9999 and follows the live loot tuning',()=>{
 const f=fixture();
 try{
  assert.equal(DEFAULT_TUNING.daily_coin_cap,9999);assert.equal(DAILY_COIN_CAP,9999);assert.equal(dailyCoinCap(),9999);
  assert.equal(f.companion().dailyCap,9999);assert.equal(f.companion().dailyRemaining,9999);
  f.zones.loot.tune({daily_coin_cap:500},'gm');assert.equal(dailyCoinCap(),500); // The /gm Loot tab or the in-game Combat page.
  const view=f.companion();assert.equal(view.dailyCap,500);assert.equal(view.dailyRemaining,500);
  assert.throws(()=>f.zones.loot.tune({daily_coin_cap:0}),/between 1 and 100000/);assert.throws(()=>f.zones.loot.tune({daily_coin_cap:2.5}),/whole number/);
  f.zones.loot.reset('tuning');assert.equal(dailyCoinCap(),9999);
 }finally{f.db.close();}
});
