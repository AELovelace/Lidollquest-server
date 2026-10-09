#!/usr/bin/env node
// Builds the statically hosted public quest editor: the live Story Workshop page with a browser-local API, the shipped
// catalogue and the server's own validators baked in, plus a copy of the GM wiki beside it. Upload the output folder to
// any static host (or open index.html from disk). Usage: node scripts/build-public-quest-editor.mjs [outDir]
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {createQuestService} from '../server/service.mjs';
import {gmWikiFiles} from '../server/gm-wiki.mjs';
import {lookCatalog} from '../server/sprite-looks.mjs';

const serverRoot=new URL('../server/',import.meta.url);
const read=name=>readFileSync(new URL(name,serverRoot),'utf8');
export const RULE_MODULES=['story-flags.mjs','sprite-look-validation.mjs','quest-content.mjs','flow-faith.mjs','flow-content.mjs']; // Dependency order; each may import only earlier entries or a provided stub.
const PROVIDED={
 './faith-blessing.mjs':"(()=>{const faith=window.LIDOLL_PUBLIC_CATALOG.faith;return {GODS:Object.fromEntries(faith.gods.map(g=>[g.id,{id:g.id,name:g.name}])),godsData:{settings:{piety_max:faith.max}}};})()",
 './flow-triggers.mjs':"{triggerTypes:['flag_entry','objective_entry']}"
}; // Data-only stand-ins for server modules that drag in SQLite or shipped data files.

export async function snapshotCatalog(){
 const service=createQuestService({walletClient:{async authenticate(){return {owner:'build',gamemaster:true};}},log:()=>{}});
 await new Promise(ready=>service.server.listen(0,'127.0.0.1',ready));
 try{
  const cat=service.zones.world.flows.catalog(),v=cat.records;
  const snapshot={generated:new Date().toISOString(),nodes:cat.nodes,faith:cat.faith,zones:cat.zones,items:cat.items,spells:v.spells,sprites:[...new Set(v.compiledSprites)],monsters:cat.monsters,engineNpcs:cat.npcs.filter(n=>n.engineOwned),engineFlags:cat.flags.filter(f=>f.engineOwned),questCatalog:v.questCatalog};
  if(JSON.stringify(snapshot).length>1024*1024)throw Error('The public editor catalogue grew past 1 MiB; trim it before shipping.');
  const catalog=lookCatalog(),sheets=JSON.parse(read('sprite-lab-sheets.json')).sheets;
  for(const asset of catalog.assets)if(!sheets[asset.sprite])throw Error('Missing Sprite Lab sheet: '+asset.sprite);
  snapshot.spriteLab={catalog,sheets}; // Embed the same shipped layers as the live designer, including file:// use without requests.
  return snapshot;
 }finally{service.server.closeAllConnections();await new Promise(done=>service.server.close(done));}
} // A fresh in-memory world holds only shipped content, so nothing authored on a live server can leak into the public page.

export function renderRules(){
 const known=new Map(Object.keys(PROVIDED).map(key=>[key,null])),modules=[];
 for(const name of RULE_MODULES){
  const spec='./'+name,src=read(name).replace(/\r\n/g,'\n');let body=src;
  for(const m of src.matchAll(/^import \{([^}]+)\} from '([^']+)';?$/gm)){
   const names=m[1].split(',').map(v=>v.trim()).filter(Boolean),exported=known.get(m[2]);
   if(!known.has(m[2]))throw Error(name+' imports '+m[2]+', which the public editor build does not bundle.');
   for(const n of names){const local=n.split(/\s+as\s+/)[0];if(exported&&!exported.includes(local))throw Error(name+' imports '+local+' from '+m[2]+', which does not export it.');}
   body=body.replace(m[0],()=>'const {'+names.map(n=>n.replace(/\s+as\s+/,':')).join(',')+'}=__resolve('+JSON.stringify(m[2])+');');
  }
  if(/^import\b/m.test(body))throw Error(name+' uses an import form the public editor build does not understand.');
  if(/^export\b(?! (?:const|let|function|async function) )/m.test(body))throw Error(name+' uses an export form the public editor build does not understand.');
  const exports=[...body.matchAll(/^export (?:const|let|function|async function) ([A-Za-z_$][\w$]*)/gm)].map(m=>m[1]);
  body=body.replace(/^export (?=(?:const|let|function|async function) )/gm,'');
  modules.push({spec,body,exports});known.set(spec,exports);
 }
 return "window.LIDOLL_PUBLIC_RULES=(()=>{'use strict';\nconst Buffer={byteLength:s=>new TextEncoder().encode(s).length};\n"
  +"const __provided={"+Object.entries(PROVIDED).map(([key,value])=>JSON.stringify(key)+':'+value).join(',')+"},__modules={},__resolve=spec=>__modules[spec]??__provided[spec]??(()=>{throw Error('Unbundled module '+spec);})();\n"
  +modules.map(m=>"__modules["+JSON.stringify(m.spec)+"]=(()=>{\n"+m.body+"\nreturn {"+m.exports.join(',')+"};\n})();").join('\n')
  +"\nreturn Object.assign({},...Object.values(__provided),...Object.values(__modules));\n})();";
} // The server's validators run unchanged in the browser, so public drafts fail for the same reasons the live console would reject them.

export function renderRuntime(snapshot){
 return 'window.LIDOLL_PUBLIC_CATALOG='+JSON.stringify(snapshot).replace(/</g,'\\u003c')+';\n'+renderRules()+'\n'+read('gm-public-workshop.js');
}

export function renderPage(snapshot,{title='LiDollQuest Quest Editor',wikiHref='wiki/'}={}){
 let html=read('gm-flow-editor.html');
 const swap=(from,to)=>{if(html.split(from).length!==2)throw Error('Public editor build expects exactly one '+from.slice(0,60));html=html.replace(from,()=>to);};
 swap('<meta name="robots" content="noindex,nofollow">','<meta name="description" content="Try your hand at LiDollQuest quest creation: build quests, NPC conversations and story flows in your browser, then export a bundle for the gamemasters.">');
 swap('<title>LiDollQuest Story Workshop</title>','<title>'+title+'</title>');
 swap('<h1>Story Workshop</h1>','<h1>'+title+'</h1>');
 const links=html.match(/<a class="live-link"[^>]*>[^<]*<\/a>/g)??[];if(links.length!==2)throw Error('Public editor build expects two live-only links.');
 for(const link of links)html=html.replace(link,()=>'');
 swap('href="/gm/wiki/"','href="'+wikiHref+'"');
 const editor=read('gm-flow-editor.js').replace('/* CONTENT_BLOCKS */',()=>read('gm-content-blocks.js')+'\n'+read('gm-story-sheets.js')+'\n'+read('gm-sprite-lab.js')),runtime=renderRuntime(snapshot),bundle=read('gm-quest-bundle.js');
 for(const [label,source] of [['editor',editor],['runtime',runtime],['bundle',bundle]])if(/<\/script/i.test(source))throw Error('Inline '+label+' script would close its tag early.');
 swap('<script>/* QUEST_BUNDLE */</script>','<script>'+bundle+'</script>');
 swap('<script>/* MUSIC_WIDGET */</script>','<script>'+read('gm-music-widget.js')+'</script>'); // Same splice as the served page; offline there is no song list, so no preview buttons appear.
 swap('<script>/* FLOW_EDITOR */</script>','<script>'+runtime+'</script><script>'+editor+'</script>');
 return html;
} // Same assembly as the served /gm/flow-editor page, with the stand-in API loaded first and the staff-only links removed.

export function buildPublicQuestEditor({outDir,snapshot}){
 mkdirSync(outDir,{recursive:true});
 const files=['index.html'];writeFileSync(resolve(outDir,'index.html'),renderPage(snapshot));
 for(const name of gmWikiFiles){
  const target=resolve(outDir,'wiki',name);mkdirSync(dirname(target),{recursive:true});
  let body=readFileSync(new URL('gm-wiki/'+name,serverRoot));
  if(name==='index.html'){
   let text=body.toString('utf8');
   for(const [from,to] of [['href="/gm/flow-editor"','href="../index.html"'],['<meta name="robots" content="noindex,nofollow">','']]){if(text.split(from).length!==2)throw Error('Public wiki copy expects exactly one '+from);text=text.replace(from,()=>to);}
   body=Buffer.from(text,'utf8');
  }
  writeFileSync(target,body);files.push('wiki/'+name);
 }
 return {outDir,files};
} // The wiki is already static Markdown rendered in the browser; only its Story Workshop link needs to point at the public page.

const invoked=process.argv[1]&&resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase();
if(invoked){
 const outDir=resolve(process.argv[2]??'public-quest-editor'),snapshot=await snapshotCatalog(),result=buildPublicQuestEditor({outDir,snapshot});
 console.log('Public quest editor written to '+result.outDir+' ('+result.files.length+' files, catalogue from '+snapshot.generated+'). Upload the folder to any static host, or open index.html directly.');
}
