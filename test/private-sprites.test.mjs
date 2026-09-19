import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPrivateSprites} from '../server/private-sprites.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {createQuestService} from '../server/service.mjs';
import {randomUUID} from 'node:crypto';

function fixture(provider){
 const db=new DatabaseSync(':memory:');let owner='alice',balance=10,lose=false,calls=0;
 const zones=createQuestZones(db,{grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:50}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 const receipts=new Map(),png=Buffer.alloc(40);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(2304,16);png.writeUInt32BE(64,20);
 const output={frames:36,png:png.toString('base64')};
 const walletClient={diamonds:async(_token,b)=>{if(!receipts.has(b.request_id)){if(b.kind==='debit'&&balance<1)throw Object.assign(Error('Insufficient'),{code:'insufficient_balance'});balance+=b.kind==='debit'?-1:1;receipts.set(b.request_id,{balance});}if(lose){lose=false;throw Error('Lost receipt');}return receipts.get(b.request_id);}};
 const make=()=>createPrivateSprites(db,{walletClient,provider:provider??(async()=>{calls++;return output;})});
 let sprites=make();zones.setPrivateSprites(sprites);
 const create=(avatar='player',request_id=randomUUID())=>zones.act('secret',{action:'create',name:'Doll',request_id,controller:'window',avatar}).character;
 const generate=(cid='',request_id=randomUUID())=>sprites.act(owner,'secret',{action:'generate',character_id:cid,request_id,prompt:'A knight in a violet coat'});
 return {db,zones,create,generate,receipts,output,get sprites(){return sprites;},get balance(){return balance;},get calls(){return calls;},set owner(v){owner=v;},lose(){lose=true;},empty(){balance=0;},restart(){sprites.close();sprites=make();zones.setPrivateSprites(sprites);},close(){sprites.close();db.close();}};
}
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Generation did not settle');};

test('generation debits once, survives lost responses, claims drafts once, and enforces per-character privacy',async()=>{
 const f=fixture();try{
  f.lose();await assert.rejects(()=>f.generate('','first'));assert.equal(f.balance,9);await f.sprites.recover('alice','new-token');
  await until(()=>f.sprites.list('alice').sprites[0]?.status==='ready');assert.equal(f.calls,1);
  const id=f.sprites.list('alice').sprites[0].id;await f.generate('','first');assert.equal(f.balance,9);
  const c=f.create(id,'creation');assert.equal(f.sprites.list('alice',c.id).used,1);assert.equal(f.sprites.list('alice').used,0);
  await f.generate('','second');await until(()=>f.sprites.list('alice').sprites[0]?.status==='ready');f.create(id,'creation');assert.equal(f.sprites.list('alice').used,1,'Creation replay must not claim another draft');
  const other=f.create();assert.throws(()=>f.sprites.authorize('alice',other.id,id),e=>e.status===403);assert.throws(()=>f.sprites.authorize('bob',c.id,id),e=>e.status===403);
  assert.throws(()=>f.sprites.asset('bob',id),e=>e.status===404);assert.equal(f.sprites.asset('alice',id).frames,36);
  f.db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?,?,?,?)').run('alice',c.id,'honeydew-lantern','alice','window',2,2,Date.now(),0);
  f.db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?,?,?,?)').run('bob','bob-character','honeydew-lantern','bob','window',3,2,Date.now(),0);
  assert.equal(f.sprites.asset('bob',id).frames,36,'Nearby players can render equipped art');
  f.db.prepare("UPDATE quest_presence SET zone='princess-rose' WHERE owner='bob'").run();assert.throws(()=>f.sprites.asset('bob',id),e=>e.status===404);
  await f.sprites.act('alice','secret',{action:'delete',character_id:c.id,sprite_id:id,request_id:'delete'});
  assert.equal(f.zones.read('secret',c.id).character.avatar,'player');assert.throws(()=>f.sprites.asset('alice',id));assert.equal(f.sprites.list('alice',c.id).used,0);
 }finally{f.close();}
});

test('pending jobs reserve all five slots and concurrent sixth requests cannot debit',async()=>{
 const pending=[];const f=fixture((prompt,signal)=>new Promise((resolve,reject)=>{pending.push(resolve);signal.addEventListener('abort',()=>reject(Error('Stopped')));}));
 try{const c=f.create();for(let i=0;i<5;i++)await f.generate(c.id,'slot-'+i);assert.equal(f.balance,5);assert.equal(f.sprites.list('alice',c.id).used,5);
  await assert.rejects(()=>f.generate(c.id,'sixth'),e=>e.status===409);assert.equal(f.balance,5);assert.equal(pending.length,1,'Only one provider job runs at a time');
  await assert.rejects(()=>f.sprites.act('alice','secret',{action:'delete',character_id:c.id,sprite_id:f.sprites.list('alice',c.id).sprites[0].id,request_id:'early'}),e=>e.status===409);
 }finally{f.close();}
});

test('failed generations refund once, and insufficient funds never call the provider',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('Provider failed');});try{
  await f.generate('','failed');await until(()=>f.sprites.list('alice').sprites[0].status==='refunded');assert.equal(f.balance,10);assert.equal(f.receipts.size,2);
  await f.generate('','failed');await f.sprites.recover('alice','secret');assert.equal(f.balance,10);assert.equal(calls,1);
  f.empty();await f.generate('','empty');assert.equal(f.sprites.list('alice').sprites.find(r=>r.status==='insufficient').status,'insufficient');assert.equal(calls,1);
 }finally{f.close();}
});

test('restart refunds an interrupted provider request instead of generating or charging again',async()=>{
 let calls=0;const f=fixture((_p,signal)=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Stopped'))));});
 try{await f.generate('','restart');await until(()=>calls===1);f.restart();await f.sprites.recover('alice','renewed');assert.equal(f.balance,10);assert.equal(calls,1);assert.equal(f.sprites.list('alice').sprites[0].status,'refunded');}finally{f.close();}
});

test('changed retry payloads, unowned characters and malformed strips are rejected',async()=>{
 const f=fixture(async()=>({frames:1,png:'bad'}));try{
  const c=f.create();await f.generate(c.id,'same');await assert.rejects(()=>f.sprites.act('alice','secret',{action:'generate',character_id:c.id,request_id:'same',prompt:'A different description'}),e=>e.status===409);
  f.owner='bob';await assert.rejects(()=>f.generate(c.id),e=>e.status===404);await until(()=>f.sprites.list('alice',c.id).sprites[0].status==='refunded');assert.equal(f.balance,10);
 }finally{f.close();}
});

test('HTTP generation requires diamond consent before any billing and preserves native method/origin checks',async()=>{
 let scope='wallet:read saves:read saves:write',charges=0;const service=createQuestService({spriteProvider:async()=>{throw Error('Fixture failure');},walletClient:{authenticate:async()=>({owner:'owner',id:'grant',client:'lidollquest',coins:50,scope}),diamonds:async(_token,body)=>{if(body.kind==='debit')charges++;return {balance:10};}},log:()=>{}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+service.server.address().port,headers={Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json'};
 const input={action:'generate',character_id:'',request_id:'http-generation',prompt:'A violet knight with a silver cape'};
 const post=extra=>fetch(url+'/sprites/action',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(input)});
 try{
  assert.equal((await post()).status,403);assert.equal(charges,0);
  scope+=' diamonds:write';assert.equal((await post({Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await fetch(url+'/sprites/action',{headers})).status,404);
  assert.equal((await post()).status,200);assert.equal(charges,1);
  await until(()=>service.db.prepare('SELECT status FROM quest_private_sprites').get()?.status==='refunded');
  assert.equal((await post()).status,200);assert.equal(charges,1);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
