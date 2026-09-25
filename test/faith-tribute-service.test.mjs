import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createQuestService} from '../server/service.mjs';
import {districtData} from '../server/hub-districts.mjs';

// A tribute to a new god paid in stars settles through the wallet's star debit (service.mjs settlePurchases), exactly
// like a companion diamond roll: one durable debit id, coins untouched, and a refused debit declines the switch.
test('switching gods with a 5-star tribute: debited once through the wallet, not enough stars declines',async()=>{
 mkdirSync('artifacts',{recursive:true});const directory=mkdtempSync(resolve('artifacts/faith-tribute-')),token='a'.repeat(43),owner='b'.repeat(64);
 let time=1000000,stars=7,service,url,c;const starDebits=[],coinDebits=[];
 const walletClient={
  authenticate:async()=>({owner,id:'a',client:'lidollquest',coins:100,scope:'wallet:read wallet:write stars:read stars:write'}),
  credit:async(_,body)=>{if(body.kind==='debit')coinDebits.push(body);return {request_id:body.request_id,currency:'LiDollCoin',amount:body.amount,balance:100};},
  stars:async(_,body)=>{assert.deepEqual([body.asset,body.kind],['stars','debit']);if(stars<body.amount)throw Object.assign(Error('Not enough stars.'),{code:'insufficient_balance',status:409});stars-=body.amount;starDebits.push(body);return {request_id:body.request_id,currency:'Stars',kind:'debit',amount:body.amount,balance:stars};}
 };
 const start=async()=>{service=createQuestService({filename:resolve(directory,'quest.sqlite'),walletClient,now:()=>time,log:()=>{}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+service.server.address().port;};
 const stop=()=>new Promise(r=>service.server.close(r));
 const send=async body=>{time+=1500;const r=await fetch(url+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const act=async(action,extra={})=>{const r=await send({action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});assert.equal(r.status,200,JSON.stringify(r.data));c=r.data.character;return r.data;};
 await start();try{
  await act('create',{name:'Pilgrim',creation:{patron:'orin'}});assert.equal(c.faith.god,'orin');
  await act('enter',{zone:'princess-rose-garden',loadout:{player_info:{level:12},inventory:[]}});
  const temple=districtData.districts.find(d=>d.hub==='princess-rose').temple,x=temple.x+Math.floor(temple.w/2)+2,y=temple.y+temple.h-1; // The Castle priest stands at (mid+2, back-1); stand just below.
  const db=new DatabaseSync(resolve(directory,'quest.sqlite'));db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);db.close();
  await act('faith_dedicate',{fixture:'priest',mode:'stars'});
  assert.equal(c.faith.god,'sable');assert.equal(c.faith.piety,0);assert.equal(stars,2);assert.deepEqual(starDebits.map(d=>d.amount),[5]);assert.equal(coinDebits.length,0); // Stars only; coins untouched.
 }finally{await stop();}
 await start();try{ // Not enough stars: the vow is refused and nothing changes.
  const db=new DatabaseSync(resolve(directory,'quest.sqlite'));const row=db.prepare('SELECT id,state FROM quest_characters').get(),state=JSON.parse(row.state);state.faith.god='orin';db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),row.id);db.close();
  c=(await send({action:'enter',controller:'a',request_id:randomUUID(),character_id:row.id,revision:(await (await fetch(url+'/zones',{headers:{Authorization:'Bearer '+token}})).json()).characters[0].revision,zone:'princess-rose-garden'})).data.character;
  await act('faith_dedicate',{fixture:'priest',mode:'stars'});
  assert.equal(c.faith.god,'orin');assert.match(c.hubNotice,/Not enough stars/);assert.equal(stars,2);
 }finally{await stop();}
});
