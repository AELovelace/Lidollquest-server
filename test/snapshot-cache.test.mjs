import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cacheKey,parseKnown,elide,CACHED_SECTIONS} from '../server/snapshot-cache.mjs';
import {createQuestService} from '../server/service.mjs';

test('parseKnown opts in only when the parameter is present and ignores junk',()=>{
 assert.equal(parseKnown(null),null,'absent parameter keeps the classic response');
 assert.deepEqual([...parseKnown('')],[],'empty means "caching, but I hold nothing yet"');
 assert.deepEqual([...parseKnown('0123456789abcdef,nope,FEDCBA9876543210,0123456789abcde')],['0123456789abcdef'],'only 16 lower-case hex keys count');
 assert.equal(parseKnown(Array.from({length:500},(_,i)=>i.toString(16).padStart(16,'0')).join(',')).size,128,'bounded');
});

test('elide stubs only listed pieces and records every section key',()=>{
 const snapshot=()=>({zones:[{id:'a',walls:[[1]]},{id:'b',walls:[[0]]}],avatars:[{id:'player'}],rpp:{balance:3},coins:5});
 const full=snapshot(),keyA=cacheKey(full.zones[0]),keyAvatars=cacheKey(full.avatars);
 const out=elide(snapshot(),new Set([keyA,keyAvatars]));
 assert.deepEqual(out.zones[0],{id:'a',cacheKey:keyA,cached:true});
 assert.deepEqual(out.zones[1],{...full.zones[1],cacheKey:cacheKey(full.zones[1])},'unknown zones stay full and carry their key');
 assert.equal(out.avatars,undefined,'known section omitted');assert.deepEqual(out.rpp,full.rpp,'unknown section kept');
 assert.deepEqual(Object.keys(out.cacheKeys).sort(),['avatars','rpp'],'every present cached section gets a key');
 assert.equal(out.coins,5,'everything else untouched');
 assert.equal(cacheKey({id:'a',walls:[[1]]}),keyA,'keys are content hashes');
});

// What a well-behaved client does: remember every piece by key, fill stubs back in.
function merge(data,store){
 const next=new Map();
 data.zones=data.zones.map(z=>{if(z.cached){assert.ok(store.has(z.cacheKey),'client holds '+z.id);next.set(z.cacheKey,store.get(z.cacheKey));return store.get(z.cacheKey);}next.set(z.cacheKey,z);return z;});
 for(const [name,key] of Object.entries(data.cacheKeys)){if(name in data)next.set(key,data[name]);else{assert.ok(store.has(key),'client holds '+name);data[name]=store.get(key);next.set(key,data[name]);}}
 return next;
}
const strip=d=>{const {serverTime,cacheKeys,zones,...rest}=structuredClone(d);return {...rest,zones:zones.map(({cacheKey,...z})=>z)};}; // Compare content only.

test('through the real gateway, stubs plus the client copy rebuild the classic snapshot on GET and POST',async()=>{
 const token='k'.repeat(43),owner='b'.repeat(64);
 const service=createQuestService({now:()=>1000000,log:()=>{},walletClient:{authenticate:async()=>({owner,id:'grant-a',client:'lidollquest',coins:50})}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+service.server.address().port;
 const post=async(query,body)=>{const r=await fetch(url+'/zones/action'+query,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({controller:'w',request_id:randomUUID(),...body})});const text=await r.text();return {status:r.status,bytes:text.length,data:JSON.parse(text)};};
 const get=async query=>{const r=await fetch(url+'/zones'+query,{headers:{Authorization:'Bearer '+token}});const text=await r.text();return {status:r.status,bytes:text.length,data:JSON.parse(text)};};
 try{
  const created=(await post('',{action:'create',name:'Diet'})).data.character;
  const entered=await post('',{action:'enter',zone:'honeydew-lantern',character_id:created.id,revision:created.revision});assert.equal(entered.status,200);
  assert.equal(entered.data.capabilities.snapshotCache,true,'the server advertises support');assert.equal(entered.data.cacheKeys,undefined,'no opt-in, classic response');
  const q='?character_id='+created.id;
  const classic=await get(q);assert.equal(classic.data.cacheKeys,undefined);
  const first=await get(q+'&known=');assert.equal(first.status,200);assert.ok(first.data.cacheKeys,'opted in');
  assert.ok(first.data.zones.every(z=>!z.cached&&/^[0-9a-f]{16}$/.test(z.cacheKey)),'holding nothing: every piece in full, each with its key');
  let store=merge(structuredClone(first.data),new Map());
  const second=await get(q+'&known='+[...store.keys()].join(','));
  assert.ok(second.bytes<classic.bytes/5,`diet response ${second.bytes} bytes vs classic ${classic.bytes}`);
  assert.ok(second.data.zones.every(z=>z.cached),'unchanged zones come back as stubs');for(const name of CACHED_SECTIONS)if(name in classic.data)assert.ok(!(name in second.data),name+' omitted');
  const rebuilt=structuredClone(second.data);store=merge(rebuilt,store);assert.deepEqual(strip(rebuilt),strip(classic.data),'stubs + client copy == classic snapshot');
  const moved=await post('?known='+[...store.keys()].join(','),{action:'heartbeat',character_id:created.id,revision:rebuilt.character.revision});
  assert.equal(moved.status,200,JSON.stringify(moved.data).slice(0,200));assert.ok(moved.data.zones.some(z=>z.cached),'POST responses are dieted too');
  store=merge(moved.data,store);assert.ok(moved.data.zones.every(z=>!z.cached),'every stub resolved from the client copy');
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
