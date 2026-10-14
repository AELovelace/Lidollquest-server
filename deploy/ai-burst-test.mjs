// Send exactly N concurrent synthetic conversations through the production AI pool, once each.
// No lore upload or game database writes. history:[] avoids creating persistent NPC sessions.
// node deploy/ai-burst-test.mjs --key-file C:/Scripts/npc-rag/.env --count 100
// Add --mix chat for casual conversation prompts, keeping normal classification enabled.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createAiPool,parseNodes} from '../server/ai-pool.mjs';

const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];};
const nodes=parseNodes(arg('nodes',process.env.NPC_RAG_NODES||'http://47.51.162.106:9092,http://192.168.1.188:9092'));
const count=Number(arg('count',100)),timeoutMs=Number(arg('timeout-ms',90000));
const mix=arg('mix','mixed');
const requiredPolicy=arg('require-policy',null); // Optional deployment check before sending any paid conversations.
if(!['mixed','chat'].includes(mix))throw Error('mix must be mixed or chat');
if(!Number.isInteger(count)||count<1||count>1000)throw Error('count must be 1-1000');
if(!Number.isFinite(timeoutMs)||timeoutMs<1000||timeoutMs>180000)throw Error('timeout-ms must be 1000-180000');
const keyFile=arg('key-file',null);
const key=process.env.NPC_RAG_KEY||(keyFile?(readFileSync(keyFile,'utf8').match(/^NPC_API_KEY=(.*)$/m)?.[1]||'').trim().replace(/^["']|["']$/g,''):''); // Only the shared RAG key is read; never print it.
if(!key)throw Error('Provide --key-file or NPC_RAG_KEY');
const stamp=new Date().toISOString(),runId='burst-'+stamp.replace(/[^0-9]/g,'');
const output=resolve(arg('output',`artifacts/${runId}.json`));
const mixedPrompts=[
 'How do I remove a cursed item?', 'Where can I sleep and recover?',
 'What does Dignity do?', 'How do I hire a companion?',
 'Hello Pip! How are you today?', 'How do I change my diaper?',
 'Where can I store spare items?', 'How do I travel to the Tundra?',
 'How do I learn a new skill?', 'I feel nervous about exploring. Can you encourage me?',
]; // Eight game questions and two casual prompts, repeated with unique player identities.
const chatPrompts=[
 'Hello Pip! How are you today?', 'It is lovely to see you. How has your day been?',
 'I had a long day and could use a little encouragement.', 'What kind of music makes you smile?',
 'Do you prefer sunny mornings or rainy afternoons?', 'Tell me a short, silly joke.',
 'I am feeling a little shy. Could we chat for a moment?', 'What is your idea of a relaxing afternoon?',
 'Thank you for keeping me company. You are easy to talk to.', 'I finally finished something difficult today, and I feel proud!',
]; // Social conversation only: no game rules, places, quests or wiki questions.
const prompts=mix==='chat'?chatPrompts:mixedPrompts;
const mixDescription=mix==='chat'?'100% casual chat prompts; normal classification':'80% game questions / 20% casual chat';
const percentile=(values,p)=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b);return s[Math.max(0,Math.ceil(p*s.length)-1)];};
const median=values=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
const stats=rows=>{const ms=rows.map(r=>r.ms);return {n:rows.length,p50_ms:median(ms),p95_ms:percentile(ms,.95),max_ms:ms.length?Math.max(...ms):null,under5s:ms.filter(n=>n<5000).length};};
const tally=(rows,field)=>rows.reduce((out,r)=>(out[r[field]??'unknown']=(out[r[field]??'unknown']||0)+1,out),{});
async function health(base){ // Keep only public operational fields; no credentials or model error bodies in the artifact.
 try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(8000),redirect:'error'}),h=await r.json();return {node:new URL(base).host,status:r.status,ok:h.ok,llm:h.llm,classifier:h.classifier,classification:h.classification??null,overflow:h.overflow??null};}
 catch(e){return {node:new URL(base).host,error:e.name};}
}
const before=await Promise.all(nodes.map(n=>health(n.base)));
console.log('Preflight:',JSON.stringify(before));
if(before.some(h=>h.status!==200||!h.ok||!h.llm))throw Error('A RAG node is not ready; no burst sent');
if(requiredPolicy&&before.some(h=>h.classification?.policy!==requiredPolicy))throw Error('RAG policy mismatch; no burst sent');
await Promise.all(nodes.map(async n=>{const r=await fetch(n.base+'/v1/companion/lore',{headers:{'X-Api-Key':key},signal:AbortSignal.timeout(8000),redirect:'error'});await r.body?.cancel();if(!r.ok)throw Error('RAG authentication/preflight failed: '+r.status);}));
const pool=createAiPool({nodes,key,log:()=>{}}),telemetry=[];
let finished=false,completed=0;
const started=performance.now();
const monitor=(async()=>{while(!finished){const samples=await Promise.all(nodes.map(n=>health(n.base)));telemetry.push({ms:Math.round(performance.now()-started),nodes:samples});if(!finished)await new Promise(r=>setTimeout(r,1000));}})();
console.log(`Launching ${count} concurrent /v1/npc/chat requests; ${mixDescription}; one attempt each, ${timeoutMs/1000}s deadline.`);
const results=await Promise.all(Array.from({length:count},async(_,i)=>{
 const promptIndex=mix==='chat'?Math.floor(i/nodes.length):i; // Pair chat prompts across the fresh pool's alternating nodes.
 const begin=performance.now(),prompt=prompts[promptIndex%prompts.length];
 let row;
 try{
  const r=await pool.request('/v1/npc/chat',{message:prompt,player_id:runId+'-'+i,player_name:'Load Tester',npc_name:'Pip',history:[]},{attempts:1,timeoutMs});
  const b=r.body||{};row={id:i,node:r.node,status:r.status,ms:Math.round(performance.now()-begin),ok:r.ok&&typeof b.reply==='string'&&!!b.reply.trim(),fallback:!!b.fallback,guard:b.guard??null,category:b.category??null,method:b.method??null,source_count:Array.isArray(b.sources)?b.sources.length:null,timings_ms:b.timings_ms??null,prompt,reply:typeof b.reply==='string'?b.reply:null};
 }catch(e){row={id:i,node:e.node??null,status:e.status??e.name,ms:Math.round(performance.now()-begin),ok:false,error:e.name};}
 completed++;if(completed%25===0)console.log(`Completed ${completed}/${count} after ${((performance.now()-started)/1000).toFixed(1)}s`);
 return row;
}));
const wallMs=Math.round(performance.now()-started);finished=true;pool.close();await monitor;
const after=await Promise.all(nodes.map(n=>health(n.base)));
const good=results.filter(r=>r.ok),generated=good.filter(r=>!r.fallback&&String(r.guard).startsWith('passed'));
const summary={count,wall_ms:wallMs,successful_replies:stats(good),generated_guard_passed:stats(generated),failed:results.length-good.length,fallbacks:good.filter(r=>r.fallback).length,guards:tally(good,'guard'),statuses:tally(results,'status'),categories:tally(good,'category'),replies_with_sources:good.filter(r=>r.source_count>0).length,
 by_node:Object.fromEntries(nodes.map(n=>{const host=new URL(n.base).host,rows=results.filter(r=>r.node===host),ok=rows.filter(r=>r.ok);return [host,{requests:rows.length,successful_replies:stats(ok),generated_guard_passed:stats(ok.filter(r=>!r.fallback&&String(r.guard).startsWith('passed'))),failed:rows.length-ok.length,fallbacks:ok.filter(r=>r.fallback).length,guards:tally(ok,'guard')}];})),
 overflow_observed:Object.fromEntries(nodes.map(n=>{const host=new URL(n.base).host,s=telemetry.flatMap(t=>t.nodes.filter(h=>h.node===host&&h.overflow).map(h=>h.overflow));return [host,{samples:s.length,peak_local:Math.max(0,...s.map(h=>h.local_in_flight||0)),peak_cloud:Math.max(0,...s.map(h=>h.cloud_in_flight||0)),max_cloud_cooldown_s:Math.max(0,...s.map(h=>h.cloud_cooldown_s||0))}];}))};
mkdirSync(resolve(output,'..'),{recursive:true});
writeFileSync(output,JSON.stringify({started_at:stamp,endpoint:'/v1/npc/chat',attempts_per_request:1,mix:mixDescription,before,after,summary,telemetry,results},null,2));
console.log('Summary:',JSON.stringify(summary));console.log('Artifact:',output);
