import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {hubRooms,hubBlocked} from '../server/hubs.mjs';
import {createItemOrigins} from '../server/item-origins.mjs';

function fixture(hub){
 const db=new DatabaseSync(':memory:');let time=Date.UTC(2026,8,17),c;const paid=[];
 const zones=createQuestZones(db,{grant:()=>({owner:'alice',id:'alice',client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:(...a)=>paid.push(a),now:()=>time,diveOptions:{log:()=>{}}});
 const body=(action,extra={})=>({action,character_id:c?.id,revision:c?.revision,request_id:randomUUID(),controller:'alice',...extra});
 const send=input=>{time+=1000;const result=zones.act('token',input);c=result.character;return result;};
 const act=(action,extra)=>send(body(action,extra));
 act('create',{name:'Disposer'});
 act('enter',{zone:hub==='princess-rose'?hub+'-shops':hub,loadout:{player_info:{equipped_head:'cursed_crown'},inventory:[{item_id:'offline',name:'Old shirt',category:'torso'},{item_id:'quest_key',category:'quest_item'}]}}); // Honeydew's and LittleBigCity's dumpsters stand in the town itself; Rose keeps its Market Hall.
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const mutate=fn=>{const state=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);fn(state);db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),c.id);c=zones.read('token',c.id).character;};
 const discard=(slot=0,extra={})=>act('item_discard',{fixture:'dumpster',slot,item_id:c.loadout.inventory[slot]?.item_id,item_instance:c.loadout.inventory[slot]?.online_item??'',...extra});
 return {db,zones,act,body,send,place,mutate,discard,paid,get c(){return c;}};
}
for(const hub of ['princess-rose','honeydew-lantern','littlebig-clockwork'])test(hub+' dumpster is reachable; exact carried item removal is durable and free',()=>{
 const f=fixture(hub);try{
  const snapshot=f.zones.read('token',f.c.id),room=snapshot.zones.find(z=>z.id===snapshot.zone),bin=room.fixtures.find(f=>f.kind==='dumpster');
  const seen=new Set(),queue=[room.spawn];while(queue.length){const p=queue.shift(),key=p.x+','+p.y;if(seen.has(key)||p.x<1||p.y<1||p.x>=room.width-1||p.y>=room.height-1||room.walls?.[p.y]?.[p.x]||hubBlocked(room,p.x,p.y))continue;seen.add(key);for(const [x,y] of [[1,0],[-1,0],[0,1],[0,-1]])queue.push({x:p.x+x,y:p.y+y});}
  assert.ok(seen.has(bin.x+','+(bin.y+1)),'entrance reaches the dumpster approach');
  assert.throws(()=>f.discard(),/Stand next/);f.place(bin.x,bin.y+1);
  assert.throws(()=>f.discard(1),/Quest items/);
  assert.throws(()=>f.discard(0,{item_id:'different'}),/item changed/);
  const command=f.body('item_discard',{fixture:'dumpster',slot:0,item_id:'offline',item_instance:''});
  f.send(command);f.send(command);assert.deepEqual(f.c.loadout.inventory.map(i=>i.item_id),['quest_key']);
  assert.equal(f.c.loadout.player_info.equipped_head,'cursed_crown');assert.deepEqual(f.paid,[]);
  assert.equal(f.c.hubNotice,'Threw away Old shirt.');
 }finally{f.db.close();}
});
test('disposal rejects stale revisions, pending purchases/needs, combat and mismatched provenance; spent rights stay spent',()=>{
 const f=fixture('princess-rose');try{
  f.place(34,21);
  const old=f.body('item_discard',{fixture:'dumpster',slot:0,item_id:'offline',item_instance:''});
  f.act('loadout',{loadout:f.c.loadout});assert.throws(()=>f.send(old),/Character changed/);
  for(const [key,value,pattern] of [['pendingPurchase','reservation',/purchase is still/],['worldTurnDue',{id:'needs'},/pending exploration/],['run',{phase:'interval'},/Leave combat/]]){
   f.mutate(s=>s[key]=value);assert.throws(()=>f.discard(),pattern);f.mutate(s=>delete s[key]);
  }
  const item=createItemOrigins(f.db).mint(f.c.id,{item_id:'loot',name:'Loot',value:100,category:'torso'});
  f.mutate(s=>s.loadout.inventory.push(item));
  assert.throws(()=>f.discard(2,{item_instance:'wrong'}),/item changed/);
  f.discard(2);assert.equal(f.db.prepare('SELECT status FROM quest_item_origins WHERE id=?').get(item.online_item).status,'spent');
  const restored=structuredClone(f.c.loadout);restored.inventory.push(item);f.act('loadout',{loadout:restored});
  assert.equal(f.c.loadout.inventory.at(-1).online_item,undefined);assert.deepEqual(f.paid,[]);
 }finally{f.db.close();}
});
