import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createQuestService} from '../server/service.mjs';

if(!process.env.QUEST_PUPPETEER_MODULE)throw Error('Set QUEST_PUPPETEER_MODULE to Puppeteer.');
const {default:puppeteer}=await import(pathToFileURL(process.env.QUEST_PUPPETEER_MODULE));
const token='s'.repeat(43),service=createQuestService({walletClient:{async authenticate(t){return {owner:'a'.repeat(64),id:'test',client:'lidollquest',gamemaster:t===token,coins:0,blockedAccounts:[]};}},log:()=>{}});
let browser,phase='launch',promptReply='';const errors=[];
try{
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
 const request=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;};
 browser=await puppeteer.launch({executablePath:process.env.QUEST_BROWSER_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage();await page.setViewport({width:1440,height:1050});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept(d.type()==='prompt'?promptReply:undefined));
 await page.evaluateOnNewDocument(t=>localStorage.setItem('lidollquest.gm.grant',JSON.stringify({token:t})),token);await page.goto(base+'/gm');await page.waitForFunction(()=>!document.querySelector('#app').hidden);
 const field=async(selector,value)=>page.$eval(selector,(input,value)=>{input.value=String(value);input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));},value);
 const clickNamed=async(selector,name)=>page.$$eval(selector,(buttons,name)=>{const b=buttons.find(b=>b.textContent===name);if(!b)throw Error('Missing '+name);b.click();},name);
 phase='weapon editing';await page.click('#tab-loot');await page.waitForFunction(()=>document.querySelectorAll('#itemPoolList tr').length>0);
 await page.select('#itemPoolFilter','weapon');await field('#itemPoolSearch','rattle_1');await clickNamed('#itemPoolList button','Edit');
 assert.equal(await page.$eval('#in_atk_min',n=>n.value),'3');await field('#iName','Workshop Rattle');await field('#in_atk_min',12);await field('#in_atk_max',18);await field('#iWeaponClass','wand');await field('#in_mp_cost',3);await field('#in_power',9);
 await page.click('#iSave');await page.waitForFunction(()=>document.querySelector('#itemEditor').hidden);
 let loot=await request('/gm/loot'),weapon=loot.poolItems.find(i=>i.id==='rattle_1');assert.equal(weapon.name,'Workshop Rattle');assert.equal(weapon.atk_max,18);assert.equal(weapon.modified,true);
 const preview=(await request('/gm/action',{action:'loot_preview',item_id:'rattle_1',level:1,seed:'browser'})).result.item;assert.match(preview.name,/Workshop Rattle/);assert.equal(preview.weapon_class,'wand');
 await clickNamed('#itemPoolList button','Edit');assert.equal(await page.$eval('#in_power',n=>n.value),'9');await page.click('#iCancel');
 await mkdir('artifacts/loot-crafting-browser',{recursive:true});await page.screenshot({path:'artifacts/loot-crafting-browser/weapons.png',fullPage:true});
 phase='crafting forms';await page.click('#tab-crafting');await page.waitForSelector('#craftForm [data-field="discipline"]');
 assert.equal(await page.$eval('#craftAdvanced',n=>n.open),false);
 const before=await request('/gm/crafting');
 await page.click('#craftAdvanced summary');await field('#craftJson','[null]');await page.click('#craftApplyJson');assert.ok(await page.$('#craftForm [data-field="discipline"]'),'Malformed advanced JSON preserves the form draft');await page.click('#craftAdvanced summary');
 await field('#craftForm [data-field="difficulty"]',11);
 await page.select('#craftSection','materials');await field('#craftSearch','wood');await page.click('[data-craft-entry="wood"]');await field('#craftForm [data-field="value"]',19);
 await page.select('#craftSection','recipes');assert.equal(await page.$eval('#craftForm [data-field="difficulty"]',n=>n.value),'11');
 const save=async()=>{const response=page.waitForResponse(r=>r.url().endsWith('/gm/action')&&r.request().postData()?.includes('crafting_save'));await page.click('#craftSave');const r=await response;await page.waitForFunction(()=>!document.querySelector('#craftSave').disabled);return r;};
 assert.equal((await save()).status(),200);assert.match(await page.$eval('#craftDirty',n=>n.textContent),/Materials/);
 let after=await request('/gm/crafting');assert.equal(after.data.recipes[0].difficulty,11);assert.deepEqual(after.data.recipes[0].ingredients,before.data.recipes[0].ingredients);assert.deepEqual(after.data.materials,before.data.materials);
 await field('#craftForm [data-field="Ingredients.quantity"]',0);assert.equal((await save()).status(),409);assert.equal(await page.$eval('#craftForm [data-field="Ingredients.quantity"]',n=>n.value),'0');assert.equal((await request('/gm/crafting')).revision,after.revision);
 await field('#craftForm [data-field="Ingredients.quantity"]',Object.values(before.data.recipes[0].ingredients)[0]);
 await page.select('#craftSection','materials');await page.click('[data-craft-entry="wood"]');assert.equal(await page.$eval('#craftForm [data-field="value"]',n=>n.value),'19');assert.equal((await save()).status(),200);
 phase='all sections';for(const section of ['culinary','cooking','regions','wildlife','tuning','catalysts']){await page.select('#craftSection',section);assert.ok(await page.$$eval('#craftForm input,#craftForm select',nodes=>nodes.length)>0,section);assert.equal((await save()).status(),200,section+' unchanged round trip');}
 phase='duplicate/delete';await page.select('#craftSection','materials');await page.click('[data-craft-entry="wood"]');promptReply='workshop_wood';await page.click('#craftCopy');await page.waitForSelector('[data-craft-entry="workshop_wood"]');await field('#craftForm [data-field="name"]','Workshop Wood');assert.equal((await save()).status(),200);assert.equal((await request('/gm/crafting')).data.materials.workshop_wood.name,'Workshop Wood');await page.click('#craftDelete');assert.equal((await save()).status(),200);assert.equal((await request('/gm/crafting')).data.materials.workshop_wood,undefined);
 phase='stale revision';await page.select('#craftSection','tuning');await field('#craftForm [data-field="burn_base"]',17);const external=await request('/gm/crafting');await request('/gm/action',{action:'crafting_save',section:'tuning',value:{...external.data.tuning,burn_base:18},revision:external.revision});assert.equal((await save()).status(),409);assert.equal(await page.$eval('#craftForm [data-field="burn_base"]',n=>n.value),'17');assert.equal((await request('/gm/crafting')).data.tuning.burn_base,18);
 await page.click('#craftReload');await page.waitForFunction(()=>document.querySelector('#craftForm [data-field="burn_base"]').value==='18');
 phase='screenshots';await page.select('#craftSection','recipes');await page.screenshot({path:'artifacts/loot-crafting-browser/recipes.png',fullPage:true});await page.setViewport({width:390,height:844});
 for(const section of ['recipes','regions','wildlife','tuning']){await page.select('#craftSection',section);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),section+' fits mobile');}
 await page.screenshot({path:'artifacts/loot-crafting-browser/mobile.png',fullPage:true});assert.deepEqual(errors,[]);console.log('Weapon edits, previews, crafting forms, drafts, validation, stale saves and mobile checks passed.');
}catch(error){console.error('Phase:',phase);throw error;}finally{await browser?.close();service.server.closeAllConnections();await new Promise(r=>service.server.close(r));}
