import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {decode,encode,blank,over} from './png.mjs';

// Server-side paperdoll portraits, for MommyBot's showcase post.
//
// The layer order below is a direct port of drawCharacter() in the companion
// client's paperdoll.js, so the Discord portrait and the in-browser preview show
// the same character. If one changes, change the other.
//
// Sprite names ARE the item mapping: an equipped item resolves to
// `sprTQ_<item_id>`. There is no lookup table to keep in step. Artwork is exported
// at half scale by python/export_paperdoll_assets.py in the game checkout.

const ASSETS=fileURLToPath(new URL('./paperdoll-assets/',import.meta.url));
const LAYER_CACHE_MAX=64;   // ~22 MB of decoded RGBA; body layers are reused by every character
const PORTRAIT_CACHE_MAX=64; // rendered PNGs, keyed by character revision

// The companion client rewrites two panty ids before looking for artwork, because
// these two share another item's sprite rather than owning one.
const PANTY_ART_ALIAS={diaper_hugger_diaper:'blessed_pottypants_diaper',diaper_school_issued:'thick_medical_diaper'};
// Draw order, back to front. Matches the companion exactly.
const WORN_ORDER=['socks','panties','diaper_cover','bra','pants','shoes','torso','gloves','special','accessory_1','accessory_2','accessory_3','mouth','weapon','plug'];

export function layersFor(p,has,items={}){
 // Returns [{name, alpha}] back to front. Pure, so the ordering can be tested
 // without touching the filesystem.
 const out=[{name:'TQ_Base_3',alpha:1}];
 const push=(name,alpha=1)=>{out.push({name,alpha});};
 const hair='sprTQ_Hair_'+p.hair_style+'_'+p.hair_color;
 if(p.hair_style===4)push(hair+'_Back');
 if(p.has_breasts)push('sprTQ_Breasts_1');
 if(p.nipple_style>0)push('sprTQ_Nipples_'+p.nipple_style);
 if(!p.equipped_panties){ // Anatomy only shows when nothing covers it, as in the campaign renderer.
  if(p.pubes_style>0)push('sprTQ_Pubes_'+p.pubes_style);
  if(p.penis_style>0)push('sprTQ_Penis_'+p.penis_style);
 }
 const expression=String(p.face_expression||'cheeky');
 const face='sprTQ_Face_'+expression[0].toUpperCase()+expression.slice(1)+p.gender+'_'+p.inspection_embarrassment;
 push(has(face)?face:'sprTQ_Face_CheekyFemale_0'); // Authored fallback when a mood has no art for that gender/shame step.

 for(const slot of WORN_ORDER){
  let id=p['equipped_'+slot];
  if(!id||(slot==='pants'&&id===p.equipped_torso))continue; // A dress fills both slots but is drawn once.
  if(slot==='panties'){
   id=PANTY_ART_ALIAS[id]??id;
   if(items[id]?.is_diaper){
    // Diapers have used-state artwork: _1 clean, _2 wet, _3 messy. Not every diaper
    // has all three, so fall back to the base sprite rather than drawing nothing.
    const variant=id.replace(/_[123]$/,'')+(p.diaper_tum_absorbed>0?'_3':p.diaper_wet_absorbed>0?'_2':'_1');
    if(has('sprTQ_'+variant))id=variant;
   }
  }
  // The plug reads as under the clothing rather than on top of it.
  push('sprTQ_'+id,slot==='plug'?0.7:1);
 }
 push(hair);
 if(p.hair_style===4)push(hair+'_Front');
 if(p.equipped_head)push('sprTQ_'+p.equipped_head);
 return out;
}

export function createPaperdoll({assets=ASSETS,items=null,log=console.warn}={}){
 let manifest=null,unavailable=null;
 const layers=new Map();    // name -> decoded RGBA, bounded LRU
 const portraits=new Map(); // character:revision -> encoded PNG, bounded LRU

 const catalog=items??(()=>{ // is_diaper drives the used-state artwork above.
  try{return JSON.parse(readFileSync(new URL('./companion-items.json',import.meta.url),'utf8'));}
  catch{return {};}
 })();

 function ready(){
  if(manifest||unavailable)return manifest;
  const path=join(assets,'manifest.json');
  if(!existsSync(path)){
   // A deployment without exported artwork still serves every other field; the
   // caller falls back to the text sheet rather than failing the request.
   unavailable='Paperdoll artwork has not been exported for this deployment.';
   log('paperdoll_assets_missing',path);
   return null;
  }
  try{manifest=JSON.parse(readFileSync(path,'utf8'));}
  catch(error){unavailable='Paperdoll artwork is unreadable.';log('paperdoll_manifest_unreadable',error?.message??'unknown');}
  return manifest;
 }

 function remember(cache,key,value,max){
  cache.delete(key);cache.set(key,value);
  while(cache.size>max)cache.delete(cache.keys().next().value); // insertion order is the LRU order
  return value;
 }

 function layer(name){
  if(layers.has(name)){const hit=layers.get(name);layers.delete(name);layers.set(name,hit);return hit;}
  if(!manifest.sprites[name])return null; // Only manifest names are ever opened, never a character-supplied string.
  try{return remember(layers,name,decode(readFileSync(join(assets,name+'.png'))),LAYER_CACHE_MAX);}
  catch(error){log('paperdoll_layer_unreadable',name,error?.message??'unknown');return null;}
 }

 function render(sheet){
  const art=ready();
  if(!art)return null;
  const key=sheet.character_id+':'+sheet.revision;
  if(portraits.has(key)){const hit=portraits.get(key);portraits.delete(key);portraits.set(key,hit);return hit;}
  const p=sheet.player_info??{};
  const has=name=>Object.hasOwn(art.sprites,name);
  const canvas=blank(art.width,art.height);
  let drawn=0;
  for(const {name,alpha} of layersFor(p,has,catalog)){
   const image=layer(name);
   if(!image)continue; // An item with no artwork is simply not drawn, as in the companion.
   over(canvas,image,alpha);
   drawn++;
  }
  if(!drawn)return null;
  return remember(portraits,key,encode(canvas),PORTRAIT_CACHE_MAX);
 }

 return {render,layersFor,
  get available(){return Boolean(ready());},
  get reason(){return unavailable;},
  get size(){const art=ready();return art?{width:art.width,height:art.height}:null;},
  stats:()=>({layers:layers.size,portraits:portraits.size}),
  clear(){layers.clear();portraits.clear();}};
}
