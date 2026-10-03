import {parentPort} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {computeTask,resolveFloor} from './compute-tasks.mjs';

const floors=new Map(); // Floors this thread has already been sent, by key; path batches then arrive carrying only the key.
parentPort.on('message',({id,kind,input})=>{
 const start=performance.now();
 try{const result=computeTask(kind,kind==='paths'?resolveFloor(input,floors):input);parentPort.postMessage({id,result,elapsedMs:performance.now()-start});}
 catch(error){parentPort.postMessage({id,error:String(error?.message??error),code:error?.code,elapsedMs:performance.now()-start});} // code 'floor_missing' asks the pool for the whole floor.
}); // A failed calculation rejects its own job without taking down the HTTP service.
