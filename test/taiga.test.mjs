import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,taigaData,tundraData,TAIGA_ZONE,TUNDRA_ZONE} from '../server/zones.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {pathTo,walkable} from '../server/dive-generation.mjs';
import {addTaigaTrail} from '../server/wilderness-links.mjs';
import {hubRooms,hubArrival} from '../server/hubs.mjs';

function fixture({upgrade=true,taiga=taigaData}={}){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),api;const ids={};
 const loadout={player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const freeze=(...args)=>{const f=generateDesert(...args);f.enemies.forEach(e=>e.roaming=false);return f;};
 function setup(link=upgrade){api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>assert.fail('No boss reward in Taiga'),diveOptions:{log:()=>{}},desertOptions:{log:()=>{}},tundraOptions:{log:()=>{},generate:freeze,...(!link?{upgradeFloor:()=>false}:{})},taigaOptions:{log:()=>{},generate:freeze,data:taiga}});}setup();
 const snap=name=>api.read(name,ids[name]);
 function command(name,action,extra={}){const s=snap(name);return {action,controller:'window',request_id:randomUUID(),character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra};}
 function act(name,action,extra={}){time+=350;return api.act(name,command(name,action,extra));}
 function player(name,hub='princess-rose'){ids[name]=api.act(name,{action:'create',name,controller:'window',request_id:randomUUID()}).character.id;return act(name,'enter',{zone:hub,combat_version:3,loadout});}
 function place(name,p){const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]),state=JSON.parse(row.state);if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids[name]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[name]);}
 const floor=name=>{const s=snap(name);return s.zones.find(z=>z.id===s.zone);};
 function cross(name){const f=floor(name),gate=f.exits.find(e=>e.zone===TAIGA_ZONE);place(name,{x:gate.x,y:gate.y+1});return act(name,'dive_exit',{zone:TAIGA_ZONE});}
 return {db,ids,loadout,snap,command,act,player,place,floor,cross,restart:setup,raw:(name,input)=>api.act(name,input),advance:ms=>{time+=ms;api.tick();}};
}

test('100 Taiga editions have one southern exit, both biomes, connected loot and complete scenery footprints',()=>{
 const cold=new Set(Object.keys(tundraData.enemies));
 for(let n=0;n<100;n++){
  const f=generateDesert(taigaData,'taiga-'+n);assert.ok(validateDesert(f));assert.deepEqual(f,generateDesert(taigaData,'taiga-'+n));
  assert.equal(f.width,80);assert.equal(f.height,80);assert.deepEqual(f.exits,[{x:40,y:78,zone:TUNDRA_ZONE,name:'Frostveil Tundra'}]);
  assert.equal(f.enemies.length,20);assert.equal(f.chests.length,10);assert.equal(f.pickups.length,30);
  assert.ok(f.enemies.some(e=>cold.has(e.type)));assert.ok(f.enemies.some(e=>!cold.has(e.type)));
  assert.ok(f.decorations.some(p=>p.sprite.startsWith('sprForest')));assert.ok(f.decorations.some(p=>p.sprite.startsWith('sprTundra')));
  const cells=new Set();for(const p of f.decorations)for(let dy=0;dy<p.span_h;dy++)for(let dx=0;dx<p.span_w;dx++){
   const x=p.x+dx,y=p.y+dy;assert.equal(f.walls[y][x],0);assert.equal(f.props[y][x],1);assert.ok(!cells.has(x+','+y));cells.add(x+','+y);
  }
  assert.equal(cells.size,f.props.flat().filter(Boolean).length);assert.ok(f.decorations.length>=30);
 }
});

test('north trail upgrades existing Tundra editions without rerolling content, locks or personal claims',()=>{
 for(let n=0;n<30;n++){
  const f=generateDesert(tundraData,'old-'+n),before=structuredClone(f);f.enemies[0].engaged='active-battle';
  assert.equal(addTaigaTrail(f,taigaData.config),true);assert.equal(addTaigaTrail(f,taigaData.config),false);
  assert.equal(f.enemies[0].engaged,'active-battle');assert.deepEqual(f.chests,before.chests);assert.deepEqual(f.pickups,before.pickups);
  assert.deepEqual(f.rooms,before.rooms);assert.deepEqual(f.exits.slice(0,2),before.exits);
  assert.deepEqual(f.entries[TAIGA_ZONE],{x:50,y:2});assert.ok(pathTo(f,f.entrance,f.exits[2]));assert.ok(validateDesert(f));
  for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)if(walkable(before,x,y))assert.ok(walkable(f,x,y));
 }
 const f=fixture({upgrade:false});try{
  f.player('alice');f.act('alice','dive_enter',{zone:TUNDRA_ZONE});const chest=f.snap('alice').dive.chests[0];f.place('alice',chest);f.act('alice','dive_claim',{chest:chest.id});
  const old=f.floor('alice');assert.equal(old.exits.length,2);f.restart(true);const upgraded=f.floor('alice');assert.equal(upgraded.exits.length,3);assert.ok(upgraded.exits.every(e=>e.style==='gap'));assert.equal(upgraded.geometryVersion,2); // Trail, then wall gaps.assert.equal(f.snap('alice').dive.claimed,1);
  f.cross('alice');assert.equal(f.snap('alice').zone,TAIGA_ZONE);
 }finally{f.db.close();}
});

test('Taiga requires the north Tundra trail; transfers, replay, reconnect and loot stay route scoped',()=>{
 const f=fixture();try{
  f.player('alice');assert.throws(()=>f.act('alice','dive_enter',{zone:TAIGA_ZONE}),/portal/);
  assert.ok(f.snap('alice').zones.every(z=>!(z.portals??[]).some(p=>p.target===TAIGA_ZONE)));
  f.act('alice','dive_enter',{zone:TUNDRA_ZONE});assert.throws(()=>f.act('alice','dive_exit',{zone:TAIGA_ZONE}),/Stand beside/);
  assert.throws(()=>f.act('alice','dive_enter',{zone:TAIGA_ZONE}),/Leave your current dungeon/);
  const tundraChest=f.snap('alice').dive.chests[0];f.place('alice',tundraChest);f.act('alice','dive_claim',{chest:tundraChest.id});
  f.place('alice',{x:50,y:1});const command=f.command('alice','move',{direction:'north',world_step:true}); /* Walk into the top-wall gap. */const first=f.raw('alice',command);f.raw('alice',command);
  assert.equal(first.zone,TAIGA_ZONE);assert.deepEqual(first.position,{x:40,y:78});assert.equal(first.character.worldTurnDue,undefined);assert.equal(first.character.dive.hubOrigin,'princess-rose');
  assert.equal(first.dive.claimed,0);const loot=first.dive.chests[0];f.place('alice',loot);f.act('alice','dive_claim',{chest:loot.id});
  f.restart();const resumed=f.act('alice','enter',{zone:TAIGA_ZONE,combat_version:3});assert.equal(resumed.dive.claimed,1);assert.equal(resumed.character.loadout.inventory.filter(i=>i.category!=='ingredient').length,2);
  const exit=f.floor('alice').exits[0];f.place('alice',{x:exit.x,y:exit.y-1});const back=f.act('alice','move',{direction:'south'});
  assert.equal(back.zone,TUNDRA_ZONE);assert.deepEqual(back.position,{x:50,y:1});assert.equal(back.dive.claimed,1);
  f.cross('alice');assert.equal(f.snap('alice').dive.claimed,1);assert.equal(f.act('alice','dive_exit').zone,TUNDRA_ZONE);assert.equal(f.act('alice','dive_exit').zone,'princess-rose');
 }finally{f.db.close();}
});

test('parties cross together; a busy member rolls back the whole transfer',()=>{
 const f=fixture();try{
  f.player('alice');f.player('bob');f.act('alice','party_invite',{member:f.ids.bob});f.act('bob','party_accept',{invitation:f.snap('bob').partyInvitations[0].id});
  f.act('alice','dive_enter',{zone:TUNDRA_ZONE});assert.equal(f.snap('bob').zone,TUNDRA_ZONE);
  const state=JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.ids.bob).state);state.worldTurnDue={id:'pending'};f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),f.ids.bob);
  assert.throws(()=>f.cross('alice'),/turn|busy|Finish/i);assert.equal(f.snap('alice').zone,TUNDRA_ZONE);
  delete state.worldTurnDue;f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),f.ids.bob);
  f.cross('alice');assert.equal(f.snap('bob').zone,TAIGA_ZONE);assert.equal(f.snap('alice').peers.length,2);
  const chest=f.snap('alice').dive.chests[0];f.place('alice',chest);f.act('alice','dive_claim',{chest:chest.id});assert.equal(f.snap('bob').dive.claimed,0);
  f.act('bob','dive_exit');assert.equal(f.snap('alice').zone,TUNDRA_ZONE);assert.equal(f.snap('bob').zone,TUNDRA_ZONE);
 }finally{f.db.close();}
});

test('disabled Taiga refuses entry; weekly rollover safely restores the originating hub and retains loot',()=>{
 const disabled=fixture({taiga:{...taigaData,config:{...taigaData.config,enabled:false}}});try{
  disabled.player('alice');disabled.act('alice','dive_enter',{zone:TUNDRA_ZONE});assert.throws(()=>disabled.cross('alice'),/unavailable/);assert.equal(disabled.snap('alice').zone,TUNDRA_ZONE);
 }finally{disabled.db.close();}
 const f=fixture();try{
  f.player('alice','honeydew-lantern');f.place('alice',{x:1,y:25});f.act('alice','move',{direction:'west',world_step:true}); // Honeydew Village's west gate walks straight onto Frostveil.
  f.cross('alice');const old=f.snap('alice').dive.edition;
  const chest=f.snap('alice').dive.chests[0];f.place('alice',chest);f.act('alice','dive_claim',{chest:chest.id});f.advance(7*86400000);
  const resumed=f.act('alice','enter',{zone:TAIGA_ZONE,combat_version:3});assert.equal(resumed.zone,'honeydew-lantern');assert.equal(resumed.character.loadout.inventory.filter(i=>i.category!=='ingredient').length,1);
  assert.deepEqual(resumed.position,{x:1,y:25}); // Back inside the village's Tundra gate.
  f.place('alice',{x:1,y:25});f.act('alice','move',{direction:'west',world_step:true});f.cross('alice');assert.notEqual(f.snap('alice').dive.edition,old);assert.equal(f.snap('alice').dive.claimed,0);
 }finally{f.db.close();}
});

test('Taiga submission and reconnect preserve the scene before recovery at its southern trailhead',()=>{
 const f=fixture();try{
  f.player('alice');f.act('alice','dive_enter',{zone:TUNDRA_ZONE});f.cross('alice');f.act('alice','enter',{zone:TAIGA_ZONE,combat_version:3,defeat_version:1});
  const foe=f.snap('alice').dive.enemies.find(e=>!tundraData.enemies[e.type]);f.place('alice',foe);const battle=f.act('alice','dive_engage',{encounter:foe.id});
  const lost=f.act('alice','submit',{battle:battle.encounter.id,cycle:battle.character.run.cycle}),pending=lost.character.pendingDefeat;
  assert.ok(pending);assert.deepEqual(pending.position,{x:40,y:78});assert.deepEqual(lost.position,{x:foe.x,y:foe.y});
  f.restart();const resumed=f.act('alice','enter',{zone:TAIGA_ZONE,combat_version:3,defeat_version:1});assert.equal(resumed.character.pendingDefeat.id,pending.id);
  f.act('alice','defeat_complete',{scene:pending.id});assert.throws(()=>f.act('alice','dive_exit'),/defeat dialogue/);
  f.advance(61000);f.act('alice','enter',{zone:TAIGA_ZONE,combat_version:3,defeat_version:1});const recovered=f.snap('alice');
  assert.equal(recovered.character.pendingDefeat,undefined);assert.equal(recovered.zone,TAIGA_ZONE);assert.deepEqual(recovered.position,{x:40,y:78});
 }finally{f.db.close();}
});

test('80x80 Taiga snapshot with a full inventory fits the gateway and mixed enemies can start shared combat',()=>{
 const f=fixture();try{
  f.loadout.inventory=Array.from({length:99},()=>({item_id:'adult_food',name:'Meal'}));f.player('alice');f.act('alice','dive_enter',{zone:TUNDRA_ZONE});f.cross('alice');
  const s=f.snap('alice');assert.ok(Buffer.byteLength(JSON.stringify(s))<262144);
  const foe=s.dive.enemies.find(e=>!tundraData.enemies[e.type]);f.place('alice',foe);const battle=f.act('alice','dive_engage',{encounter:foe.id});
  assert.ok(battle.encounter.enemies.length);assert.ok(battle.encounter.enemies.every(e=>typeof e.name==='string'));assert.equal(battle.character.run.zone,TAIGA_ZONE);
  assert.throws(()=>f.act('alice','dive_exit',{battle:battle.encounter.id,cycle:battle.character.run.cycle}),/fight|combat|action/i);
 }finally{f.db.close();}
});
