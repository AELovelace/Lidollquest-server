import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createPrivateSprites} from '../server/private-sprites.mjs';
import {createQuestService} from '../server/service.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,state TEXT,revision INTEGER DEFAULT 0);CREATE TABLE quest_presence(owner TEXT,character_id TEXT,zone TEXT,seen INTEGER);INSERT INTO quest_characters VALUES ('char','alice','{}',0);`);
 const receipts=new Map();let balance=10,lose=false,providerCalls=0;
 const walletClient={diamonds:async(_token,b)=>{if(!receipts.has(b.request_id)){balance+=b.kind==='debit'?-1:1;receipts.set(b.request_id,{balance});}if(lose){lose=false;throw Error('Lost receipt');}return receipts.get(b.request_id);}};
 const make=()=>createPrivateSprites(db,{walletClient,provider:()=>{providerCalls++;throw Error('Retired provider was called');}});
 let sprites=make();
 function seed(status='ready',request='old',cid='char'){
  const id='private-'+request,prompt='A violet knight with a silver cape';
  db.prepare('INSERT INTO quest_private_sprites VALUES (?,?,?,?,?,?,?,?,?)').run(id,'alice',cid,request,JSON.stringify([cid,prompt]),prompt,status,status==='ready'?'stored-png':null,1);
  return {action:'generate',character_id:cid,request_id:request,prompt};
 }
 return {db,receipts,seed,get sprites(){return sprites;},get balance(){return balance;},get providerCalls(){return providerCalls;},lose(){lose=true;},restart(){sprites.close();sprites=make();},close(){sprites.close();db.close();}};
}

test('retired generation rejects a fresh request without inserting jobs, charging or calling a provider',async()=>{
 const f=fixture();try{
  await assert.rejects(()=>f.sprites.act('alice','token',{action:'generate',character_id:'char',request_id:'new',prompt:'A new character'}),e=>e.status===410&&e.code==='sprite_generator_retired');
  assert.equal(f.balance,10);assert.equal(f.providerCalls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM quest_private_sprites').get().n,0);
  assert.equal(f.sprites.list('alice','char').enabled,false);
 }finally{f.close();}
});

test('an ambiguous historical debit is replayed and refunded once even after a lost response',async()=>{
 const f=fixture();try{
  const input=f.seed('charging');f.lose();await assert.rejects(()=>f.sprites.recover('alice','token'));assert.equal(f.balance,9);
  await Promise.all([f.sprites.recover('alice','token'),f.sprites.recover('alice','token')]);
  await f.sprites.act('alice','token',input);f.restart();await f.sprites.recover('alice','token');
  assert.equal(f.balance,10);assert.equal(f.receipts.size,2);assert.equal(f.providerCalls,0);assert.equal(f.sprites.list('alice','char').latestStatus,'refunded');
  await assert.rejects(()=>f.sprites.act('alice','token',{...input,prompt:'Different request'}),e=>e.status===409);
 }finally{f.close();}
});

test('queued and running purchased jobs refund at restart without new generation',async()=>{
 const f=fixture();try{
  f.seed('queued','queued');f.seed('running','running');f.restart();await f.sprites.recover('alice','token');await f.sprites.recover('alice','token');
  assert.equal(f.receipts.size,2);assert.ok([...f.receipts.keys()].every(k=>k.startsWith('refund-sprite-')));assert.equal(f.providerCalls,0);
  assert.ok(f.sprites.list('alice','char').sprites.every(r=>r.status==='refunded'));
 }finally{f.close();}
});

test('retirement removes old artwork access, switches saved appearances and preserves creation receipts',async()=>{
 const f=fixture();try{
  const input=f.seed();const look={version:1,slots:{base:'piko_base'}};
  f.db.prepare('UPDATE quest_characters SET state=?').run(JSON.stringify({avatar:'private-old',look,creationAvatar:'private-old',creation:{old:true}}));
  f.restart();
  assert.throws(()=>f.sprites.asset('alice','private-old'),e=>e.status===410);assert.throws(()=>f.sprites.asset('bob','private-old'),e=>e.status===410);
  assert.throws(()=>f.sprites.authorize('alice','char','private-old'),e=>e.status===410);
  let row=f.db.prepare('SELECT state,revision FROM quest_characters').get(),state=JSON.parse(row.state);assert.equal(state.avatar,'look');assert.deepEqual(state.look,look);assert.equal(state.creationAvatar,'private-old');assert.deepEqual(state.creation,{old:true});assert.equal(row.revision,1);
  assert.equal(f.db.prepare('SELECT png FROM quest_private_sprites').get().png,null);
  await f.sprites.act('alice','token',input);assert.equal(f.receipts.size,0);f.restart();assert.equal(f.db.prepare('SELECT revision FROM quest_characters').get().revision,1);
 }finally{f.close();}
});

test('retirement preserves missing setup and denies old artwork even to nearby observers',()=>{
 const f=fixture();try{
  f.seed();f.db.prepare('UPDATE quest_characters SET state=?').run(JSON.stringify({avatar:'private-old'}));f.restart();
  const saved=JSON.parse(f.db.prepare('SELECT state FROM quest_characters').get().state);assert.equal(saved.avatar,'player');assert.equal(saved.look,undefined);
  const insert=f.db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?)');insert.run('alice','char','hub',Date.now());insert.run('bob','other','hub',Date.now());
  assert.throws(()=>f.sprites.asset('bob','private-old'),e=>e.status===410);
 }finally{f.close();}
});

test('HTTP rejects new generation even with diamond permission, and ordinary login recovers historical refunds',async()=>{
 let calls=0;const receipts=[];
 const service=createQuestService({authTtlMs:0,spriteProvider:()=>{calls++;},walletClient:{authenticate:async()=>({owner:'owner',id:'grant',client:'lidollquest',coins:50,scope:'wallet:read saves:read saves:write social:read diamonds:write'}),diamonds:async(_token,body)=>{receipts.push(body);return {balance:10};}},log:()=>{}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+service.server.address().port,headers={Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json'};
 try{
  const res=await fetch(url+'/sprites/action',{method:'POST',headers,body:JSON.stringify({action:'generate',character_id:'',request_id:'fresh',prompt:'A violet knight'})});assert.equal(res.status,410);assert.equal(calls,0);assert.equal(receipts.length,0);
  service.db.prepare('INSERT INTO quest_private_sprites VALUES (?,?,?,?,?,?,?,?,?)').run('private-pending','owner','','pending','[]','','refunding',null,1);
  assert.equal((await fetch(url+'/zones',{headers})).status,200);assert.equal(receipts.length,1);assert.equal(receipts[0].kind,'refund');
  assert.equal(receipts[0].original_id,'sprite-'+createHash('sha256').update('owner:pending').digest('hex'));
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
