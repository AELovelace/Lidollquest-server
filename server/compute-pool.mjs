import {Worker} from 'node:worker_threads';
import {availableParallelism} from 'node:os';
import {performance} from 'node:perf_hooks';
import {AsyncResource} from 'node:async_hooks';
import {FLOOR_CACHE_LIMIT} from './compute-tasks.mjs';

export function computeWorkerCount(value='auto',cores=availableParallelism()){
 if(value==='auto')return Math.min(6,Math.max(0,cores-2)); // Leave headroom for the coordinator and other VM services.
 if(!/^(0|[1-9]\d*)$/.test(String(value))||Number(value)>32)throw Error('QUEST_COMPUTE_WORKERS must be auto or an integer from 0 to 32');
 return Number(value);
}

export function createComputePool({size=2,maxQueue=64,timeoutMs=60000,observe=()=>{},workerUrl=new URL('./compute-worker.mjs',import.meta.url),floorCacheLimit=FLOOR_CACHE_LIMIT}={}){
 if(!Number.isInteger(size)||size<1||size>32)throw Error('Compute pool size must be from 1 to 32');
 const queue=[],slots=Array.from({length:size},()=>({worker:null,job:null,completed:0,failed:0,floors:new Set()}));
 function payload(slot,job){
  const key=job.kind==='paths'?job.input?.floor?.key:null;if(!key)return job.input; // Unkeyed jobs always carry their whole input.
  if(slot.floors.has(key)&&!job.resend){slot.floors.delete(key);slot.floors.add(key);observe('worker.floor.cached',0);return {...job.input,floor:{key}};} // This worker already holds the grid: send the key alone (the roundtrip was ~7 ms of cloning for ~0.4 ms of pathing).
  slot.floors.delete(key);slot.floors.add(key);while(slot.floors.size>floorCacheLimit)slot.floors.delete(slot.floors.values().next().value);observe('worker.floor.sent',0);return job.input;
 } // Per-slot memory of the floors each thread has seen, evicting oldest first in step with the worker's own cache.
 let nextId=0,closed=false,closing=null,rejected=0;
 function finish(slot,error,result,elapsedMs){
  const job=slot.job;if(!job)return;slot.job=null;clearTimeout(job.timer);
  if(error)slot.failed++;else slot.completed++;
  if(Number.isFinite(elapsedMs))observe('worker.'+job.kind,elapsedMs,Boolean(error));
  observe('worker.roundtrip.'+job.kind,performance.now()-job.sentAt,Boolean(error));
  job.resource.runInAsyncScope(error?job.reject:job.resolve,null,error??result);job.resource.emitDestroy();
 } // Settle each job once and preserve its async diagnostic context across worker messages.
 function spawn(slot){
  const worker=new Worker(workerUrl);slot.worker=worker;slot.floors=new Set(); // A fresh thread holds no floors.
  const failed=error=>{if(slot.worker!==worker)return;slot.worker=null;finish(slot,error);void worker.terminate();drain();};
  worker.on('message',message=>{
   if(slot.worker!==worker||slot.job?.id!==message.id)return;
   if(message.code==='floor_missing'&&!slot.job.resend){const job=slot.job;job.resend=true;slot.floors.delete(job.input.floor.key);observe('worker.floor.resent',0);worker.postMessage({id:job.id,kind:job.kind,input:payload(slot,job)});return;} // The worker forgot a floor the pool remembered: send the whole floor once, keeping the job's timer and slot.
   finish(slot,message.error?Error(message.error):null,message.result,message.elapsedMs);worker.unref();drain();
  });
  worker.on('error',failed);worker.on('exit',code=>failed(Error('Compute worker exited ('+code+')')));worker.unref();
  return worker;
 } // Replacement workers are started only when there is queued work, preventing idle crash loops.
 function drain(){
  if(closed)return;
  for(const slot of slots){
   if(slot.job||!queue.length)continue;
   const job=queue.shift();slot.job=job;job.sentAt=performance.now();
   observe('worker.queue.'+job.kind,job.sentAt-job.queuedAt);
   try{
    const worker=slot.worker??spawn(slot);worker.ref();
    job.timer=setTimeout(()=>{if(slot.job!==job)return;slot.worker=null;finish(slot,Error('Compute job timed out'));void worker.terminate();drain();},timeoutMs);
    worker.postMessage({id:job.id,kind:job.kind,input:payload(slot,job)});
   }catch(error){finish(slot,error);slot.worker?.unref();}
  }
  if(queue.length&&slots.some(slot=>!slot.job))queueMicrotask(drain);
 } // The queue and concurrency limit bound memory use; no request creates its own thread.
 function submit(kind,input){
  if(closed)return Promise.reject(Error('Compute pool is closed'));
  if(!['generate','paths'].includes(kind))return Promise.reject(Error('Unknown compute task'));
  if(queue.length>=maxQueue&&slots.every(slot=>slot.job)){rejected++;return Promise.reject(Error('Compute queue is full'));}
  return new Promise((resolve,reject)=>{queue.push({id:++nextId,kind,input,resolve,reject,queuedAt:performance.now(),resource:new AsyncResource('QuestComputeJob')});drain();});
 }
 function snapshot(){return {size,queued:queue.length,busy:slots.filter(slot=>slot.job).length,rejected,workers:slots.map((slot,index)=>({index,busy:Boolean(slot.job),completed:slot.completed,failed:slot.failed}))};}
 function close(){
  if(closing)return closing;closed=true;
  for(const job of queue.splice(0)){job.resource.runInAsyncScope(job.reject,null,Error('Compute pool is closed'));job.resource.emitDestroy();}
  closing=Promise.all(slots.map(slot=>{finish(slot,Error('Compute pool is closed'));const worker=slot.worker;slot.worker=null;return worker?.terminate();}));return closing;
 } // Shutdown rejects queued and active calculations before database ownership is released.
 return {submit,snapshot,close};
}
