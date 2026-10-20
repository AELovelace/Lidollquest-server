import {decoratePlaceZone,validatePlaceZone} from '../server/town-place-layout.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
import {createZoneSnapshotRuntime} from '../server/zone-snapshot-runtime.mjs';
import {installZoneSnapshotEpochs} from '../server/zone-snapshot-epochs.mjs';

test('Utopia building draft, paired stairs, normal travel, parcel regeneration and portable import',async()=>{
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
  const entry={name:'Bakery',home:'utopia-arcanum',type:'interior',rooms:[{id:'shop',name:'Bakery shop',width:12,height:10},{id:'upstairs',name:'Bakery upstairs',width:12,height:10}],connections:[{id:'stairs',name:'Upstairs',a:{zone:'shop',x:8,y:7,arrival:{x:8,y:8}},b:{zone:'upstairs',x:0,y:6,arrival:{x:1,y:6}},defaultFor:'upstairs'},{id:'second-stair',name:'Second stairs',a:{zone:'shop',x:8,y:2,arrival:{x:8,y:3}},b:{zone:'upstairs',x:8,y:2,arrival:{x:8,y:3}}}],anchors:[{id:'counter',name:'Counter',zone:'shop',x:7,y:5},{id:'desk',name:'Desk',zone:'upstairs',x:4,y:3}]};
  const town=await http('/gm/map?zone=utopia-arcanum&paint=1'),floor={...town.floor,id:'utopia-arcanum',name:'Utopia',spawn:town.floor.entrance};
  let parcel=null;
  for(let y=3;y<floor.height-7&&!parcel;y++)for(let x=3;x<floor.width-5&&!parcel;x++)try{const candidate={...entry,exterior:{x,y,w:3,h:3}},p=service.zones.world.places.normalize('bakery',candidate);validatePlaceZone(decoratePlaceZone(floor,[p]),floor.portals??[]);parcel=candidate.exterior;}catch{}
  assert.ok(parcel,'Utopia has a valid parcel');entry.exterior=parcel;
  await http('/gm/places',null,ordinary,403);
  await http('/gm/action',{request_id:randomUUID(),action:'world_place_save',id:'bakery',revision:0,entry},ordinary,403);
  assert.equal(service.zones.world.places.list().length,0);
  const request={request_id:randomUUID(),action:'world_place_save',id:'bakery',revision:0,entry};
  const saved=await http('/gm/action',request);assert.deepEqual(await http('/gm/action',request),saved,'retry replays the receipt without another revision');
  assert.equal((await http('/gm/places?id=bakery')).places[0].revision,1);
  assert.ok(!(await http('/gm/content')).worldZones.some(r=>r.id===zone));
  assert.ok(!render().zones.some(r=>r.id===zone),'draft geometry never leaks to a warm player snapshot');
  await http('/gm/map?zone='+zone+'&paint=1',null,staff,409);
  const draftMap=await http('/gm/place-map?id=bakery&room=shop');assert.equal(draftMap.edition,'draft');
  await gm({action:'world_place_patch',id:'bakery',room:'shop',revision:1,ops:[{kind:'cells',cells:[{x:4,y:4,floor:7}]}]});
  assert.ok(!(await http('/gm/content')).worldZones.some(r=>r.id===zone));
  const npc=Object.keys(service.live.published().npcs).find(k=>!service.live.published().npcs[k].retired);assert.ok(npc);
  await gm({action:'world_place_stage',id:'bakery',room:'shop',revision:2,placement:{id:'resident',zone:'shop',kind:'npc',content:npc,name:'Test resident',x:3,y:3}});
  assert.equal(service.db.prepare("SELECT COUNT(*) n FROM world_placements WHERE id='town-bakery-resident'").get().n,0);
  await gm({action:'world_place_publish',id:'bakery',revision:3});
  assert.equal(service.db.prepare("SELECT COUNT(*) n FROM world_placements WHERE id='town-bakery-resident'").get().n,1,'publication creates the staged resident exactly once');
  await gm({action:'world_place_publish',id:'bakery',revision:4});
  assert.equal(service.db.prepare("SELECT COUNT(*) n FROM world_placements WHERE id='town-bakery-resident'").get().n,1);
  await http('/gm/action',{request_id:randomUUID(),action:'world_place_retire',id:'bakery',revision:5},staff,409);
  assert.ok(service.zones.questGuideGraph().has(zone),'publication refreshes the route graph immediately');
  assert.ok(service.zones.questGuideGraph().get('utopia-arcanum').some(e=>e.to===zone));
  const outside={x:parcel.x+1,y:parcel.y+4};service.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(outside.x,outside.y,current.character.id);
  await command('move',{direction:'north'});assert.equal(current.zone,zone,'walking onto town doorstep enters the shop');
  service.db.prepare('UPDATE quest_presence SET x=8,y=8 WHERE character_id=?').run(current.character.id);
  await command('move',{direction:'north'});assert.equal(current.zone,'utopia-arcanum-place-bakery-upstairs');
  await command('hub_visit',{zone,returning:true});assert.deepEqual(current.position,{x:8,y:8},'upstairs return selects its paired stair arrival');
  service.db.prepare('UPDATE quest_presence SET x=8,y=3 WHERE character_id=?').run(current.character.id);
  await command('move',{direction:'north'});assert.equal(current.zone,'utopia-arcanum-place-bakery-upstairs');assert.deepEqual(current.position,{x:8,y:3});
  await command('hub_visit',{zone,connection:'bakery:second-stair'});assert.deepEqual(current.position,{x:8,y:3},'second doorway returns through its own pair');
  await command('hub_visit',{zone:'utopia-arcanum-place-bakery-upstairs',connection:'bakery:second-stair'});
  await command('hub_visit',{zone,returning:true});assert.deepEqual(current.position,{x:8,y:8},'Return prioritizes the default exit even beside another stair to the same room');
  await command('hub_visit',{zone:'utopia-arcanum',returning:true});assert.deepEqual(current.position,outside,'shop return selects the town doorway');
  const before=await http('/gm/map?zone=utopia-arcanum&paint=1');
  await http('/gm/action',{request_id:randomUUID(),action:'world_patch_apply',zone:'utopia-arcanum',edition:before.edition,revision:before.revision,patch_revision:before.patch.revision,ops:[{kind:'cells',cells:[{...outside,floor:7}]}]},staff,409); // A live stroke must not disappear beneath the reserved approach overlay.
  await gm({action:'world_hub_regenerate',zone:'utopia-arcanum',edition:before.edition,revision:before.revision,confirm_reset:true});
  const after=await http('/gm/map?zone=utopia-arcanum&paint=1');
  assert.ok(after.floor.portals.some(p=>p.connection==='bakery:entrance'),'regeneration preserves the entrance');
  if(after.district.pending){assert.equal(after.edition,before.edition);assert.ok(after.district.conflict,'a retained edition explains its conflict');}
  const bundle=await http('/gm/place-bundle?id=bakery');assert.equal(bundle.version,1);assert.equal(bundle.entry.rooms[0].id,'shop');
  await gm({action:'world_place_save',id:'imported',revision:0,entry:bundle.entry});assert.equal((await http('/gm/places?id=imported')).places[0].published,null);
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
  await command('hub_visit',{zone:'utopia-arcanum',returning:true});assert.equal(current.zone,'utopia-arcanum','custom interiors retain the existing Return behavior');
  await command('gm_warp_zone',{zone});const character=current.character.id,position=current.position;
  await close();await open();
  assert.equal(service.db.prepare('SELECT zone FROM quest_presence WHERE character_id=?').get(character).zone,zone,'startup recovery recognizes persisted custom rooms');
  await command('enter',{zone,combat_version:3});assert.equal(current.zone,zone);assert.deepEqual(current.position,position);
  assert.equal(current.zones.find(r=>r.id===zone).walls[5][5],1,'existing map patches survive restart on custom rooms');
  assert.equal((await http('/gm/places?id=bakery')).places[0].published.rooms[0].id,zone);
  const world=service.zones.world,clock=world.life.clock();
  world.act({action:'world_clock_set',revision:clock.revision,dayMinutes:60,minute:480,paused:true});
  await gm({action:'world_routine_save',zone,placement:'town-bakery-resident',revision:0,routine:{version:1,name:'Upstairs shift',enabled:true,entries:[{id:'work',name:'Work',clock:'game',from:0,to:1439,priority:0,days:[0,1,2,3,4,5,6],blocks:[{kind:'travel',destination:{zone:'utopia-arcanum-place-bakery-upstairs',anchor:'place:bakery:desk',dx:0,dy:0}},{kind:'stay'}]}]}});
  for(let i=0;i<40;i++){at+=1000;service.zones.tickRoutines();}
  assert.equal(world.routines.get('town-bakery-resident').state.zone,'utopia-arcanum-place-bakery-upstairs','resident routine traverses the paired stairs');
  assert.equal(world.map(zone).placements.filter(p=>p.id==='town-bakery-resident').length,0,'no duplicate NPC remains at home');
  assert.equal(world.map('utopia-arcanum-place-bakery-upstairs').placements.filter(p=>p.id==='town-bakery-resident').length,1);
  const traveller=world.routines.get('town-bakery-resident').state;
  service.db.prepare('UPDATE world_npc_routines SET state=? WHERE id=?').run(JSON.stringify({...traveller,x:5,y:4}),'town-bakery-resident'); // Put the resident between named anchors so only its actual position protects this tile.
  const upstairs=await http('/gm/map?zone=utopia-arcanum-place-bakery-upstairs&paint=1');
  await http('/gm/action',{request_id:randomUUID(),action:'world_patch_apply',zone:upstairs.id,edition:upstairs.edition,revision:upstairs.revision,patch_revision:upstairs.patch.revision,ops:[{kind:'cells',cells:[{x:5,y:4,wall:1}]}]},staff,409);
  assert.equal((await http('/gm/map?zone='+upstairs.id+'&paint=1')).floor.walls[4][5],0,'a refused occupied edit rolls the live patch back');

 }finally{
  await close();
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('town-place-service-'));
  rmSync(directory,{recursive:true,force:true}); // Remove only this verified disposable test directory.
 }
});
