import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthCache,authCacheMs,DEFAULT_AUTH_CACHE_MS} from '../server/auth-cache.mjs';

function harness(ttlMs=30000){ // Fake tracker that counts calls and fails on demand, with a hand-driven clock.
 let time=0,calls=0,failNext=null;
 const cache=createAuthCache(async token=>{calls++;if(failNext){const e=failNext;failNext=null;throw e;}return {owner:'owner-'+token,coins:calls};},{ttlMs,clock:()=>time});
 return {cache,calls:()=>calls,advance:ms=>time+=ms,fail:e=>failNext=e};
}

test('a login is reused within the TTL and asked again after it',async()=>{
 const h=harness();
 const first=await h.cache.lookup('tok');assert.equal(first.fresh,true);assert.equal(h.calls(),1);
 h.advance(29999);const again=await h.cache.lookup('tok');assert.equal(again.fresh,false);assert.equal(again.verified.owner,'owner-tok');assert.equal(h.calls(),1);
 h.advance(1);const renewed=await h.cache.lookup('tok');assert.equal(renewed.fresh,true);assert.equal(renewed.verified.coins,2);assert.equal(h.calls(),2);
});

test('simultaneous requests share one tracker call',async()=>{
 const h=harness();
 const [a,b]=await Promise.all([h.cache.lookup('tok'),h.cache.lookup('tok')]);
 assert.equal(h.calls(),1);assert.equal(a.fresh,true);assert.equal(b.fresh,false);
 a.verified.owner='edited';assert.equal((await h.cache.lookup('tok')).verified.owner,'owner-tok','callers get copies, never the shared identity');
});

test('failed logins are never remembered and forget ends a login early',async()=>{
 const h=harness();h.fail(Object.assign(Error('Bad token'),{status:401}));
 await assert.rejects(h.cache.lookup('tok'),/Bad token/);
 assert.equal((await h.cache.lookup('tok')).fresh,true);assert.equal(h.calls(),2);
 h.cache.forget('tok');assert.equal((await h.cache.lookup('tok')).fresh,true);assert.equal(h.calls(),3);
});

test('TTL 0 disables the cache and the env setting is validated',async()=>{
 const h=harness(0);await h.cache.lookup('tok');await h.cache.lookup('tok');assert.equal(h.calls(),2);assert.equal(h.cache.size(),0);
 assert.equal(authCacheMs(undefined),DEFAULT_AUTH_CACHE_MS);assert.equal(authCacheMs(''),DEFAULT_AUTH_CACHE_MS);assert.equal(authCacheMs('0'),0);assert.equal(authCacheMs('5000'),5000);
 assert.throws(()=>authCacheMs('-1'),/QUEST_AUTH_CACHE_MS/);assert.throws(()=>authCacheMs('abc'),/QUEST_AUTH_CACHE_MS/);assert.throws(()=>authCacheMs('600001'),/QUEST_AUTH_CACHE_MS/);
});

test('memory stays bounded by evicting expired then oldest logins',async()=>{
 let time=0;const cache=createAuthCache(async t=>({owner:t}),{ttlMs:1000,clock:()=>time,max:3});
 for(const t of ['a','b','c'])await cache.lookup(t);
 await cache.lookup('d');assert.equal(cache.size(),3,'oldest login evicted at the cap');
 time+=2000;await cache.lookup('e');assert.equal(cache.size(),1,'expired logins pruned first');
});

test('the gameplay gateway asks the tracker once per TTL and a remembered login never rewrites coins',async()=>{
 const {createQuestService}=await import('../server/service.mjs');const {randomUUID}=await import('node:crypto'); // Lazy imports keep the unit tests above free of the full service.
 const token='t'.repeat(43),owner='a'.repeat(64);let calls=0,coins=50;
 const service=createQuestService({now:()=>1000000,log:()=>{},walletClient:{authenticate:async()=>{calls++;return {owner,id:'grant-a',client:'lidollquest',coins};}}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+service.server.address().port;
 const act=async(action,extra={})=>(await fetch(url+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,controller:'test-window',request_id:randomUUID(),...extra})})).json(); // One gameplay POST through the real HTTP gateway.
 try{
  const created=await act('create',{name:'Cachey'});assert.equal(created.coins,50);
  service.db.prepare('UPDATE wallet_cache SET coins=? WHERE owner=?').run(75,owner);coins=10; // A newer receipt balance lands locally while the tracker's old answer is still remembered.
  const read=await (await fetch(url+'/zones?character_id='+created.character.id,{headers:{Authorization:'Bearer '+token}})).json();
  assert.equal(calls,1,'second request reused the remembered login');assert.equal(read.coins,75,'a remembered login leaves the newer balance alone');
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
