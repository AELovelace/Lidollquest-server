import {generateCaverns} from './caverns-generation.mjs';
import {generateFloor,pathTo} from './dive-generation.mjs';
import {generateDesert} from './desert-generation.mjs';
import {generateForest} from './forest-generation.mjs';
import {generateMansion} from './mansion-generation.mjs';
import {generateFarmstead} from './farmstead-generation.mjs';
import {generateSpa} from './spa-generation.mjs';
import {generateCastleDungeon,generateAutoNursery,generateRegressionSchool,generateRegressionHospital} from './full-dungeon-generation.mjs';
import {generateFullDungeon} from './full-dungeon-generation.mjs';
export const GENERATORS=Object.freeze({arcadia_industrial:generateFullDungeon,caverns:generateCaverns,rooms:generateFloor,desert:generateDesert,forest:generateForest,mansion:generateMansion,farmstead:generateFarmstead,spa:generateSpa,castle_dungeon:generateCastleDungeon,auto_nursery:generateAutoNursery,regression_school:generateRegressionSchool,regression_hospital:generateRegressionHospital}); // Workers receive generator names and exported content, never mutable game state.
export const generatorName=generate=>Object.keys(GENERATORS).find(name=>GENERATORS[name]===generate)??null; // null: a custom generator that must run on the main thread.

export function floorKey(zoneId,edition,f){
 let h=2166136261>>>0;const mix=v=>{h^=v&0xffff;h=Math.imul(h,16777619)>>>0;}; // FNV-1a over every cell: a changed wall or prop always yields a new key, whatever bumped it.
 mix(f.width);mix(f.height);for(const row of f.walls)for(const cell of row)mix(cell);for(const row of f.props??[])for(const cell of row)mix(cell?1:0); // Props only matter as "blocked or not" to walkable().
 return zoneId+':'+edition+':'+(f.geometryVersion??0)+':'+(f.mechanismRevision??0)+':'+h.toString(16);
} // Names a floor's walkability so a worker that already holds it can be sent the key instead of the whole grid.
export function resolveFloor(input,cache,limit=FLOOR_CACHE_LIMIT){
 const floor=input?.floor;if(!floor?.key)return input; // Unkeyed callers (tests, benchmarks) ship the whole floor every time.
 if(floor.walls){cache.delete(floor.key);cache.set(floor.key,floor);while(cache.size>limit)cache.delete(cache.keys().next().value);return input;} // A full floor refreshes the cache; the oldest key falls out past the limit.
 const hit=cache.get(floor.key);if(!hit)throw Object.assign(Error('floor_missing'),{code:'floor_missing'}); // The pool resends the whole floor once when it sees this code.
 cache.delete(floor.key);cache.set(floor.key,hit);return {...input,floor:hit};
} // Workers keep recent floors by key (least recently used first out) so pursuit batches cross the thread boundary without the grid.
export const FLOOR_CACHE_LIMIT=64; // Per worker thread; the pool mirrors this per slot so the two caches evict in step.
export function computeTask(kind,input){
 if(kind==='generate'){
  if(!Object.hasOwn(GENERATORS,input.generator))throw Error('Unknown floor generator');
  return GENERATORS[input.generator](input.data,input.edition);
 }
 if(kind==='paths')return input.starts.map(start=>input.targets.map(target=>pathTo(input.floor,start,target,input.limit))); // One floor crosses the thread boundary for the whole batch.
 throw Error('Unknown compute task');
} // Pure calculations only: workers never receive database connections, account credentials or mutable game state.
