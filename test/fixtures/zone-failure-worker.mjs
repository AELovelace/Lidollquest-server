import {parentPort,threadId} from 'node:worker_threads';
parentPort.on('message',({id,input})=>{
 if(input.mode==='crash')process.exit(7);
 if(input.mode==='hang')return;
 parentPort.postMessage({id,bytes:new TextEncoder().encode(String(threadId)),elapsedMs:1});
});
parentPort.postMessage({ready:true});
