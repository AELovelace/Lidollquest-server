import {parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {createZoneSnapshotRuntime} from './zone-snapshot-runtime.mjs';

const runtime=createZoneSnapshotRuntime(workerData);
parentPort.on('message',({id,input})=>{
 const start=performance.now();
 try{const result=runtime.render(input);parentPort.postMessage({id,...result,elapsedMs:performance.now()-start},[result.bytes.buffer]);}
 catch(error){parentPort.postMessage({id,error:{message:error.message,status:error.status,code:error.code,...(error.status?{}:{frames:String(error.stack??'').split('\n').slice(1,4).map(s=>s.trim()).join(' | ')})},elapsedMs:performance.now()-start});}
}); // One task per worker at a time; messages never contain player access tokens or wallet credentials.
parentPort.postMessage({ready:true});
