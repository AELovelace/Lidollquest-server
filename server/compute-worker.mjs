import {parentPort} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {computeTask} from './compute-tasks.mjs';

parentPort.on('message',({id,kind,input})=>{
 const start=performance.now();
 try{const result=computeTask(kind,input);parentPort.postMessage({id,result,elapsedMs:performance.now()-start});}
 catch(error){parentPort.postMessage({id,error:String(error?.message??error),elapsedMs:performance.now()-start});}
}); // A failed calculation rejects its own job without taking down the HTTP service.
