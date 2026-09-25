import {generateFloor,pathTo} from './dive-generation.mjs';
import {generateDesert} from './desert-generation.mjs';
import {generateForest} from './forest-generation.mjs';
import {generateMansion} from './mansion-generation.mjs';
import {generateFarmstead} from './farmstead-generation.mjs';
import {generateSpa} from './spa-generation.mjs';
import {generateCastleDungeon,generateAutoNursery,generateRegressionSchool,generateRegressionHospital} from './full-dungeon-generation.mjs';
export const GENERATORS=Object.freeze({rooms:generateFloor,desert:generateDesert,forest:generateForest,mansion:generateMansion,farmstead:generateFarmstead,spa:generateSpa,castle_dungeon:generateCastleDungeon,auto_nursery:generateAutoNursery,regression_school:generateRegressionSchool,regression_hospital:generateRegressionHospital}); // Workers receive generator names and exported content, never mutable game state.
export const generatorName=generate=>Object.keys(GENERATORS).find(name=>GENERATORS[name]===generate)??null; // null: a custom generator that must run on the main thread.

export function computeTask(kind,input){
 if(kind==='generate'){
  if(!Object.hasOwn(GENERATORS,input.generator))throw Error('Unknown floor generator');
  return GENERATORS[input.generator](input.data,input.edition);
 }
 if(kind==='paths')return input.starts.map(start=>input.targets.map(target=>pathTo(input.floor,start,target,input.limit))); // One floor crosses the thread boundary for the whole batch.
 throw Error('Unknown compute task');
} // Pure calculations only: workers never receive database connections, account credentials or mutable game state.
