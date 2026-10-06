import {DEFAULT_ZONE_CAPACITY,parseZoneCapacity} from './zone-capacity.mjs';
import {Worker} from 'node:worker_threads';
import {availableParallelism} from 'node:os';
import {performance} from 'node:perf_hooks';
import {computeWorkerCount} from './compute-pool.mjs';

export function zoneWorkerCount(value='auto',cores=availableParallelism()){
 if(value==='auto')return Math.min(4,Math.max(0,cores-2));
 if(!/^(0|[1-9]\d*)$/.test(String(value))||Number(value)>16)throw Error('QUEST_ZONE_WORKERS must be auto or an integer from 0 to 16');
 return Number(value);
}
export function zoneShardIndex(zone,size){let hash=2166136261;for(const character of String(zone)){hash^=character.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0)%size;} // Stable preferred worker per zone; spare workers may share read-only snapshots from a busy zone.
export function worldWorkerBudget(zoneValue='auto',computeValue='auto',cores=availableParallelism()){const zoneWorkers=zoneWorkerCount(zoneValue,cores);return {zoneWorkers,workerCount:computeWorkerCount(computeValue,Math.max(1,cores-zoneWorkers))};} // Both automatic pools share the same CPU budget; explicit numbers remain operator choices.

export function createZoneShards({size,filename,blankCanvas,questPack,followerEnabled,zoneCapacity=DEFAULT_ZONE_CAPACITY,maxQueue=256,timeoutMs=10000,observe=()=>{},workerUrl=new URL('./zone-worker.mjs',import.meta.url)}){
 zoneCapacity=parseZoneCapacity(zoneCapacity); // Validate before spawning workers.
 if(!Number.isInteger(size)||size<1||size>16)throw Error('Zone worker size must be from 1 to 16');
 if(!filename||filename===':memory:')throw Error('Zone workers require a shared persistent SQLite filename');
 const slots=Array.from({length:size},(_,index)=>({index,worker:null,ready:false,job:null,queue:[],completed:0,failed:0,restarts:0,zones:new Set()}));let closed=false,sequence=0,rejected=0,closing;
 const unavailable=message=>Object.assign(Error(message),{status:503,code:'zone_worker_unavailable'});
 function settle(slot,error,result){const job=slot.job;if(!job)return;slot.job=null;clearTimeout(job.timer);if(error){slot.failed++;job.reject(error);}else{slot.completed++;job.resolve(result);}observe('shard.roundtrip',performance.now()-job.started,!!error);}
 function spawn(slot){
  const worker=new Worker(workerUrl,{workerData:{filename,blankCanvas,questPack,followerEnabled,zoneCapacity}});slot.worker=worker;slot.ready=false;
  let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});slot.started=ready;
  const bootTimer=setTimeout(()=>fail(unavailable('Zone worker startup timed out.')),30000);
  function fail(error){if(slot.worker!==worker)return;clearTimeout(bootTimer);slot.worker=null;slot.ready=false;slot.restarts++;readyReject(error);settle(slot,unavailable('Zone worker interrupted. Retry the request.'));for(const job of slot.queue.splice(0)){clearTimeout(job.queueTimer);job.reject(unavailable('Zone worker interrupted. Retry the request.'));}void worker.terminate();} // Failed reads can safely retry; no worker can partially commit an action.
  worker.on('error',fail);worker.on('exit',code=>fail(unavailable('Zone worker exited ('+code+').')));
  worker.on('message',message=>{
   if(slot.worker!==worker)return;
   if(message.ready){clearTimeout(bootTimer);slot.ready=true;readyResolve();worker.unref();drain(slot);return;}
   if(slot.job?.id!==message.id)return;
   observe('shard.snapshot',message.elapsedMs,!!message.error);for(const timing of message.timings??[])observe('shard.'+timing.name,timing.elapsed,timing.failed);
   settle(slot,message.error?Object.assign(Error(message.error.frames?message.error.message+' <worker: '+message.error.frames+'>':message.error.message),{status:message.error.status,code:message.error.code??'zone_worker_failed'}):null,message.bytes);worker.unref();drain(slot);
  });
  slot.fail=fail;return ready;
 }
 function drain(slot){
  if(closed||slot.job)return;if(!slot.queue.length){const donor=slots.filter(s=>s!==slot&&s.queue.length).sort((a,b)=>b.queue.length-a.queue.length)[0];if(donor&&slot.ready)slot.queue.push(donor.queue.shift());} // Read-only WAL snapshots can move to an idle core without transferring mutable zone ownership.
  if(!slot.queue.length)return;if(!slot.worker){spawn(slot);return;}if(!slot.ready)return;
  const job=slot.queue.shift();clearTimeout(job.queueTimer);slot.zones.add(job.zone);slot.job=job;job.started=performance.now();observe('shard.queue',job.started-job.queued);
  job.timer=setTimeout(()=>slot.fail(unavailable('Zone worker request timed out.')),Math.max(1,timeoutMs-(job.started-job.queued)));slot.worker.ref();
  try{slot.worker.postMessage({id:job.id,input:job.input});}catch(error){slot.fail(error);}
 }
 function render(zone,input){
  if(closed)return Promise.reject(unavailable('Zone workers are shutting down.'));
  if(slots.reduce((n,s)=>n+s.queue.length,0)>=maxQueue){rejected++;return Promise.reject(Object.assign(Error('Online snapshot queue is busy. Retry shortly.'),{status:429,code:'zone_worker_busy'}));}
  const slot=slots[zoneShardIndex(zone,size)];
  return new Promise((resolve,reject)=>{const job={id:++sequence,zone,input,resolve,reject,queued:performance.now()};job.queueTimer=setTimeout(()=>{const index=slot.queue.indexOf(job);if(index<0)return;slot.queue.splice(index,1);rejected++;reject(unavailable('Zone snapshot waited too long. Retry shortly.'));},timeoutMs);slot.queue.push(job);drain(slot);for(const other of slots)if(other!==slot)drain(other);}); // Queue wait and execution share one deadline; a hot zone cannot strand idle cores.
 }
 function snapshot(){return {size,queued:slots.reduce((n,s)=>n+s.queue.length,0),busy:slots.filter(s=>s.job).length,rejected,workers:slots.map(s=>({index:s.index,threadId:s.worker?.threadId??null,ready:s.ready,busy:!!s.job,queued:s.queue.length,completed:s.completed,failed:s.failed,restarts:s.restarts,zones:[...s.zones].sort()}))};}
 function close(){if(closing)return closing;closed=true;closing=Promise.all(slots.map(slot=>{settle(slot,unavailable('Zone workers are shutting down.'));for(const job of slot.queue.splice(0)){clearTimeout(job.queueTimer);job.reject(unavailable('Zone workers are shutting down.'));}const worker=slot.worker;slot.fail?.(unavailable('Zone workers are shutting down.'));return worker?.terminate();}));return closing;}
 return {render,snapshot,ready:()=>closed?Promise.reject(unavailable('Zone workers are shutting down.')):Promise.all(slots.map(slot=>slot.worker?slot.started:spawn(slot))),close}; // Bounded worker queues provide backpressure instead of spawning a thread per player.
}
