import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuestService} from '../server/service.mjs';
import {queueCraftingRewards,deliverCraftingRewards} from '../server/crafting-rewards.mjs';
import {randomUUID} from 'node:crypto';

test('full inventories defer rewards without minting or losing materials',()=>{
 const state={loadout:{inventory:Array.from({length:512},(_,i)=>({item_id:'full_'+i,category:'weapon'}))}};
 let minted=0;const origins={mint:(_id,item)=>{minted++;return {...item,online_item:'right_'+minted};}},c={id:'owner'};
 queueCraftingRewards(c,state,{wood:3},origins);assert.equal(minted,0);assert.equal(state.pendingCraftingMaterials.wood,3);
 state.loadout.inventory.pop();deliverCraftingRewards(c,state,origins);assert.equal(minted,3);assert.equal(state.loadout.inventory.length,512);assert.equal(state.loadout.inventory.at(-1).quantity,3);assert.equal(state.pendingCraftingMaterials,undefined);
 deliverCraftingRewards(c,state,origins);assert.equal(minted,3);
});

test('funded payouts survive lost replies, use valid wallet IDs and report only the unpaid balance',async()=>{
 const owner='a'.repeat(64),token='a'.repeat(43),receipts=new Map();let coins=50,lose=true;
 const service=createQuestService({walletClient:{authenticate:async()=>({owner,id:'grant',client:'lidollquest',coins}),credit:async(_token,input)=>{
  assert.match(input.request_id,/^[A-Za-z0-9_-]{1,80}$/);let result=receipts.get(input.request_id);if(!result){coins+=input.amount;result={balance:coins};receipts.set(input.request_id,result);}if(lose){lose=false;throw Error('Lost reply');}return result;
 }}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+service.server.address().port+'/zones',headers={Authorization:'Bearer '+token};
 service.db.prepare('INSERT INTO reward_outbox(id,owner,amount,reason) VALUES (?,?,?,?)').run('store-'+ 'b'.repeat(64),owner,25000,'Funded shop sale');
 try{
  const visit=async()=>{const response=await fetch(url,{headers});assert.equal(response.status,200);return response.json();};
  assert.equal((await visit()).pendingCoins,25000);assert.equal(coins,10049);
  assert.equal((await visit()).pendingCoins,15001);assert.equal(coins,10049);
  assert.equal((await visit()).pendingCoins,5002);assert.equal((await visit()).pendingCoins,0);assert.equal(coins,25050);assert.equal(receipts.size,3);
  const act=async(action,character,extra={})=>{const response=await fetch(url+'/action',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({action,character_id:character?.id,revision:character?.revision,request_id:randomUUID(),controller:'crafting-test',...extra})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data.character;};
  let c=await act('create',null,{name:'Delivery tester'});c=await act('enter',c,{zone:'honeydew-lantern',loadout:{player_info:{level:1,playerHealth:30,playerHealthMax:30,str:1,def:1},inventory:[]}});
  const saved=JSON.parse(service.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);saved.pendingCraftingMaterials={wood:2};service.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(saved),c.id);
  c=await act('loadout',c,{loadout:c.loadout});assert.equal(c.loadout.inventory.find(i=>i.item_id==='wood').quantity,2);assert.equal(c.pendingCraftingMaterials,undefined); // The stale imported bag cannot overwrite the newly delivered material.
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});

test('GM crafting authoring requires staff, saves validated sections and detects stale edits',async()=>{
 const staff='s'.repeat(43),player='p'.repeat(43);
 const service=createQuestService({gmEnabled:true,gmAllow:'',walletClient:{authenticate:async token=>({owner:(token===staff?'a':'b').repeat(64),id:'grant',client:'lidollquest',coins:0,gamemaster:token===staff})}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+service.server.address().port;
 const request=async(path,body,token=staff)=>{const response=await fetch(url+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 try{
  assert.equal((await request('/gm/crafting',null,player)).status,403);
  const initial=await request('/gm/crafting');assert.equal(initial.status,200);assert.equal(initial.body.data.recipes.length,96);
  const edit={action:'crafting_save',section:'tuning',revision:initial.body.revision,value:{...initial.body.data.tuning,burn_base:18},reason:'Test tuning'};
  assert.equal((await request('/gm/action',edit,player)).status,403);assert.equal((await request('/gm/action',edit)).status,200);assert.equal((await request('/gm/action',edit)).status,409);
  assert.equal((await request('/gm/action',{...edit,revision:1,section:'recipes',value:{}})).status,400);
  const after=await request('/gm/crafting');assert.equal(after.body.data.tuning.burn_base,18);assert.equal(after.body.revision,1);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
