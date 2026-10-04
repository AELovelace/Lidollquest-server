// End-to-end check of the public quest editor: build it, author a quest, NPC and story in a real browser, export the
// bundle, then import, save and publish it through the live Story Workshop on an in-memory server.
// Usage: QUEST_PUPPETEER_MODULE=<path to puppeteer> node scripts/test-public-quest-editor-browser.mjs
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,readdirSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';
import {createServer} from 'node:http';
import {snapshotCatalog,buildPublicQuestEditor} from './build-public-quest-editor.mjs';
import {createQuestService} from '../server/service.mjs';

const modulePath=process.env.QUEST_PUPPETEER_MODULE;
if(!modulePath)throw Error('Set QUEST_PUPPETEER_MODULE to an installed Puppeteer module.');
const {default:puppeteer}=await import(pathToFileURL(modulePath));
process.env.QUEST_FLOWS_ENABLED='true';
const dir=mkdtempSync(join(tmpdir(),'lidoll-public-editor-')),siteDir=join(dir,'site'),downloads=join(dir,'downloads');
const snapshot=await snapshotCatalog();buildPublicQuestEditor({outDir:siteDir,snapshot});
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.md':'text/markdown; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const site=createServer((req,res)=>{const path=decodeURIComponent(new URL(req.url,'http://site').pathname),file=join(siteDir,path.endsWith('/')?path+'index.html':path);if(!existsSync(file)){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream'});res.end(readFileSync(file));});
await new Promise(ready=>site.listen(0,'127.0.0.1',ready));
const token='s'.repeat(43),owner='a'.repeat(64),service=createQuestService({walletClient:{async authenticate(value){if(value!==token)throw Object.assign(Error('Unauthorized'),{status:401});return {owner,id:'test-grant',client:'lidollquest',gamemaster:true,scope:'wallet:read'};}},log:()=>{}});
await new Promise(ready=>service.server.listen(0,'127.0.0.1',ready));
const siteBase='http://127.0.0.1:'+site.address().port,liveBase='http://127.0.0.1:'+service.server.address().port;
let browser,page,phase='launch';
try{
 const firefox=process.env.QUEST_BROWSER==='firefox';
 browser=await puppeteer.launch({browser:firefox?'firefox':'chrome',pipe:!firefox&&process.env.QUEST_BROWSER_PIPE==='1',executablePath:process.env.QUEST_BROWSER_PATH??(firefox?'C:/Program Files/Mozilla Firefox/firefox.exe':'C:/Program Files/Google/Chrome/Application/chrome.exe'),headless:true,args:firefox?['--no-remote']:[]}); // Pipe transport can run Chromium checks when local WebSocket connections are unavailable.
 page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.setViewport({width:1500,height:1000});
 const status=prefix=>page.waitForFunction(p=>document.querySelector('#status')?.textContent.startsWith(p),{timeout:20000},prefix);
 const click=async(scope,text)=>{const found=await page.evaluate((scope,text)=>{const b=[...document.querySelectorAll(scope+' button')].find(b=>b.textContent===text);if(!b)return false;b.click();return true;},scope,text);assert.ok(found,'Missing button '+text+' in '+scope);};
 const set=async(label,value)=>{const found=await page.evaluate((label,value)=>{const wrap=[...document.querySelectorAll('#properties label')].find(l=>l.firstChild?.textContent===label);if(!wrap)return false;const input=wrap.querySelector('input,select,textarea');if(input.type==='checkbox')input.checked=!!value;else input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));return true;},label,value);assert.ok(found,'Missing field '+label);};
 const param=key=>page.evaluate(key=>new URL(location.href).searchParams.get(key),key);

 phase='open public editor';await page.goto(siteBase+'/');await status('Ready · public quest editor');
 assert.deepEqual(await page.evaluate(()=>['publish','rollback','test','map','openIncludedStories'].map(id=>document.getElementById(id).hidden)),[true,true,true,true,true]);
 assert.equal(await page.$$eval('.live-link',links=>links.length),0);assert.ok((await page.$eval('#wikiLink',a=>a.href)).endsWith('/wiki/'));
 assert.deepEqual(await page.$$eval('#newAssets button',b=>b.map(v=>v.textContent)),['+ flag','+ npc','+ quest','+ orb']);
 assert.deepEqual(errors,[]);

 phase='author npc';await click('#newAssets','+ npc');await page.waitForFunction(()=>document.querySelector('#workspaceTitle')?.textContent.includes('npc blocks'));
 const npcId=await param('id');await set('name','Lantern Scout');await set('Default facing','3');
 await page.waitForFunction(()=>[...document.querySelectorAll('#properties button')].some(b=>b.textContent==='Design a Sprite Lab look'));
 await click('#properties','Design a Sprite Lab look');await set('Hair','mohawk');
 await page.waitForFunction(()=>{const c=document.querySelector('#properties canvas');return c&&c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0);}); // Bundled sheets must actually decode and draw, not merely populate selectors.
 await page.click('#save');await status('Asset drafts saved.');
 phase='author quest';await page.click('#backToFlow');await click('#newAssets','+ quest');await page.waitForFunction(()=>document.querySelector('#workspaceTitle')?.textContent.includes('quest blocks'));
 const questId=await param('id');await set('name','A Light for the Scout');await click('#properties','Add quest givers');await set('Quest givers 1',npcId);
 await page.click('[data-node^="stage:"] strong');await page.waitForFunction(()=>document.querySelector('#properties h2')?.textContent==='Quest stage');
 await click('#properties','+ Objective');await page.waitForFunction(()=>document.querySelector('#properties h2')?.textContent==='Objective');
 await set('Target',snapshot.monsters[0].id);await set('Player instructions','Defeat the path guardian for the Lantern Scout.');
 await page.click('#validate');await status('Block checks passed.');await page.click('#save');await status('Asset drafts saved.');
 phase='author flow';await page.click('#backToFlow');for(const block of ['Entry','Dialogue','End'])await click('#palette',block);
 await page.click('#arrange'); // New blocks all land at the same canvas spot; spread them so each card can be clicked.
 const ids=await page.$$eval('[data-node]',cards=>cards.map(c=>c.dataset.node));assert.equal(ids.length,3);
 await page.click('[data-node="'+ids[0]+'"] strong');await set('Connect next',ids[1]);
 await page.click('[data-node="'+ids[1]+'"] strong');await set('Player-facing text','The scout thanks you for clearing the path.');await set('Connect next',ids[2]);
 await click('#properties','Story settings / bindings');await set('Name','Scout rescue story');const flowId=await page.evaluate(()=>[...document.querySelectorAll('#properties label')].find(l=>l.firstChild.textContent==='Stable ID').querySelector('input').value);
 await page.click('#validate');await status('Validation passed.');await page.click('#save');await status('Draft saved.');
 phase='preview';await page.click('#play');await page.waitForFunction(()=>!document.querySelector('#preview').hidden&&document.querySelector('#previewText').textContent.startsWith('The scout thanks'));
 await click('#previewActions','next');await page.waitForFunction(()=>document.querySelector('#previewTitle').textContent==='Story complete');
 phase='export';const cdp=await page.createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
 await page.click('#exportBundle');await status('Exported the story flow, 2 content records');
 let file=null;for(let i=0;i<50&&!file;i++){await new Promise(r=>setTimeout(r,100));file=existsSync(downloads)?readdirSync(downloads).find(n=>n.endsWith('.lidollquest.json')):null;}
 assert.ok(file,'bundle download');const bundle=JSON.parse(readFileSync(join(downloads,file),'utf8'));
 assert.equal(bundle.format,'lidollquest-quest-bundle');assert.equal(bundle.flow.id,flowId);assert.equal(bundle.flow.name,'Scout rescue story');assert.equal(bundle.source,'public-quest-editor');
 assert.deepEqual(bundle.assets.map(a=>a.kind+':'+a.id).sort(),['npc:'+npcId,'quest:'+questId].sort());assert.equal(bundle.assets.find(a=>a.kind==='quest').entry.givers[0],npcId);assert.deepEqual(bundle.flags,[]);
 assert.equal(bundle.assets.find(a=>a.kind==='npc').entry.facing,3);assert.equal(bundle.assets.find(a=>a.kind==='npc').entry.look.slots.hair,'mohawk');
 phase='reload keeps local drafts';await page.reload();await status('Ready · public quest editor');
 assert.ok((await page.$$eval('#flows option',o=>o.map(v=>v.textContent))).some(t=>t.startsWith('Scout rescue story')));
 await page.select('#flows',flowId);await page.waitForFunction(()=>document.querySelectorAll('[data-node]').length===3);
 phase='wiki';await page.goto(siteBase+'/wiki/');await page.waitForFunction(()=>document.querySelectorAll('#chapters a').length>3);
 assert.ok((await page.$eval('.play-link',a=>a.getAttribute('href')))==='../index.html');
 assert.deepEqual(errors,[]);

 phase='live import';const live=await browser.newPage();live.on('pageerror',e=>errors.push(e.message));live.on('dialog',d=>d.accept());await live.setViewport({width:1500,height:1000});
 await live.evaluateOnNewDocument(token=>localStorage.setItem('lidollquest.gm.grant',JSON.stringify({token})),token);
 await live.goto(liveBase+'/gm/flow-editor');await live.waitForFunction(()=>document.querySelector('#status')?.textContent.startsWith('Ready'));
 assert.equal(await live.$eval('#publish',b=>b.hidden),false);
 const [chooser]=await Promise.all([live.waitForFileChooser(),live.click('#importBundle')]);await chooser.accept([join(downloads,file)]);
 await live.waitForFunction(()=>document.querySelector('#status')?.textContent.startsWith('Imported "Scout rescue story", 2 content records'));
 assert.equal(await live.evaluate(()=>[...document.querySelectorAll('#properties label')].find(l=>l.firstChild.textContent==='Name').querySelector('input').value),'Scout rescue story');
 phase='live save';await live.click('#save');await live.waitForFunction(()=>document.querySelector('#status')?.textContent==='Draft saved.');
 assert.equal(service.zones.world.flows.get(flowId).draft.name,'Scout rescue story');assert.equal(service.live.entry('quest',questId).draft.name,'A Light for the Scout');assert.equal(service.live.entry('npc',npcId).draft.name,'Lantern Scout');assert.equal(service.live.entry('quest',questId).published,null);
 phase='live publish';await live.click('#publish');await live.waitForFunction(()=>document.querySelector('#status')?.textContent.startsWith('Published.'));
 assert.ok(service.zones.world.flows.get(flowId).published);assert.equal(service.live.published().quests[questId].name,'A Light for the Scout');assert.equal(service.live.published().npcs[npcId].name,'Lantern Scout');
 assert.equal(service.live.published().npcs[npcId].facing,3);assert.equal(service.live.published().npcs[npcId].look.slots.hair,'mohawk');
 phase='live export';const liveCdp=await live.createCDPSession();await liveCdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:join(dir,'live')});
 await live.evaluate(()=>[...document.querySelectorAll('#library button')].find(b=>b.textContent.startsWith('A Light for the Scout')).click());await live.waitForFunction(()=>document.querySelector('#workspaceTitle')?.textContent.includes('quest blocks')); // An opened published quest and its published giver travel with a live export.
 await live.click('#exportBundle');await live.waitForFunction(()=>document.querySelector('#status')?.textContent.startsWith('Exported the story flow, 2 content records'));
 assert.deepEqual(errors,[]);
 console.log('PASS: public editor authors NPC, quest and story locally, previews and exports a bundle; the live workshop imports, saves and publishes it, and exports a self-contained bundle back.');
}catch(error){console.error('Browser failure at',phase,await page?.evaluate(()=>({status:document.querySelector('#status')?.textContent,title:document.querySelector('#workspaceTitle')?.textContent})).catch(()=>null));throw error;}
finally{await browser?.close();site.closeAllConnections();await new Promise(done=>site.close(done));service.server.closeAllConnections();await new Promise(done=>service.server.close(done));}
