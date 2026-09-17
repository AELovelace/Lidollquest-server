import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

test('personal bank: both halls, atomic replay, full storage/inventory, ownership, character isolation and reconnect',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.UTC(2026,8,16),zones;
 const start=()=>zones=createQuestZones(db,{now:()=>time,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:50}),adjust:()=>{}});
 start();let c,owner='alice';
 const command=(action,extra={})=>({action,controller:owner,request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});
 const send=input=>{time+=100;const result=zones.act(owner,input);c=result.character;return result;};
 const act=(action,extra)=>send(command(action,extra));
 const place=()=>db.prepare('UPDATE quest_presence SET x=29,y=20 WHERE character_id=?').run(c.id);
 try{
  act('create',{name:'Alice'});const id=c.id;
  act('enter',{zone:'honeydew-lantern-shops',loadout:{player_info:{equipped_weapon:'iron_dagger'},inventory:[{item_id:'adult_food',name:'Food',custom:{quality:12}}]}});
  assert.throws(()=>act('bank_deposit',{fixture:'bank',slot:0}),/Stand next/);
  place();const deposit=command('bank_deposit',{fixture:'bank',slot:0}),saved=send(deposit);
  assert.equal(saved.bank.count,1);assert.equal(c.loadout.inventory.length,0);assert.equal(c.loadout.player_info.equipped_weapon,'iron_dagger');
  assert.equal(send(deposit).bank.count,1); // Same durable receipt never removes a second item.
  start();let snapshot=act('enter',{zone:'honeydew-lantern',loadout:{player_info:{},inventory:[]}});place();
  snapshot=zones.read(owner,id);assert.equal(snapshot.bank.count,1);assert.equal(snapshot.bank.items[0].item.custom.quality,12);
  const stored=snapshot.bank.items[0];const withdraw=command('bank_withdraw',{fixture:'bank',bank_item:stored.id});
  send(withdraw);send(withdraw);assert.equal(c.loadout.inventory.length,1);
  assert.throws(()=>act('bank_withdraw',{fixture:'bank',bank_item:stored.id}),/no longer/);
  assert.throws(()=>act('bank_deposit',{fixture:'bank',slot:-1}),/Choose/);
  const stale=command('bank_deposit',{fixture:'bank',slot:0});act('chat',{text:'Bank hello'});assert.throws(()=>send(stale),/Character changed/);
  act('bank_deposit',{fixture:'bank',slot:0});
  const entries=Array.from({length:512},(_,i)=>({id:'stored-'+i,item:{item_id:'adult_food',custom:i}}));
  db.prepare('UPDATE quest_bank SET items=? WHERE character_id=?').run(JSON.stringify(entries),id);
  act('loadout',{loadout:{player_info:{},inventory:[{item_id:'water_bottle'}]}});
  assert.throws(()=>act('bank_deposit',{fixture:'bank',slot:0}),/Bank full/);assert.equal(c.loadout.inventory.length,1);
  act('loadout',{loadout:{player_info:{},inventory:Array.from({length:99},()=>({item_id:'water_bottle'}))}});
  assert.throws(()=>act('bank_withdraw',{fixture:'bank',bank_item:'stored-0'}),/Inventory full/);
  assert.equal(zones.read(owner,id).bank.count,512);
  act('loadout',{loadout:{player_info:{},inventory:[]}});act('bank_withdraw',{fixture:'bank',bank_item:'stored-0'});
  assert.equal(act('bank_deposit',{fixture:'bank',slot:0}).bank.count,512); // The last available storage slot works.
  act('hub_visit',{zone:'honeydew-lantern'});act('leave');
  act('enter',{zone:'littlebig-clockwork-shops'});place();assert.equal(zones.read(owner,id).bank.items.length,16);
  const last=act('bank_page',{fixture:'bank',page:31});assert.equal(last.bank.count,512);assert.equal(last.bank.items.length,16);
  assert.equal(last.bank.items[0].item.custom,497); // Stable order after removing stored-0 and depositing it again at the end.
  assert.throws(()=>act('bank_page',{fixture:'bank',page:32}),/available bank page/);
  const alice=c;act('leave');act('create',{name:'Alt'});act('enter',{zone:'littlebig-clockwork-shops',loadout:{player_info:{},inventory:[]}});place();
  assert.equal(zones.read(owner,c.id).bank.count,0);assert.throws(()=>act('bank_withdraw',{fixture:'bank',bank_item:'stored-1'}),/no longer/);
  owner='bob';act('create',{name:'Bob'});act('enter',{zone:'littlebig-clockwork-shops',loadout:{player_info:{},inventory:[]}});place();
  assert.equal(zones.read(owner,c.id).bank.count,0);assert.throws(()=>zones.read(owner,alice.id),e=>e.status===404);
  assert.throws(()=>act('bank_deposit',{character_id:alice.id,fixture:'bank',slot:0}),e=>e.status===404);
 }finally{db.close();}
});
