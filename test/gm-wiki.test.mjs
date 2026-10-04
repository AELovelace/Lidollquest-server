import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createQuestService} from '../server/service.mjs';
import vm from 'node:vm';

const root=new URL('../server/gm-wiki/',import.meta.url);
const pages=JSON.parse(readFileSync(new URL('pages.json',root),'utf8'));
const illustrations=JSON.parse(readFileSync(new URL('illustrations.json',root),'utf8'));
const content=new Map(pages.map(p=>[p.source,readFileSync(new URL('content/'+p.slug+'.md',root),'utf8')]));
const slug=value=>value.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/ /g,'-');

test('GM handbook chapters and Markdown cross-references resolve',()=>{
 assert.equal(new Set(pages.map(p=>p.slug)).size,pages.length);
 assert.deepEqual(readdirSync(new URL('content/',root)).filter(n=>n.endsWith('.md')).sort(),[...content.keys()].sort());
 for(const p of pages){
  assert.equal(p.source,p.slug+'.md');const body=content.get(p.source);
  assert.match(body,/^# .+/);assert.doesNotMatch(body,/\b(singleplayer|single-player)\b/i);
  for(const match of body.matchAll(/(!?)\[[^\]]+\]\((\S+?)(?:\s+"[^"]*")?\)/g)){
   if(match[1]){const asset=match[2].replace(/^\.\.\//,'');assert.ok(illustrations.includes(asset),'Unserved illustration: '+asset);assert.ok(readFileSync(new URL(asset,root)).length>0);continue;}
   if(/^https?:/.test(match[2]))continue;
   const [target,anchor]=match[2].split('#'),destination=content.get(target||p.source);
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
  for(const file of ['pages.json','wiki.css','wiki.js','route-demo.js','vendor/marked.min.js','vendor/purify.min.js','assets/little-log-logo.svg',...illustrations,...pages.map(p=>'content/'+p.slug+'.md')]){
   const response=await get('/gm/wiki/'+file);assert.equal(response.status,200,file);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
   if(file.endsWith('.png')){assert.equal(response.headers.get('content-type'),'image/png');const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(1,4).toString(),'PNG');}
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

test('route teaching model demonstrates detours, waits, mode endings and returning home without networking',()=>{
 const code=readFileSync(new URL('route-demo.js',root),'utf8'),scope={};vm.runInNewContext(code,scope);const create=scope.GmRouteDemo.create;
 assert.doesNotMatch(code,/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/);
 const m=create(),s=m.snapshot(),path=m.path(s.points[0],s.points[1]);
 assert.ok(path.some(p=>p.x===5&&p.y===4),'route uses the gap');
 for(let i=1;i<path.length;i++)assert.equal(Math.abs(path[i].x-path[i-1].x)+Math.abs(path[i].y-path[i-1].y),1,'four-way steps only');
 m.setBlocked(true);assert.equal(m.path(s.points[0],s.points[1]),null);m.setBlocked(false);
 m.setMode('once');let waited=false;for(let i=0;i<100;i++){m.step();if(m.snapshot().message.startsWith('Waiting'))waited=true;}
 assert.equal(waited,true);assert.deepEqual(JSON.parse(JSON.stringify(m.snapshot().pos)),{x:8,y:6});assert.match(m.snapshot().message,/Holding/);
 m.setActive(false);for(let i=0;i<40;i++)m.step();assert.deepEqual(JSON.parse(JSON.stringify(m.snapshot().pos)),{x:1,y:6});
 for(const [mode,expected] of [['loop',[0,1,2,0,1]],['pingpong',[0,1,2,1,0]]]){
  const demo=create();demo.setMode(mode);const arrived=[];
  for(let i=0;i<180&&arrived.length<5;i++){demo.step();const state=demo.snapshot(),index=state.points.findIndex(p=>p.x===state.pos.x&&p.y===state.pos.y);if(index>=0&&index!==arrived.at(-1))arrived.push(index);}
  assert.deepEqual(arrived,expected,mode);
 }
});
