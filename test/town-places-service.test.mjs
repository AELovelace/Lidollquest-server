import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
import {createZoneSnapshotRuntime} from '../server/zone-snapshot-runtime.mjs';
import {installZoneSnapshotEpochs} from '../server/zone-snapshot-epochs.mjs';

test('GM publication reaches catalogs, map painting, a warm worker and reconnects after restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'town-place-service-')),filename=join(directory,'world.sqlite');
 const staff='s'.repeat(43),ordinary='a'.repeat(43),identity={owner:'staff',id:'staff-session',gamemaster:true,client:'lidollquest',coins:0,scope:'wallet:read wallet:write'};
 let at=Date.parse('2026-10-20T18:00:00Z'),service,runtime,base,current;
 const open=async()=>{service=createQuestService({filename,now:()=>at,log:()=>{},walletClient:{authenticate:async token=>token===staff?identity:{...identity,owner:'ordinary',gamemaster:false}}});await service.prepare();await new Promise(r=>service.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+service.server.address().port;};
 const close=async()=>{runtime?.close();runtime=null;if(service){service.server.closeAllConnections();await new Promise(r=>service.server.close(r));service=null;}};
 const http=async(path,body,token=staff,status=200)=>{const r=await fetch(base+path,{headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;};
 const command=async(action,extra={})=>{at+=1000;current=await http('/zones/action',{request_id:randomUUID(),controller:'test',...(current?.character?{character_id:current.character.id,revision:current.character.revision}:{}),action,...extra});return current;};
 const gm=body=>http('/gm/action',{request_id:randomUUID(),...body});
 const zone='utopia-arcanum-place-bakery-shop';
 try{
  await open();
  await command('create',{name:'Builder'});
  await command('enter',{zone:'utopia-arcanum',combat_version:3,content_version:1,quest_version:1,follower_version:1,
   loadout:{player_info:{level:1,playerHealth:100,playerHealthMax:100},inventory:[]}});
  installZoneSnapshotEpochs(service.db);runtime=createZoneSnapshotRuntime({filename});
  const render=()=>JSON.parse(new TextDecoder().decode(runtime.render({at,identity,character:current.character.id,view:{},badges:service.zones.snapshotBadges(),capabilities:current.capabilities}).bytes));
  assert.ok(!render().zones.some(r=>r.id===zone)); // Warm the reader before a place exists.
  assert.ok(!service.zones.questGuideGraph().has(zone)); // Warm the coordinator's route cache before publication too.
  const entry={name:'Bakery',home:'utopia-arcanum',rooms:[{id:'shop',name:'Bakery shop',width:12,height:10}]};
  await http('/gm/places',null,ordinary,403);
  await http('/gm/action',{request_id:randomUUID(),action:'world_place_save',id:'bakery',revision:0,entry},ordinary,403);
  assert.equal(service.zones.world.places.list().length,0);
  const request={request_id:randomUUID(),action:'world_place_save',id:'bakery',revision:0,entry};
  const saved=await http('/gm/action',request);assert.deepEqual(await http('/gm/action',request),saved,'retry replays the receipt without another revision');
  assert.equal((await http('/gm/places?id=bakery')).places[0].revision,1);
  assert.ok(!(await http('/gm/content')).worldZones.some(r=>r.id===zone));
  assert.ok(!render().zones.some(r=>r.id===zone),'draft geometry never leaks to a warm player snapshot');
  await http('/gm/map?zone='+zone+'&paint=1',null,staff,409);
  await gm({action:'world_place_publish',id:'bakery',revision:1});
  assert.ok(service.zones.questGuideGraph().has(zone),'publication refreshes the route graph immediately');
  assert.ok((await http('/gm/content')).worldZones.some(r=>r.id===zone));
  assert.ok((await http('/gm/music')).zones.some(r=>r.id===zone));
  await http('/gm/chat?zone='+zone); // Moderation accepts published custom rooms without a process restart.
  assert.deepEqual(render().zones.find(r=>r.id===zone).walls,[],'inactive new rooms arrive as stubs');
  let map=await http('/gm/map?zone='+zone+'&paint=1');
  assert.equal(map.floor.width,12);assert.equal(map.floor.tilesets.floor,'tileLBCInterior');
  const paint={action:'world_patch_apply',zone,edition:map.edition,revision:map.revision,patch_revision:map.patch.revision,ops:[{kind:'cells',cells:[{x:5,y:5,wall:1}]}]};
  await gm(paint);
  map=await http('/gm/map?zone='+zone+'&paint=1');assert.equal(map.floor.walls[5][5],1);
  await command('gm_catalog');assert.ok(current.receipt.gm.zones.some(r=>r.id===zone));
  await command('gm_warp_zone',{zone});assert.equal(current.zone,zone);assert.equal(current.character.hubVisit,zone);
  assert.equal(current.zones.find(r=>r.id===zone).walls[5][5],1);
  const reader=render();assert.equal(reader.zone,zone);assert.deepEqual(reader.zones.find(r=>r.id===zone),current.zones.find(r=>r.id===zone));
  await command('hub_visit',{zone:'utopia-arcanum'});assert.equal(current.zone,'utopia-arcanum','custom interiors retain the existing Return behavior');
  await command('gm_warp_zone',{zone});const character=current.character.id,position=current.position;
  await close();await open();
  assert.equal(service.db.prepare('SELECT zone FROM quest_presence WHERE character_id=?').get(character).zone,zone,'startup recovery recognizes persisted custom rooms');
  await command('enter',{zone,combat_version:3});assert.equal(current.zone,zone);assert.deepEqual(current.position,position);
  assert.equal(current.zones.find(r=>r.id===zone).walls[5][5],1,'existing map patches survive restart on custom rooms');
  assert.equal((await http('/gm/places?id=bakery')).places[0].published.rooms[0].id,zone);
 }finally{
  await close();
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('town-place-service-'));
  rmSync(directory,{recursive:true,force:true}); // Remove only this verified disposable test directory.
 }
});
