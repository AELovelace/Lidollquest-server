// AI load ("torture") test: how many chatting players can the AI nodes carry?
// Simulated players hammer npc-rag through the real ai-pool.mjs (least busy x latency, failover), in rising steps of
// concurrency. Each simulated player is a closed loop: send one request, wait for the answer, send the next (no
// thinking time), so N players = N requests always in flight. The mix matches what the game sends:
//   companion  /v1/companion/chat   a full companion reply (classify, wiki/lore/memories, guarded generation)
//   pip        /v1/npc/chat         a Pip question with history
//   gate       9091 classifier      the 4-token "should the companion answer?" check from COMPANION_LIFELIKE_PLAN.md
// It stops early when a step gets too slow or starts failing, so a broken node is never hammered for long.
//
//   node deploy/ai-load-test.mjs --key-file C:/Scripts/npc-rag/.env
//   node deploy/ai-load-test.mjs --nodes http://47.51.162.106:9092 --levels 1,2,4 --seconds 20
//   node deploy/ai-load-test.mjs --key-file .env --models "http://47.51.162.106:9091|http://47.51.162.106:9094,|"   (per-node model ports)
//
// It loads LIVE servers: Pip and the companions slow down while it runs. Nothing is written to any game database;
// the only server-side change is a companion lore push (the same lore the game server pushes).
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createAiPool,parseNodes} from '../server/ai-pool.mjs';
import {companionLore} from '../server/follower-chat.mjs';
import {participationContext,participationSaysJoin} from '../server/participation-gate.mjs';

const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i>0?process.argv[i+1]:fallback;};
const nodes=parseNodes(arg('nodes',process.env.NPC_RAG_NODES??'http://47.51.162.106:9092,http://192.168.1.188:9092'),arg('models',process.env.NPC_RAG_NODE_MODELS??'')); // --models "<llm>|<classifier>,..." like NPC_RAG_NODE_MODELS.
const keyFile=arg('key-file',null);
const key=process.env.NPC_RAG_KEY||(keyFile?(readFileSync(keyFile,'utf8').match(/^NPC_API_KEY=(.*)$/m)?.[1]??'').trim().replace(/^["']|["']$/g,''):''); // Never printed.
const levels=arg('levels','1,2,4,8,16,24').split(',').map(Number).filter(n=>n>0);
const seconds=Number(arg('seconds',40));                        // Length of each concurrency step.
const gateBackend=arg('gate-backend','qwen');
if(!['qwen','decider'].includes(gateBackend))throw Error('gate-backend must be qwen or decider');
const mix=Object.fromEntries(arg('mix','companion:60,pip:25,gate:15').split(',').map(p=>p.split(':')).map(([k,v])=>[k,Number(v)])); // Percent per kind.
const maxP95=Number(arg('max-p95',45))*1000,maxErrors=Number(arg('max-errors',25))/100; // Stop rules.
const chatEvery=Number(arg('chat-every',30));                   // Seconds between AI requests for one real chatting player (capacity estimate).
const startedAt=new Date().toISOString(),runId='simulated-'+startedAt.replace(/[^0-9]/g,'');
const output=resolve(arg('output',`artifacts/${runId}.json`)); // Save observations without credentials or player content.
let requestId=0; // Unique synthetic identities prevent accidental per-player 429s between concurrent workers.

const catalog=JSON.parse(readFileSync(new URL('../server/followers-data.json',import.meta.url),'utf8')).companions;
const lore=companionLore(catalog);
const npcs=Object.keys(catalog);
const LINES=['how are you today?','remember the Slime Knight we beat?','tell me about your past','where should we go next?','do you ever have accidents too?','I love strawberry milk, what about you?','how do I change my diaper?','what is the Cursebreaker for?','are you scared of the forest?','how do I look?'];
const PIP=['how do I change my diaper?','where do I sleep?','what does Dignity do?','how do I hire a companion?','where is the bank?','how do I get to the Tundra?'];
const MEM=[{id:'m1',text:'Doll and I beat the Slime Knight in the Forest together.',importance:3,age_days:1},{id:'m2',text:'Doll said she loves strawberry milk.',importance:2,age_days:2},{id:'m3',text:'Doll and I explored the Seafoam Coast together.',importance:2,age_days:5}];
const pick=list=>list[Math.floor(Math.random()*list.length)];

function request(kind){ // One request of the given kind through the pool; resolves to {kind,ok,status,ms,node}.
 const t=Date.now(),opts={timeoutMs:60000};
 let work;
 if(kind==='companion'){const npc=pick(npcs),def=catalog[npc];work=pool.request('/v1/companion/chat',{message:def.name.split(' ')[0]+', '+pick(LINES),npc_id:npc,npc_name:def.name.slice(0,32),player_name:'Doll',persona:def.online.persona,voice:def.dialogue.talk_lines.slice(0,3),bond:Math.floor(Math.random()*60),lore_version:lore.version,memories:MEM,audience:Math.floor(Math.random()*3)},opts);}
 else if(kind==='pip')work=pool.request('/v1/npc/chat',{message:pick(PIP),player_id:runId+'-'+requestId++,player_name:'Doll',npc_name:'Pip',history:[]},opts);
 else if(gateBackend==='decider')work=pool.request('/v1/participation/decide',participationContext({name:'Elowen'},{message:pick(LINES),playerName:'Doll'}),opts).then(r=>{if(r.ok)participationSaysJoin(r.body);return r;});
 else work=pool.model('classifier','/v1/chat/completions',{model:'local',messages:[{role:'system',content:'Would it be natural for Elowen, a companion standing nearby, to answer or chime in? Answer YES or NO.'},{role:'user',content:pick(LINES)}],max_tokens:4,temperature:0,stream:false,chat_template_kwargs:{enable_thinking:false}},opts);
 return work.then(r=>({kind,ok:r.ok,status:r.status,ms:Date.now()-t,node:r.node,
  has_reply:typeof r.body?.reply==='string'&&!!r.body.reply.trim(),fallback:!!r.body?.fallback,
  guard:r.body?.guard??null,category:r.body?.category??null,timings_ms:r.body?.timings_ms??null,
  gate_answer:kind==='gate'?(gateBackend==='decider'?r.body?.decision:String(r.body?.choices?.[0]?.message?.content??'').trim()):null
 })).catch(e=>({kind,ok:false,status:e?.status??(e?.name==='TimeoutError'?'timeout':'network'),ms:Date.now()-t,node:e?.node??'?'})); // Keep HTTP success separate from actual generated dialogue.
}
function chooseKind(){let r=Math.random()*100;for(const [k,v] of Object.entries(mix)){if((r-=v)<0)return k;}return 'companion';}
const pct=(list,p)=>{if(!list.length)return 0;const s=[...list].sort((a,b)=>a-b),middle=Math.floor(s.length/2);return p===50?(s.length%2?s[middle]:(s[middle-1]+s[middle])/2):s[Math.max(0,Math.min(s.length-1,Math.ceil(p/100*s.length)-1))];}; // Conventional median and nearest-rank tail percentiles.

const pool=createAiPool({nodes,key,log:()=>{}});
if(gateBackend==='decider'){
 for(const node of nodes){
  const response=await fetch(node.base+'/health',{signal:AbortSignal.timeout(10000)}),health=await response.json();
  if(!response.ok||!health.participation?.enabled||!health.participation?.healthy||health.participation?.decision_policy!=='participation-sociable-v1-schema_first')throw Error('Participation preflight failed: '+node.base);
 }
} // Refuse B if either node is disabled/unhealthy; no hidden Qwen fallback.
console.log(`AI load test: ${nodes.map(n=>n.base).join(', ')} | steps ${levels.join(', ')} x ${seconds}s | mix ${JSON.stringify(mix)} | key ${key?'set':'MISSING'}`);
await pool.probe();console.log('probe:',pool.view().map(n=>`${n.host} ${n.healthy?'healthy':'DOWN'} slots=${n.slots}`).join(' | '));
const pushed=await pool.broadcast('/v1/companion/lore',lore,{timeoutMs:60000});console.log('lore push:',pushed.map(r=>`${r.node} ${r.status}`).join(' | '));
if(pushed.some(r=>r.status===401))throw Error('A node refused the key (401); pass --key-file or NPC_RAG_KEY.');

const summary=[],stages=[];
for(const users of levels){
 const results=[],deadline=Date.now()+seconds*1000;
 const player=async()=>{while(Date.now()<deadline)results.push(await request(chooseKind()));}; // Closed loop, no thinking time.
 const t=Date.now();await Promise.all(Array.from({length:users},player));const wall=(Date.now()-t)/1000;
 const ok=results.filter(r=>r.ok),errors=results.length-ok.length,lat=ok.map(r=>r.ms);
 const byKind=Object.fromEntries(Object.keys(mix).map(k=>{const l=ok.filter(r=>r.kind===k).map(r=>r.ms);return [k,`${l.length} ok p50 ${(pct(l,50)/1000).toFixed(1)}s p95 ${(pct(l,95)/1000).toFixed(1)}s`];}));
 const byNode=Object.fromEntries([...new Set(results.map(r=>r.node))].map(n=>[n,results.filter(r=>r.node===n).length]));
 const statuses=Object.entries(results.filter(r=>!r.ok).reduce((m,r)=>(m[r.status]=(m[r.status]??0)+1,m),{})).map(([s,n])=>s+'x'+n).join(' ')||'none';
 const rps=ok.length/wall,row={users,requests:results.length,ok:ok.length,errors,rps:+rps.toFixed(2),p50:pct(lat,50),p95:pct(lat,95),max:Math.max(0,...lat),players:Math.floor(rps*chatEvery)};
 summary.push(row);
 const replies=ok.filter(r=>r.kind!=='gate'),generated=replies.filter(r=>r.has_reply&&!r.fallback&&String(r.guard).startsWith('passed'));
 const replyStats={http_ok:replies.length,generated:generated.length,fallbacks:replies.filter(r=>r.fallback).length,
  guards:replies.reduce((out,r)=>(out[r.guard??'unknown']=(out[r.guard??'unknown']||0)+1,out),{}),
  generated_p50_ms:pct(generated.map(r=>r.ms),50),generated_p95_ms:pct(generated.map(r=>r.ms),95)};
 stages.push({summary:row,by_kind:byKind,by_node:byNode,replies:replyStats,results,pool:pool.view()});
 mkdirSync(dirname(output),{recursive:true});
 writeFileSync(output,JSON.stringify({started_at:startedAt,nodes:nodes.map(n=>n.base),levels,seconds,mix,gate_backend:gateBackend,
  request_timeout_ms:60000,attempts:2,think_time_ms:0,summary,stages},null,2)); // Persist each completed stage even if a later one is interrupted.
 console.log(`\n== ${users} simultaneous request(s), ${wall.toFixed(0)}s: ${results.length} requests, ${errors} failed (${statuses})`);
 console.log(`   throughput ${rps.toFixed(2)} replies/s | latency p50 ${(row.p50/1000).toFixed(1)}s p95 ${(row.p95/1000).toFixed(1)}s max ${(row.max/1000).toFixed(1)}s`);
 console.log('   by kind:',JSON.stringify(byKind));console.log('   by node:',JSON.stringify(byNode),'| pool:',pool.view().map(n=>`${n.host} ~${n.latencyMs}ms${n.healthy?'':' DOWN'}`).join(' | '));
 console.log('   dialogue:',JSON.stringify(replyStats));
 console.log(`   ~${row.players} actively chatting players at one AI request per ${chatEvery}s each`);
 if(results.length&&errors/results.length>maxErrors){console.log(`\nStopping: ${Math.round(errors/results.length*100)}% errors at ${users}.`);break;}
 if(row.p95>maxP95){console.log(`\nStopping: p95 ${(row.p95/1000).toFixed(1)}s is over ${maxP95/1000}s at ${users}.`);break;}
}
console.log('\nsummary (users, replies/s, p50 s, p95 s, errors, ~players):');
for(const r of summary)console.log(`  ${String(r.users).padStart(3)}  ${r.rps.toFixed(2).padStart(6)}  ${(r.p50/1000).toFixed(1).padStart(5)}  ${(r.p95/1000).toFixed(1).padStart(5)}  ${String(r.errors).padStart(4)}  ${String(r.players).padStart(5)}`);
pool.close();
console.log('Artifact:',output);
