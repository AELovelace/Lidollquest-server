// AI A/B test: record every AI function on the live nodes (state A), switch models or prompts, record again (state B),
// then compare. Runs the continuity checks plus resident life, greetings, shops, gossip, addressing, voices and the
// Decider (deploy/ai-checks.mjs). Every reply, latency and node /health snapshot is saved, so B can be read beside A.
//
//   record:   node deploy/ai-ab-test.mjs --label A-lidoll-fm-0.2 --key-file C:/Scripts/npc-rag/.env
//             (options: --nodes url,url  --runs 3  --out deploy/ab-results  --only secrets,residents  --no-lore-push)
//   compare:  node deploy/ai-ab-test.mjs --compare deploy/ab-results/A-….json deploy/ab-results/B-….json [--html report.html]
//
// Read-only apart from the companion lore push the game server also makes (skip it with --no-lore-push). One call at a time.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CORE,EXTRA,lore} from './ai-checks.mjs';

const argv=process.argv.slice(2);
const arg=(name,fallback)=>{const i=argv.indexOf('--'+name);return i>=0?argv[i+1]:fallback;};
const flag=name=>argv.includes('--'+name);
const HERE=dirname(fileURLToPath(import.meta.url));
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct=(o,n)=>n?Math.round(o/n*100):0;
const quantile=(xs,q)=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s[Math.min(s.length-1,Math.floor(q*s.length))]:0;};

function scrub(value){ // /health snapshots are saved: drop anything that looks like a credential.
 if(Array.isArray(value))return value.map(scrub);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/key|token|secret|password|auth/i.test(k)).map(([k,v])=>[k,scrub(v)]));
 return value;
}

async function record(){
 const label=arg('label');
 if(!label)throw Error('Pass --label (e.g. A-lidoll-fm-0.2) or --compare A.json B.json');
 const nodes=arg('nodes',process.env.NPC_RAG_NODES??'http://47.51.162.106:9092,http://192.168.1.188:9092').split(',').map(s=>s.trim().replace(/\/+$/,'')).filter(Boolean);
 const runs=Number(arg('runs',3)),keyFile=arg('key-file',null),only=(arg('only','')||'').split(',').map(s=>s.trim()).filter(Boolean);
 const key=process.env.NPC_RAG_KEY||(keyFile?(readFileSync(keyFile,'utf8').match(/^NPC_API_KEY=(.*)$/m)?.[1]??'').trim().replace(/^["']|["']$/g,''):''); // Never printed or saved.
 const headers={'Content-Type':'application/json',...(key?{'X-Api-Key':key}:{})};
 const checks=[...CORE,...EXTRA].filter(([group])=>!only.length||only.includes(group));
 const out={label,started:new Date().toISOString(),runs,lore_version:lore.version,checks:checks.map(([group,label])=>({group,label})),nodes:{}};
 for(const base of nodes){
  const post=async(path,body)=>{const t=Date.now();try{const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});return {status:r.status,body:await r.json().catch(()=>({})),ms:Date.now()-t};}catch(error){return {status:0,body:{error:String(error.message)},ms:Date.now()-t};}};
  const node={health:null,results:[]};out.nodes[base]=node;
  try{const h=await fetch(base+'/health',{headers,signal:AbortSignal.timeout(15000)});node.health=scrub(await h.json());}catch(error){node.health={error:String(error.message)};} // Which models answered: kept with the results.
  try{const u=new URL(base);u.port=arg('model-port','9090');const m=await (await fetch(u.origin+'/v1/models',{signal:AbortSignal.timeout(8000)})).json();node.models=(m.models??m.data??[]).map(x=>x.name??x.id).filter(Boolean);}catch{node.models=[];} // llama.cpp's loaded GGUF (the student), e.g. lidoll-fm-0.2-Q8_0.gguf.
  console.log(`\n${base}: student ${node.models.join(', ')||'unknown (set --model-port)'}`);
  if(!flag('no-lore-push')){const pushed=await post('/v1/companion/lore',lore);node.lore_push=pushed.status;if(pushed.status!==200)console.warn(`${base}: lore push answered ${pushed.status}${pushed.status===401?' (pass --key-file)':''}`);}
  console.log(`\n### ${base}  (${runs} runs per check, ${checks.length} checks)`);
  for(const [group,name,run] of checks){
   const tries=[];
   for(let i=0;i<runs;i++){
    const calls=[];
    const timed=async(path,body,{allow=[]}={})=>{const r=await post(path,body);calls.push({path,status:r.status,ms:r.ms});if(r.status!==200&&!allow.includes(r.status))throw Error(`${path} answered ${r.status}`);r.body.reply=String(r.body.reply??'');return r;};
    try{const res=await run(timed);tries.push({ok:res.ok,reply:String(res.reply??''),note:res.note??'',calls});}
    catch(error){tries.push({ok:false,reply:'',note:'ERROR '+error.message,calls});}
   }
   const scored=tries.filter(t=>t.ok!==null),ok=scored.filter(t=>t.ok).length;
   node.results.push({group,label:name,tries});
   const tag=!scored.length?'N/A ':ok===scored.length?'PASS':ok?'PART':'FAIL';
   const bad=tries.find(t=>t.ok===false);
   console.log(`  ${tag} ${ok}/${scored.length}  [${group}] ${name}${bad?'\n        e.g. '+(bad.reply||bad.note).slice(0,200):''}`);
  }
  const s=summarize(node);node.summary=s;
  console.log(`  ---\n  by group: ${Object.entries(s.groups).map(([g,v])=>`${g} ${v.ok}/${v.n}`).join(' | ')}\n  TOTAL ${s.ok}/${s.n} (${pct(s.ok,s.n)}%) | latency p50 ${(s.p50/1000).toFixed(1)}s p95 ${(s.p95/1000).toFixed(1)}s`);
 }
 out.finished=new Date().toISOString();
 const dir=arg('out',join(HERE,'ab-results'));mkdirSync(dir,{recursive:true});
 const file=join(dir,`${label.replace(/[^\w.-]+/g,'_')}-${out.started.slice(0,16).replace(/[:T]/g,'')}.json`);
 writeFileSync(file,JSON.stringify(out,null,1));
 console.log(`\nSaved ${file}\nAfter switching, record B and compare:  node deploy/ai-ab-test.mjs --compare "${file}" <B.json>`);
}

function summarize(node){ // Pass counts per group (N/A tries excluded) and call latency percentiles per group and overall.
 const groups={},all=[];
 for(const r of node.results){
  const g=groups[r.group]??={ok:0,n:0,ms:[]};
  for(const t of r.tries){if(t.ok!==null){g.n++;if(t.ok)g.ok++;}for(const c of t.calls){if(c.status===200){g.ms.push(c.ms);all.push(c.ms);}}}
 }
 for(const g of Object.values(groups)){g.p50=quantile(g.ms,.5);g.p95=quantile(g.ms,.95);delete g.ms;}
 const ok=Object.values(groups).reduce((s,g)=>s+g.ok,0),n=Object.values(groups).reduce((s,g)=>s+g.n,0);
 return {groups,ok,n,p50:quantile(all,.5),p95:quantile(all,.95)};
}

function compare(){
 const i=argv.indexOf('--compare'),[fa,fb]=[argv[i+1],argv[i+2]];
 if(!fa||!fb)throw Error('--compare needs two result files: A then B');
 const A=JSON.parse(readFileSync(fa,'utf8')),B=JSON.parse(readFileSync(fb,'utf8'));
 const pairs=Object.keys(A.nodes).map((base,k)=>[base,B.nodes[base]?base:Object.keys(B.nodes)[k]]).filter(([,b])=>b); // Same node URL, else same position.
 const sections=[];
 for(const [na,nb] of pairs){
  const a=A.nodes[na],b=B.nodes[nb],sa=a.summary??summarize(a),sb=b.summary??summarize(b);
  console.log(`\n### ${na}${na===nb?'':' vs '+nb}\n  ${A.label}: ${sa.ok}/${sa.n} (${pct(sa.ok,sa.n)}%) p50 ${(sa.p50/1000).toFixed(1)}s p95 ${(sa.p95/1000).toFixed(1)}s\n  ${B.label}: ${sb.ok}/${sb.n} (${pct(sb.ok,sb.n)}%) p50 ${(sb.p50/1000).toFixed(1)}s p95 ${(sb.p95/1000).toFixed(1)}s`);
  const rows=[];
  for(const rb of b.results){
   const ra=a.results.find(r=>r.group===rb.group&&r.label===rb.label);
   const score=r=>{if(!r)return null;const s=r.tries.filter(t=>t.ok!==null);return s.length?{ok:s.filter(t=>t.ok).length,n:s.length}:null;};
   const xa=score(ra),xb=score(rb),delta=xa&&xb?pct(xb.ok,xb.n)-pct(xa.ok,xa.n):null;
   rows.push({group:rb.group,label:rb.label,xa,xb,delta,ra,rb});
   const fmt=x=>x?`${x.ok}/${x.n}`:'—';
   console.log(`  ${delta===null?'  new':delta>0?`+${delta}%`.padStart(5):delta<0?`${delta}%`.padStart(5):'   = '}  ${fmt(xa).padStart(4)} → ${fmt(xb).padEnd(4)} [${rb.group}] ${rb.label}`);
  }
  sections.push({na,nb,sa,sb,rows});
 }
 const html=arg('html',join(dirname(fb),`compare-${basename(fa,'.json')}-vs-${basename(fb,'.json')}.html`));
 writeFileSync(html,report(A,B,sections));
 console.log(`\nSide-by-side report: ${html}`);
}

function report(A,B,sections){ // One self-contained page: totals, per-group table, then every check's replies A beside B.
 const chip=t=>t.ok===null?'<span class="c na">n/a</span>':t.ok?'<span class="c ok">pass</span>':'<span class="c bad">fail</span>';
 const tries=r=>r?r.tries.map(t=>`<li>${chip(t)} ${esc(t.reply||t.note)}${t.note&&t.reply?` <i>${esc(t.note)}</i>`:''} <small>${t.calls.map(c=>c.ms+' ms').join(', ')}</small></li>`).join(''):'<li><i>not in this run</i></li>';
 const frac=x=>x?`${x.ok}/${x.n}`:'—';
 const body=sections.map(s=>{
  const groups=[...new Set([...Object.keys(s.sa.groups),...Object.keys(s.sb.groups)])];
  return `<h2>${esc(s.na)}${s.na===s.nb?'':' vs '+esc(s.nb)}</h2>
  <table><thead><tr><th>Group</th><th>${esc(A.label)}</th><th>${esc(B.label)}</th><th>Δ</th><th>p50 A → B</th></tr></thead><tbody>
  ${groups.map(g=>{const a=s.sa.groups[g],b=s.sb.groups[g],d=a&&b?pct(b.ok,b.n)-pct(a.ok,a.n):null;return `<tr><td>${esc(g)}</td><td>${a?`${a.ok}/${a.n} (${pct(a.ok,a.n)}%)`:'—'}</td><td>${b?`${b.ok}/${b.n} (${pct(b.ok,b.n)}%)`:'—'}</td><td class="${d>0?'up':d<0?'down':''}">${d===null?'new':(d>0?'+':'')+d+'%'}</td><td>${a?(a.p50/1000).toFixed(1):'—'} → ${b?(b.p50/1000).toFixed(1):'—'} s</td></tr>`;}).join('')}
  <tr class="tot"><td>Total</td><td>${s.sa.ok}/${s.sa.n} (${pct(s.sa.ok,s.sa.n)}%)</td><td>${s.sb.ok}/${s.sb.n} (${pct(s.sb.ok,s.sb.n)}%)</td><td>${pct(s.sb.ok,s.sb.n)-pct(s.sa.ok,s.sa.n)}%</td><td>${(s.sa.p50/1000).toFixed(1)} → ${(s.sb.p50/1000).toFixed(1)} s (p95 ${(s.sa.p95/1000).toFixed(1)} → ${(s.sb.p95/1000).toFixed(1)})</td></tr></tbody></table>
  ${s.rows.map(r=>`<section class="${r.delta>0?'up':r.delta<0?'down':''}"><h3><span class="g">${esc(r.group)}</span> ${esc(r.label)} <span class="score">${frac(r.xa)} → ${frac(r.xb)}</span></h3>
   <div class="ab"><div><h4>A · ${esc(A.label)}</h4><ul>${tries(r.ra)}</ul></div><div><h4>B · ${esc(B.label)}</h4><ul>${tries(r.rb)}</ul></div></div></section>`).join('')}`;}).join('');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI A/B comparison</title><style>
:root{--bg:#f6f4f9;--panel:#fff;--ink:#231b2e;--muted:#6b6077;--line:#e1d8ea;--ok:#2f7d4f;--bad:#b3373b;--na:#8a7f96}
@media (prefers-color-scheme:dark){:root{--bg:#16121b;--panel:#211a28;--ink:#eee6f3;--muted:#a597b2;--line:#3a2f44;--ok:#6fcf97;--bad:#ff8a8f;--na:#9c90a8}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:24px 16px}
h1{margin:0 0 4px}p.meta{color:var(--muted);margin:0 0 18px}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:10px 0 18px}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-weight:600}.tot td{font-weight:700}.up{color:var(--ok)}.down{color:var(--bad)}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0;color:var(--ink)}section.up{border-left:4px solid var(--ok)}section.down{border-left:4px solid var(--bad)}
h3{font-size:15px;margin:2px 0 8px}.g{font-size:11px;color:var(--muted);text-transform:uppercase;margin-right:6px}.score{float:right;font-variant-numeric:tabular-nums}
.ab{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media (max-width:760px){.ab{grid-template-columns:1fr}}h4{margin:0 0 4px;font-size:12px;color:var(--muted)}
ul{margin:0;padding-left:18px}li{margin:4px 0}small{color:var(--muted)}.c{font-size:11px;padding:1px 6px;border-radius:9px;border:1px solid}.c.ok{color:var(--ok)}.c.bad{color:var(--bad)}.c.na{color:var(--na)}
</style></head><body><main><h1>AI A/B comparison</h1><p class="meta">A = <b>${esc(A.label)}</b> (${esc(A.started)}) · B = <b>${esc(B.label)}</b> (${esc(B.started)}) · ${B.runs} runs per check · checks are regex/keyword scored: read the replies before trusting a number.</p>${body}</main></body></html>`;
}

(flag('compare')?Promise.resolve().then(compare):record()).catch(error=>{console.error(error.message);process.exitCode=1;});
