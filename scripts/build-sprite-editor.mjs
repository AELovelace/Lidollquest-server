import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {craftingData} from '../server/crafting.mjs';

export function buildSpriteEditor({outDir=resolve('public-sprite-editor')}={}){
 const catalog=craftingData.sprite_lab,sheets=JSON.parse(readFileSync(new URL('../server/sprite-lab-sheets.json',import.meta.url),'utf8')).sheets;
 for(const a of catalog.assets)for(const sprite of [a.sprite,...Object.values(a.body_sprites??{})])if(!sheets[sprite])throw Error('Missing sheet for '+a.id+': '+sprite); // Body-fit alternatives must work on a static host as well as the game server.
 mkdirSync(outDir,{recursive:true});const files={'index.html':'sprite-editor.html','style.css':'sprite-editor.css','editor.js':'sprite-editor.js','model.js':'sprite-editor-model.js','sprite-lab.js':'gm-sprite-lab.js'};
 for(const [target,source] of Object.entries(files)){
  let code=readFileSync(new URL('../server/'+source,import.meta.url),'utf8');
  if(target==='sprite-lab.js'){
   const start=code.indexOf('function spriteLabSheet('),end=code.indexOf('// host: element');
   if(start<0||end<=start)throw Error('Shared Sprite Lab renderer boundaries changed.');
   code='const spriteLab={images:new Map()};\n'+code.slice(start,end); // Bundle only local pixel/compositing helpers; omit the GM API loader and connected designer.
  }
  writeFileSync(resolve(outDir,target),code);
 }
 writeFileSync(resolve(outDir,'catalog.js'),'window.LIDOLL_SPRITE_EDITOR='+JSON.stringify({catalog,sheets}).replace(/</g,'\\u003c')+';\n');
 return {outDir,files:[...Object.keys(files),'catalog.js']};
} // The six-file site needs no Node process, live credentials, generated server HTML, or external CDN.
if(process.argv[1]&&resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase())console.log(buildSpriteEditor({outDir:resolve(process.argv[2]??'public-sprite-editor')}));
