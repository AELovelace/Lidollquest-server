import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
import {createWalletClient} from '../server/wallet.mjs';
import {createServer} from 'node:http';
import {connect} from 'node:net';
const token='a'.repeat(43),owner='a'.repeat(64);
test('lobby conflicts log their precise reason without exposing wallet tokens or loadouts',async()=>{
 const logs=[],walletClient={authenticate:async()=>({owner,id:'grant-a',client:'lidollquest',coins:50})};
 const service=createQuestService({walletClient,now:()=>1000000,log:(...parts)=>logs.push(parts)});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+service.server.address().port;
 async function act(action,c,extra={}){const response=await fetch(url+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,character_id:c?.id,revision:c?.revision,controller:'test-window',request_id:randomUUID(),...extra})});return {status:response.status,body:await response.json()};}
 try{
  const created=await act('create',null,{name:'Tester'});
  const entered=await act('enter',created.body.character,{zone:'honeydew-lantern'});
  assert.equal(entered.status,200);assert.equal(logs.length,0);
  const stale=await act('enter',created.body.character,{zone:'honeydew-lantern',loadout:{note:'PRIVATE-INVENTORY'}});
  assert.equal(stale.status,409);
  assert.deepEqual(logs.at(-1),['quest_lobby_entry_conflict',stale.body.error_description]);
  const busy=await act('enter',entered.body.character,{zone:'honeydew-lantern',controller:'another-window'});
  assert.equal(busy.status,409);assert.match(logs.at(-1)[1],/another game window/);
  assert.doesNotMatch(JSON.stringify(logs),new RegExp(token+'|PRIVATE-INVENTORY'));
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
test('standalone HTTP service persists fights and recovers a lost payout after restart without double credit',async()=>{
 mkdirSync('artifacts',{recursive:true});const directory=mkdtempSync(resolve('artifacts/service-'));let now=1000000,balance=50,lose=true,calls=0;const receipts=new Map();
 const walletClient={authenticate:async secret=>{if(secret!==token)throw Object.assign(Error('Bad token'),{status:401});return {owner,id:'grant-a',client:'lidollquest',coins:balance};},credit:async(secret,body)=>{calls++;let receipt=receipts.get(body.request_id);if(!receipt){balance+=body.amount;receipt={request_id:body.request_id,currency:'LiDollCoin',amount:body.amount,balance};receipts.set(body.request_id,receipt);}if(lose){lose=false;throw Error('Lost response');}return receipt;}};
 let service,url;const start=async()=>{service=createQuestService({filename:resolve(directory,'quest.sqlite'),walletClient,now:()=>now,roll:()=>0});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+service.server.address().port;};
 const stop=()=>new Promise(r=>service.server.close(r));const act=async(action,c,extra={})=>{now+=500;const response=await fetch(url+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,character_id:c?.id,revision:c?.revision,controller:'test-window',request_id:randomUUID(),...extra})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
 await start();try{
  assert.equal((await fetch(url+'/zones')).status,401);assert.equal((await fetch(url+'/zones',{headers:{Authorization:'Bearer '+token,Origin:'https://evil.invalid'}})).status,403);
  const loadout={player_info:{playerHealth:83,playerHealthMax:140,str:6,def:3,level:4,note:'test'.repeat(1500)},inventory:[{item_id:'potion',name:'Potion'}],attack:11,player_mp:17,player_mp_max:20};
  let c=(await act('create',null,{name:'Tester',avatar:'objNPCGuard'})).character;c=(await act('enter',c,{zone:'honeydew-lantern',loadout})).character;c=(await act('start',c)).character;
  c=(await act('attack',c)).character;const hp=c.run.enemy.hp;
  await stop();await start();const recovered=await (await fetch(url+'/zones?character_id='+c.id,{headers:{Authorization:'Bearer '+token}})).json();assert.equal(recovered.character.run.enemy.hp,hp);assert.equal(recovered.character.avatar,'objNPCGuard');assert.equal(recovered.peers.find(p=>p.id===c.id).avatar,'objNPCGuard');
  assert.equal(recovered.character.loadout.inventory[0].item_id,'potion');assert.equal(recovered.character.loadout.player_mp,17);assert.equal(recovered.character.run.maxHp,140);
  while(c.run.phase==='fight')c=(await act('attack',c)).character;
  let result=await act('cashout',c);assert.equal(result.pendingCoins,5);assert.equal(balance,55);assert.equal(receipts.size,1);
  await stop();await start();result=await (await fetch(url+'/zones?character_id='+c.id,{headers:{Authorization:'Bearer '+token}})).json();assert.equal(result.pendingCoins,0);assert.equal(result.coins,55);assert.equal(receipts.size,1);assert.equal(calls,2);
  const raw=await new Promise((done,reject)=>{let text='';const socket=connect(service.server.address().port,'127.0.0.1',()=>socket.write('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));socket.on('data',b=>text+=b);socket.on('error',reject);socket.on('close',()=>done(text));});assert.match(raw,/HTTP\/1.1 400/);assert.equal((await fetch(url+'/health')).status,200);
 }finally{await stop();}
});
test('wallet transport signs the exact server award and refuses malformed receipts',async()=>{
 const key='synthetic-server-reward-key-0000000000000000000';let bad=false;
 const server=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const body=JSON.parse(text||'{}');assert.match(req.headers['x-reward-signature'],/^[a-f0-9]{64}$/);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({request_id:body.request_id,currency:'LiDollCoin',amount:bad?999:body.amount,balance:60}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const client=createWalletClient({baseUrl:'http://127.0.0.1:'+server.address().port+'/',key});const body={request_id:'test',kind:'credit',amount:10};assert.equal((await client.credit(token,body)).amount,10);bad=true;await assert.rejects(client.credit(token,body),/receipt/);}finally{await new Promise(r=>server.close(r));}
});
