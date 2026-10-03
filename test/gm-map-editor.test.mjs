import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createQuestService} from '../server/service.mjs';

test('the Map Editor pop-out is served with the panel hardening and its spliced scripts parse',async()=>{
 const staff='s'.repeat(43),service=createQuestService({log:()=>{},walletClient:{authenticate:async token=>({owner:'staff',gamemaster:token===staff,client:'lidollquest',coins:0,scope:'social:read'})}});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
 try{
  const response=await fetch(base+'/gm/map-editor');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/html/);assert.equal(response.headers.get('x-frame-options'),'DENY');assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  const page=await response.text();assert.match(page,/<title>LiDollQuest Map Editor<\/title>/);assert.match(page,/id="palette"/);assert.doesNotMatch(page,/\/\* (TILE_PAINTER|MAP_EDITOR) \*\//,'both splices filled');
  const scripts=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);assert.equal(scripts.length,2);
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
