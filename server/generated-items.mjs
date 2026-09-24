import {readFileSync} from 'node:fs';
import {createBaseGenerator} from './loot.mjs';

// Generated gear (loot.mjs createBaseGenerator) carries ids such as `gen_cottage_pull_up`
// that no static catalog lists, so companion equipping and the inspection sheet refused
// it. withGenerated(catalog) returns that catalog plus every style + garment base, built
// from the shipped `bases` table and the live /gm overrides, and rebuilt only when the
// loot store's revision changes. Static entries win on an id clash.

const shipped=(()=>{try{return JSON.parse(readFileSync(new URL('./dive-data.json',import.meta.url),'utf8')).bases??null;}catch{return null;}})();
let store=null,cache={revision:undefined,items:{}},merged=new WeakMap();

export function configureGeneratedItems(value){store=value??null;cache={revision:undefined,items:{}};merged=new WeakMap();} // zones.mjs hands over the live loot store, as it does for shop stock.

export function generatedItems(){
 const revision=store?store.revision():'shipped';
 if(revision!==cache.revision)cache={revision,items:createBaseGenerator(store?store.applyBases(shipped):shipped).catalog()};
 return cache.items;
}

export function withGenerated(catalog){
 const items=generatedItems(),hit=merged.get(catalog);
 if(hit?.items===items)return hit.value;
 const value={...items,...catalog};
 merged.set(catalog,{items,value});
 return value;
} // Cached per catalog object, so a hot read path spreads the tables once per gamemaster edit.
