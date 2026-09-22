import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
const token='a'.repeat(43),onlineToken='b'.repeat(43),owner='c'.repeat(64),stranger='d'.repeat(64);

test('character endpoint is protected and serves one owner public inspection sheet',async()=>{
 let now=1000000;
 const service=createQuestService({onlineToken,now:()=>now,walletClient:{authenticate:async secret=>{
  if(secret!==token)throw Object.assign(Error('No account'),{status:401});
  return {owner,id:'grant',client:'lidollquest',coins:0};
 }}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+service.server.address().port;
 const sheet=async(query='account_id='+owner,headers={Authorization:'Bearer '+onlineToken})=>fetch(base+'/integrations/mommybot/character?'+query,{headers});
 let character;
 async function act(action,extra={}){
  now+=500;const body={action,character_id:character?.id,revision:character?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));character=result.character;return body;
 }
 try{
  assert.equal((await sheet('account_id='+owner,{})).status,401);
  assert.equal((await sheet('account_id='+owner,{Authorization:'Bearer '+token})).status,401);
  assert.equal((await sheet('account_id='+owner,{Authorization:'Bearer '+onlineToken,Origin:'https://browser.invalid'})).status,401);
  assert.equal((await sheet('')).status,400);
  assert.equal((await sheet('account_id='+stranger)).status,404); // An owner with no characters is indistinguishable from an absent one.
  await act('create',{name:'Friend'});
  const response=await sheet();assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.name,'Friend');
  assert.equal(body.character_id,character.id);
  assert.ok(Number.isSafeInteger(body.level)&&body.level>=1);
  assert.ok(['fighter','mage','diplomat'].includes(body.class_id));
  assert.equal(body.equipment.length,16);
  assert.ok(body.equipment.every(slot=>typeof slot.slot==='string'&&typeof slot.name==='string'));
  assert.ok(body.player_info&&typeof body.player_info.gender==='string');
  assert.deepEqual(body.characters,[{id:character.id,name:'Friend'}]);
  assert.equal(body.online,false);
  assert.equal(body.account_id,undefined);
  const {portrait_png,...text}=body; // A base64 blob would make the substring check below flaky, and it carries no field names.
  assert.doesNotMatch(JSON.stringify(text),new RegExp(owner+'|grant|inventory|coins|secret'));

  // The TQ/DQ paperdoll artwork was purged, so the sheet never carries a portrait.
  assert.equal(portrait_png,null);
  assert.equal(body.portrait_size,null);
  await act('enter',{zone:'honeydew-lantern'});
  assert.equal((await(await sheet()).json()).online,true);
  assert.equal((await sheet('account_id='+owner+'&character_id=missing')).status,404);
  assert.equal((await sheet('account_id='+stranger+'&character_id='+character.id)).status,404); // Another account cannot name a character it does not own.
  assert.equal((await fetch(base+'/integrations/mommybot/character?account_id='+owner,{method:'POST',headers:{Authorization:'Bearer '+onlineToken}})).status,405);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});

test('disabled companion credential exposes no character information',async()=>{
 const {server}=createQuestService({onlineToken:'',walletClient:{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/integrations/mommybot/character?account_id=x')).status,503);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
