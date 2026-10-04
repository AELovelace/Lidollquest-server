// Paints the whole-world poster (world-map.mjs) off the main thread: a few seconds of pixel work would otherwise stall
// every player's moves and battles. It receives plain data only (zone views, the exit graph, the extra sprites the
// main thread looked up) and reads the shipped tile artwork from disk itself; it never touches the database.
import {parentPort,workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {createMapRenderer} from './map-render.mjs';
import {layoutWorld,paintWorld} from './world-map.mjs';

const tiles=(()=>{try{return JSON.parse(readFileSync(new URL('./tile-artwork.json',import.meta.url),'utf8'));}catch{return {version:0,tilesets:{},sprites:{}};}})(); // Same fallback as gm.mjs: flat colours without the export.
const {root,zones,views,scale,layers,sprites,avatars}=workerData;
try{
 const renderer=createMapRenderer({tiles,compiled:sprites,avatars}); // sprites: monster art and GM uploads by name, gathered by the caller.
 parentPort.postMessage({png:paintWorld(renderer,layoutWorld({root,zones}),views,{scale,layers})});
}catch(error){parentPort.postMessage({error:String(error?.message??error),status:error?.status,code:error?.code});}
