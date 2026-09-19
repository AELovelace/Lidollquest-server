import {generateFloor,pathTo} from './dive-generation.mjs';
import {generateDesert} from './desert-generation.mjs';

export function computeTask(kind,input){
 if(kind==='generate'){
  if(!['rooms','desert'].includes(input.generator))throw Error('Unknown floor generator');
  return (input.generator==='desert'?generateDesert:generateFloor)(input.data,input.edition);
 }
 if(kind==='paths')return input.starts.map(start=>input.targets.map(target=>pathTo(input.floor,start,target,input.limit))); // One floor crosses the thread boundary for the whole batch.
 throw Error('Unknown compute task');
} // Pure calculations only: workers never receive database connections, account credentials or mutable game state.
