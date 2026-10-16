// Pure scheduling and scoring helpers for the AI capacity test.
export function randomFromSeed(seed=1){
 let state=seed>>>0;
 return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
} // Repeat the same offered workload independently of response speed.

export function buildSchedule({players,seconds,interval=30,seed=1,burstEvery=120,burstFraction=.2}){
 const random=randomFromSeed(seed),events=[];
 for(let player=0;player<players;player++){
  for(let turn=0;turn*interval<seconds;turn++){
   const base=turn*interval,burst=base>0&&base%burstEvery===0&&player<Math.floor(players*burstFraction);
   const at=base+(burst?0:player/players*interval+random()*interval/players*.5);
   if(at<seconds)events.push({player,turn,at_ms:Math.round(at*1000),kind:random()<.75?'companion':'pip',nearby:random()<.2,prompt:Math.floor(random()*1000000)});
  }
 }
 return events.sort((a,b)=>a.at_ms-b.at_ms||a.player-b.player);
} // Each player sends once per interval; periodic bursts align 20% without adding messages.

export function assertTestHealth(health,overflow='disabled'){
 if(!['disabled','enabled'].includes(overflow))throw Error('Expected overflow mode must be disabled or enabled');
 if(health?.overflow?.enabled!==(overflow==='enabled'))throw Error('Cloud overflow must be '+overflow+'; reported state differs or is unknown');
 if(health.ok!==true||health.llm!==true||health.classifier!==true)throw Error('RAG or local generation is unhealthy');
 for(const [name,section] of [['routing',health.classification],['participation',health.participation]]){
  if(!section?.workers?.length||section.healthy_capacity!==section.capacity||section.workers.some(w=>!w.healthy||w.failures))throw Error(name+' workers are unhealthy');
 }
 if(!health.participation.enabled||!health.participation.healthy||!['lidoll/decider-chat-0-1','lidoll/decider-multitask-v2','lidoll/decider-multitask-v3'].includes(health.participation.release))throw Error('Decider Chat release is not ready'); // The merged routing+participation Decider (2026-10-15) is accepted like the dedicated one, matching participation-gate.mjs.
} // Unknown health fails closed; both hosts must retain the requested mode throughout the test.

export const assertLocalHealth=health=>assertTestHealth(health,'disabled'); // Preserve the local-only guard for existing callers.

export async function runSchedule(events,{dispatch,now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),shouldStop=()=>false,onSample=()=>{},maxPending=128,maxLagMs=1000,durationMs=0}={}){
 const start=now(),pending=new Set(),results=[],samples=[];
 let index=0,nextSample=0,stopped=false;
 while(now()-start<durationMs||index<events.length){
  const elapsed=now()-start;
  if(shouldStop()){stopped=true;break;}
  while(index<events.length&&events[index].at_ms<=elapsed){
   const event=events[index++],lag=Math.max(0,now()-start-event.at_ms);
   if(lag>maxLagMs||pending.size>=maxPending){results.push({...event,ok:false,generated:false,outcome:lag>maxLagMs?'scheduler_late':'load_limit',ms:lag,scheduler_lag_ms:lag});continue;}
   const task=(async()=>dispatch(event))().then(result=>results.push({...event,...result,ms:now()-start-event.at_ms,scheduler_lag_ms:lag}),()=>results.push({...event,ok:false,generated:false,outcome:'dispatch_error',ms:now()-start-event.at_ms,scheduler_lag_ms:lag})).finally(()=>pending.delete(task));
   pending.add(task); // Do not await replies here: slow servers must not reduce the offered rate.
  }
  if(elapsed>=nextSample){const sample={elapsed_ms:elapsed,pending:pending.size,offered:index,completed:results.length};samples.push(sample);onSample(sample,results);nextSample=elapsed+5000;}
  if(index>=events.length&&elapsed>=durationMs)break;
  await sleep(Math.max(1,Math.min(50,(events[index]?.at_ms??durationMs)-elapsed)));
 }
 const pendingAtEnd=pending.size,drainStart=now();
 await Promise.all(pending); // Requests keep finite HTTP deadlines; record drain time separately from the arrival window.
 return {results,samples,offered:index,planned:events.length,stopped,pending_at_end:pendingAtEnd,drain_ms:now()-drainStart,wall_ms:now()-start};
}

export const percentile=(values,p)=>{
 if(!values.length)return null;
 const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);
 return p===50?(s.length%2?s[m]:(s[m-1]+s[m])/2):s[Math.ceil(p/100*s.length)-1];
}; // Conventional median and nearest-rank p95, including scheduling delay for player-visible latency.

export function summarizeStage(stage){
 const rows=stage.results,generated=rows.filter(r=>r.generated),failures=rows.filter(r=>!r.ok),gates=rows.flatMap(r=>r.gates??[]);
 const samples=stage.samples.filter(s=>s.elapsed_ms>=60000),split=Math.max(1,Math.floor(samples.length/3));
 const mean=list=>list.reduce((sum,s)=>sum+s.pending,0)/Math.max(1,list.length);
 const growth=mean(samples.slice(-split))-mean(samples.slice(0,split));
 const p50=percentile(generated.map(r=>r.ms),50),p95=percentile(generated.map(r=>r.ms),95),errorRate=failures.length/Math.max(1,rows.length);
 const reasons=[];
 if(stage.stopped||stage.offered!==stage.planned)reasons.push('incomplete arrival schedule');
 if(generated.length<20)reasons.push('fewer than 20 generated replies');
 if(p50===null||p50>=5000)reasons.push('generated median >= 5s');
 if(p95===null||p95>=10000)reasons.push('generated p95 >= 10s');
 if(errorRate>=.01)reasons.push('failed player messages >= 1%');
 if(samples.length<12)reasons.push('insufficient sustained backlog samples');
 if(growth>2)reasons.push('average pending messages grew by more than two');
 return {offered:stage.offered,generated:generated.length,failures:failures.length,error_rate:errorRate,
  outcomes:rows.reduce((out,r)=>(out[r.outcome]=(out[r.outcome]??0)+1,out),{}),generated_p50_ms:p50,generated_p95_ms:p95,
  gate_calls:gates.length,gate_p50_ms:percentile(gates.map(r=>r.ms),50),gate_p95_ms:percentile(gates.map(r=>r.ms),95),
  pending_growth:growth,pending_at_end:stage.pending_at_end,drain_ms:stage.drain_ms,pass:reasons.length===0,reasons};
} // Quiet decisions and source-guard replies are reported separately, never counted as generated dialogue.
