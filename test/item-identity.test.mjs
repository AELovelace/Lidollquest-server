import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createItemOrigins} from '../server/item-origins.mjs';
import {compactItemIdentities} from '../server/item-identity.mjs';
import {importLoadout,addToInventory,MAX_LOADOUT_NODES} from '../server/loadout.mjs';

test('below-blue identities compact without downgrading authored or rolled valuable items',()=>{
 for(const rarity of ['common','uncommon','rare','epic','legendary','unknown']){
  const item={item_id:'sample',rarity,loot:{rolled:false,rarity:'common'},quantity:512,online_item:'first',online_items:['first','second'],online_sell_price:4};
  const out=compactItemIdentities(structuredClone(item));
  assert.equal(out.quantity,512);assert.equal(out.online_sell_price,4);
  if(['common','uncommon'].includes(rarity)){assert.equal(out.online_item,undefined);assert.equal(out.online_items,undefined);assert.equal(out.online_sale_quantity,2);}
  else assert.deepEqual(out,item);
 }
 const valuable={item_id:'rolled',rarity:'common',loot:{rolled:true,rarity:'rare'},online_item:'valuable'};
 assert.deepEqual(compactItemIdentities(structuredClone(valuable)),valuable);
});

test('common stack sale counts survive consumption, forged prices, escrow and transfer without client UUIDs',()=>{
 const db=new DatabaseSync(':memory:'),origins=createItemOrigins(db),a={id:'alice'},b={id:'bob'};
 const state={loadout:{player_info:{},inventory:[]}},item={item_id:'berries',category:'ingredient',rarity:'uncommon',name:'Berries',value:8};
 try{
  for(let n=0;n<512;n++)addToInventory(state.loadout.inventory,origins.mint(a.id,{...item}));
  const before=structuredClone(state);origins.reconcile(a,state,before);
  const stack=state.loadout.inventory[0];assert.equal(stack.quantity,512);assert.equal(stack.online_sale_quantity,512);assert.equal(stack.online_items,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(state))<1000);
  stack.quantity=510;stack.online_sell_price=99999;origins.reconcile(a,state,before);
  assert.equal(stack.online_sale_quantity,510);assert.equal(stack.online_sell_price,4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM quest_item_origins WHERE status='spent'").get().n,2);
  const rights=origins.attach(a,stack);assert.equal(rights.length,510);
  for(const id of rights)assert.ok(origins.park(id,a.id));
  state.loadout.inventory=[];origins.reconcile(a,state,before);
  for(const id of rights)assert.ok(origins.release(id,b.id));
  const receiver={loadout:{player_info:{},inventory:[stack]}};origins.reconcile(b,receiver,{loadout:{player_info:{},inventory:[]}});
  assert.equal(stack.online_item,undefined);assert.equal(stack.online_sale_quantity,510);
  assert.equal(origins.sales(a,stack,2).length,0);assert.equal(origins.sales(b,stack,2).length,2);
  stack.quantity=512;assert.equal(origins.attach(b,stack).length,510,'escrow preserves the verified portion of a mixed stack');
 }finally{db.close();}
});

test('larger ordinary inventories fit the node budget while excessive complexity and depth still fail',()=>{
 const fields=Object.fromEntries(Array.from({length:45},(_,n)=>['f'+n,0]));
 const input={player_info:{},inventory:Array.from({length:512},(_,n)=>({item_id:'item-'+n,category:'ingredient',quantity:512,desc:'x'.repeat(250),...fields}))};
 assert.ok(Buffer.byteLength(JSON.stringify(input))>256*1024);assert.doesNotThrow(()=>importLoadout(input));
 assert.equal(MAX_LOADOUT_NODES,40000);
 assert.throws(()=>importLoadout({player_info:{values:Array(40000).fill(0)},inventory:[]}),/too complex/);
 let nested={};for(let n=0;n<18;n++)nested={child:nested};assert.throws(()=>importLoadout({player_info:nested,inventory:[]}),/too complex/);
 for(let n=0;n<4000;n++)nested={child:nested};assert.throws(()=>importLoadout({player_info:nested,inventory:[]}),e=>e.status===400&&/too complex/.test(e.message));
});
