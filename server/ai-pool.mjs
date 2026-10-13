// AI node pool: Pip (tutor.mjs) and the companions (follower-chat.mjs) share every configured AI server.
// A node is one machine running npc-rag (9092) beside Sakura's main model (9090) and classifier (9091).
//   NPC_RAG_NODES=http://47.51.162.106:9092,http://192.168.1.188:9092        (npc-rag on each node)
//   NPC_RAG_NODE_MODELS=<llm>|<classifier>,<llm>|<classifier>                  (optional, same order; default: same host :9090|:9091)
// Each request goes to the healthy node with the lowest (in flight + 1) / slots x latency. A timeout, network error or 5xx
// marks that node down for DOWN_MS and the request moves to the next node once. With every node down the least recently
// failed one is still tried, so the game never goes quiet just because a probe was unlucky.
const DEFAULT_SLOTS=4;        // llama.cpp --parallel; replaced by /props total_slots once a probe reaches the model.
const DOWN_MS=30000;          // A failed node sits out this long (or until a health probe says it is back).
const HEALTH_MS=30000;        // tick() probes every node's /health at most this often.
const START_LATENCY=1500;     // ms; a fresh node's guess until real replies are measured.
const ALPHA=.3;               // Latency EWMA weight of the newest reply.
const MAX_BYTES=65536;        // Replies are small JSON; anything bigger is refused.

const trim=u=>String(u??'').trim().replace(/\/+$/,''); // Base URLs without trailing slashes.
export function parseNodes(nodes='',models=''){ // Comma list of npc-rag base URLs -> [{base,llm,classifier}].
 const bases=String(nodes??'').split(',').map(trim).filter(Boolean),extra=String(models??'').split(',');
 return bases.map((base,i)=>{const [llm,classifier]=(extra[i]??'').split('|').map(trim),u=new URL(base),host=u.protocol+'//'+u.hostname;return {base,llm:llm||host+':9090',classifier:classifier||host+':9091'};}); // Model ports default to the same machine.
}
export function nodesFromEnv(env=process.env){return env.NPC_RAG_NODES?parseNodes(env.NPC_RAG_NODES,env.NPC_RAG_NODE_MODELS):null;} // null = not set: callers keep their legacy single-URL settings.

async function readJson(res,maxBytes){ // Bounded body read; plain test doubles with only json() still work.
 if(!res.body?.[Symbol.asyncIterator])return typeof res.json==='function'?await res.json().catch(()=>({})):{};
 const chunks=[];let size=0;for await(const part of res.body){size+=part.length;if(size>maxBytes)throw Error('AI response too large');chunks.push(Buffer.from(part));}
 const text=Buffer.concat(chunks).toString('utf8');try{return text?JSON.parse(text):{};}catch{if(res.ok)throw Error('AI sent invalid JSON');return {};} // A broken success is a failure; a broken error page is just an error status.
}

export function createAiPool({nodes=[],key='',fetcher=globalThis.fetch,now=Date.now,log=console.warn,downMs=DOWN_MS,healthMs=HEALTH_MS,maxBytes=MAX_BYTES}={}){
 const pool=nodes.map(n=>({...n,host:new URL(n.base).host,inFlight:0,slots:DEFAULT_SLOTS,latency:START_LATENCY,downUntil:0,failures:0,lastError:'',lastOk:0})); // Live per-node state.
 const controllers=new Set();let lastProbe=-Infinity,closed=false;
 const healthy=(n,t=now())=>n.downUntil<=t;
 const score=n=>(n.inFlight+1)/n.slots*n.latency; // Lower is better: a free fast node beats a busy slow one.
 function order(){ // Healthy nodes best-first, then down nodes by who failed longest ago.
  const t=now();return [...pool.filter(n=>healthy(n,t)).sort((a,b)=>score(a)-score(b)),...pool.filter(n=>!healthy(n,t)).sort((a,b)=>a.downUntil-b.downUntil)];
 }
 function down(n,error){n.downUntil=now()+downMs;n.failures++;n.lastError=String(error?.message??error).slice(0,200);} // Sits out; a probe or a later success brings it back.
 function up(n,ms){if(ms!=null)n.latency=n.latency*(1-ALPHA)+ms*ALPHA;n.downUntil=0;n.failures=0;n.lastError='';n.lastOk=now();}

 async function call(n,url,body,{timeoutMs=12000,signal=null,headers={},method='POST'}={}){ // One HTTP call to one node; throws on network trouble or timeout.
  const controller=new AbortController();controllers.add(controller);
  const onAbort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',onAbort,{once:true}); // The caller's close() reaches this request too.
  const timer=setTimeout(()=>controller.abort(Object.assign(Error('timed out after '+timeoutMs+' ms'),{name:'TimeoutError'})),timeoutMs);timer.unref?.(); // Never hold the process open for a stuck AI host.
  n.inFlight++;const start=now();
  try{
   const res=await fetcher(url,{method,redirect:'error',headers:{...(method==='POST'?{'Content-Type':'application/json'}:{}),...headers},...(method==='POST'?{body:JSON.stringify(body)}:{}),signal:controller.signal});
   const json=await readJson(res,maxBytes);
   return {status:res.status,ok:!!res.ok,body:json,ms:now()-start};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);controllers.delete(controller);n.inFlight--;}
 }

 async function run(urlOf,body,{attempts=2,auth=false,...opts}={}){ // Try the best node, then the next one once; 4xx answers go straight back to the caller.
  if(closed)throw Error('AI pool closed');
  const headers=auth&&key?{'X-Api-Key':key,Authorization:'Bearer '+key}:{}; // npc-rag accepts either header; model servers get no key.
  let last=null;
  for(const n of order().slice(0,Math.max(1,attempts))){
   const url=urlOf(n);
   try{
    const res=await call(n,url,body,{...opts,headers});
    if(res.status>=500||res.status===401||res.status===403){last=Object.assign(Error('AI answered '+res.status+(res.status<500?' (wrong or missing NPC_RAG_KEY on this node?)':'')),{status:res.status,url,node:n.host});down(n,last);continue;} // Sick or misconfigured (prod 2026-10-13: node B rejected the key): move on.
    if(res.ok)up(n,res.ms);
    return {...res,node:n.host,url};
   }catch(error){
    if(opts.signal?.aborted)throw error; // Shutting down: no failover.
    last=Object.assign(error instanceof Error?error:Error(String(error)),{url,node:n.host});down(n,last);
   }
  }
  throw last??Object.assign(Error('no AI nodes configured'),{url:''});
 }

 async function probe(){ // Health of every node: npc-rag /health (with model reachability) and llama.cpp /props for the slot count.
  lastProbe=now();
  await Promise.all(pool.map(async n=>{
   try{
    const res=await call(n,n.base+'/health',null,{method:'GET',timeoutMs:5000});
    const ok=res.ok&&res.body?.ok!==false&&res.body?.llm!==false; // npc-rag up but its main model unreachable = only fallback lines: count it as down.
    if(ok){if(!healthy(n))log?.('ai_node_recovered',n.host);up(n,null);}else down(n,Error('health check failed'+(res.body?.llm===false?': model unreachable':' ('+res.status+')')));
   }catch(error){down(n,error);}
   try{const props=await call(n,n.llm+'/props',null,{method:'GET',timeoutMs:5000});const slots=Number(props.body?.total_slots);if(props.ok&&slots>=1)n.slots=Math.min(64,Math.floor(slots));}catch{} // Optional: keep the old slot count if the model port is closed to us.
  }));
 }

 return {
  configured:pool.length>0,
  hosts:()=>pool.map(n=>n.host),
  request:(path,body,opts={})=>run(n=>n.base+path,body,{...opts,auth:true}),          // npc-rag endpoints (/v1/npc/chat, ...).
  model:(kind,path,body,opts={})=>run(n=>n[kind]+path,body,opts),                     // Direct model calls: kind = 'llm' or 'classifier'.
  async broadcast(path,body,opts={}){ // The same npc-rag call on every node (companion lore pushes); never throws, reports each node.
   if(closed)return [];const headers=key?{'X-Api-Key':key,Authorization:'Bearer '+key}:{};
   return Promise.all(pool.map(async n=>{try{const res=await call(n,n.base+path,body,{...opts,headers});if(res.status>=500)down(n,Error('AI answered '+res.status));return {node:n.host,status:res.status,ok:res.ok};}catch(error){if(!opts.signal?.aborted)down(n,error);return {node:n.host,status:0,ok:false,error:String(error?.message??error).slice(0,200)};}}));
  },
  tick(){if(!closed&&pool.length&&now()-lastProbe>=healthMs)return probe().catch(()=>{});return Promise.resolve();}, // Called from the service timers; cheap when not due.
  probe,
  view:()=>pool.map(n=>({host:n.host,healthy:healthy(n),inFlight:n.inFlight,slots:n.slots,latencyMs:Math.round(n.latency),failures:n.failures,lastError:n.lastError,lastOk:n.lastOk||null,downForMs:Math.max(0,n.downUntil-now())})), // GM panel.
  close(){closed=true;for(const c of controllers)c.abort();},
 };
}
