import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createQuestService} from '../server/service.mjs';

test('scenery removal previews select one overlapping object and preserve the original snapshot',()=>{
 const source=readFileSync(new URL('../server/gm-map-editor.js',import.meta.url),'utf8');
 for(const kind of ['hub','dive']){
  const layer=kind==='hub'?'fixtures':'decorations',first={id:'first',kind:'scenery',sprite:'sprUtopiaTower',x:27,y:34,span_w:3,span_h:3,solid:true},second={...first,id:'second'};
  const floor={walls:Array.from({length:40},()=>Array(40).fill(0)),props:Array.from({length:40},()=>Array(40).fill(0)),[layer]:[first,second]},original=structuredClone(floor);
  const state={map:{kind,floor},pending:[]},context={state};runInNewContext(source.slice(source.indexOf('function effectiveFloor('),source.indexOf('async function loadContent(')),context);
  const remove={kind:'decoration',op:'remove',match:{id:second.id,sprite:second.sprite,x:27,y:34}};state.pending.push(remove,remove);
  assert.deepEqual(Array.from(context.effectiveFloor()[layer],p=>p.id),['first'],'repeated ID removal leaves the other identical sprite in place');
  state.pending=[{...remove,match:{sprite:first.sprite,x:27,y:34}}];assert.deepEqual(Array.from(context.effectiveFloor()[layer],p=>p.id),['second'],'legacy coordinate removal removes one object, like the server');
  state.pending=[{...remove,match:{id:second.id,sprite:second.sprite,x:1,y:1}}];assert.deepEqual(Array.from(context.effectiveFloor()[layer],p=>p.id),['first'],'a stable ID wins over old coordinates');
  assert.deepEqual(floor,original,'the preview never mutates the saved floor');
 }
});

test('surface dungeon entrances drag and cut as one connection without mutating the base preview or copying a portal',async()=>{
 const source=readFileSync(new URL('../server/gm-map-editor.js',import.meta.url),'utf8');
 for(const building of [true,false]){
  const target=building?'dungeon-mana-tunnels':'dungeon-littlebig-sewers',portal={target,key:target,name:'Test entrance',fullDungeon:true,entranceFixture:'entrance-'+target,x:8,y:10};
  const art={id:portal.entranceFixture,kind:'scenery',sprite:building?'sprManaStation':'sprSewerManhole',x:building?7:8,y:building?7:10,span_w:building?3:1,span_h:building?3:1,solid:building};
  const floor={walls:Array.from({length:30},()=>Array(30).fill(0)),fixtures:[art],doors:[portal],portals:[{...portal}],fullDungeonPortals:[{...portal}]},original=structuredClone(floor);
  const state={map:{id:building?'utopia-arcanum':'littlebigcity',kind:'hub',patch:{},floor},pending:[],plan:{supports:{decorations:false}}};
  const context={state,structuredClone,MOVABLE_FIXTURES:new Set(),MOVE_ONLY_FIXTURES:new Set(),renderToolOptions:()=>{},schedule:()=>{},say:()=>{},queueOp:op=>state.pending.push(op)};
  runInNewContext(source.slice(source.indexOf('function effectiveFloor('),source.indexOf('async function loadContent('))+'\n'+source.slice(source.indexOf('const fixturesEditable='),source.indexOf('function drawGhost(')),context); // Exercise the actual handlers without DOM or network setup.
  context.select(art.x,art.y);assert.equal(state.selection.type,'entrance');assert.equal(context.objectAt(portal.x,portal.y).type,'entrance');
  assert.throws(()=>context.copySelection(false),/not copied/);
  await context.moveObject(state.selection,{x:15,y:16});
  const dx=15-art.x,dy=16-art.y,copy=value=>JSON.parse(JSON.stringify(value));
  assert.deepEqual(copy(state.pending),[{kind:'exit',op:'move',exit:target,to:{x:portal.x+dx,y:portal.y+dy}}],'one move preserves the facade-to-doorstep offset');
  const preview=context.effectiveFloor();assert.deepEqual([preview.fixtures[0].x,preview.fixtures[0].y],[15,16]);
  for(const p of [preview.doors[0],preview.portals[0],preview.fullDungeonPortals[0]])assert.deepEqual([p.x,p.y],[portal.x+dx,portal.y+dy]);
  assert.deepEqual(floor,original,'unsaved previews leave all original objects untouched');
  context.copySelection(true);const clip=state.clipboard;await context.pasteAt({x:18,y:19});assert.equal(state.clipboard,null,'a moved entrance never becomes a reusable copy');
  assert.equal(context.effectiveFloor().fixtures[0].x,18);assert.equal(state.pending.length,2);
  state.clipboard={...clip,zone:'another-hub'};await assert.rejects(context.pasteAt({x:20,y:20}),/own hub/);
  state.clipboard={...clip,cut:false};await assert.rejects(context.pasteAt({x:20,y:20}),/cannot be copied/);assert.equal(state.pending.length,2);
  state.pending=[];assert.deepEqual(context.effectiveFloor(),original,'discarding edits restores both art and travel preview');
 }
});

test('changing the object sprite rebuilds the preview with the new selection',()=>{
 const source=readFileSync(new URL('../server/gm-map-editor.js',import.meta.url),'utf8');
 const functions=source.slice(source.indexOf('function field('),source.indexOf('function renderToolOptions('));
 const state={opts:{sprite:'sprItem',target:'sign',name:'Court sign',lifetime:'persistent'}},renders=[];
 let scheduled=0;
 const context={state,el:()=>({}),renderToolOptions:()=>renders.push({...state.opts}),schedule:()=>scheduled++};
 runInNewContext(functions,context); // Exercise the dropdown's actual change handler without starting the editor.
 const select=context.field({},'Object / token sprite','sprite','text',[{id:'sprItem'},{id:'sprFairy'}]);
 for(const sprite of ['sprFairy','sprItem']){
  select.value=sprite;select.onchange();
  assert.equal(renders.at(-1)?.sprite,sprite,'the sidebar refreshes on every selection');
  assert.deepEqual(renders.at(-1),{sprite,target:'sign',name:'Court sign',lifetime:'persistent'});
 }
 assert.equal(renders.length,2);
 assert.equal(scheduled,2,'the map preview still redraws');
});

test('the Map Editor pop-out is served with the panel hardening and its spliced scripts parse',async()=>{
 const staff='s'.repeat(43),service=createQuestService({log:()=>{},walletClient:{authenticate:async token=>({owner:'staff',gamemaster:token===staff,client:'lidollquest',coins:0,scope:'social:read'})}});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
 try{
  const response=await fetch(base+'/gm/map-editor');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/html/);assert.equal(response.headers.get('x-frame-options'),'DENY');assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  const page=await response.text();assert.match(page,/<title>LiDollQuest Map Editor<\/title>/);assert.match(page,/id="palette"/);assert.doesNotMatch(page,/\/\* (TILE_PAINTER|MAP_EDITOR|MUSIC_WIDGET|SPRITE_LAB) \*\//,'every splice filled');
  const scripts=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);assert.equal(scripts.length,4);
  assert.match(scripts[2],/async function spriteLabComposite\(/,'the shared Sprite Lab renderer is spliced in, so NPC looks draw in the editor');assert.match(scripts[3],/function fitLook\(/);
  assert.match(scripts[1],/function musicWidget\(/,'the shared Zone music widget is spliced in');assert.match(page,/id="zoneMusic"/);
  assert.doesNotMatch(scripts[0],/^export /m,'the painter is spliced without module exports');assert.match(scripts[0],/function tileAt\(/);
  for(const script of scripts){new Function(script);assert.doesNotMatch(script,/\/\/.*(const|let|var)\s+\w+\s*=/,'a line comment would swallow code on the same line');}
  new Function(scripts.join('\n'));
  assert.equal((await fetch(base+'/gm/map-editor',{method:'POST'})).status,405);
  const panel=await (await fetch(base+'/gm')).text();assert.match(panel,/Pop out Map Editor/);assert.match(panel,/worldMapEditor/);
  const content=await (await fetch(base+'/gm/content',{headers:{Authorization:'Bearer '+staff}})).json();assert.equal(content.avatarSprites.objNPCInnkeeper,'sprNPCInnkeeper');
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});

test('the Story Workshop map dialog sends the payloads the world actions actually check',()=>{
 const source=readFileSync(new URL('../server/gm-flow-editor.js',import.meta.url),'utf8');
 assert.match(source,/world_regenerate',\{zone:state\.zone,edition:mapData\.edition,revision:mapData\.revision,\.\.\.\(mapData\.district\?\{confirm_reset:true\}:\{confirm_reset_rewards:true\}\)\}/,'dives need confirm_reset_rewards, hubs confirm_reset');
 assert.match(source,/world_cancel',\{zone:state\.zone,edition:mapData\.edition,revision:mapData\.revision,job:mapData\.job\.id\}/,'cancel names the job');
 assert.match(source,/\/gm\/map-editor\?zone=/,'the dialog hands off to the full editor');
});

test('the Map Editor receives each NPC\'s Sprite Lab look, so GMs see the artwork they made (2026-10-15)',async()=>{
 const staff='s'.repeat(43),service=createQuestService({log:()=>{},walletClient:{authenticate:async token=>({owner:'staff',gamemaster:token===staff,client:'lidollquest',coins:0,scope:'social:read'})}});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
 try{
  const look={version:1,slots:{base:'piko_woman',hair:'mohawk',torso:'maid_dress',shoes:'sneakers'},colors:{hair:[[205,86,44]]},enabled:{hair:[true]},facing:2};
  const wren=service.live.entry('npc','utopia_wren');const {facing:unset,...rest}=wren.published;service.live.change({action:'content_publish',kind:'npc',id:'utopia_wren',revision:wren.revision,entry:{...rest,look}},'staff'); // No record facing: the look's own facing applies, as in game.
  const map=await (await fetch(base+'/gm/map?zone=utopia-arcanum-tower&paint=1',{headers:{Authorization:'Bearer '+staff}})).json();
  const placed=map.placements.find(p=>p.content==='utopia_wren');
  assert.ok(placed.lookKey,'the placement names its look');assert.equal(map.looks[placed.lookKey].slots.hair,'mohawk');assert.equal(placed.facing,2,'and faces the way the look faces');
  assert.ok(!map.placements.find(p=>p.content==='utopia_padma').lookKey,'NPCs without a look keep their compiled sprite');
 }finally{await new Promise(r=>service.server.close(r));}
});
