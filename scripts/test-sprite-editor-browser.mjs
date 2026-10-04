// Static-only walkthrough: editing and PNG download run offline, with no game API.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildSpriteEditor} from './build-sprite-editor.mjs';
import {decodePng} from '../server/png-codec.mjs';

const modulePath=process.env.QUEST_PUPPETEER_MODULE;if(!modulePath)throw Error('Set QUEST_PUPPETEER_MODULE to the Puppeteer module path.');
const {default:puppeteer}=await import(pathToFileURL(modulePath));
const dir=mkdtempSync(join(tmpdir(),'sprite-editor-browser-'));
const site=createServer((req,res)=>{const name=new URL(req.url,'http://site').pathname,file=resolve(dir,'.'+(name==='/'?'/index.html':name));if(!file.startsWith(dir+ '\\')&&!file.startsWith(dir+'/')){res.writeHead(403);res.end();return;}if(!existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(file)]??'application/octet-stream');res.end(readFileSync(file));});
await new Promise(r=>site.listen(0,'127.0.0.1',r));const siteUrl='http://127.0.0.1:'+site.address().port;
buildSpriteEditor({outDir:dir});let browser,page,phase='launch';
try{
 browser=await puppeteer.launch({executablePath:process.env.QUEST_BROWSER_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,pipe:process.env.QUEST_BROWSER_PIPE==='1',timeout:15000,protocolTimeout:15000});
 page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.setViewport({width:1440,height:1100});
 phase='static page';await page.goto(siteUrl);await page.waitForFunction(()=>!document.getElementById('workspace').disabled);
 await page.setOfflineMode(true); // Bundled sheets, tools and downloads must keep working without any server.
 phase='source and pixels';await page.select('#slot','hair');await page.waitForSelector('#sources button');await page.click('#sources button');await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Editing a local copy'));
 const pixel=await page.$('#pixels'),box=await pixel.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2+20,{steps:8});await page.mouse.up();assert.equal(await page.$eval('#undo',b=>b.disabled),false);await page.click('#undo');await page.click('#redo');
 await page.click('#copy');await page.click('#next');await page.click('#paste');
 phase='local exports';await page.evaluate(()=>{const original=URL.createObjectURL;URL.createObjectURL=blob=>{window.exportedBlob=blob;return original.call(URL,blob);};HTMLAnchorElement.prototype.click=function(){window.exportedName=this.download;};});
 await page.click('#project');const project=await page.evaluate(async()=>JSON.parse(await window.exportedBlob.text()));assert.equal(project.format,'lidollquest-sprite');assert.equal(project.slot,'hair');
 await page.click('#png');await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('PNG downloaded.'));
 const bytes=await page.evaluate(async()=>[...new Uint8Array(await window.exportedBlob.arrayBuffer())]),png=decodePng(Buffer.from(bytes));assert.equal(png.width,128);assert.equal(png.height,128);assert.deepEqual(png.data,decodePng(Buffer.from(project.png,'base64')).data);
 assert.equal(await page.$('#signin'),null);assert.equal(await page.$('#apiUrl'),null);await page.setOfflineMode(false);
 phase='reload local recovery';await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent==='Recovered your local artwork.');assert.equal(await page.$eval('#slot',s=>s.value),'hair');
 await page.setViewport({width:600,height:900});await page.screenshot({path:join(dir,'workshop-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS: static page pixels, frame history, offline PNG/project downloads and local recovery. Screenshot: '+join(dir,'workshop-mobile.png'));
}catch(e){console.error('Sprite editor walkthrough failed at '+phase+': '+e.message);throw e;}finally{await browser?.close();site.closeAllConnections();await new Promise(r=>site.close(r));}
