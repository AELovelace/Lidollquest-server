import {performance} from 'node:perf_hooks';
import {availableParallelism} from 'node:os';
import {createComputePool,computeWorkerCount} from '../server/compute-pool.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {diveData} from '../server/dive.mjs';
import {desertData,tundraData,taigaData,highDesertData} from '../server/zones.mjs';
import {campaignDives} from '../server/hubs.mjs';
import {createQuestService} from '../server/service.mjs';

const counts=(process.argv.find(value=>value.startsWith('--workers='))?.slice(10)??'0,1,2,4,6').split(',').map(value=>computeWorkerCount(value));
const definitions=[diveData,desertData,tundraData,taigaData,highDesertData,...campaignDives];
const generation=definitions.map(data=>({generator:[desertData,tundraData,taigaData,highDesertData].includes(data)?'desert':'rooms',data,edition:'2026-09-14'}));
const floors=generation.map(input=>computeTask('generate',input));
const batches=floors.map((floor,index)=>({floor:{width:floor.width,height:floor.height,walls:floor.walls,props:floor.props},starts:floor.enemies.map(e=>({x:e.x,y:e.y})),targets:floor.enemies.slice(0,16).map(e=>({x:e.x,y:e.y})),limit:definitions[index].config.pursuit_steps}));
const round=value=>Math.round(value*100)/100,p95=values=>values.length?round([...values].sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1]):null;

async function httpSample(workerCount){
 const service=createQuestService({workerCount,now:()=>Date.parse('2026-09-17T12:00:00Z'),performanceOptions:{automatic:false},walletClient:{authenticate:async()=>({owner:'benchmark',id:'benchmark',client:'lidollquest',coins:0})}});
 try{
  await service.prepare();await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+service.server.address().port,latencies=[];
  const read=async lane=>{const start=performance.now(),response=await fetch(base+'/zones',{headers:{Authorization:'Bearer '+String(lane).repeat(43)}});await response.json();if(!response.ok)throw Error('Benchmark request failed: '+response.status);latencies.push(performance.now()-start);};
  await Promise.all([1,2,3,4].map(read));latencies.length=0;service.metrics.sample();
  const start=performance.now();await Promise.all([1,2,3,4].map(async lane=>{for(let i=0;i<10;i++)await read(lane);}));
  const elapsed=performance.now()-start,metrics=service.metrics.snapshot().current;
  return {httpRequestsPerSecond:round(40000/elapsed),httpClientP95Ms:p95(latencies),httpLoopDelayMaxMs:metrics.delayMaxMs,snapshots:metrics.timings.find(row=>row.name==='snapshot.build')?.calls??0};
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
} // An isolated in-memory HTTP workload measures snapshot overhead, without real accounts, traffic or database files.

const results=[];
for(const size of counts){
 const timings=[],pool=size?createComputePool({size,observe:(name,ms)=>timings.push({name,ms})}):null;
 const run=(kind,input)=>pool?pool.submit(kind,input):computeTask(kind,input);
 let generationMs,pathMs;
 try{
  if(pool)await Promise.all(Array.from({length:size},()=>run('paths',{floor:{width:1,height:1,walls:[[0]]},starts:[],targets:[],limit:1}))); // Exclude thread startup from steady execution comparisons.
  let start=performance.now();await Promise.all(generation.map(input=>run('generate',input)));generationMs=performance.now()-start;
  timings.length=0;start=performance.now();await Promise.all(Array.from({length:40},(_,index)=>run('paths',batches[index%batches.length])));pathMs=performance.now()-start;
 }finally{await pool?.close();}
 results.push({workers:size,generationBatchMs:round(generationMs),pathBatchMs:round(pathMs),pathJobsPerSecond:round(40000/pathMs),queueP95Ms:p95(timings.filter(row=>row.name==='worker.queue.paths').map(row=>row.ms)),executionP95Ms:p95(timings.filter(row=>row.name==='worker.paths').map(row=>row.ms)),...await httpSample(size)});
}
console.log(JSON.stringify({availableCores:availableParallelism(),note:'Synthetic local comparison: ten floor generations, forty pursuit batches (up to sixteen targets), and forty empty-lobby HTTP reads at concurrency four. HTTP reads do not exercise roaming or wallet latency. Repeat on the VM and compare live populated-zone p95/queue/stale-result metrics before choosing a worker count.',results},null,2));
