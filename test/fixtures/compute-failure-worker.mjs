import {parentPort,threadId} from 'node:worker_threads';
parentPort.on('message',({id,input})=>{
 if(input.mode==='crash')process.exit(1);
 if(input.mode==='hang')return;
 parentPort.postMessage({id,result:threadId,elapsedMs:0});
}); // Test-only worker for process failure, saturation and timeout recovery.
