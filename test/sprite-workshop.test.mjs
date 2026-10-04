import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {spriteWorkshop,workshopPng,workshopStrip} from '../server/sprite-workshop.mjs';
import {encodePng,decodePng} from '../server/png-codec.mjs';
import {validateLook,createLookUnlocks} from '../server/sprite-looks.mjs';
import {buildSpriteEditor} from '../scripts/build-sprite-editor.mjs';
import {createQuestService} from '../server/service.mjs';

const alice={owner:'alice',scope:'wallet:read'},bob={owner:'bob',scope:'wallet:read'},gm={owner:'staff',scope:'wallet:read',gamemaster:true};
const image=()=>{const data=new Uint8Array(128*128*4);for(let f=0;f<16;f++){const p=((Math.floor(f/4)*32+7)*128+(f%4)*32+5)*4;data.set([f+1,20,30,255],p);}return encodePng({width:128,height:128,data}).toString('base64');};
function fixture(){const db=new DatabaseSync(':memory:'),store=spriteWorkshop(db);return {db,store,close:()=>db.close()};}
function published(store,who=alice,options={}){let r=store.act(who,{action:'create',slot:'torso',name:'My top',...options});r=store.act(who,{action:'save',id:r.id,revision:r.revision,png:image()});return store.act(who,{action:'publish',id:r.id,revision:r.revision});}

test('PNG validation and strip conversion retain exact per-frame pixels and transparency',()=>{
 const png=image(),a=decodePng(Buffer.from(workshopPng(png),'base64')),strip=decodePng(Buffer.from(workshopStrip(png),'base64'));
 assert.equal(strip.width,512);assert.equal(strip.height,32);
 for(let f=0;f<16;f++)for(let y=0;y<32;y++)for(let x=0;x<32;x++){const p=((Math.floor(f/4)*32+y)*128+(f%4)*32+x)*4,q=(y*512+f*32+x)*4;assert.deepEqual(strip.data.slice(q,q+4),a.data.slice(p,p+4));}
 for(const bad of ['https://example.com/sprite.png','x'.repeat(100001),'not png'])assert.throws(()=>workshopPng(bad));
 const broken=Buffer.from(png,'base64');broken[50]^=255;assert.throws(()=>workshopPng(broken.toString('base64')));
 assert.throws(()=>workshopStrip(encodePng({width:32,height:32,data:new Uint8Array(4096)}).toString('base64')),/128 x 128/);
});

test('private drafts, ownership, revisions, publication and complete historical restores',()=>{
 const {db,store,close}=fixture();try{
  let r=store.act(alice,{action:'create',slot:'torso',name:'First'});
  assert.equal(store.manifest('alice').length,0);assert.throws(()=>store.act(alice,{action:'publish',id:r.id,revision:r.revision}),/Draw some pixels/);
  for(const f of [()=>store.draft(bob,r.id),()=>store.act(bob,{action:'save',id:r.id,revision:r.revision,png:image()}),()=>store.draft(gm,r.id)])assert.throws(f,/cannot edit/);
  r=store.act(alice,{action:'save',id:r.id,revision:r.revision,png:image(),name:'Tinted',channels:[{name:'Fabric',source:[[200,200,200]],shade:[1],palette:'fabric'}],hides:['legs']});
  assert.throws(()=>store.act(alice,{action:'save',id:r.id,revision:1,png:image()}),/another tab/);
  r=store.act(alice,{action:'publish',id:r.id,revision:r.revision});const old=store.manifest('alice')[0];
  assert.equal(store.manifest('bob').length,0);assert.equal(store.manifest('bob',[r.id])[0].id,r.id);assert.equal(store.view(bob).catalog.assets.some(a=>a.id===r.id),false);
  assert.throws(()=>store.sheet(bob,r.id),/another account/);assert.throws(()=>store.act(bob,{action:'create',source:r.id}),/another account/);
  const unlocks=createLookUnlocks(db),look={version:1,slots:{base:'piko_base',torso:r.id}};
  assert.equal(validateLook(look,{db,unlocked:unlocks.set('alice')}).slots.torso,r.id);assert.throws(()=>validateLook(look,{db,unlocked:unlocks.set('bob')}),/another account/);assert.throws(()=>validateLook(look,{db}),/another account/);
  r=store.act(alice,{action:'save',id:r.id,revision:r.revision,png:image(),name:'Changed',channels:[],hides:[]});assert.equal(store.manifest('alice')[0].name,'Tinted','draft edits never leak');
  r=store.act(alice,{action:'publish',id:r.id,revision:r.revision});assert.equal(store.manifest('alice')[0].name,'Changed');assert.equal(store.asset(r.id,old.hash).frames,16,'old hashes remain loadable');
  r=store.act(alice,{action:'restore',id:r.id,revision:r.revision,version:1});assert.equal(r.name,'Tinted');assert.equal(r.channels.length,1);assert.deepEqual(r.hides,['legs']);assert.equal(store.manifest('alice')[0].name,'Changed','restore is a draft operation');
  assert.throws(()=>store.act(alice,{action:'save',id:r.id,revision:r.revision,png:image(),channels:[{name:'Bad',source:[[1,2,3]],shade:[1]}]}),/grey/);
  assert.equal(store.draft(alice,r.id).revision,r.revision,'failed save rolls back');assert.throws(()=>store.view(null),/Sign in/);
 }finally{close();}
});

test('shared overrides, protected copies and isolated catalogs respect staff and ownership',()=>{
 const {db,store,close}=fixture();try{
  assert.throws(()=>store.act(alice,{action:'create',shared:true,slot:'hair'}),/gamemaster/);
  assert.throws(()=>store.act(alice,{action:'create',source:'crown'}),/Unlock this source/,'a missing unlock table never becomes an SQL error');
  const r=published(store,gm,{shared:true,source:'piko_hair',replace:true});assert.equal(r.id,'piko_hair');
  assert.equal(store.gmLab().catalog.assets.filter(a=>a.id==='piko_hair').length,1);assert.equal(store.gmLab().sheets[r.sprite],r.png);
  const cat=store.catalog();cat.assets.length=0;assert.ok(store.catalog().assets.length);
  assert.throws(()=>store.act(alice,{action:'save',id:r.id,revision:r.revision,png:image()}),/cannot edit/);
  const privateRow=published(store,alice);assert.equal(store.gmLab().catalog.assets.some(a=>a.id===privateRow.id),false);
  const unlocks=createLookUnlocks(db);db.prepare('INSERT INTO look_unlocks VALUES (?,?,?,?)').run('alice','crown',0,'test');assert.ok(store.act(alice,{action:'create',source:'crown'}).id);assert.ok(unlocks.list('alice').includes(privateRow.id));
 }finally{close();}
});

test('worker connections refresh published versions and rollback does not poison the catalog',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'sprite-workshop-')),'test.sqlite'),db=new DatabaseSync(path),a=spriteWorkshop(db);db.exec('PRAGMA journal_mode=WAL');
 const worker=new DatabaseSync(path,{readOnly:true}),b=spriteWorkshop(worker);
 try{assert.equal(b.manifest('alice').length,0);const r=published(a);assert.equal(b.manifest('alice')[0].id,r.id);db.exec('BEGIN');a.act(alice,{action:'save',id:r.id,revision:r.revision,png:image(),name:'Rolled back'});const draft=a.draft(alice,r.id);a.act(alice,{action:'publish',id:r.id,revision:draft.revision});assert.equal(a.manifest('alice')[0].name,'Rolled back');db.exec('ROLLBACK');assert.equal(a.manifest('alice')[0].name,'My top');assert.equal(b.manifest('alice')[0].name,'My top');}finally{worker.close();db.close();}
});

test('pixel tools isolate frames, support history, and the build is a self-contained static site',()=>{
 const scope={};vm.runInNewContext(readFileSync(new URL('../server/sprite-editor-model.js',import.meta.url),'utf8'),scope);const d=scope.SpriteEditorModel.create();
 d.begin();d.line(0,[0,0],[31,31],[20,30,40,255]);d.commit();assert.equal(d.pixel(0,20,20)[3],255);assert.equal(d.pixel(1,0,0)[3],0);
 d.copy(0);d.paste(15);assert.equal(d.pixel(15,20,20)[3],255);d.undo();assert.equal(d.pixel(15,20,20)[3],0);d.redo();d.transform(15,'flipX');assert.equal(d.pixel(15,11,20)[3],255);
 d.begin();d.fill(1,0,0,[1,2,3,255]);d.commit();assert.equal(d.pixel(1,31,31)[3],255);assert.equal(d.pixel(2,0,0)[3],0);
 const outDir=mkdtempSync(join(tmpdir(),'sprite-editor-site-')),result=buildSpriteEditor({outDir});assert.equal(result.files.length,6);
 const page=readFileSync(join(outDir,'index.html'),'utf8');assert.ok(page.includes('id="pixels"')&&page.includes('id="png"')&&page.includes('Download PNG for GM'));assert.ok(!page.includes('/gm/'));
 assert.ok(page.includes("connect-src 'none'"));for(const id of ['apiUrl','signin','publishing','drafts'])assert.ok(!page.includes('id="'+id+'"'));
 for(const file of result.files.filter(f=>f.endsWith('.js'))){const code=readFileSync(join(outDir,file),'utf8');new vm.Script(code,{filename:file});assert.doesNotMatch(code,/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/,file+' must not make API requests');assert.doesNotMatch(code,/\/gm\/|\/sprite-workshop\/|apiUrl|access_token/);}
 const catalog={window:{}};vm.runInNewContext(readFileSync(join(outDir,'catalog.js'),'utf8'),catalog);const bundled=catalog.window.LIDOLL_SPRITE_EDITOR;assert.deepEqual(Object.keys(bundled).sort(),['catalog','sheets']);for(const a of bundled.catalog.assets)assert.ok(bundled.sheets[a.sprite]);
});

test('game service delivers only published strips through its existing authenticated asset route',async()=>{
 const service=createQuestService({walletClient:{authenticate:async()=>({...alice,client:'lidollquest',coins:0,scope:'wallet:read social:read'})},log:()=>{}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+service.server.address().port,headers={Authorization:'Bearer '+'a'.repeat(32)},store=spriteWorkshop(service.db);
 try{
  const draft=store.act(alice,{action:'create',slot:'hair',name:'Private draft'}),live=published(store),meta=store.manifest(alice.owner)[0];
  let r=await fetch(base+'/content/asset?asset_id='+encodeURIComponent('workshop:'+live.id+':'+meta.hash),{headers});assert.equal(r.status,200);assert.equal((await r.json()).frames,16);
  r=await fetch(base+'/content/asset?asset_id='+encodeURIComponent('workshop:'+draft.id+':'+'0'.repeat(64)),{headers});assert.equal(r.status,404);
  r=await fetch(base+'/content/asset?asset_id='+encodeURIComponent('workshop:'+live.id+':'+meta.hash));assert.equal(r.status,401);
  r=await fetch(base+'/sprite-workshop/index.html',{headers});assert.equal(r.status,404,'static editor is not served by the game');
  for(const [path,method] of [['catalog','GET'],['action','POST'],['signin/start','POST'],['action','OPTIONS']]){r=await fetch(base+'/sprite-workshop/'+path,{method,headers:{...headers,Origin:'https://static.example'}});assert.equal(r.status,404);assert.equal(r.headers.get('access-control-allow-origin'),null);}
  r=await fetch(base+'/zones',{headers});assert.equal(r.status,200);const snapshot=await r.json();assert.ok(snapshot.spriteWorkshop.some(a=>a.id===live.id));assert.ok(!snapshot.spriteWorkshop.some(a=>a.id===draft.id));
 }finally{service.server.closeAllConnections();await new Promise(r=>service.server.close(r));}
});
