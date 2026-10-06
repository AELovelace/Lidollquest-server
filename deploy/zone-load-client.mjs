import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

process.once('message',async({base,players,seconds,hz,expectedPeers=null})=>{
 const start=performance.now()+100,end=start+seconds*1000,latencies=[],errors={},actions={};let bytes=0,peerMin=Infinity,peerMax=0,peerMismatchResponses=0;
 await Promise.all(players.map(async(player,index)=>{
  let next=start+index/players.length*(1000/hz),turn=0,state=player.state,out=false,known=new Set();
  while(next<end){
   await sleep(Math.max(0,next-performance.now()));if(performance.now()>=end)break;
   const action=turn%30===29?'chat':turn%5===4&&player.direction?'move':'heartbeat',input={action,character_id:state.character.id,revision:state.character.revision,request_id:randomUUID(),controller:'benchmark'};
   if(action==='move')input.direction=out?player.reverse:player.direction;
   if(action==='chat'){input.text='Benchmark traveller '+index+' says hello.';input.channel='area';}
   const began=performance.now();
   try{
    const response=await fetch(base+'/zones/action?known='+[...known].join(','),{method:'POST',headers:{Authorization:'Bearer '+player.token,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(10000)}),body=await response.text();bytes+=Buffer.byteLength(body);
    if(response.ok){state=JSON.parse(body);const peers=state.peers?.length??0;peerMin=Math.min(peerMin,peers);peerMax=Math.max(peerMax,peers);if(expectedPeers!==null&&peers!==expectedPeers)peerMismatchResponses++;if(action==='move')out=!out;actions[action]=(actions[action]??0)+1;for(const zone of state.zones??[])if(zone.cacheKey)known.add(zone.cacheKey);for(const key of Object.values(state.cacheKeys??{}))known.add(key);if(known.size>256)known=new Set([...known].slice(-256));}
    else{const result=JSON.parse(body),key=response.status+':'+result.error_description;errors[key]=(errors[key]??0)+1;}
   }catch(error){errors[error.name]=(errors[error.name]??0)+1;}
   latencies.push(performance.now()-began);turn++;next+=1000/hz;
   if(next<performance.now()){const skipped=Math.floor((performance.now()-next)/(1000/hz));next+=skipped*(1000/hz);} // Report missed offered load instead of hiding saturation behind a closed-loop client.
  }
 }));
 latencies.sort((a,b)=>a-b);const elapsed=(performance.now()-start)/1000,pct=p=>latencies[Math.min(latencies.length-1,Math.floor(latencies.length*p))]??0;
 const scheduled=players.reduce((total,_,index)=>total+Math.ceil(seconds*hz-index/players.length),0),missed=scheduled-latencies.length; // Include offered slots lost at the deadline, not just slots skipped between requests.
 process.send({players:players.length,scheduled,peerMin:Number.isFinite(peerMin)?peerMin:null,peerMax,peerMismatchResponses,offeredRps:players.length*hz,elapsedSeconds:elapsed,requests:latencies.length,achievedRps:latencies.length/elapsed,p50Ms:pct(.5),p95Ms:pct(.95),p99Ms:pct(.99),maxMs:pct(1),bytes,missed,errors,actions});process.disconnect();
}); // Separate process: load-generator CPU is excluded from the server's performance counters.
