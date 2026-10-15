import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiPool,parseNodes,nodesFromEnv} from '../server/ai-pool.mjs';

// ai-pool.mjs: Pip and the companions share every AI node. Least busy x fastest healthy node first, one failover on
// network trouble / timeout / 5xx, 4xx answers go straight back, health probes bring nodes back and read slot counts.

const A='http://47.51.162.106:9092',B='http://192.168.1.188:9092';
const refused=url=>Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED',message:'connect ECONNREFUSED '+url}});
function harness(route,{nodes=parseNodes(A+','+B),...opts}={}){ // route(url,init) -> Response | Promise; every call is recorded.
 let time=1000;const calls=[];
 const pool=createAiPool({nodes,key:'k'.repeat(32),now:()=>time,log:()=>{},fetcher:async(url,init)=>{calls.push({url:String(url),init});return route(String(url),init);},...opts});
 return {pool,calls,advance:ms=>{time+=ms;},hosts:()=>calls.map(c=>new URL(c.url).host)};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('nodes come from a comma list; model URLs default to the same machine and can be overridden per node',()=>{
 assert.deepEqual(parseNodes(' http://a.test:9092/ , http://b.test:9092','|,http://b.test:7000|http://b.test:7001'),[
  {base:'http://a.test:9092',llm:'http://a.test:9090',classifier:'http://a.test:9091'},
  {base:'http://b.test:9092',llm:'http://b.test:7000',classifier:'http://b.test:7001'}]);
 assert.deepEqual(parseNodes(''),[]);
 assert.equal(nodesFromEnv({}),null,'unset: callers keep their legacy single URLs');
 assert.equal(nodesFromEnv({NPC_RAG_NODES:A+','+B}).length,2);
 assert.equal(createAiPool({nodes:[]}).configured,false);
});

test('requests go to the least busy node and carry the npc-rag key; model calls carry none',async()=>{
 const gate=deferred();
 const h=harness(url=>url.startsWith(A)?gate.promise.then(()=>Response.json({reply:'a'})):Response.json({reply:'b'}));
 const first=h.pool.request('/v1/npc/chat',{message:'hi'}); // Both idle and equal: A (first listed) wins the tie.
 await new Promise(r=>setImmediate(r));
 const second=await h.pool.request('/v1/npc/chat',{message:'hi'}); // A is busy now, so B answers.
 assert.equal(second.node,'192.168.1.188:9092');assert.equal(second.body.reply,'b');
 gate.resolve();assert.equal((await first).body.reply,'a');
 assert.equal(h.calls[0].init.headers['X-Api-Key'],'k'.repeat(32));assert.equal(h.calls[0].init.headers.Authorization,'Bearer '+'k'.repeat(32));
 await h.pool.model('classifier','/v1/chat/completions',{});
 assert.match(h.calls.at(-1).url,/:9091\/v1\/chat\/completions$/);assert.equal(h.calls.at(-1).init.headers['X-Api-Key'],undefined,'model servers never see the key');
});

test('a refused or 5xx node fails over once, sits out, and a health probe brings it back',async()=>{
 let aDown=true;
 const h=harness(url=>{
  if(url.startsWith('http://47.51.162.106')){if(aDown)throw refused(url);return url.endsWith('/props')?Response.json({total_slots:8}):Response.json({ok:true,llm:true,reply:'a'});}
  return Response.json({ok:true,llm:true,reply:'b'});
 });
 const res=await h.pool.request('/v1/npc/chat',{});
 assert.equal(res.body.reply,'b');assert.deepEqual(h.hosts(),['47.51.162.106:9092','192.168.1.188:9092'],'A tried first, then B once');
 const view=h.pool.view().find(n=>n.host==='47.51.162.106:9092');assert.equal(view.healthy,false);assert.match(view.lastError,/fetch failed/);
 h.calls.length=0;await h.pool.request('/v1/npc/chat',{});assert.deepEqual(h.hosts(),['192.168.1.188:9092'],'a down node is skipped while healthy ones remain');
 aDown=false;await h.pool.probe();
 const back=h.pool.view().find(n=>n.host==='47.51.162.106:9092');assert.equal(back.healthy,true);assert.equal(back.slots,8,'slot count read from llama.cpp /props');
 const five=harness(url=>url.startsWith(A)?new Response('{}',{status:503}):Response.json({reply:'b'}));
 assert.equal((await five.pool.request('/x',{})).body.reply,'b','5xx moves on too');
});

test('4xx answers go back to the caller without failover; every node failing throws with the last URL',async()=>{
 const h=harness(()=>Response.json({detail:'busy'},{status:429}));
 const res=await h.pool.request('/v1/npc/chat',{});assert.equal(res.status,429);assert.equal(h.calls.length,1);
 const dead=harness(url=>{throw refused(url);});
 await assert.rejects(dead.pool.request('/v1/npc/chat',{}),e=>e.cause?.code==='ECONNREFUSED'&&/192\.168\.1\.188:9092\/v1\/npc\/chat$/.test(e.url));
 dead.calls.length=0;await assert.rejects(dead.pool.request('/v1/npc/chat',{}));
 assert.equal(dead.calls.length,2,'with every node down both are still tried, least recently failed first');
 assert.deepEqual(dead.hosts(),['47.51.162.106:9092','192.168.1.188:9092']);
});

test('a single legacy node is always tried, even after it failed',async()=>{
 let ok=false;const h=harness(url=>{if(!ok)throw refused(url);return Response.json({reply:'back'});},{nodes:parseNodes(A)});
 await assert.rejects(h.pool.request('/x',{}));ok=true;
 assert.equal((await h.pool.request('/x',{})).body.reply,'back');assert.equal(h.pool.view()[0].healthy,true,'a success clears the down mark');
});

test('slow nodes lose traffic: latency is measured and weighs into the choice',async()=>{
 let time=0;const calls=[];
 const pool=createAiPool({nodes:parseNodes(A+','+B),now:()=>time,log:()=>{},fetcher:async url=>{calls.push(String(url));time+=String(url).startsWith(A)?9000:300;return Response.json({});}});
 await pool.request('/x',{});await pool.request('/x',{}); // A once (slow), then B once (fast).
 calls.length=0;for(let i=0;i<4;i++)await pool.request('/x',{});
 assert.ok(calls.every(u=>u.startsWith(B)),'the fast node takes the idle traffic');
 const [a,b]=pool.view();assert.ok(a.latencyMs>b.latencyMs);
});

test('health probes: npc-rag up but its model down counts as down; tick() probes at most every 30 s',async()=>{
 const h=harness(url=>url.endsWith('/health')?Response.json({ok:true,llm:!url.startsWith(A)}):Response.json({total_slots:4}));
 await h.pool.tick();const [a,b]=h.pool.view();
 assert.equal(a.healthy,false);assert.match(a.lastError,/model unreachable/);assert.equal(b.healthy,true);
 const n=h.calls.length;await h.pool.tick();assert.equal(h.calls.length,n,'not due yet');
 h.advance(30000);await h.pool.tick();assert.ok(h.calls.length>n,'due again');
});

test('timeouts fail over, oversized replies are refused, and close() aborts in-flight calls',async()=>{
 const h=harness((url,init)=>url.startsWith(A)?new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason))):Response.json({reply:'b'}));
 const res=await h.pool.request('/x',{},{timeoutMs:20});assert.equal(res.body.reply,'b');
 assert.match(h.pool.view()[0].lastError,/timed out after 20 ms/);
 const big=harness(()=>new Response('x'.repeat(70000)),{nodes:parseNodes(A)});
 await assert.rejects(big.pool.request('/x',{}),/too large/);
 const hang=harness((url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})))),{nodes:parseNodes(A)});
 const pending=hang.pool.request('/x',{},{timeoutMs:60000});hang.pool.close();
 await assert.rejects(pending,/aborted/);await assert.rejects(hang.pool.request('/x',{}),/closed/);
});

test('a node that rejects the key (401/403) is benched and the other node answers',async()=>{
 const h=harness(url=>url.startsWith(A)?Response.json({detail:'missing or wrong API key'},{status:401}):Response.json({reply:'b'}));
 const res=await h.pool.request('/v1/companion/chat',{});assert.equal(res.body.reply,'b');assert.equal(res.status,200);
 const a=h.pool.view().find(n=>n.host==='47.51.162.106:9092');assert.equal(a.healthy,false);assert.match(a.lastError,/401.*NPC_RAG_KEY/);
 const forbidden=harness(url=>url.startsWith(A)?new Response('{}',{status:403}):Response.json({reply:'b'}));
 assert.equal((await forbidden.pool.request('/x',{})).body.reply,'b');
 const both=harness(()=>Response.json({},{status:401}));await assert.rejects(both.pool.request('/x',{}),/401/,'every node rejecting the key still surfaces as an error');
});

test('a "local busy" ambient line moves to the other node instead of being skipped, and the busy node stays healthy (2026-10-15)',async()=>{
 const h=harness(url=>url.startsWith(A)?new Response(JSON.stringify({detail:'local_busy'}),{status:429}):new Response(JSON.stringify({reply:'hi',lane:'local'}),{status:200}));
 const first=await h.pool.request('/v1/companion/chat',{},{busyStatuses:[429]});
 assert.equal(first.status,200);assert.deepEqual(h.hosts(),['47.51.162.106:9092','192.168.1.188:9092'],'tried the busy node, then the free one');
 assert.ok(h.pool.view().every(n=>n.healthy),'busy is not sick: nobody is marked down');
 const plain=harness(url=>new Response(JSON.stringify({detail:'local_busy'}),{status:429}));
 assert.equal((await plain.pool.request('/v1/companion/chat',{})).status,429,'without busyStatuses a 4xx still comes straight back');assert.equal(plain.calls.length,1);
 const both=harness(()=>new Response(JSON.stringify({detail:'local_busy'}),{status:429}));
 assert.equal((await both.pool.request('/v1/companion/chat',{},{busyStatuses:[429]})).status,429,'every node full: the caller skips the line');assert.equal(both.calls.length,2);
});
