import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
const token='a'.repeat(43),onlineToken='b'.repeat(43),owner='c'.repeat(64);

test('join feed is protected, publishes authenticated arrivals and suppresses reads, heartbeats and reconnects',async()=>{
 let now=1000000;
 const service=createQuestService({onlineToken,now:()=>now,walletClient:{authenticate:async secret=>{
  if(secret!==token)throw Object.assign(Error('No account'),{status:401});
  return {owner,id:'grant',client:'lidollquest',coins:0};
 }}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+service.server.address().port;
 const feed=async(after=0,headers={Authorization:'Bearer '+onlineToken})=>fetch(base+'/integrations/mommybot/joins?after='+after,{headers});
 let character;
 async function act(action,extra={}){
  now+=500;const body={action,character_id:character?.id,revision:character?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));character=result.character;return body;
 }
 try{
  assert.equal((await feed(0,{})).status,401);
  assert.equal((await feed(0,{Authorization:'Bearer '+token})).status,401);
  assert.equal((await feed(0,{Authorization:'Bearer '+onlineToken,Origin:'https://browser.invalid'})).status,401);
  assert.equal((await fetch(base+'/zones/action',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"enter"}'})).status,401);
  await act('create',{name:'Friend'});assert.equal((await(await feed()).json()).events.length,0);
  const entered=await act('enter',{zone:'honeydew-lantern'});
  let page=await(await feed()).json();assert.equal(page.events.length,1);assert.equal(page.events[0].name,'Friend');assert.equal(page.events[0].online,1);
  assert.doesNotMatch(JSON.stringify(page),new RegExp(owner+'|grant|controller|inventory|account_id'));
  await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(entered)});
  await act('heartbeat');await act('leave');await act('enter',{zone:'honeydew-lantern'});
  assert.equal((await(await feed()).json()).events.length,1);
  now+=121000;await act('enter',{zone:'honeydew-lantern'});
  page=await(await feed(1)).json();assert.equal(page.events.length,1);assert.equal(page.events[0].id,2);assert.equal(page.has_more,false);
  await act('leave');assert.equal((await(await feed(1)).json()).events[0].online,0);
  assert.equal((await feed('bad')).status,400);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});

test('disabled join feed exposes no player information',async()=>{
 const {server}=createQuestService({onlineToken:'',walletClient:{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/integrations/mommybot/joins')).status,503);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('a resumed session reads as a return while a fresh sign-in or an explicit leave reads as a join',async()=>{
 let now=1000000,grantId='grant-a';
 const service=createQuestService({authTtlMs:0,onlineToken,now:()=>now,walletClient:{authenticate:async secret=>{
  if(secret!==token)throw Object.assign(Error('No account'),{status:401});
  return {owner,id:grantId,client:'lidollquest',coins:0};
 }}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+service.server.address().port;
 const feed=async(after=0)=>(await fetch(base+'/integrations/mommybot/joins?after='+after,{headers:{Authorization:'Bearer '+onlineToken}})).json();
 let character;
 async function act(action,extra={}){
  now+=500;const body={action,character_id:character?.id,revision:character?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));character=result.character;return body;
 }
 try{
  await act('create',{name:'Friend'});
  await act('enter',{zone:'honeydew-lantern'});
  let page=await feed();
  assert.equal(page.events.length,1);assert.equal(page.events[0].kind,'join'); // First arrival of all.
  let cursor=page.next_cursor;

  now+=121000; // The tab slept: presence went stale, but nothing was ever left or signed out.
  await act('enter',{zone:'honeydew-lantern'});
  page=await feed(cursor);
  assert.equal(page.events.length,1);assert.equal(page.events[0].kind,'return');
  cursor=page.next_cursor;

  await act('leave');
  now+=121000;
  await act('enter',{zone:'honeydew-lantern'});
  page=await feed(cursor);
  assert.equal(page.events.length,1);assert.equal(page.events[0].kind,'join'); // Leaving and coming back is a real arrival.
  cursor=page.next_cursor;

  now+=121000;grantId='grant-b'; // A fresh sign-in issues a new grant for the same account.
  await act('enter',{zone:'honeydew-lantern'});
  page=await feed(cursor);
  assert.equal(page.events.length,1);assert.equal(page.events[0].kind,'join');
  cursor=page.next_cursor;

  now+=121000;
  await act('enter',{zone:'honeydew-lantern'});
  await act('heartbeat');await act('heartbeat');
  page=await feed(cursor);
  assert.equal(page.events.length,1);assert.equal(page.events[0].kind,'return'); // Heartbeats never announce anything by themselves.
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
