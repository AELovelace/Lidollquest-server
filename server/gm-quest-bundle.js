// One JSON file carries a story flow, its shared content drafts and authored flags between the public quest editor and the live Story Workshop.
// Plain script shared by both pages; the server re-validates everything on save, so this only checks the file's shape.
const QUEST_BUNDLE={format:'lidollquest-quest-bundle',version:1,kinds:['quest','npc','orb','monster'],maxBytes:2*1024*1024,maxAssets:64,maxFlags:128};
function questBundleId(value,pattern=/^[a-z][a-z0-9_-]{0,79}$/){return typeof value==='string'&&pattern.test(value)&&!['constructor','prototype','__proto__'].includes(value);}
function serializeQuestBundle({flow=null,assets=[],flags=[],source='story-workshop',now=()=>new Date()}){
 const clone=v=>JSON.parse(JSON.stringify(v));
 return {format:QUEST_BUNDLE.format,version:QUEST_BUNDLE.version,exported:now().toISOString(),source,
  flow:flow?clone(flow):null,
  assets:assets.map(a=>({kind:a.kind,id:a.id,entry:clone(a.entry)})),
  flags:flags.map(f=>({id:f.id,name:f.name,description:f.description??''}))};
} // Revisions are deliberately left out: they belong to whichever server or browser store receives the bundle.
function parseQuestBundle(input){
 const fail=message=>{throw Error(message);};
 const text=typeof input==='string'?input:JSON.stringify(input);
 if(typeof text!=='string'||text.length>QUEST_BUNDLE.maxBytes)fail('A quest bundle must stay below 2 MiB.');
 let data;try{data=typeof input==='string'?JSON.parse(input):input;}catch{fail('This file is not valid JSON.');}
 if(!data||typeof data!=='object'||Array.isArray(data))fail('This file is not a quest bundle.');
 if(data.format!==QUEST_BUNDLE.format)fail('This file is not a LiDollQuest quest bundle.');
 if(data.version!==QUEST_BUNDLE.version)fail('This bundle is version '+String(data.version)+'; this editor reads version '+QUEST_BUNDLE.version+'.');
 const flow=data.flow??null;
 if(flow!==null){
  if(typeof flow!=='object'||Array.isArray(flow)||!questBundleId(flow.id))fail('The bundled story flow needs a stable lowercase ID.');
  if(!Array.isArray(flow.nodes)||!Array.isArray(flow.edges??[])||!Array.isArray(flow.bindings??[]))fail('The bundled story flow is incomplete.');
 }
 const assets=data.assets??[],flags=data.flags??[],seen=new Set();
 if(!Array.isArray(assets)||assets.length>QUEST_BUNDLE.maxAssets)fail('A bundle holds up to '+QUEST_BUNDLE.maxAssets+' shared content records.');
 if(!Array.isArray(flags)||flags.length>QUEST_BUNDLE.maxFlags)fail('A bundle holds up to '+QUEST_BUNDLE.maxFlags+' flags.');
 return {
  source:typeof data.source==='string'?data.source.slice(0,40):'',exported:typeof data.exported==='string'?data.exported.slice(0,40):'',
  flow:flow?{...flow,edges:flow.edges??[],bindings:flow.bindings??[]}:null,
  assets:assets.map(a=>{
   if(!a||typeof a!=='object'||!QUEST_BUNDLE.kinds.includes(a.kind))fail('Unknown content kind in this bundle: '+String(a?.kind??'?'));
   if(!questBundleId(a.id,/^[a-z][a-z0-9_-]{1,79}$/))fail('Content records need stable lowercase IDs.');
   if(!a.entry||typeof a.entry!=='object'||Array.isArray(a.entry))fail('Content record '+a.id+' has no definition.');
   const key=a.kind+':'+a.id;if(seen.has(key))fail('Duplicate content record: '+key);seen.add(key);
   return {kind:a.kind,id:a.id,entry:{...a.entry,id:a.id}};
  }),
  flags:flags.map(f=>{
   if(!f||typeof f!=='object'||!questBundleId(f.id,/^story_[a-z0-9_]{1,74}$/))fail('Bundled flags need story_ IDs.');
   if(typeof f.name!=='string'||!f.name.trim()||f.name.length>100||typeof (f.description??'')!=='string'||(f.description??'').length>1000)fail('Give flag '+f.id+' a name and a short description.');
   return {id:f.id,name:f.name.trim(),description:f.description??''};
  })};
}
function questBundleFileName(bundle){
 const name=bundle.flow?.name||bundle.assets[0]?.entry?.name||bundle.assets[0]?.entry?.title||'quest-bundle';
 return (String(name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'quest-bundle')+'.lidollquest.json';
} // A readable file name helps gamemasters tell submissions apart; the bundle inside carries the stable IDs.
