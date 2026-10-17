// AI continuity test: do the deployed models still follow the companion and Pip prompts?
// Runs every prompt path through each node's npc-rag (the same calls the game server makes), several times each, and
// scores the replies with simple checks: persona and lore, secrets by bond, memories, multi-turn continuity, rules
// (no narration, short, no leaks), the phase A-D kinds (emote, reaction, musing, banter), slips, impressions,
// summaries and Pip. Use it after changing models or prompts; compare the pass rates with the last run.
//
//   node deploy/ai-continuity-test.mjs --key-file C:/Scripts/npc-rag/.env
//   node deploy/ai-continuity-test.mjs --nodes http://47.51.162.106:9092 --runs 5
//
// Read-only apart from a companion lore push (the same lore the game server pushes). Light load: one call at a time.
import {readFileSync} from 'node:fs';
import {CORE as CHECKS,lore} from './ai-checks.mjs'; // The checks live in ai-checks.mjs, shared with ai-ab-test.mjs.

const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i>0?process.argv[i+1]:fallback;};
const nodes=arg('nodes',process.env.NPC_RAG_NODES??'http://47.51.162.106:9092,http://192.168.1.188:9092').split(',').map(s=>s.trim().replace(/\/+$/,'')).filter(Boolean);
const keyFile=arg('key-file',null),runs=Number(arg('runs',3));
const key=process.env.NPC_RAG_KEY||(keyFile?(readFileSync(keyFile,'utf8').match(/^NPC_API_KEY=(.*)$/m)?.[1]??'').trim().replace(/^["']|["']$/g,''):''); // Never printed.
const headers={'Content-Type':'application/json',...(key?{'X-Api-Key':key}:{})};

const summary={};
for(const base of nodes){
 const post=async(path,body)=>{const t=Date.now();const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});return {status:r.status,body:await r.json().catch(()=>({})),ms:Date.now()-t};};
 const pushed=await post('/v1/companion/lore',lore);if(pushed.status!==200)throw Error(`${base}: lore push answered ${pushed.status}${pushed.status===401?' (pass --key-file)':''}`);
 console.log(`\n### ${base}  (${runs} runs per check)`);
 const groups={},times=[];
 for(const [group,label,run] of CHECKS){
  let ok=0;const bad=[];
  for(let i=0;i<runs;i++){
   const timed=async(path,body,{allow=[]}={})=>{const r=await post(path,body);times.push(r.ms);if(r.status!==200&&!allow.includes(r.status))throw Error(`${path} answered ${r.status}`);r.body.reply=String(r.body.reply??'');return r;};
   try{const res=await run(timed);if(res.ok===null){ok++;continue;}if(res.ok)ok++;else bad.push(res.reply);if(res.note&&i===0&&!res.ok)bad.push('('+res.note+')');}catch(error){bad.push('ERROR '+error.message);}
  }
  groups[group]??=[0,0];groups[group][0]+=ok;groups[group][1]+=runs;
  console.log(`  ${ok===runs?'PASS':ok?'PART':'FAIL'} ${ok}/${runs}  [${group}] ${label}${bad.length?'\n        e.g. '+String(bad[0]).slice(0,220):''}`);
 }
 const sorted=[...times].sort((a,b)=>a-b),pct=q=>sorted[Math.min(sorted.length-1,Math.floor(q*sorted.length))]??0;
 const total=Object.values(groups).reduce((s,[o,n])=>[s[0]+o,s[1]+n],[0,0]);
 console.log(`  ---\n  by group: ${Object.entries(groups).map(([g,[o,n]])=>`${g} ${o}/${n}`).join(' | ')}\n  TOTAL ${total[0]}/${total[1]} (${Math.round(total[0]/total[1]*100)}%) | latency p50 ${(pct(.5)/1000).toFixed(1)}s p95 ${(pct(.95)/1000).toFixed(1)}s`);
 summary[base]=total;
}
console.log('\nsummary:',Object.entries(summary).map(([b,[o,n]])=>`${b.replace(/^https?:\/\//,'')} ${o}/${n} (${Math.round(o/n*100)}%)`).join(' | '));
