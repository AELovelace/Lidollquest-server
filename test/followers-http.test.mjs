import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createQuestService} from '../server/service.mjs';

test('HTTP recruitment charges once after a lost wallet reply, survives restart, and guards party capacity',async()=>{
 const filename=join(mkdtempSync(join(tmpdir(),'quest-followers-')),'quest.sqlite');let time=Date.UTC(2026,8,25),service,base,lose=true,denied=false,diamonds=3;
 const tokens={alice:'a'.repeat(43),bob:'b'.repeat(43),cara:'c'.repeat(43)},ids={},receipts=new Map();
 const walletClient={authenticate:async token=>({owner:token,id:token,client:'lidollquest',coins:0,scope:'wallet:read wallet:write diamonds:read diamonds:write'}),diamonds:async(_,body)=>{
  if(denied)throw Object.assign(Error('Consent revoked'),{status:403});
  assert.equal(body.amount,1);let receipt=receipts.get(body.request_id);if(!receipt){if(!diamonds)throw Object.assign(Error('No diamonds'),{code:'insufficient_balance'});diamonds--;receipt={request_id:body.request_id};receipts.set(body.request_id,receipt);}if(lose){lose=false;throw Error('Lost receipt');}return receipt;
 }};
 const start=async()=>{service=createQuestService({filename,walletClient,now:()=>time,followerOptions:{enabled:true},log:()=>{}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+service.server.address().port;};
 const stop=async()=>{await new Promise(r=>service.server.close(r));};
 const read=async who=>(await fetch(base+'/zones?character_id='+ids[who],{headers:{Authorization:'Bearer '+tokens[who]}})).json();
 const send=async(who,input)=>{time+=1000;const response=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+tokens[who],'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:response.status,data:await response.json()};};
 const command=async(who,action,extra={})=>{const s=await read(who);return send(who,{action,request_id:randomUUID(),controller:who,character_id:ids[who],revision:s.character.revision,...extra});};
 try{
  await start();for(const who of Object.keys(tokens)){
   const created=await send(who,{action:'create',name:who,request_id:randomUUID(),controller:who});ids[who]=created.data.character.id;
   const entered=await command(who,'enter',{zone:'princess-rose',combat_version:3,follower_version:1,loadout:{player_info:{level:1,playerHealth:100,playerHealthMax:100,str:10,def:5},inventory:[]}});assert.equal(entered.status,200);
   assert.equal((await command(who,'dive_enter',{zone:'dive-quarters'})).status,200); // Mira now recruits from inside this dungeon's entrance.
  }
  let snap=await read('alice');const mira=snap.followers.entities.find(n=>n.npc==='merchant_mira');assert.ok(mira);
  for(const who of Object.keys(tokens))service.db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(mira.x,mira.y,time,ids[who]);
  const request={action:'follower_hire',npc:'merchant_mira',request_id:randomUUID(),controller:'alice',character_id:ids.alice,revision:snap.character.revision};
  const pending=await send('alice',request);assert.equal(pending.status,200,JSON.stringify(pending.data));assert.equal(pending.data.followers.active.status,'pending');assert.equal(diamonds,2);
  assert.equal((await command('bob','follower_hire',{npc:'merchant_mira'})).status,409);
  await stop();await start();denied=true;assert.equal((await read('alice')).followers.active.status,'pending','A later consent failure cannot release a possibly charged reservation');denied=false;
  const resumed=await read('alice');assert.equal(resumed.followers.active.status,'active');assert.equal(diamonds,2);assert.equal(receipts.size,1);
  assert.ok(JSON.parse(service.db.prepare('SELECT payment_receipt FROM quest_follower_hires WHERE id=?').get(resumed.followers.active.id).payment_receipt).request_id);
  const replay=await send('alice',request);assert.equal(replay.status,200);assert.equal(diamonds,2);
  assert.equal((await command('alice','party_invite',{member:ids.bob})).status,200);const invitation=(await read('bob')).partyInvitations[0].id;
  const joined=await command('bob','party_accept',{invitation});assert.equal(joined.status,200);assert.equal(joined.data.party.slots,3);assert.equal(joined.data.party.followers.length,1);
  assert.equal((await command('alice','party_invite',{member:ids.cara})).status,409);
  const before=await read('alice');const header=before.followers.active;assert.equal((await command('alice','follower_dismiss')).status,200);assert.equal((await read('alice')).followers.active,null);assert.equal((await read('bob')).party.slots,2);
  diamonds=0;assert.equal((await command('alice','follower_hire',{npc:'merchant_mira'})).status,200);const declined=await read('alice');assert.equal(declined.followers.active,null);assert.match(declined.character.lastResult.log[0],/declined/);assert.ok(header.expires>time);
 }finally{if(service?.server.listening)await stop();}
});
