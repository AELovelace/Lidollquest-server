// Fixed-arrival test. Cloud off by default; --overflow enabled requires overflow on both hosts.
// This drives real RAG/generation and pushes companion lore, but writes no game database.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createAiPool,parseNodes} from '../server/ai-pool.mjs';
import {companionLore} from '../server/follower-chat.mjs';
import {participationContext,participationSaysJoin} from '../server/participation-gate.mjs';
import {buildSchedule,assertTestHealth,runSchedule,summarizeStage,percentile} from './ai-player-test-support.mjs';

const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];};
const numeric=(name,fallback,min,max)=>{const v=Number(arg(name,fallback));if(!Number.isFinite(v)||v<min||v>max)throw Error('Invalid --'+name);return v;};
const levels=String(arg('players','25,50,75,100')).split(',').map(Number);
const overflow=arg('overflow','disabled');
if(!['disabled','enabled'].includes(overflow))throw Error('--overflow must be disabled or enabled'); // Explicit mode never changes a remote service's configuration.
if(!levels.length||levels.some(n=>!Number.isInteger(n)||n<1||n>1000))throw Error('Invalid --players');
const seconds=numeric('seconds',600,10,3600),interval=numeric('chat-every',30,5,300),seed=numeric('seed',20261014,0,4294967295);
const nearbyCount=numeric('nearby',2,1,8),burstEvery=numeric('burst-every',120,30,3600),burstFraction=numeric('burst-fraction',.2,0,1);
if(!Number.isInteger(nearbyCount)||burstEvery%interval!==0)throw Error('nearby must be integral and burst-every must be a multiple of chat-every');
const nodes=parseNodes(arg('nodes',process.env.NPC_RAG_NODES??'http://47.51.162.106:9092,http://192.168.1.188:9092'),arg('models',process.env.NPC_RAG_NODE_MODELS??''));
if(!nodes.length)throw Error('No nodes');
const keyFile=arg('key-file',null),key=process.env.NPC_RAG_KEY||(keyFile?(readFileSync(keyFile,'utf8').match(/^NPC_API_KEY=(.*)$/m)?.[1]??'').trim().replace(/^["']|["']$/g,''):'');
if(!key)throw Error('NPC_RAG_KEY or --key-file is required'); // Never print credentials or raw environment files.
const startedAt=new Date().toISOString(),runId='players-'+startedAt.replace(/[^0-9]/g,'');
const output=resolve(arg('output',`artifacts/${runId}.json`));
const catalog=JSON.parse(readFileSync(new URL('../server/followers-data.json',import.meta.url),'utf8')).companions;
const npcIds=Object.keys(catalog),lore=companionLore(catalog),pool=createAiPool({nodes,key,log:()=>{}});
const SOCIAL=['How has your day been?','What helps you relax after a long day?','Tell me about a happy memory.','What would you like to do tomorrow?','Do you prefer sunshine or rain?','What makes someone a good friend?','I feel embarrassed today. Can we talk?','What is your favorite kind of meal?','Do you enjoy quiet walks?','What sort of music do you like?','I could use a little encouragement.','What makes you laugh?','Would you rather explore or stay somewhere cozy?','Do you ever feel nervous around new people?','What is something you are proud of?','Tell me a little about yourself.','What do you think about friendship?','How do you cheer yourself up?','Do you like sweet or savory snacks?','What would make today better?','I am glad we get to spend time together.','What is a small thing that makes you happy?','How do you decide who to trust?','What would you do on a free afternoon?'];
const PREFACES=['','Hey, ','I was wondering, ','Before we head out, ','While we take a break, ','Just between us, ','I have been thinking. ','Can I ask something? '];
const GAME=['How do I change my diaper?','Where can I sleep?','What does Dignity do?','How do I hire a companion?','Where is the bank?','How do I get to the Tundra?','How do I restore my health?','What happens when I die?'];
const memories=[{id:'m1',text:'We enjoyed a quiet walk together.',importance:2,age_days:1},{id:'m2',text:'I said that I like strawberry milk.',importance:2,age_days:2}];
const report={started_at:startedAt,local_only:overflow==='disabled',overflow_mode:overflow,nodes:nodes.map(n=>n.base),config:{levels,seconds,interval,seed,nearbyCount,burstEvery,burstFraction,companion_fraction:.75,nearby_fraction:.2,social_fraction:.8,attempts:2,timeout_ms:{gate:12000,companion:20000,pip:45000}},health:[],stages:[],stop_reason:null};
let stopped=false,healthBusy=false,monitor=null,currentStage=null;
function save(){mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));} // Persist each checkpoint and interruption without dialogue text or secrets.
function stop(reason){stopped=true;report.stop_reason??=reason;}
process.on('SIGINT',()=>stop('operator interrupt'));
async function checkHealth(phase){
 const snapshots=await Promise.all(nodes.map(async node=>{const response=await fetch(node.base+'/health',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('health HTTP '+response.status+' on '+node.base);const health=await response.json();return {node:node.base,health};}));
 report.health.push({at:new Date().toISOString(),phase,snapshots});
 for(const s of snapshots){try{assertTestHealth(s.health,overflow);}catch(error){throw Error(s.node+': '+error.message);}}
} // Preflight and periodic verification enforce the selected overflow mode and healthy workers.

async function call(path,body,timeoutMs){
 const began=performance.now();
 try{const r=await pool.request(path,body,{timeoutMs,attempts:2});return {ok:r.ok,status:r.status,node:r.node,ms:performance.now()-began,body:r.body};}
 catch(error){return {ok:false,status:error?.status??error?.name??'network',node:error?.node??'?',ms:performance.now()-began,body:{}};}
} // Client timing includes failover; production-style deadlines retain the cost of slow requests.

function makeDispatch(players){
 const state=Array.from({length:players},(_,i)=>({name:'Traveller '+(i+1),histories:new Map()}));
 return async event=>{
  const player=state[event.player],gates=[],historyKey=event.kind==='pip'?'pip':npcIds[event.player%npcIds.length];
  let npc=historyKey,history=(player.histories.get(historyKey)??[]).map(t=>({...t}));
  const text=(event.prompt%5===0?GAME: SOCIAL)[Math.floor(event.prompt/5)%(event.prompt%5===0?GAME.length:SOCIAL.length)];
  let message=PREFACES[Math.floor(event.prompt/101)%PREFACES.length]+text;
  if(event.kind==='companion'&&event.nearby){
   const candidates=Array.from({length:nearbyCount},(_,i)=>npcIds[(event.player+i)%npcIds.length]);
   const answers=await Promise.all(candidates.map(async id=>{
    const candidateHistory=player.histories.get(id)??[],r=await call('/v1/participation/decide',participationContext(catalog[id],{message,playerName:player.name,history:candidateHistory,conversation:candidateHistory.length>0,hired:id===npc,nearbyNames:candidates.map(n=>catalog[n].name)}),12000);
    let join=false;try{if(r.ok)join=participationSaysJoin(r.body);}catch{r.ok=false;r.status='invalid_gate';}
    gates.push({node:r.node,status:r.status,ok:r.ok,ms:r.ms,join,timings_ms:r.body.timings_ms??null});return {id,join,ok:r.ok};
   }));
   if(answers.some(r=>!r.ok))return {ok:false,generated:false,outcome:'gate_failed',gates};
   const speaker=answers.find(r=>r.join);
   if(!speaker)return {ok:true,generated:false,outcome:'quiet',gates};
   npc=speaker.id;history=(player.histories.get(npc)??[]).map(t=>({...t})); // At most one generated answer per nearby message; fanout still costs one gate per candidate.
  }else if(event.kind==='companion')message=catalog[npc].name.split(' ')[0]+', '+message;
  const body=event.kind==='pip'?{message,player_id:runId+'-'+players+'-'+event.player,player_name:player.name,npc_name:'Pip',history}:
   {message,npc_id:npc,npc_name:catalog[npc].name.slice(0,32),player_name:player.name,persona:catalog[npc].online.persona,voice:catalog[npc].dialogue.talk_lines.slice(0,3),history,bond:30,lore_version:lore.version,memories,audience:event.nearby?nearbyCount:0};
  const r=await call(event.kind==='pip'?'/v1/npc/chat':'/v1/companion/chat',body,event.kind==='pip'?45000:20000);
  const generated=r.ok&&!r.body.fallback&&['passed','passed_after_retry'].includes(r.body.guard)&&typeof r.body.reply==='string'&&!!r.body.reply.trim();
  if(generated){const h=player.histories.get(npc)??[];player.histories.set(npc,[...h,{role:'user',content:message},{role:'assistant',content:r.body.reply.slice(0,600)}].slice(-6));}
  return {ok:r.ok&&!r.body.fallback,generated,outcome:!r.ok?'http_error':r.body.fallback?'availability_fallback':r.body.guard??'unknown',status:r.status,node:r.node,http_ms:r.ms,timings_ms:r.body.timings_ms??null,gates};
 }; // Histories stay in harness memory; artifacts contain only synthetic IDs, outcomes and timings.
}

try{
 await checkHealth('preflight');
 await pool.probe();
 const pushed=await pool.broadcast('/v1/companion/lore',lore,{timeoutMs:30000});
 if(pushed.some(r=>!r.ok))throw Error('Companion lore push failed');
 console.log('Player test: both nodes healthy, overflow '+overflow+'. '+levels.join('/')+' players; '+seconds+'s per stage.');
 monitor=setInterval(()=>{if(healthBusy||stopped)return;healthBusy=true;checkHealth('monitor').catch(error=>stop('health/overflow verification failed: '+error.message)).finally(()=>{healthBusy=false;save();});},30000);
 for(const players of levels){
  if(stopped)break;
  await checkHealth('before-'+players);
  const schedule=buildSchedule({players,seconds,interval,seed,burstEvery,burstFraction});
  const stage={players,started_at:new Date().toISOString(),planned:schedule.length,results:[],samples:[]};currentStage=stage;report.stages.push(stage);
  console.log('Starting '+players+' active players: '+schedule.length+' scheduled messages.');
  let lastProgress=-30000;
  const run=await runSchedule(schedule,{durationMs:seconds*1000,dispatch:makeDispatch(players),shouldStop:()=>stopped,onSample:(sample,results)=>{
   stage.results=[...results];stage.samples.push(sample);
   if(sample.elapsed_ms-lastProgress>=30000){
    lastProgress=sample.elapsed_ms;const generated=results.filter(r=>r.generated),failed=results.filter(r=>!r.ok).length;
    console.log(players+' players | '+Math.round(sample.elapsed_ms/1000)+'s | offered '+sample.offered+' | pending '+sample.pending+' | generated '+generated.length+' | failed '+failed+' | p95 '+Math.round(percentile(generated.map(r=>r.ms),95)??0)+'ms');save();
    if(results.length>=30&&failed/results.length>=.1)stop('early stop: at least 10% failed player messages');
    if(sample.pending>=100)stop('early stop: at least 100 pending messages');
   }
  }});
  Object.assign(stage,run);if(stopped)stage.stopped=true;stage.summary=summarizeStage(stage);
  await checkHealth('after-'+players);save();
  console.log('Stage result: '+JSON.stringify(stage.summary));
  if(!stage.summary.pass){stop('capacity threshold at '+players+' players: '+stage.summary.reasons.join('; '));break;}
 }
}catch(error){stop(error.message);if(currentStage)currentStage.invalid=true;console.error('Stopped: '+error.message);process.exitCode=1;}
finally{
 if(monitor)clearInterval(monitor);
 while(healthBusy)await new Promise(r=>setTimeout(r,50));
 report.finished_at=new Date().toISOString();
 report.highest_passing_players=Math.max(0,...report.stages.filter(s=>!s.invalid&&s.summary?.pass).map(s=>s.players));
 save();pool.close();console.log('Highest passing tested population: '+report.highest_passing_players+' active AI users. Artifact: '+output);
}
