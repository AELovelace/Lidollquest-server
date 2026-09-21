import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,highDesertData,desertData,HIGH_DESERT_ZONE,DESERT_ZONE,TAIGA_ZONE,WILDERNESS_LINKS} from '../server/zones.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {pathTo,walkable} from '../server/dive-generation.mjs';
import {addNorthTrail} from '../server/wilderness-links.mjs';

function fixture({upgrade=true,highDesert=highDesertData}={}){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-21T12:00:00Z'),api;const ids={};
 const loadout={player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const freeze=(...args)=>{const f=generateDesert(...args);f.enemies.forEach(e=>e.roaming=false);return f;}; // Frozen foes keep synthetic positioning deterministic.
 function setup(link=upgrade){api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>assert.fail('No boss reward in the High Desert'),diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}},taigaOptions:{log:()=>{}},desertOptions:{log:()=>{},generate:freeze,...(!link?{upgradeFloor:()=>false}:{})},highDesertOptions:{log:()=>{},generate:freeze,data:highDesert}});}setup();
 const snap=name=>api.read(name,ids[name]);
 function command(name,action,extra={}){const s=snap(name);return {action,controller:'window',request_id:randomUUID(),character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra};}
 function act(name,action,extra={}){time+=350;return api.act(name,command(name,action,extra));}
 function player(name,hub='honeydew-lantern'){ids[name]=api.act(name,{action:'create',name,controller:'window',request_id:randomUUID()}).character.id;return act(name,'enter',{zone:hub,combat_version:3,loadout});}
 function place(name,p){const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]),state=JSON.parse(row.state);if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids[name]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[name]);}
 const floor=name=>{const s=snap(name);return s.zones.find(z=>z.id===s.zone);};
 function cross(name){const gate=floor(name).exits.find(e=>e.zone===HIGH_DESERT_ZONE);place(name,{x:gate.x,y:gate.y+1});return act(name,'dive_exit',{zone:HIGH_DESERT_ZONE});} // Step beside the north gate, then take it.
 return {db,ids,snap,command,act,player,place,floor,cross,restart:setup,raw:(name,input)=>api.act(name,input),advance:ms=>{time+=ms;api.tick();}};
}

test('100 High Desert editions have one southern exit, both rosters, connected loot and complete scenery footprints',()=>{
 const arid=new Set(Object.keys(desertData.enemies));
 for(let n=0;n<100;n++){
  const f=generateDesert(highDesertData,'high-'+n);assert.ok(validateDesert(f));assert.deepEqual(f,generateDesert(highDesertData,'high-'+n));
  assert.equal(f.width,80);assert.equal(f.height,80);assert.equal(f.theme,'high_desert');
  assert.deepEqual(f.exits,[{x:40,y:78,zone:DESERT_ZONE,name:'Dustbreak Desert'}]);
  assert.equal(f.enemies.length,20);assert.equal(f.chests.length,10);assert.equal(f.pickups.length,30);
  assert.ok(f.enemies.some(e=>arid.has(e.type)));assert.ok(f.enemies.some(e=>!arid.has(e.type))); // Desert raiders and Forest goblins/fairies share the plateau.
  assert.ok(f.decorations.some(p=>p.sprite.startsWith('sprDesertEnv')));assert.ok(f.decorations.some(p=>p.sprite.startsWith('sprForestEnv')));
  const cells=new Set();for(const p of f.decorations)for(let dy=0;dy<p.span_h;dy++)for(let dx=0;dx<p.span_w;dx++){
   const x=p.x+dx,y=p.y+dy;assert.equal(f.walls[y][x],0);assert.equal(f.props[y][x],1);assert.ok(!cells.has(x+','+y));cells.add(x+','+y);
  }
  assert.ok(f.decorations.length>=30);
 }
});

test('north trail at (50,1) upgrades existing Desert editions without rerolling content or the two hub exits',()=>{
 assert.deepEqual(WILDERNESS_LINKS.find(([,branch])=>branch===HIGH_DESERT_ZONE),[DESERT_ZONE,HIGH_DESERT_ZONE]);
 for(let n=0;n<30;n++){
  const f=generateDesert(desertData,'old-'+n),before=structuredClone(f);f.enemies[0].engaged='active-battle';
  assert.equal(addNorthTrail(f,highDesertData.config),true);assert.equal(addNorthTrail(f,highDesertData.config),false); // Idempotent across restarts.
  assert.equal(f.enemies[0].engaged,'active-battle');assert.deepEqual(f.chests,before.chests);assert.deepEqual(f.pickups,before.pickups);
  assert.deepEqual(f.rooms,before.rooms);assert.deepEqual(f.exits.slice(0,2),before.exits);
  assert.deepEqual(f.exits[2],{x:50,y:1,zone:HIGH_DESERT_ZONE,name:'Dustbreak High Desert'});
  assert.deepEqual(f.entries[HIGH_DESERT_ZONE],{x:50,y:2});assert.ok(pathTo(f,f.entrance,f.exits[2]));assert.ok(validateDesert(f));
  for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)if(walkable(before,x,y))assert.ok(walkable(f,x,y));
 }
 const f=fixture({upgrade:false});try{
  f.player('alice');f.act('alice','dive_enter',{zone:DESERT_ZONE});const chest=f.snap('alice').dive.chests[0];f.place('alice',chest);f.act('alice','dive_claim',{chest:chest.id});
  assert.equal(f.floor('alice').exits.length,2);f.restart(true);const upgraded=f.floor('alice');assert.equal(upgraded.exits.length,3);assert.ok(upgraded.exits.every(e=>e.style==='gap'));assert.equal(upgraded.geometryVersion,2); // Trail, then wall gaps.assert.equal(f.snap('alice').dive.claimed,1);
  f.cross('alice');assert.equal(f.snap('alice').zone,HIGH_DESERT_ZONE);
 }finally{f.db.close();}
});

test('High Desert requires the north Desert trail; loot stays route scoped and the south exit returns to (50,2)',()=>{
 const f=fixture();try{
  f.player('alice');assert.throws(()=>f.act('alice','dive_enter',{zone:HIGH_DESERT_ZONE}),/portal/);
  assert.ok(f.snap('alice').zones.every(z=>!(z.portals??[]).some(p=>p.target===HIGH_DESERT_ZONE)));
  f.act('alice','dive_enter',{zone:DESERT_ZONE});assert.throws(()=>f.act('alice','dive_exit',{zone:HIGH_DESERT_ZONE}),/Stand beside/);
  const desertChest=f.snap('alice').dive.chests[0];f.place('alice',desertChest);f.act('alice','dive_claim',{chest:desertChest.id});
  f.place('alice',{x:50,y:1});const first=f.act('alice','move',{direction:'north',world_step:true}); // Walk into the top-wall gap.
  assert.equal(first.zone,HIGH_DESERT_ZONE);assert.deepEqual(first.position,{x:40,y:78});assert.equal(first.dive.claimed,0);
  const loot=first.dive.chests[0];f.place('alice',loot);f.act('alice','dive_claim',{chest:loot.id});
  f.restart();const resumed=f.act('alice','enter',{zone:HIGH_DESERT_ZONE,combat_version:3});assert.equal(resumed.dive.claimed,1);
  const exit=f.floor('alice').exits[0];f.place('alice',{x:exit.x,y:exit.y-1});const back=f.act('alice','move',{direction:'south'});
  assert.equal(back.zone,DESERT_ZONE);assert.deepEqual(back.position,{x:50,y:1});assert.equal(back.dive.claimed,1);
  f.cross('alice');assert.equal(f.act('alice','dive_exit').zone,DESERT_ZONE); // Escape retreats to the parent Desert first...
  assert.equal(f.act('alice','dive_exit').zone,'honeydew-lantern'); // ...then to the original hub.
  f.act('alice','dive_enter',{zone:DESERT_ZONE});assert.throws(()=>f.act('alice','dive_exit',{zone:TAIGA_ZONE}),/Stand beside|exit/); // No cross-link to the Tundra branch.
 }finally{f.db.close();}
});

test('parties climb together and a disabled High Desert refuses the trail',()=>{
 const f=fixture();try{
  f.player('alice');f.player('bob');f.act('alice','party_invite',{member:f.ids.bob});f.act('bob','party_accept',{invitation:f.snap('bob').partyInvitations[0].id});
  f.act('alice','dive_enter',{zone:DESERT_ZONE});assert.equal(f.snap('bob').zone,DESERT_ZONE);
  f.cross('alice');assert.equal(f.snap('bob').zone,HIGH_DESERT_ZONE);assert.equal(f.snap('alice').peers.length,2);
  f.act('bob','dive_exit');assert.equal(f.snap('alice').zone,DESERT_ZONE);assert.equal(f.snap('bob').zone,DESERT_ZONE);
 }finally{f.db.close();}
 const disabled=fixture({highDesert:{...highDesertData,config:{...highDesertData.config,enabled:false}}});try{
  disabled.player('alice');disabled.act('alice','dive_enter',{zone:DESERT_ZONE});assert.throws(()=>disabled.cross('alice'),/unavailable/);assert.equal(disabled.snap('alice').zone,DESERT_ZONE);
 }finally{disabled.db.close();}
});

test('80x80 High Desert snapshot fits the gateway and mixed foes start shared combat',()=>{
 const f=fixture();try{
  f.player('alice');f.act('alice','dive_enter',{zone:DESERT_ZONE});f.cross('alice');
  const s=f.snap('alice');assert.ok(Buffer.byteLength(JSON.stringify(s))<262144);
  const foe=s.dive.enemies.find(e=>!desertData.enemies[e.type]);f.place('alice',foe);const battle=f.act('alice','dive_engage',{encounter:foe.id});
  assert.ok(battle.encounter.enemies.every(e=>typeof e.name==='string'));assert.equal(battle.character.run.zone,HIGH_DESERT_ZONE);
 }finally{f.db.close();}
});
