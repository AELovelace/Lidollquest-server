import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createQuestService} from '../server/service.mjs';

const root=new URL('../server/gm-wiki/',import.meta.url);
const pages=JSON.parse(readFileSync(new URL('pages.json',root),'utf8'));
const content=new Map(pages.map(p=>[p.source,readFileSync(new URL('content/'+p.slug+'.md',root),'utf8')]));
const slug=value=>value.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/ /g,'-');

test('GM handbook chapters and Markdown cross-references resolve',()=>{
 assert.equal(new Set(pages.map(p=>p.slug)).size,pages.length);
 assert.deepEqual(readdirSync(new URL('content/',root)).filter(n=>n.endsWith('.md')).sort(),[...content.keys()].sort());
 for(const p of pages){
  assert.equal(p.source,p.slug+'.md');const body=content.get(p.source);
  assert.match(body,/^# .+/);assert.doesNotMatch(body,/\b(singleplayer|single-player)\b/i);
  for(const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
   if(/^https?:/.test(match[1]))continue;
   const [target,anchor]=match[1].split('#'),destination=content.get(target||p.source);
   assert.ok(destination,`${p.source}: missing chapter ${target}`);
   if(anchor)assert.ok([...destination.matchAll(/^#{1,6} (.+)$/gm)].some(m=>slug(m[1])===anchor),`${p.source}: missing section ${match[1]}`);
  }
 }
}); // Broken chapter/section links are caught before the handbook ships with a release.

test('GM wiki serves local source/assets with GM perimeter checks and no editing access',async()=>{
 const walletClient={async authenticate(){return {owner:'reader',gamemaster:false};}};
 const service=createQuestService({walletClient,gmRequireTls:true,gmTrustProxy:'127.0.0.1',gmAllow:'127.0.0.1',log:()=>{}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+service.server.address().port;
 const get=(path,options={})=>fetch(base+path,{headers:{'X-Forwarded-Proto':'https'},...options});
 try{
  assert.equal((await fetch(base+'/gm/wiki/')).status,403,'Transport guard applies to the handbook');
  const redirected=await get('/gm/wiki',{redirect:'manual'});assert.equal(redirected.status,308);assert.equal(redirected.headers.get('location'),'/gm/wiki/');
  const page=await get('/gm/wiki/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);assert.match(await page.text(),/GM wiki/);
  for(const file of ['pages.json','wiki.css','wiki.js','vendor/marked.min.js','vendor/purify.min.js','assets/little-log-logo.svg',...pages.map(p=>'content/'+p.slug+'.md')]){
   const response=await get('/gm/wiki/'+file);assert.equal(response.status,200,file);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
   if(file.endsWith('.md')){assert.match(response.headers.get('content-type'),/^text\/markdown/);assert.match(await response.text(),/^# /);}
  }
  assert.equal((await get('/gm/wiki/content/first-quest.md',{method:'HEAD'})).status,200);
  assert.equal((await get('/gm/wiki/content/first-quest.md',{method:'POST'})).status,405);
  for(const path of ['private.env','content/../../service.mjs','content/%2e%2e%2fservice.mjs','vendor/unknown.js'])assert.notEqual((await get('/gm/wiki/'+path)).status,200,path);
  assert.equal((await get('/gm/flows')).status,401,'Reading docs does not authenticate editing APIs');
  assert.match(await (await get('/gm')).text(),/href="\/gm\/wiki\/"/);
  assert.match(await (await get('/gm/flow-editor')).text(),/href="\/gm\/wiki\/"/);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
