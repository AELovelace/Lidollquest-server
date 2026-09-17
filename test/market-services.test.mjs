import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {hubRooms,hubData,hubBlocked} from '../server/hubs.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {createQuestService} from '../server/service.mjs';
import {removeCursedGear} from '../server/curse-removal.mjs';

test('all three enlarged markets have clear stairs and reachable services with valid full scenery footprints',()=>{
 for(const z of hubRooms.filter(z=>z.kind==='shops')){
  assert.deepEqual([z.width,z.height],[40,24]);
  assert.equal(z.fixtures.filter(f=>f.kind==='shop').length,8);
  assert.equal(z.fixtures.filter(f=>f.service==='curse_remove'&&f.price===20).length,1);
  assert.ok(z.fixtures.filter(f=>f.kind==='scenery').length>=25);
  const seen=new Set([z.spawn.x+','+z.spawn.y]),queue=[z.spawn];
  for(let i=0;i<queue.length;i++)for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
   const x=queue[i].x+dx,y=queue[i].y+dy,key=x+','+y;
   if(x<1||y<1||x>=z.width-1||y>=z.height-1||seen.has(key)||hubBlocked(z,x,y))continue;
   seen.add(key);queue.push({x,y});
  }
  assert.ok(seen.has(z.exit.x+','+z.exit.y));
  const occupied=new Set();
  for(const f of z.fixtures){
   if(f.solid!==false)for(let y=f.y;y<f.y+(f.span_h??1);y++)for(let x=f.x;x<f.x+(f.span_w??1);x++){
    assert.ok(x>0&&y>0&&x<z.width-1&&y<z.height-1,f.id+' bounds');
    assert.ok(!occupied.has(x+','+y),f.id+' overlaps solid scenery');occupied.add(x+','+y);
   }
   if(f.kind!=='scenery')assert.ok([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen.has((f.x+dx)+','+(f.y+dy))),f.id+' unreachable');
  }
 }
});

const gear=Object.values(hubData.equipment).find(i=>i.cursed&&i.category==='head');
const other=Object.values(hubData.equipment).find(i=>i.cursed&&i.category==='panties'&&i.is_diaper);
assert.ok(gear&&other);
const loadout=()=>({player_info:{str:20,def:15,dex:10,int:10,cha:10,shame:512,equipped_head:gear.item_id,equipped_panties:other.item_id,panties_bulk:other.bulk},inventory:[]});

test('curse removal validates proximity, slot, funds outcome and bag space, retains provenance and only removes the selected piece',()=>{
 const db=new DatabaseSync(':memory:');let c,time=Date.now();
 const zones=createQuestZones(db,{now:()=>time,grant:()=>({owner:'a',id:'a',client:'lidollquest'}),wallet:()=>({coins:100}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=1200;const r=zones.act('a',{action,character_id:c?.id,revision:c?.revision,controller:'a',request_id:randomUUID(),...extra});c=r.character;return r;};
 const refresh=()=>c=zones.read('a',c.id).character;
 try{
  act('create',{name:'Tester'});act('enter',{zone:'princess-rose-shops',loadout:loadout()});
  const input={fixture:'curse-remover',slot:'head',item_id:gear.item_id};
  assert.throws(()=>act('curse_remove',input),/Stand next/);
  db.prepare('UPDATE quest_presence SET x=9,y=21 WHERE character_id=?').run(c.id);
  assert.throws(()=>act('curse_remove',{...input,slot:'weapon'}),/currently equipped/);
  const before=structuredClone(c.loadout);act('curse_remove',input);zones.completePurchase(c.pendingPurchase,false);refresh();assert.deepEqual(c.loadout,before);
  const full={...c.loadout,inventory:Array.from({length:99},()=>({item_id:'adult_food'}))};act('loadout',{loadout:full});
  assert.throws(()=>act('curse_remove',input),/Inventory full/);act('loadout',{loadout:before});
  // A server-issued piece keeps its resale identity when it moves from equipment back into the bag.
  db.prepare("INSERT INTO quest_item_origins(id,character_id,item,price,status) VALUES (?,?,?,?,'held')").run('test-origin',c.id,JSON.stringify(gear),7);
  const state=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);state.equipmentOrigins={equipped_head:'test-origin'};
  db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),c.id);
  act('curse_remove',input);const pending=c.pendingPurchase;assert.equal(c.loadout.player_info.equipped_head,gear.item_id);
  assert.throws(()=>act('loadout',{loadout:before}),/settling/);
  zones.completePurchase(pending,true);zones.completePurchase(pending,true);refresh();
  assert.equal(c.loadout.player_info.equipped_head,'');assert.equal(c.loadout.player_info.equipped_panties,other.item_id);
  assert.equal(c.loadout.inventory.length,1);assert.equal(c.loadout.inventory[0].online_item,'test-origin');assert.equal(c.loadout.inventory[0].cursed,true);
  assert.equal(c.loadoutRevision,c.revision);
 }finally{db.close();}
});

test('dress removal releases both occupied slots once, and used cursed diaper removal follows disposal rules',()=>{
 const dress=Object.values(hubData.equipment).find(i=>i.cursed&&i.category==='dress');assert.ok(dress);
 const l=loadout();l.player_info.equipped_torso=dress.item_id;l.player_info.equipped_pants=dress.item_id;
 const r=removeCursedGear(l,'pants',dress.item_id,hubData.equipment,99);
 assert.equal(r.loadout.player_info.equipped_torso,'');assert.equal(r.loadout.player_info.equipped_pants,'');assert.equal(r.loadout.inventory.length,1);
 l.player_info.diaper_wet_absorbed=1;l.inventory=Array.from({length:99},()=>({item_id:'adult_food'}));
 const diaper=removeCursedGear(l,'panties',other.item_id,hubData.equipment,99);
 assert.equal(diaper.dispose,true);assert.equal(diaper.loadout.inventory.length,99);assert.equal(diaper.loadout.player_info.diaper_wet_absorbed,0);
});

test('20-coin curse debit survives a lost reply and service restart with one removal and one charge',async()=>{
 mkdirSync('artifacts',{recursive:true});const directory=mkdtempSync(resolve('artifacts/curse-service-'));let balance=40,lose=true,service,url,c;const receipts=new Map();
 const walletClient={authenticate:async()=>({owner:'c'.repeat(64),id:'a',client:'lidollquest',coins:balance}),credit:async(token,body)=>{
  assert.equal(body.amount,20);assert.equal(body.kind,'debit');
  if(!receipts.has(body.request_id)){balance-=body.amount;receipts.set(body.request_id,{balance});}
  if(lose)throw Error('Lost reply');return receipts.get(body.request_id);
 }};
 const start=async()=>{service=createQuestService({filename:resolve(directory,'quest.sqlite'),walletClient,log:()=>{}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+service.server.address().port;};
 const stop=()=>new Promise(r=>service.server.close(r));
 const send=async body=>{const r=await fetch(url+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));c=data.character;return data;};
 const body=(action,extra={})=>({action,character_id:c?.id,revision:c?.revision,controller:'a',request_id:randomUUID(),...extra});
 await start();try{
  await send(body('create',{name:'Cursed'}));await send(body('enter',{zone:'honeydew-lantern-shops',loadout:loadout()}));
  service.db.prepare('UPDATE quest_presence SET x=9,y=21 WHERE character_id=?').run(c.id);
  const request=body('curse_remove',{fixture:'curse-remover',slot:'head',item_id:gear.item_id});await send(request);
  assert.equal(balance,20);assert.ok(c.pendingPurchase);assert.equal(c.loadout.player_info.equipped_head,gear.item_id);
  await stop();lose=false;await start();await send(request);await send(request);
  assert.equal(balance,20);assert.equal(receipts.size,1);assert.equal(c.loadout.inventory.length,1);assert.equal(c.loadout.player_info.equipped_head,'');
 }finally{await stop();}
});
