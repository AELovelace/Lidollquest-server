import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as pause} from 'node:timers/promises';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestService} from '../server/service.mjs';
import {combatData} from '../server/combat.mjs';
import {hubData} from '../server/hubs.mjs';
import {walkable} from '../server/dive-generation.mjs';
import {diveData} from '../server/dive.mjs';

const monster={id:'patch_monster',enemy_id:'patch_monster',name:'Patch monster',hp:20,str:1,def:0,dex:1,exp:12,spell_cast_chance:0,enemy_spells:[],sprite:'sprItem',battle_sprite:'',roaming:false};
function fixture(){ // The live world with content, like world-controls.test.mjs.
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-05T12:00:00Z'),owner='alice';
 const live=createWorldContent(db,{now:()=>time,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment});
 const options={now:()=>time,roll:()=>0,live,grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}};let zones=createQuestZones(db,options);zones.tick();
 const loadout={player_info:{class_id:'fighter',playerHealth:500,playerHealthMax:500,str:100,def:8,dex:8,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const read=id=>zones.read('',id);
 const act=(id,action,extra={})=>{time+=350;const s=id?read(id):null;return zones.act('',{action,request_id:randomUUID(),controller:'window',character_id:id,revision:s?.character.revision,...(s?.character.dive?{edition:s.dive.edition}:{}),...extra});};
 function player(name='alice',dive=true){owner=name;const c=act(null,'create',{name}).character;act(c.id,'enter',{zone:'princess-rose',loadout,combat_version:3,content_version:1,defeat_version:1});if(dive)act(c.id,'dive_enter',{loadout});return c.id;}
 function state(id,change){const row=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(id),s=JSON.parse(row.state);change(s);db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),id);}
 function position(id,x,y){state(id,s=>{if(s.dive){s.dive.position={x,y};s.dive.safeUntil=time+999999;}});db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(x,y,time,id);}
 const map=(zone='dive-quarters')=>zones.world.paintMap(zone); // The paint view: the map view plus patch and tile grids.
 function free(m,margin=3){for(let y=margin;y<m.floor.height-margin;y++)for(let x=margin;x<m.floor.width-margin;x++)if(walkable(m.floor,x,y)&&![m.floor.entrance,m.floor.spawn,...Object.values(m.floor.entries??{}),...(m.floor.exits??[]),...(m.floor.portals??[]),...(m.floor.enemies??[]),...(m.floor.chests??[]),...(m.floor.pickups??[]),...(m.floor.fixtures??[]),...m.players,...(m.placements??[])].some(p=>p&&Math.abs(p.x-x)+Math.abs(p.y-y)<3))return {x,y};throw Error('No test placement');}
 const world=(action,zone='dive-quarters',extra={})=>{const m=map(zone);return zones.world.act({action,zone,edition:m.edition,revision:m.revision,patch_revision:m.patch?.revision??zones.world.paintMap(zone).patch?.revision??0,...extra});};
 const patch=(zone,ops,extra={})=>world('world_patch_apply',zone,{ops,...extra});
 function publish(kind,entry){let revision=0;try{revision=live.entry(kind,entry.id).revision;}catch{}return live.change({action:'content_publish',kind,id:entry.id,revision,entry},'dm');}
 return {db,live,zones:()=>zones,read,act,player,state,position,map,free,world,patch,publish,advance:ms=>time+=ms,tick:()=>{time+=1001;zones.tick();},restart(){zones.close();zones=createQuestZones(db,options);zones.tick();},close(){zones.close();db.close();}};
}
const wallOp=(x,y,wall=1)=>({kind:'cells',cells:[{x,y,wall}]});

test('a cells op walls a Dive tile in place, stamps the revision, bumps geometryVersion and is idempotent on later ticks',()=>{
 const f=fixture();try{
  const before=f.map(),spot=f.free(before),version=before.floor.geometryVersion??0;
  const result=f.patch('dive-quarters',[wallOp(spot.x,spot.y)]);assert.equal(result.patch.revision,1);assert.equal(result.patch.ops.length,1);assert.equal(result.floor.walls[spot.y][spot.x],1);
  const after=f.map();assert.equal(after.floor.walls[spot.y][spot.x],1);assert.equal(after.floor.patchRevision,1);assert.equal(after.floor.geometryVersion,version+1);assert.notEqual(after.revision,before.revision);
  assert.equal(f.zones().world.paintMap('dive-quarters').patch.revision,1);
  const updated=f.db.prepare('SELECT updated FROM dive_editions WHERE edition=?').get(after.edition).updated;f.tick();f.tick();assert.equal(f.db.prepare('SELECT updated FROM dive_editions WHERE edition=?').get(after.edition).updated,updated,'an unchanged revision never rewrites the floor');
  assert.equal(f.map().floor.geometryVersion,version+1);
  assert.throws(()=>f.patch('dive-quarters',[wallOp(spot.x,spot.y+1)],{patch_revision:0}),/patch layer changed/);
 }finally{f.close();}
});

test('ops that would strand anything are refused with the offending change named',()=>{
 const f=fixture();try{
  const m=f.map(),e=m.floor.entrance,chest=m.floor.chests[0];
  assert.throws(()=>f.patch('dive-quarters',[wallOp(0,5,0)]),/outer wall/);
  assert.throws(()=>f.patch('dive-quarters',[wallOp(e.x,e.y)]),/arrival tile/);
  assert.throws(()=>f.patch('dive-quarters',[wallOp(chest.x,chest.y)]),/chest/);
  const ring=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>({x:chest.x+dx,y:chest.y+dy,wall:1})).filter(c=>c.x>0&&c.y>0&&c.x<m.floor.width-1&&c.y<m.floor.height-1);
  assert.throws(()=>f.patch('dive-quarters',[{kind:'cells',cells:ring}]),/cut off/);
  assert.throws(()=>f.patch('dive-quarters',[{kind:'cells',cells:[{x:-1,y:2,wall:1}]}]),/outside the map/);
  assert.throws(()=>f.patch('dive-quarters',[{kind:'safeRoom',op:'add',rect:{x:1,y:1,w:0,h:2}}]),/rectangle/);
  assert.throws(()=>f.patch('dive-quarters',[{kind:'decoration',op:'add',decoration:{sprite:'bad sprite',x:3,y:3}}]),/sprite/);
  assert.throws(()=>f.patch('dive-quarters',[{kind:'nonsense'}]),/Unknown change kind/);
  assert.throws(()=>f.patch('dungeon-castle-dungeon',[wallOp(5,5)]),/Full dungeons/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM world_floor_patches').get().n,0,'nothing was stored by the refused edits');
 }finally{f.close();}
});

test('scenery, safe rooms and arrival points patch Dive floors and revert cleanly through remove, rollback and clear',()=>{
 const f=fixture();try{
  const m=f.map(),spot=f.free(m),entrance=m.floor.entrance;
  let r=f.patch('dive-quarters',[{kind:'decoration',op:'add',decoration:{sprite:'sprPQDetailPottedRose',x:spot.x,y:spot.y,span_w:2,span_h:1,solid:true}},{kind:'safeRoom',op:'add',rect:{x:spot.x-1,y:spot.y-1,w:4,h:3}}]);
  const stamped=r.floor.decorations.find(d=>d.sprite==='sprPQDetailPottedRose'&&d.x===spot.x);assert.ok(stamped?.id.startsWith('patch-'));assert.equal(r.floor.props[spot.y][spot.x],1);assert.equal(r.floor.props[spot.y][spot.x+1],1);assert.ok(r.floor.safeRooms.some(s=>s.x===spot.x-1&&s.w===4));
  const walk=f.free(f.map());r=f.patch('dive-quarters',[{kind:'spawn',entrance:{x:walk.x,y:walk.y}}]);assert.deepEqual(r.floor.entrance,{x:walk.x,y:walk.y});assert.equal(r.patch.revision,2);
  r=f.patch('dive-quarters',[{kind:'decoration',op:'remove',match:{sprite:'sprPQDetailPottedRose',x:spot.x,y:spot.y}}]);assert.ok(!r.floor.decorations.some(d=>d.id===stamped.id));assert.equal(r.floor.props[spot.y][spot.x],0,'removing solid scenery frees its footprint');assert.equal(r.patch.revision,3);
  const removeOp=r.patch.ops.find(op=>op.kind==='spawn');r=f.world('world_patch_remove','dive-quarters',{op:removeOp.id});assert.deepEqual(r.floor.entrance,entrance,'dropping the stored spawn change restores the generated arrival');assert.equal(r.patch.revision,4);
  r=f.world('world_patch_rollback','dive-quarters',{target_revision:1});assert.equal(r.patch.revision,5);assert.equal(r.floor.props[spot.y][spot.x],1,'rolling back re-stamps the scenery');assert.deepEqual(r.floor.entrance,entrance);
  r=f.world('world_patch_clear','dive-quarters');assert.equal(r.patch.revision,6);assert.equal(r.patch.ops.length,0);assert.equal(r.floor.props[spot.y][spot.x],0);assert.ok(!r.floor.safeRooms.some(s=>s.x===spot.x-1&&s.w===4));assert.equal(r.floor.patchRevision,6);assert.equal(r.floor.patchUndo.cells.length,0);
  assert.equal(r.patch.history.length,6);assert.throws(()=>f.world('world_patch_rollback','dive-quarters',{target_revision:99}),/does not exist/);
 }finally{f.close();}
});

test('the patch survives GM regeneration and the weekly reset, and placements re-realize on the new geometry',async()=>{
 const f=fixture();try{
  f.publish('npc',{id:'patch_npc',name:'Patch NPC',dialogue:[{id:'hello',text:'Hi.',next:'close',actions:[]}]});
  const m=f.map(),spot=f.free(m);f.world('world_place_content',undefined,{placement_kind:'npc',content:'patch_npc',x:spot.x,y:spot.y,lifetime:'persistent'});
  const placed=f.map().placements.find(p=>p.content==='patch_npc');assert.deepEqual([placed.x,placed.y],[spot.x,spot.y]);
  const r=f.patch('dive-quarters',[wallOp(spot.x,spot.y)]);assert.equal(r.floor.walls[spot.y][spot.x],1);
  const moved=f.map().placements.find(p=>p.content==='patch_npc');assert.equal(moved.id,placed.id);assert.ok(moved.x!==spot.x||moved.y!==spot.y,'the NPC stepped off the new wall');
  const before=f.map().edition;f.world('world_regenerate',undefined,{confirm_reset_rewards:true});f.tick();await pause();f.tick();
  const regenerated=f.map();assert.notEqual(regenerated.edition,before);assert.equal(regenerated.floor.patchRevision,1,'the new edition carries the patch');
  const op=regenerated.patch.ops[0];assert.ok(regenerated.floor.walls[spot.y][spot.x]===1||regenerated.patch.skipped.some(s=>s.id===op.id),'applied, or skipped with a reason when the new layout forbids it');
  assert.ok(regenerated.placements.some(p=>p.id===placed.id),'persistent placements survive and re-realize');
  f.advance(7*86400000);f.tick();await pause();f.tick();const weekly=f.map();assert.notEqual(weekly.edition,regenerated.edition);assert.equal(weekly.floor.patchRevision,1);
 }finally{f.close();}
});

test('visitors and DM monsters standing on a newly walled tile are moved; fights block the edit',()=>{
 const f=fixture();try{
  f.publish('monster',monster);
  const id=f.player('alice'),m=f.map(),here=f.free(m);f.position(id,here.x,here.y);
  const r=f.patch('dive-quarters',[wallOp(here.x,here.y)]);assert.equal(r.floor.walls[here.y][here.x],1);
  const s=f.read(id);assert.ok(s.position.x!==here.x||s.position.y!==here.y,'the visitor stepped aside');assert.ok(walkable(f.map().floor,s.position.x,s.position.y));
  const foeSpot=f.free(f.map());f.world('world_place',undefined,{monster:monster.id,x:foeSpot.x,y:foeSpot.y});const foe=f.map().floor.enemies.find(e=>e.manual);assert.deepEqual([foe.x,foe.y],[foeSpot.x,foeSpot.y]);
  f.patch('dive-quarters',[wallOp(foeSpot.x,foeSpot.y)]);const movedFoe=f.map().floor.enemies.find(e=>e.id===foe.id);assert.ok(movedFoe&&(movedFoe.x!==foeSpot.x||movedFoe.y!==foeSpot.y),'the monster stepped aside and kept its id');assert.deepEqual(movedFoe.spawn,{x:movedFoe.x,y:movedFoe.y});
  const busy=f.free(f.map());f.position(id,busy.x,busy.y);f.state(id,s=>{s.run={kind:'dive',enemy:{hp:5}};});
  assert.throws(()=>f.patch('dive-quarters',[wallOp(busy.x,busy.y)]),/mid-battle/);assert.equal(f.map().floor.walls[busy.y][busy.x],0);assert.equal(f.db.prepare('SELECT revision FROM world_floor_patches WHERE zone=?').get('dive-quarters').revision,2,'the refused edit rolled back');
  f.state(id,s=>{delete s.run;});
  const route=diveData.config.route,row=f.db.prepare('SELECT content,edition FROM dive_editions WHERE route=? ORDER BY updated DESC LIMIT 1').get(route);const floor=JSON.parse(row.content);const target=floor.enemies.find(e=>e.id===foe.id);target.engaged='someone';f.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=? AND depth=1').run(JSON.stringify(floor),route,row.edition);
  assert.throws(()=>f.patch('dive-quarters',[wallOp(target.x,target.y)]),/Finish the fight/);
 }finally{f.close();}
});

test('monthly hub districts and frozen authored rooms take patches, keep them across restarts and rerolls, and reach the player snapshot',()=>{
 const f=fixture();try{
  const town=f.map('honeydew-lantern'),spot=f.free(town,4);
  const r=f.patch('honeydew-lantern',[{kind:'cells',cells:[{x:spot.x,y:spot.y,wall:1}]}]);assert.equal(r.floor.walls[spot.y][spot.x],1);assert.equal(r.patch.revision,1);
  const stored=JSON.parse(f.db.prepare('SELECT e.content FROM hub_district_editions e JOIN hub_district_current c ON c.zone=e.zone AND c.edition=e.edition WHERE e.zone=?').get('honeydew-lantern').content);assert.equal(stored.walls[spot.y][spot.x],1);assert.equal(stored.wallTiles[spot.y][spot.x],10,'a new wall in a tiled town gets the plain wall tile');assert.equal(stored.patchRevision,1);
  f.restart();assert.equal(f.map('honeydew-lantern').floor.walls[spot.y][spot.x],1,'the persisted month keeps the edit after a restart');
  f.world('world_hub_regenerate','honeydew-lantern',{confirm_reset:true});const rerolled=f.zones().world.paintMap('honeydew-lantern');assert.equal(rerolled.floor.patchRevision,1,'a rerolled month carries the patch');assert.ok(rerolled.floor.walls[spot.y][spot.x]===1||rerolled.patch.skipped.length);
  const inn=f.map('honeydew-lantern-beds'),tile=f.free(inn,2);
  const edited=f.patch('honeydew-lantern-beds',[{kind:'cells',cells:[{x:tile.x,y:tile.y,wall:1}]},{kind:'decoration',op:'add',decoration:{sprite:'sprTownEnvBench',x:tile.x+1,y:tile.y,solid:false}}]);
  assert.equal(edited.floor.walls[tile.y][tile.x],1);assert.ok(edited.floor.fixtures.some(x=>x.kind==='scenery'&&x.sprite==='sprTownEnvBench'&&x.id.startsWith('patch-')));
  assert.equal(f.map('honeydew-lantern-beds').floor.walls[tile.y][tile.x],1);f.restart();assert.equal(f.map('honeydew-lantern-beds').floor.walls[tile.y][tile.x],1,'authored rooms re-apply from the table on boot');
  const bed=f.map('honeydew-lantern-beds').floor.fixtures.find(x=>x.kind==='bed');assert.throws(()=>f.patch('honeydew-lantern-beds',[{kind:'cells',cells:[{x:bed.x,y:bed.y,wall:1}]}]),/bed/);
  assert.throws(()=>f.patch('honeydew-lantern-beds',[{kind:'safeRoom',op:'add',rect:{x:2,y:2,w:2,h:2}}]),/Dive and overworld/);
  const id=f.player('bob',false);const snapshot=f.read(id);const room=snapshot.zones.find(z=>z.id==='honeydew-lantern-beds');assert.ok(room,'the snapshot lists the inn');
  const stub=snapshot.zones.find(z=>z.id==='honeydew-lantern-beds');if(stub.walls?.length)assert.equal(stub.walls[tile.y][tile.x],1);
  f.world('world_patch_clear','honeydew-lantern-beds');assert.equal(f.map('honeydew-lantern-beds').floor.walls[tile.y][tile.x],0,'clearing an authored room restores the frozen layout at once');
 }finally{f.close();}
});

test('patch actions over HTTP are audited, replayed by request id, and visible to read-only snapshot workers',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'lidoll-floor-patches-')),staff='s'.repeat(43),playerToken='p'.repeat(43),logs=[];
 const service=createQuestService({zoneWorkers:2,workerCount:1,filename:join(directory,'quest.sqlite'),log:(...parts)=>logs.push(parts),walletClient:{authenticate:async token=>({owner:token===staff?'staff':'player-owner',id:'g',client:'lidollquest',coins:0,scope:'saves:read saves:write social:read',gamemaster:token===staff,blockedAccounts:[]})}});
 await service.prepare();await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
 const gm=(body,token=staff)=>fetch(base+'/gm/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  const play=async input=>{const r=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+playerToken,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),controller:'window',...input})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
  const c=(await play({action:'create',name:'Worker tester'})).character;await play({action:'enter',character_id:c.id,revision:c.revision,zone:'honeydew-lantern'});
  const identity={owner:'player-owner',client:'lidollquest',gamemaster:false,supporterUntil:null,blockedAccounts:[]},render=async()=>JSON.parse(new TextDecoder().decode(await service.shards.render('honeydew-lantern',{at:Date.now(),identity,character:c.id,view:{companion:false},badges:service.zones.snapshotBadges(),receipt:null,capabilities:{},known:null})));
  const first=await render();const inn=first.zones.find(z=>z.id==='honeydew-lantern-beds');assert.ok(inn.walls.length,'old clients get every room with walls');
  const view=service.zones.world.paintMap('honeydew-lantern-beds');let spot=null;for(let y=2;y<view.floor.height-2&&!spot;y++)for(let x=2;x<view.floor.width-2;x++)if(walkable(view.floor,x,y)&&!inn.walls[y][x]&&![view.floor.spawn,...view.floor.fixtures,...(view.floor.portals??[]),view.floor.exit].some(p=>p&&Math.abs(p.x-x)+Math.abs(p.y-y)<3)){spot={x,y};break;}
  const body={action:'world_patch_apply',zone:'honeydew-lantern-beds',edition:view.edition,revision:view.revision,patch_revision:0,ops:[{kind:'cells',cells:[{x:spot.x,y:spot.y,wall:1}]}],request_id:randomUUID()};
  assert.equal((await gm(body,playerToken)).status,403);
  const a=await gm(body),b=await gm(body),aj=await a.json();assert.equal(a.status,200,JSON.stringify(aj));assert.deepEqual(aj,await b.json(),'a replayed request id returns the same result');
  assert.equal(service.db.prepare("SELECT COUNT(*) n FROM gm_audit WHERE action='world_patch_apply'").get().n,1);assert.equal(service.db.prepare('SELECT revision FROM world_floor_patches WHERE zone=?').get('honeydew-lantern-beds').revision,1);
  const second=await render();assert.equal(second.zones.find(z=>z.id==='honeydew-lantern-beds').walls[spot.y][spot.x],1,'the worker saw the patch epoch change and rebuilt the room');
  assert.ok(!logs.some(parts=>parts[0]==='zone_request_failed'),JSON.stringify(logs));
  const png=await fetch(base+'/gm/map.png?zone=honeydew-lantern-beds&scale=8',{headers:{Authorization:'Bearer '+staff}});assert.equal(png.status,200);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));rmSync(directory,{recursive:true,force:true,maxRetries:20,retryDelay:250});} // Worker threads release the SQLite file a moment after close; retry instead of failing on Windows EPERM.
});

test('biome layers and exits patch overworld floors: cover, wash, shoreline, mist and crater, and gates slide along their wall',()=>{
 const f=fixture();try{
  const plains='overworld-autumnal-plains',p=f.map(plains),spot=f.free(p);
  let r=f.patch(plains,[{kind:'layer',layer:'cover',cells:[{x:spot.x,y:spot.y,v:'1'},{x:spot.x+1,y:spot.y,v:'2'}]}]);assert.equal(r.floor.cover[spot.y].charAt(spot.x),'1');assert.equal(r.floor.cover[spot.y].charAt(spot.x+1),'2');assert.equal(r.floor.cover[spot.y].length,p.floor.width);
  assert.throws(()=>f.patch('dive-quarters',[{kind:'layer',layer:'cover',cells:[{x:3,y:3,v:'1'}]}]),/Cover only/);
  assert.throws(()=>f.patch(plains,[{kind:'layer',layer:'cover',cells:[{x:spot.x,y:spot.y,v:'7'}]}]),/Bad cover value/);
  if(r.floor.mist?.rows){const before=r.floor.mist.tiles;r=f.patch(plains,[{kind:'layer',layer:'mist',cells:[{x:spot.x,y:spot.y+1,v:'1'}]}]);assert.equal(r.floor.mist.rows[spot.y+1].charAt(spot.x),'1');assert.equal(r.floor.mist.tiles,r.floor.mist.rows.reduce((n,row)=>n+(row.match(/1/g)??[]).length,0));assert.ok(r.floor.mist.tiles>=before);}
  const gate=r.floor.exits.find(e=>e.style==='gap'&&(e.side==='left'||e.side==='right')),vertical=true,oldEntry={...r.floor.entries[gate.zone]},to={x:gate.x,y:gate.y+3<r.floor.height-3?gate.y+3:gate.y-3};
  r=f.patch(plains,[{kind:'exit',op:'move',zone:gate.zone,to}]);const moved=r.floor.exits.find(e=>e.zone===gate.zone);assert.deepEqual([moved.x,moved.y],[to.x,to.y]);assert.equal(r.floor.walls[to.y][to.x],0);assert.equal(r.floor.walls[gate.y][gate.x],1,'the old opening closed');assert.notDeepEqual(r.floor.entries[gate.zone],oldEntry);assert.ok(r.floor.safeRooms.some(s=>s.x===to.x&&s.y===to.y));
  assert.throws(()=>f.patch(plains,[{kind:'exit',op:'move',zone:gate.zone,to:{x:to.x+5,y:to.y}}]),/slide along its own wall/);
  const pad=r.floor.exits.find(e=>e.style==='warp');if(pad){const target=f.free(f.map(plains));r=f.patch(plains,[{kind:'exit',op:'move',zone:pad.zone,to:target}]);const movedPad=r.floor.exits.find(e=>e.zone===pad.zone);assert.deepEqual([movedPad.x,movedPad.y],[target.x,target.y]);const e=r.floor.entries[pad.zone];assert.equal(Math.abs(e.x-target.x)+Math.abs(e.y-target.y),1,'arrivals stand beside the pad');}
  r=f.world('world_patch_clear',plains);assert.equal(r.floor.cover[spot.y].charAt(spot.x),p.floor.cover[spot.y].charAt(spot.x));const back=r.floor.exits.find(e=>e.zone===gate.zone);assert.deepEqual([back.x,back.y],[gate.x,gate.y]);assert.equal(r.floor.walls[gate.y][gate.x],0);assert.equal(r.floor.walls[to.y][to.x],1);assert.deepEqual(r.floor.entries[gate.zone],oldEntry);
  const gulch='overworld-echo-gulch',g=f.map(gulch),gs=f.free(g);r=f.patch(gulch,[{kind:'layer',layer:'wash',cells:[{x:gs.x,y:gs.y,v:'1'}]}]);assert.equal(r.floor.wash[gs.y].charAt(gs.x),'1');assert.throws(()=>f.patch(plains,[{kind:'layer',layer:'wash',cells:[{x:spot.x,y:spot.y,v:'1'}]}]),/Echo Gulch/);
  const coast='overworld-seafoam-coast',c=f.map(coast),row=10;r=f.patch(coast,[{kind:'layer',layer:'shore',rows:[{y:row,edge:40}]}]);assert.equal(r.floor.shore[row],40);assert.throws(()=>f.patch(coast,[{kind:'layer',layer:'shore',rows:[{y:row,edge:0}]}]),/inside the map/);r=f.world('world_patch_clear',coast);assert.equal(r.floor.shore[row],c.floor.shore[row]);
  const caldera='overworld-emberfall-caldera',k=f.map(caldera),crater=k.floor.crater;r=f.patch(caldera,[{kind:'layer',layer:'crater',crater:{x:crater.x+2,y:crater.y,r:crater.r}}]);assert.equal(r.floor.crater.x,crater.x+2);assert.equal(r.floor.heat.x,crater.x+2);assert.throws(()=>f.patch(caldera,[{kind:'layer',layer:'crater',crater:{x:1,y:1,r:5}}]),/fit inside/);r=f.world('world_patch_clear',caldera);assert.deepEqual(r.floor.crater,crater);
  assert.throws(()=>f.patch('honeydew-lantern-beds',[{kind:'exit',op:'move',zone:'honeydew-lantern',to:{x:3,y:3}}]),/code-defined/);
 }finally{f.close();}
});

test('a GM can add a new gate or pad to a legal neighbour, arrivals follow, and clearing the patch removes the crossing',()=>{
 const f=fixture();try{
  const plains='overworld-autumnal-plains',p=f.map(plains);assert.ok(p.crossings.some(t=>t.id==='overworld-emberfall-caldera'),'linked routes are offered');assert.ok(p.crossings.some(t=>t.id==='honeydew-lantern'),'hubs are offered');assert.ok(!p.crossings.some(t=>t.id==='dive-quarters'),'unlinked dives are not');
  const beforeCount=p.floor.exits.length,along=Math.floor(p.floor.height/2)+7;
  let r=f.patch(plains,[{kind:'exit',op:'add',zone:'overworld-emberfall-caldera',name:'Second lava road',style:'gap',side:'left',to:{x:0,y:along}}]);
  const gate=r.floor.exits.find(e=>e.name==='Second lava road');assert.ok(gate?.id.startsWith('patch-'));assert.deepEqual([gate.x,gate.y,gate.w,gate.h,gate.side],[0,along,1,2,'left']);assert.equal(r.floor.walls[along][0],0);assert.equal(r.floor.walls[along+1][0],0);assert.equal(r.floor.exits.length,beforeCount+1);
  assert.ok(r.floor.entries['overworld-emberfall-caldera'],'the neighbour keeps or gains an arrival tile');assert.ok(r.floor.safeRooms.some(s=>s.x===0&&s.y===along));
  assert.throws(()=>f.patch(plains,[{kind:'exit',op:'add',zone:'dive-quarters',style:'gap',side:'top',to:{x:20,y:0}}]),/cannot open onto/);
  assert.throws(()=>f.patch(plains,[{kind:'exit',op:'add',zone:'honeydew-lantern',style:'gap',side:'left',to:{x:0,y:along}}]),/already opens there/);
  const spot=f.free(f.map(plains));r=f.patch(plains,[{kind:'exit',op:'add',zone:'honeydew-lantern',name:'Village pad',style:'warp',to:spot}]);const pad=r.floor.exits.find(e=>e.name==='Village pad');assert.deepEqual([pad.x,pad.y,pad.style],[spot.x,spot.y,'warp']);
  r=f.patch(plains,[{kind:'exit',op:'move',exit:gate.id,zone:gate.zone,to:{x:0,y:along+4}}]);const slid=r.floor.exits.find(e=>e.id===gate.id);assert.equal(slid.y,along+4);assert.equal(r.floor.walls[along][0],1,'the first opening closed again');
  r=f.world('world_patch_clear',plains);assert.equal(r.floor.exits.length,beforeCount);assert.ok(!r.floor.exits.some(e=>e.id===gate.id||e.id===pad.id));assert.equal(r.floor.walls[along][0],1);assert.equal(r.floor.walls[along+4][0],1);
  assert.deepEqual(Object.keys(r.floor.entries).sort(),Object.keys(p.floor.entries).sort(),'arrivals the patch created are gone');
 }finally{f.close();}
});

test('hub furniture and services move through fixture ops after decoration: vanity, cauldron and crafting stations keep their ids',()=>{
 const f=fixture();try{
  const gm=(zone,ops)=>{f.db.exec('BEGIN IMMEDIATE');try{const r=f.patch(zone,ops);f.db.exec('COMMIT');return r;}catch(e){f.db.exec('ROLLBACK');throw e;}}; // gm.mjs wraps every GM action like this, so a refused move leaves nothing stored.
  const hubs=f.zones().world.catalog().filter(z=>z.kind==='hub').map(z=>z.id),find=kind=>hubs.find(id=>f.map(id).floor?.fixtures?.some(x=>x.kind===kind));
  const tryMove=(zone,kind)=>{ // Nearest tile (by distance from where it stands) that the server accepts.
   const m=f.map(zone),it=m.floor.fixtures.find(x=>x.kind===kind),tiles=[];for(let y=1;y<m.floor.height-1;y++)for(let x=1;x<m.floor.width-1;x++)if(x!==it.x||y!==it.y)tiles.push({x,y});
   tiles.sort((a,b)=>Math.abs(a.x-it.x)+Math.abs(a.y-it.y)-Math.abs(b.x-it.x)-Math.abs(b.y-it.y));
   for(const to of tiles.slice(0,60)){try{gm(zone,[{id:'move-'+kind+'-'+to.x+'-'+to.y,kind:'fixture',op:'move',match:{id:it.id,kind},to}]);return {it,to};}catch(e){if(!/cut off|reach|doorway|outer wall|open floor/.test(e.message))throw e;}}
   throw Error('No tile accepted the '+kind);
  };
  const inn=find('mirror');assert.ok(inn,'some bedroom hub has a vanity mirror');
  const before=f.map(inn).patch.revision,{it:mirror,to}=tryMove(inn,'mirror');
  const moved=f.map(inn).floor.fixtures.find(x=>x.id===mirror.id);assert.deepEqual([moved.x,moved.y],[to.x,to.y],'the vanity (added by hubMirrors after the patch layer) moved');assert.equal(f.map(inn).floor.fixtures.filter(x=>x.kind==='mirror').length,1,'no second vanity appears');
  assert.equal(f.map(inn).patch.revision,before+1);
  assert.throws(()=>gm(inn,[{kind:'fixture',op:'move',match:{id:mirror.id,kind:'mirror'},to:{x:0,y:0}}]),/outer wall/,'walls are refused');assert.equal(f.map(inn).patch.revision,before+1,'a refused move stores nothing');
  const opId=f.map(inn).patch.ops.find(op=>op.kind==='fixture').id;f.db.exec('BEGIN IMMEDIATE');f.world('world_patch_remove',inn,{op:opId});f.db.exec('COMMIT');
  const home=f.map(inn).floor.fixtures.find(x=>x.id===mirror.id);assert.deepEqual([home.x,home.y],[mirror.x,mirror.y],'removing the stored move puts the vanity back');
  const yard=find('cauldron');if(yard){const forge=f.map(yard).floor.fixtures.find(x=>x.kind==='forge'),{it:pot,to:spot}=tryMove(yard,'cauldron'),after=f.map(yard).floor.fixtures;
   assert.deepEqual([after.find(x=>x.id===pot.id).x,after.find(x=>x.id===pot.id).y],[spot.x,spot.y],'the cauldron moved');if(forge)assert.deepEqual([after.find(x=>x.id===forge.id).x,after.find(x=>x.id===forge.id).y],[forge.x,forge.y],'its crafting stations stay put');}
  assert.throws(()=>gm(inn,[{kind:'fixture',op:'move',match:{id:'objNPCMerchant',kind:'shop'},to:{x:3,y:3}}]),/furniture or a service/,'shops are not movable');
  assert.throws(()=>gm('dive-quarters',[{kind:'fixture',op:'move',match:{id:'cauldron',kind:'cauldron'},to:{x:3,y:3}}]),/hub furniture/,'Dives refuse fixture moves');
 }finally{f.close();}
});

test('a GM-removed district toilet stays removed, later Applies still work, and a floor already holding a re-added duplicate recovers',()=>{
 const f=fixture();try{
  const gm=(zone,ops)=>{f.db.exec('BEGIN IMMEDIATE');try{const r=f.patch(zone,ops);f.db.exec('COMMIT');return r;}catch(e){f.db.exec('ROLLBACK');throw e;}}; // As gm.mjs runs every GM action.
  const hubs=f.zones().world.catalog().filter(z=>z.kind==='hub').map(z=>z.id),zone=hubs.find(id=>f.map(id).floor?.fixtures?.some(x=>x.id==='dormitory-toilet'));assert.ok(zone,'a district has the dormitory toilet');
  const toilet=f.map(zone).floor.fixtures.find(x=>x.id==='dormitory-toilet'),count=()=>f.map(zone).floor.fixtures.filter(x=>x.id==='dormitory-toilet').length;
  gm(zone,[{kind:'decoration',op:'remove',match:{id:toilet.id,sprite:toilet.sprite,x:toilet.x,y:toilet.y}}]);assert.equal(count(),0,'the GM removed it');
  f.tick();f.restart();assert.equal(count(),0,'the dormitory upgrade step no longer puts it back');
  const spot=f.free(f.map(zone),2);gm(zone,[{kind:'cells',cells:[{x:spot.x,y:spot.y,prop:1}]}]);assert.equal(count(),0,'a later Apply re-runs the stored remove without "That would cover the toilet"');
  const row=f.db.prepare('SELECT c.edition FROM hub_district_current c WHERE c.zone=?').get(zone),saved=JSON.parse(f.db.prepare('SELECT content FROM hub_district_editions WHERE zone=? AND edition=?').get(zone,row.edition).content);
  saved.fixtures.push({...toilet});f.db.prepare('UPDATE hub_district_editions SET content=? WHERE zone=? AND edition=?').run(JSON.stringify(saved),zone,row.edition);f.restart(); // The production state: an older server re-added the toilet after the GM removed it.
  const spot2=f.free(f.map(zone),2);gm(zone,[{kind:'cells',cells:[{x:spot2.x,y:spot2.y,prop:1}]}]);assert.equal(count(),0,'the duplicate is not restored twice, so the stored remove applies again');
  gm(zone,[{kind:'cells',cells:[{x:spot2.x,y:spot2.y,prop:0}]}]);f.db.exec('BEGIN IMMEDIATE');f.world('world_patch_clear',zone);f.db.exec('COMMIT');assert.equal(count(),1,'clearing the patch brings exactly one toilet back');
  const town=hubs.find(id=>f.map(id).floor?.fixtures?.some(x=>x.kind==='toilet'&&x.style==='outhouse'&&/^outhouse-/.test(x.id)));if(town){const outhouses=()=>f.map(town).floor.fixtures.filter(x=>x.kind==='toilet'&&x.style==='outhouse'),o=outhouses()[0],before=outhouses().length;
   gm(town,[{kind:'decoration',op:'remove',match:{id:o.id,sprite:o.sprite,x:o.x,y:o.y}}]);f.tick();f.restart();assert.equal(outhouses().length,before-1,'a removed lobby outhouse is not replaced elsewhere');}
 }finally{f.close();}
});

test('GMs place hub furniture from the catalog: real service fixtures that refuse walls and Dives and can be removed again',()=>{
 const f=fixture();try{
  const gm=(zone,ops)=>{f.db.exec('BEGIN IMMEDIATE');try{const r=f.patch(zone,ops);f.db.exec('COMMIT');return r;}catch(e){f.db.exec('ROLLBACK');throw e;}}; // As gm.mjs runs every GM action.
  const tryPlace=(zone,furniture)=>{const m=f.map(zone);for(let y=2;y<m.floor.height-2;y++)for(let x=2;x<m.floor.width-2;x++){try{gm(zone,[{kind:'fixture',op:'add',furniture,to:{x,y}}]);return f.map(zone).floor.fixtures.find(p=>String(p.id).startsWith('patch-')&&p.x===x&&p.y===y);}catch(e){if(!/open floor|cover|reach|cut off|outer wall/.test(e.message))throw e;}}throw Error('nowhere to place '+furniture);};
  const hubs=f.zones().world.catalog().filter(z=>z.kind==='hub').map(z=>z.id),room='honeydew-lantern-beds';
  const kitchen=tryPlace(room,'kitchen');assert.equal(kitchen.kind,'kitchen');assert.equal(kitchen.name,'Kitchen');
  const crib=tryPlace(room,'bed:objBedCrib');assert.equal(crib.kind,'bed');assert.equal(crib.bed,'objBedCrib','a descriptor bed: the client applies the crib rest rules');assert.ok(crib.sprite);
  const toilet=tryPlace(room,'toilet');assert.deepEqual([toilet.kind,toilet.style],['toilet','porcelain']);
  assert.throws(()=>gm(room,[{kind:'fixture',op:'add',furniture:'vanity',to:{x:0,y:0}}]),/open floor/,'walls are refused');
  assert.throws(()=>gm(room,[{kind:'fixture',op:'add',furniture:'throne',to:{x:3,y:3}}]),/Choose furniture/,'unknown furniture is refused');
  assert.throws(()=>gm('dive-quarters',[{kind:'fixture',op:'add',furniture:'kitchen',to:{x:3,y:3}}]),/hub furniture/,'Dives refuse furniture');
  gm(room,[{kind:'fixture',op:'remove',match:{id:kitchen.id,kind:'kitchen'}}]);assert.ok(!f.map(room).floor.fixtures.some(p=>p.id===kitchen.id),'placed furniture can be removed');
  const town=hubs.find(id=>!f.map(id).floor.fixtures.some(p=>p.kind==='cauldron')&&f.map(id).floor.fixtures.some(p=>p.kind==='bed'));
  if(town){const pot=tryPlace(town,'cauldron'),fx=f.map(town).floor.fixtures;assert.equal(pot.kind,'cauldron');assert.ok(fx.some(p=>p.kind==='forge')&&fx.some(p=>p.kind==='kitchen'),'a first cauldron brings its crafting stations');}
  const mirrorRoom=hubs.find(id=>!f.map(id).floor.fixtures.some(p=>p.kind==='mirror'));if(mirrorRoom){const v=tryPlace(mirrorRoom,'vanity');assert.deepEqual([v.kind,v.span_w,v.span_h],['mirror',2,2]);}
 }finally{f.close();}
});
