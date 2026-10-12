import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

test('full character uploads over 256 KiB fit gameplay transport and snapshots; oversized envelopes remain bounded',async()=>{
 const service=createQuestService({walletClient:{authenticate:async()=>({owner:'large-http',id:'grant',client:'lidollquest',coins:0})}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+service.server.address().port,headers={Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json'};
 const post=(route,body)=>fetch(url+route,{method:'POST',headers,body:typeof body==='string'?body:JSON.stringify(body)});
 try{
  const created=await (await post('/zones/action',{action:'create',controller:'large-http',request_id:randomUUID(),name:'Large HTTP'})).json();
  const result=await post('/zones/action',{action:'enter',controller:'large-http',request_id:randomUUID(),character_id:created.character.id,revision:created.character.revision,zone:'honeydew-lantern',loadout:{player_info:{note:'x'.repeat(450*1024)},inventory:[]}});
  const body=await result.text();assert.equal(result.status,200,body.slice(0,400));assert.ok(Buffer.byteLength(body)<1024*1024,'the full snapshot fits the existing gateway response bound');
  assert.equal(JSON.parse(body).character.loadout.player_info.note.length,450*1024);
  const exact=JSON.stringify({padding:'x'.repeat(768*1024-14)});assert.equal(Buffer.byteLength(exact),768*1024);
  assert.notEqual((await post('/zones/action',exact)).status,413); // The service must parse a bounded envelope before semantic validation rejects its action.
  assert.equal((await post('/zones/action',exact+' ')).status,413);
  assert.equal((await post('/cloud/action',JSON.stringify({padding:'x'.repeat(256*1024)}))).status,413);
 }finally{service.server.closeAllConnections();await new Promise(r=>service.server.close(r));}
});
