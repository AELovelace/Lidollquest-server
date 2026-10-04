import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {snapshotCatalog,renderRuntime,renderPage,buildPublicQuestEditor} from '../scripts/build-public-quest-editor.mjs';
import {validateQuestContent} from '../server/quest-content.mjs';
import {validateFlow} from '../server/flow-content.mjs';
import {validateLook} from '../server/sprite-looks.mjs';
import {createQuestService} from '../server/service.mjs';

const bundleScript=readFileSync(new URL('../server/gm-quest-bundle.js',import.meta.url),'utf8');
const bundleApi=vm.runInNewContext(bundleScript+';({serializeQuestBundle,parseQuestBundle,questBundleFileName,QUEST_BUNDLE})',{});
const same=(actual,expected,message)=>assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(expected)),message); // Sandbox values come from another vm realm, so compare their JSON rather than prototypes.
let snapshot;
test.before(async()=>{snapshot=await snapshotCatalog();});

function sandbox(){
 const store=new Map(),storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
 const context={TextEncoder,URL,console,localStorage:storage};context.window=context;
 vm.runInNewContext(renderRuntime(snapshot),context);
 return {api:context.LIDOLL_STATIC_API,rules:context.LIDOLL_PUBLIC_RULES,store,reload:()=>context.createPublicWorkshopApi({snapshot,rules:context.LIDOLL_PUBLIC_RULES,storage})};
} // The same runtime script the built page embeds, evaluated without a browser.
const act=(api,action,payload={})=>api('/gm/action',{...payload,action,request_id:'test'}).then(r=>r.result);
const quest=(id,monster,npc)=>({id,name:'A Light for the Scout',description:'Clear the path.',givers:[npc],prerequisites:[],conditions:[],repeat:'once',cooldown_seconds:86400,timer:{mode:'online',seconds:0},turn_in:{mode:'journal',npc:''},failure_text:'Quest failed.',
 stages:[{id:'stage_a1',name:'Clear the path',text:'Defeat the guardian.',mode:'all',next:'complete',objectives:[{id:'objective_a1',type:'kill',text:'Defeat the path guardian.',target:monster,npc:'',zone:'',count:1,token:false,sharing:'personal',conditions:[]}],branches:[]}],rewards:{xp:10,coins:0,rpp:0,items:[],spells:[],stats:{},equipment:[]}});
const npc=id=>({id,name:'Lantern Scout',description:'',sprite:'',battle_sprite:'',wander_radius:0,quests:[],story_default:'greeting',story_reactions:[],dialogue:[{id:'greeting',text:'My lantern went dark.',next:'close',actions:[]}]});
const flowOf=flag=>({id:'story_scout',name:'Scout rescue',description:'',repeatable:false,bindings:[],layout:{x:0,y:0,zoom:1},
 nodes:[{id:'entry_1',type:'entry',label:'Start',x:0,y:0,conditions:{all:[],any:[],none:[]},choices:[],effects:[],rewards:{}},{id:'dialogue_1',type:'dialogue',label:'Thanks',text:'The scout thanks you.',x:300,y:0,conditions:{all:[],any:[],none:[]},choices:[],effects:[],rewards:{}},{id:'set_1',type:'set_flag',label:'Remember',flag,x:600,y:0,conditions:{all:[],any:[],none:[]},choices:[],effects:[],rewards:{}},{id:'end_1',type:'end',label:'Finish',x:900,y:0,conditions:{all:[],any:[],none:[]},choices:[],effects:[],rewards:{}}],
 edges:[{from:'entry_1',port:'next',to:'dialogue_1'},{from:'dialogue_1',port:'next',to:'set_1'},{from:'set_1',port:'next',to:'end_1'}]});

test('quest bundles round-trip and malformed files are refused with a reason',()=>{
 const data=bundleApi.serializeQuestBundle({flow:flowOf('story_x'),assets:[{kind:'quest',id:'quest_1',revision:3,entry:quest('quest_1','slime','npc_1')}],flags:[{id:'story_x',name:'X'}],source:'public-quest-editor',now:()=>new Date('2026-10-03T00:00:00Z')});
 assert.equal(data.format,'lidollquest-quest-bundle');assert.equal(data.exported,'2026-10-03T00:00:00.000Z');assert.equal(data.assets[0].revision,undefined);assert.equal(data.flags[0].description,'');
 const parsed=bundleApi.parseQuestBundle(JSON.stringify(data));
 assert.equal(parsed.flow.id,'story_scout');same(parsed.assets.map(a=>a.kind+':'+a.id),['quest:quest_1']);assert.equal(parsed.assets[0].entry.id,'quest_1');same(parsed.flags,[{id:'story_x',name:'X',description:''}]);
 assert.equal(bundleApi.questBundleFileName(data),'scout-rescue.lidollquest.json');
 assert.equal(bundleApi.questBundleFileName({flow:null,assets:[{entry:{title:'Glowing Orb!'}}]}),'glowing-orb.lidollquest.json');
 for(const [input,message] of [['{not json','This file is not valid JSON.'],['[]','This file is not a quest bundle.'],['{"format":"other"}','This file is not a LiDollQuest quest bundle.'],[JSON.stringify({...data,version:2}),'This bundle is version 2; this editor reads version 1.'],
  [JSON.stringify({...data,flow:{id:'Bad ID'}}),'The bundled story flow needs a stable lowercase ID.'],[JSON.stringify({...data,assets:[{kind:'spell',id:'x',entry:{}}]}),'Unknown content kind in this bundle: spell'],[JSON.stringify({...data,assets:[data.assets[0],data.assets[0]]}),'Duplicate content record: quest:quest_1'],
  [JSON.stringify({...data,flags:[{id:'not_story',name:'x'}]}),'Bundled flags need story_ IDs.'],[JSON.stringify({...data,flags:[{id:'story_ok',name:' '}]}),'Give flag story_ok a name and a short description.']])assert.throws(()=>bundleApi.parseQuestBundle(input),{message},input.slice(0,40));
});

test('the public catalogue carries shipped references, engine flags and no server records',async()=>{
 const {api}=sandbox(),cat=await api('/gm/flows');
 assert.equal(cat.publicEditor,true);assert.equal(cat.enabled,false);assert.equal((await api('/gm/whoami')).owner,'public');
 assert.ok(cat.zones.length>5&&cat.items.length>100&&cat.monsters.length>10&&cat.sprites.includes('sprItem'));
 assert.ok(cat.records.questCatalog.objectiveTypes.includes('kill')&&cat.records.spells.length>10);
 assert.ok(cat.flags.length>10&&cat.flags.every(f=>f.engineOwned));assert.ok(cat.npcs.length>0&&cat.npcs.every(n=>n.engineOwned));
 same([cat.records.sheets,cat.records.quests,cat.records.npcs,cat.records.orbs,cat.records.zones,cat.flows,cat.placements,cat.assets],[[],[],[],[],[],[],[],[]]);
 assert.ok(cat.records.monsters.every(m=>m.published&&m.revision===0));assert.ok(cat.faith.gods.length>0);
 await assert.rejects(api('/gm/map?zone=x'),/live GM console/);await assert.rejects(api('/gm/asset?id=x'),/live GM console/);
 assert.ok(JSON.stringify(snapshot).length<1024*1024);
});

test('browser-local drafts obey the server validators and keep revisions',async()=>{
 const {api,store}=sandbox(),monster=snapshot.monsters[0].id;
 const flag=await act(api,'flow_flag_save',{entry:{id:'story_scout_rescued',name:'Rescued the scout',description:'Set after the rescue.'},revision:0});
 assert.equal(flag.revision,1);assert.equal(flag.engineOwned,false);
 await assert.rejects(act(api,'flow_flag_save',{entry:{id:'story_scout_rescued',name:'Again'},revision:0}),/This flag changed/);
 await assert.rejects(act(api,'flow_flag_save',{entry:{id:'rescued',name:'No prefix'},revision:0}),/must start with story_/);
 const saved=await act(api,'flow_assets_save',{assets:[{kind:'npc',id:'npc_scout',revision:0,entry:npc('npc_scout')},{kind:'quest',id:'quest_scout',revision:0,entry:{...quest('quest_scout',monster,'npc_scout'),extra:'dropped'}}]});
 same(saved,{assets:[{kind:'npc',id:'npc_scout'},{kind:'quest',id:'quest_scout'}],published:false});
 const cat=await api('/gm/flows');
 assert.equal(cat.records.quests[0].revision,1);assert.equal(cat.records.quests[0].published,null);assert.equal(cat.records.quests[0].draft.extra,undefined);assert.equal(cat.records.quests[0].draft.rewards.xp,10);
 assert.equal(cat.records.npcs[0].draft.story_default,'greeting');assert.equal(cat.flags[0].id,'story_scout_rescued');
 await assert.rejects(act(api,'flow_assets_save',{assets:[{kind:'quest',id:'quest_scout',revision:0,entry:quest('quest_scout',monster,'npc_scout')}]}),/This draft changed/);
 await assert.rejects(act(api,'flow_assets_save',{assets:[{kind:'quest',id:'quest_bad',revision:0,entry:{...quest('quest_bad',monster,'npc_scout'),rewards:{items:[{id:'no_such_item',count:1}]}}}]}),/Choose existing equipment or items/);
 await assert.rejects(act(api,'flow_assets_save',{assets:[{kind:'npc',id:'npc_art',revision:0,entry:{...npc('npc_art'),sprite:'managed-upload'}}]}),/compiled sprite/);
 await assert.rejects(act(api,'flow_assets_save',{assets:[{kind:'monster',id:monster,revision:0,entry:snapshot.monsters[0]}]}),/Monsters are tuned in the live GM console/);
 await assert.rejects(act(api,'flow_assets_save',{assets:[{kind:'orb',id:'orb_1',revision:0,entry:{id:'orb_1',title:'',colour:'#ffdc3c',pages:[{id:'p',text:'x',next:'close'}]}}]}),/Give the orb a title/);
 const orb=await act(api,'flow_assets_save',{assets:[{kind:'orb',id:'orb_1',revision:0,entry:{id:'orb_1',title:'Memory',colour:'#FFDC3C',hidden_until_revealed:true,pages:[{id:'p',text:'A memory.',next:'close'}],story_conditions:{all:['story_scout_rescued'],any:[],none:[]}}}]});
 assert.equal(orb.assets[0].id,'orb_1');assert.equal((await api('/gm/flows')).records.orbs[0].draft.colour,'#ffdc3c');
 await assert.rejects(act(api,'flow_assets_publish',{assets:[]}),/Publishing happens in the live GM console/);
 await assert.rejects(act(api,'flow_test_create',{}),/Only the live GM console/);
 assert.ok(JSON.parse(store.get('lidollquest.public-quest-editor.v1')).records.quest.quest_scout.draft.stages.length===1);
 const fresh=sandbox();assert.equal((await fresh.api('/gm/flows')).records.quests.length,0,'storage is per browser, not shared across sandboxes');
});

test('flows validate, save, and preview locally with the server walk',async()=>{
 const {api}=sandbox();
 await act(api,'flow_flag_save',{entry:{id:'story_scout_rescued',name:'Rescued the scout',description:''},revision:0});
 const unknown=await act(api,'flow_validate',{entry:flowOf('story_missing'),assets:[]});
 assert.ok(unknown.issues.some(i=>i.node==='set_1'&&i.message==='Choose an active authored flag.'));
 const loose={...flowOf('story_scout_rescued')};loose.edges=loose.edges.slice(0,2);
 assert.ok((await act(api,'flow_validate',{entry:loose,assets:[]})).issues.some(i=>i.node==='set_1'&&i.message==='Connect the next output.'));
 const saved=await act(api,'flow_save',{id:'story_scout',revision:0,entry:flowOf('story_scout_rescued'),assets:[]});
 assert.equal(saved.revision,1);same(saved.issues,[]);assert.equal(saved.published,null);assert.equal(saved.draft.layout.nodes.dialogue_1.x,300);assert.equal(saved.draft.nodes[1].x,undefined);
 await assert.rejects(act(api,'flow_save',{id:'story_scout',revision:0,entry:flowOf('story_scout_rescued'),assets:[]}),/This flow changed/);
 assert.equal((await api('/gm/flows')).flows[0].id,'story_scout');
 const first=await act(api,'flow_preview',{entry:flowOf('story_scout_rescued'),assets:[],flags:{},orbVisibility:{},stats:{},faith:{god:'',piety:0}});
 assert.equal(first.node.type,'dialogue');assert.equal(first.state.node,'dialogue_1');same(first.flags,{});
 const done=await act(api,'flow_preview',{entry:flowOf('story_scout_rescued'),assets:[],flags:{},node:'set_1'});
 assert.equal(done.state.done,true);assert.equal(done.flags.story_scout_rescued,true);
 await assert.rejects(act(api,'flow_preview',{entry:loose,assets:[],flags:{}}),/Connect the next output/);
 await assert.rejects(act(api,'flow_publish',{id:'story_scout',revision:1,entry:flowOf('story_scout_rescued'),assets:[]}),/Publishing happens in the live GM console/);
});

test('offline NPC looks and facing survive saving, reload and bundle transfer with live validation',async()=>{
 const {api,reload,store}=sandbox(),art=await api('/gm/sprite-lab');
 same(art.catalog,snapshot.spriteLab.catalog);
 for(const layer of art.catalog.assets)assert.equal(Buffer.from(art.sheets[layer.sprite],'base64').subarray(1,4).toString(),'PNG',layer.id+' has bundled artwork');
 art.catalog.assets.length=0;assert.ok((await api('/gm/sprite-lab')).catalog.assets.length,'the API does not expose mutable catalog state');
 const look={version:1,slots:{base:'piko_woman',hair:'mohawk',torso:'maid_dress'},colors:{hair:[[25,100,230]]},enabled:{hair:[true]},strength:{hair:[0.5]},facing:0};
 const entry={...npc('npc_stylist'),look,facing:3};
 await act(api,'flow_assets_save',{assets:[{kind:'npc',id:entry.id,revision:0,entry}]});
 const saved=(await reload()('/gm/flows')).records.npcs[0].draft;
 same(saved.look,validateLook(look));assert.equal(saved.facing,3);
 const exported=bundleApi.serializeQuestBundle({assets:[{kind:'npc',id:entry.id,entry:saved}]}),imported=bundleApi.parseQuestBundle(JSON.stringify(exported)).assets[0].entry;
 same(validateQuestContent('npc',imported,{assetRef:v=>v,look:validateLook}),saved,'live import preserves the exact appearance and facing');
 const before=store.get('lidollquest.public-quest-editor.v1');
 for(const facing of [-1,4,1.5,'2'])await assert.rejects(act(api,'flow_assets_save',{assets:[{kind:'npc',id:entry.id,revision:1,entry:{...entry,facing}}]}),/whole number between 0 and 3/);
 for(const invalid of [{...look,slots:{base:'missing'}},{...look,colors:{hair:[[256,1,2]]}},{...look,strength:{hair:[2]}},{...look,slots:{...look.slots,head:'crown',face:'sunglasses',neck:'bow_tie',back:'cape'}}]){
  let error;try{validateLook(invalid);}catch(e){error=e.message;}assert.ok(error);
  await assert.rejects(act(api,'flow_assets_save',{assets:[{kind:'npc',id:entry.id,revision:1,entry:{...entry,look:invalid}}]}),{message:error});
 }
 assert.equal(store.get('lidollquest.public-quest-editor.v1'),before,'invalid edits never replace the saved draft');
});

test('current quest flags, state objectives, branches and rewards round-trip in the static editor',async()=>{
 const {api,reload}=sandbox(),entry=quest('quest_current',snapshot.monsters[0].id,'npc_scout');
 entry.repeat='daily';entry.reset_flags=['story_path_clear'];entry.offer_line='Help the scout.';entry.complete_line='The path is clear.';
 entry.stages[0].objectives[0].on_complete_flags=['story_path_clear'];
 entry.stages[0].objectives.push({id:'ready',type:'state',field:'stamina',op:'gte',value:10,count:1,sharing:'party',text:'Rest first.'});
 entry.stages[0].branches=[{id:'done',label:'Finish',to:'complete',conditions:[{flags:{all:['story_path_clear'],any:[],none:[]}}]}];
 entry.rewards.dignity=2;
 await act(api,'flow_assets_save',{assets:[{kind:'quest',id:entry.id,revision:0,entry}]});
 const saved=(await reload()('/gm/flows')).records.quests[0].draft;
 same(saved,validateQuestContent('quest',entry,{assetRef:v=>v,spells:{},equipment:{}}));
 same(bundleApi.parseQuestBundle(JSON.stringify(bundleApi.serializeQuestBundle({assets:[{kind:'quest',id:entry.id,entry:saved}]}))).assets[0].entry,saved);
 const page=renderPage(snapshot);assert.ok(page.includes('Default facing')&&page.includes('spriteLabDesigner(host,{look:d.look??null,api,onChange:'));
 assert.ok(!page.includes('Looks are designed and previewed in the live GM console.'));
});

test('inlined validators match the server modules',async()=>{
 const {rules}=sandbox(),bad={id:'Bad ID'},refs={assetRef:v=>v,spells:{},equipment:{}};
 for(const input of [bad,{id:'quest_a',stages:[{id:'s',next:'missing',objectives:[]}]},{id:'quest_a',repeat:'hourly'}]){
  let expected='';try{validateQuestContent('quest',input,refs);}catch(e){expected=e.message;}
  assert.throws(()=>rules.validateQuestContent('quest',input,refs),{message:expected});
 }
 const catalog={npcs:[],orbs:[],quests:[],monsters:[],zones:[],sprites:[],items:[]},flags=[{id:'story_x',name:'x'}];
 same(JSON.parse(JSON.stringify(rules.validateFlow(flowOf('story_x'),{catalog,flags}))),JSON.parse(JSON.stringify(validateFlow(flowOf('story_x'),{catalog,flags})))); // Results cross a vm realm, so compare their JSON rather than prototypes.
 same(JSON.parse(JSON.stringify(rules.validateFlow(flowOf('story_y'),{catalog,flags}).issues)),validateFlow(flowOf('story_y'),{catalog,flags}).issues);
 assert.equal(rules.pietyMatches({faith:{god:snapshot.faith.gods[0].id,piety:60}},{god:'',op:'gte',value:50}),true);
 same([...rules.triggerTypes],['flag_entry','objective_entry']);
});

test('the build writes a self-contained page and a wiki that links back to it',()=>{
 const outDir=mkdtempSync(join(tmpdir(),'lidoll-public-editor-')),result=buildPublicQuestEditor({outDir,snapshot});
 const page=readFileSync(join(outDir,'index.html'),'utf8');
 assert.ok(page.includes('<title>LiDollQuest Quest Editor</title>')&&page.includes('window.LIDOLL_PUBLIC_CATALOG=')&&page.includes('function createPublicWorkshopApi')&&page.includes('function parseQuestBundle')&&page.includes('function contentGraph'));
 assert.ok(!page.includes('class="live-link"')&&!page.includes('noindex')&&!page.includes('href="/gm/wiki/"')&&page.includes('href="wiki/"'));
 assert.ok(page.includes('id="exportBundle"')&&page.includes('id="importBundle"')&&page.includes('class="live-only"'));
 assert.ok(result.files.includes('wiki/index.html')&&result.files.includes('wiki/content/first-quest.md')&&result.files.includes('wiki/vendor/marked.min.js'));
 for(const name of result.files)assert.ok(existsSync(join(outDir,name)),name);
 const wiki=readFileSync(join(outDir,'wiki','index.html'),'utf8');
 assert.ok(wiki.includes('href="../index.html"')&&!wiki.includes('/gm/flow-editor')&&!wiki.includes('noindex'));
 assert.equal(renderPage(snapshot,{title:'Custom',wikiHref:'https://example.test/wiki/'}).includes('<h1>Custom</h1>'),true);
});

test('the live workshop page ships the bundle format and the import/export controls',async()=>{
 const service=createQuestService({walletClient:{async authenticate(){return {owner:'reader',gamemaster:false};}},log:()=>{}});
 await new Promise(ready=>service.server.listen(0,'127.0.0.1',ready));
 try{
  const page=await (await fetch('http://127.0.0.1:'+service.server.address().port+'/gm/flow-editor')).text();
  assert.ok(page.includes('function parseQuestBundle')&&page.includes('id="importBundle"')&&page.includes('id="exportBundle"')&&page.includes('window.LIDOLL_STATIC_API??liveApi'));
  assert.ok(!page.includes('LIDOLL_PUBLIC_CATALOG'));
 }finally{service.server.closeAllConnections();await new Promise(done=>service.server.close(done));}
});
