#!/usr/bin/env node
// Ambient NPC life load test (AMBIENT_NPC_LIFE_PLAN.md): how many resident conversations can each npc-rag node carry?
// Simulates exactly what server/ambient-life.mjs does per conversation: an opener (ambient_open), then for every turn a
// Decider gate (/v1/participation/decide) and a reply (ambient_reply), up to MAX_LINES lines, with real Utopia personas,
// rotating topics and growing thread/said lists. Concurrency ramps per node; each stage runs STAGE_S seconds.
//
// Safety rails (these are live nodes that also serve players' companions):
//  - Ambient kinds are local-only and leave AMBIENT_LOCAL_RESERVE slots free; a 429 local_busy is counted, never retried.
//  - The node's /health is sampled every 2 s. If its cloud lane gets busier during a stage than it was at rest (players
//    pushed onto the paid API), or errors pass 20%, the ramp for that node stops at once.
//  - Any ambient reply that reports lane "cloud" aborts everything (the cost guard must never let that happen).
//
// Usage: node deploy/ambient-load-test.mjs [nodeUrl ...]   (key: NPC_RAG_KEY env, else C:/Scripts/npc-rag/.env NPC_API_KEY)
//   STAGES=1,2,4,8,12,16 STAGE_S=40 MAX_LINES=6 node deploy/ambient-load-test.mjs http://47.51.162.106:9092
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {UTOPIA_RESIDENTS} from '../server/utopia-npcs.mjs';
import {personaText,participationProfile} from '../server/ambient-persona.mjs';
import {npcParticipationContext,participationSaysJoin} from '../server/participation-gate.mjs';

const key=process.env.NPC_RAG_KEY||(()=>{try{return (readFileSync('C:/Scripts/npc-rag/.env','utf8').match(/^NPC_API_KEY=(.*)$/m)??[])[1]?.trim();}catch{return '';}})();
if(!key){console.error('Set NPC_RAG_KEY (the npc-rag API key).');process.exit(1);}
const nodes=process.argv.slice(2).length?process.argv.slice(2):['http://47.51.162.106:9092','http://192.168.1.188:9092'];
const STAGES=(process.env.STAGES||'1,2,4,8,12,16').split(',').map(Number).filter(n=>n>0);
const STAGE_S=Number(process.env.STAGE_S||40),MAX_LINES=Number(process.env.MAX_LINES||6);

const names=Object.fromEntries(UTOPIA_RESIDENTS.map(n=>[n.id,n.name]));
const actors=UTOPIA_RESIDENTS.map(n=>({id:n.id,name:n.name,persona:personaText(n.name,n.ai_persona,{names}),voice:n.ai_persona.voice,profile:participationProfile(n.ai_persona),
 topics:[...n.ai_persona.interests,...n.ai_persona.desires]}));
const situation=['You are inside a building in Utopia, a safe town. It is evening.'];
const pick=a=>a[Math.floor(Math.random()*a.length)];

async function post(node,path,body,timeoutMs){ // -> {status,ms,body}; network trouble is status 0.
 const t=performance.now(),ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeoutMs);
 try{const r=await fetch(node+path,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':key},body:JSON.stringify(body),signal:ctl.signal});return {status:r.status,ms:performance.now()-t,body:await r.json().catch(()=>({}))};}
 catch{return {status:0,ms:performance.now()-t,body:{}};}finally{clearTimeout(timer);}
}
async function health(node){try{const r=await fetch(node+'/health',{signal:AbortSignal.timeout(4000)});return (await r.json()).overflow??null;}catch{return null;}}

function newStats(){return {lines:0,linesOk:0,busy429:0,dropped:{},gates:0,gateJoin:0,gateFail:0,errors:0,cloud:0,convos:0,lineMs:[],gateMs:[]};}
async function conversation(node,s,stopAt,said){ // One resident conversation, like ambient-life converse().
 const [a,b]=[pick(actors),pick(actors)].sort(()=>Math.random()-.5);if(a.id===b.id)return;
 s.convos++;const thread=[];let speaker=a,listener=b;
 const line=async(actor,partner,kind)=>{
  const r=await post(node,'/v1/companion/chat',{npc_id:actor.id,npc_name:actor.name,persona:actor.persona,voice:actor.voice,message:'(ambient)',kind,situation,
   partner:{name:partner.name,persona:partner.persona.slice(0,600),line:thread.at(-1)?.text??''},thread:thread.slice(-8),topic:kind==='ambient_open'?pick(actor.topics):'',said:(said.get(actor.id)??[]).slice(-8)},25000);
  s.lines++;s.lineMs.push(r.ms);
  if(r.status===429){s.busy429++;return '';}
  if(r.status!==200){s.errors++;return '';}
  if(r.body.lane==='cloud'){s.cloud++;return '';}
  const g=String(r.body.guard??'');if(!g.startsWith('passed')){s.dropped[g]=(s.dropped[g]??0)+1;return '';}
  s.linesOk++;const text=String(r.body.reply??'');thread.push({speaker:actor.name,text});const mine=said.get(actor.id)??[];mine.push(text);if(mine.length>12)mine.shift();said.set(actor.id,mine);return text;
 };
 if(!await line(a,b,'ambient_open'))return;
 while(thread.length<MAX_LINES&&performance.now()<stopAt){
  const g=await post(node,'/v1/participation/decide',npcParticipationContext({name:listener.name,profile:listener.profile},{speaker:speaker.name,message:thread.at(-1).text,turns:thread,conversation:true,nearbyNames:[a.name,b.name]}),12000);
  s.gates++;s.gateMs.push(g.ms);
  let join=false;try{if(g.status===200)join=participationSaysJoin(g.body);else s.gateFail++;}catch{s.gateFail++;}
  if(!join){if(g.status===200)return;return;} // QUIET ends it; a gate failure ends it too (ambient life pauses).
  s.gateJoin++;
  if(!await line(listener,speaker,'ambient_reply'))return;
  [speaker,listener]=[listener,speaker];
 }
}
const pct=(a,p)=>{if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return Math.round(s[Math.min(s.length-1,Math.floor(p*s.length))]);};

async function stage(node,concurrency,baseCloud){
 const s=newStats(),said=new Map(),stopAt=performance.now()+STAGE_S*1000;let abort='',maxLocal=0,maxCloud=0;
 const watcher=(async()=>{while(performance.now()<stopAt&&!abort){const h=await health(node);if(h){maxLocal=Math.max(maxLocal,h.local_in_flight??0);maxCloud=Math.max(maxCloud,h.cloud_in_flight??0);if((h.cloud_in_flight??0)>baseCloud)abort='players were pushed onto the paid cloud lane';}await new Promise(r=>setTimeout(r,2000));}})();
 const worker=async()=>{while(performance.now()<stopAt&&!abort){await conversation(node,s,stopAt,said);if(s.cloud)abort='an ambient line came back from the cloud';}};
 await Promise.all(Array.from({length:concurrency},worker));abort||=s.errors+s.gateFail>0.2*Math.max(1,s.lines+s.gates)?'error rate above 20%':'';await watcher;
 const mins=STAGE_S/60;
 return {concurrency,abort,convos:s.convos,linesPerMin:Math.round(s.linesOk/mins),attemptsPerMin:Math.round(s.lines/mins),gatesPerMin:Math.round(s.gates/mins),
  okRate:s.lines?Math.round(100*s.linesOk/s.lines):0,busy429:s.busy429,dropped:s.dropped,errors:s.errors,gateFail:s.gateFail,cloud:s.cloud,
  lineP50:pct(s.lineMs,.5),lineP95:pct(s.lineMs,.95),gateP50:pct(s.gateMs,.5),gateP95:pct(s.gateMs,.95),maxLocalInFlight:maxLocal,maxCloudInFlight:maxCloud};
}

const report={started:new Date().toISOString(),stages:STAGES,stageSeconds:STAGE_S,maxLines:MAX_LINES,nodes:{}};
for(const node of nodes){
 const rest=await health(node);if(!rest){console.log(node,'unreachable; skipped');continue;}
 const baseCloud=rest.cloud_in_flight??0;console.log(`\n=== ${node} (local capacity ${rest.local_capacity}, cloud in flight at rest ${baseCloud})`);
 report.nodes[node]=[];
 for(const c of STAGES){
  const r=await stage(node,c,baseCloud);report.nodes[node].push(r);
  console.log(`c=${String(c).padStart(2)} lines/min ${String(r.linesPerMin).padStart(4)} (tried ${r.attemptsPerMin}) ok ${r.okRate}% · 429 ${r.busy429} · drops ${JSON.stringify(r.dropped)} · err ${r.errors}/${r.gateFail} · line p50/p95 ${r.lineP50}/${r.lineP95} ms · gate p50/p95 ${r.gateP50}/${r.gateP95} ms · local≤${r.maxLocalInFlight} cloud≤${r.maxCloudInFlight}${r.abort?' · STOPPED: '+r.abort:''}`);
  if(r.abort)break;
  await new Promise(res=>setTimeout(res,5000)); // Let the node settle between stages.
 }
}
mkdirSync('artifacts',{recursive:true});const file='artifacts/ambient-load-'+Date.now()+'.json';writeFileSync(file,JSON.stringify(report,null,1));console.log('\nreport:',file);
