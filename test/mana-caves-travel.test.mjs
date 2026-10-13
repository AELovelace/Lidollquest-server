import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {solveDungeonPuzzle} from '../server/full-dungeon-generation.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment});let time=Date.parse('2026-09-24T12:00:00Z'),api;const ids={};
 const start=()=>api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:100}),adjust:()=>{},diveOptions:{log:()=>{}}});start();
 const snap=(who='a')=>api.read(who,ids[who]);
 const command=(who,action,extra={})=>{const s=snap(who);return {action,controller:who,character_id:ids[who],revision:s.character.revision,request_id:randomUUID(),...(s.character.dive?{edition:s.dive.edition}:{}),...extra};};
 const send=(who,input)=>{time+=350;return api.act(who,input);},act=(who,action,extra)=>send(who,command(who,action,extra));
 const place=(who,p)=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[who]).state);if(s.dive){s.dive.position={x:p.x,y:p.y};s.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),ids[who]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[who]);};
 const create=(who,zone,version=1)=>{ids[who]=api.act(who,{action:'create',name:who==='a'?'Alice':who==='b'?'Bob':'Cora',controller:who,request_id:randomUUID()}).character.id;act(who,'enter',{zone,catacombs_version:1,mana_caves_version:1,sewer_version:1,full_dungeon_version:version,content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{class_id:'warrior',playerHealth:1000,playerHealthMax:1000,stamina:100,stamina_max:100,str:100,def:100,dex:100,cha:10,level:50,xp:0},inventory:[],player_spells:[]}});};
 const map=(who='a')=>{const s=snap(who);return s.zones.find(z=>z.id===s.zone);};
 return {db,live,ids,snap,act,send,command,place,create,map,get api(){return api;},advance(ms){time+=ms;},restart(){api.close();start();},close(){api.close();db.close();}};
}

const MANA='dungeon-mana-tunnels',CAT='dungeon-honeydew-catacombs-1';
function state(f,who,change){const s=JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.ids[who]).state);change(s);f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),f.ids[who]);return s;}
function entry(f,who='a',host='utopia-arcanum',target=MANA){f.create(who,host);const p=f.map(who).portals.find(p=>p.target===target);assert.ok(p);f.place(who,p);f.act(who,'dive_enter',{zone:target});}
function cross(f,target,who='a'){const e=f.map(who).exits.find(e=>e.zone===target);assert.ok(e,'Missing exit to '+target);f.place(who,{x:e.x,y:e.y+1});f.act(who,'dive_exit',{zone:target});assert.equal(f.snap(who).zone,target);}
function closeScene(f,who='a'){const s=f.snap(who).dive.scene;if(s)f.act(who,'dungeon_scene_choice',{scene:s.id,page:s.page,mechanism_revision:s.revision,choice:-1});}
function crystal(f,who,q,symbol,revision){const c=f.map(who).fixtures.find(c=>c.puzzle===q.id&&c.symbol===symbol);f.place(who,{x:c.x,y:c.y+1});return f.command(who,'dungeon_interact',{fixture:c.id,mechanism_revision:revision});}

test('Utopia -> Mana Caves -> Catacombs -> Sewers works both ways and Escape keeps the original surface',()=>{
 const f=fixture();try{
  entry(f);assert.ok(f.map().manaCaves);cross(f,CAT);cross(f,'dungeon-littlebig-sewers');f.act('a','dive_exit');assert.equal(f.snap().zone,'utopia-arcanum');
  const p=f.map().portals.find(p=>p.target===MANA);f.place('a',p);f.act('a','dive_enter',{zone:MANA});cross(f,CAT);cross(f,'honeydew-lantern');
  f.place('a',f.map().portals.find(p=>p.target===CAT));f.act('a','dive_enter',{zone:CAT});cross(f,MANA);cross(f,'utopia-arcanum');
  f.place('a',f.map().portals.find(p=>p.target===MANA));f.act('a','dive_enter',{zone:MANA});cross(f,CAT);cross(f,'dungeon-castle-dungeon');cross(f,'princess-rose-garden');
 }finally{f.close();}
});

test('three-player travel rejects old capabilities atomically, reconnects, and refuses regenerating destinations',()=>{
 const f=fixture();try{
  for(const who of ['a','b','c'])f.create(who,'honeydew-lantern');
  for(const who of ['b','c']){f.act('a','party_invite',{member:f.ids[who]});f.act(who,'party_accept',{invitation:f.db.prepare('SELECT id FROM quest_party_invites WHERE target=?').get(f.ids[who]).id});}
  f.place('a',f.map().portals.find(p=>p.target===CAT));f.act('a','dive_enter',{zone:CAT});
  const e=f.map().exits.find(e=>e.zone===MANA);assert.ok(e);f.place('a',{x:e.x,y:e.y+1});state(f,'c',s=>s.manaCavesVersion=0);
  assert.throws(()=>f.act('a','dive_exit',{zone:MANA}),/update/);for(const who of ['a','b','c'])assert.equal(f.snap(who).zone,CAT);
  state(f,'c',s=>s.manaCavesVersion=1);
  f.db.prepare("INSERT INTO world_regeneration(id,route,status,edition,week,source,candidate,error,created) VALUES ('held-mana','mana-tunnels','generating','held-mana','2026-09-21','test',NULL,NULL,?)").run(Date.now());
  assert.throws(()=>f.act('a','dive_exit',{zone:MANA}),/regenerated/);for(const who of ['a','b','c'])assert.equal(f.snap(who).zone,CAT);
  f.db.prepare("DELETE FROM world_regeneration WHERE id='held-mana'").run();cross(f,MANA);const mist=f.map().mist;
  f.restart();for(const who of ['a','b','c'])assert.equal(f.snap(who).zone,MANA);assert.deepEqual(f.map().mist,mist);
  f.act('a','dive_exit');for(const who of ['a','b','c'])assert.equal(f.snap(who).zone,'honeydew-lantern');
 }finally{f.close();}
});

test('shared crystals serialize requests, personal loot survives restart, and duplicate moves apply one seam pulse',()=>{
 const f=fixture();try{
  entry(f);entry(f,'b');const q=f.map().manaCaves.puzzles[0],mist=f.map().mist;
  const a=crystal(f,'a',q,q.order[0],0),b=crystal(f,'b',q,q.order[0],0);f.send('a',a);f.send('a',a);assert.equal(f.map().mechanismRevision,1);assert.throws(()=>f.send('b',b),/changed/);closeScene(f);
  for(const symbol of q.order.slice(1)){f.send('a',crystal(f,'a',q,symbol,f.map().mechanismRevision));closeScene(f);}
  for(const who of ['a','b']){const chest=f.snap(who).dive.chests.find(c=>c.requires_resonance===q.id);f.place(who,chest);const receipt=f.command(who,'dive_claim',{chest:chest.id});f.send(who,receipt);f.send(who,receipt);assert.equal(f.snap(who).dive.claimed,1);}
  const h=f.map().manaCaves.seams[0];state(f,'a',s=>{s.loadout.player_info.wet=0;s.loadout.player_info.tum=0;});f.place('a',{x:h.x-1,y:h.y});const move=f.command('a','move',{direction:'east'});f.send('a',move);f.send('a',move);
  assert.equal(state(f,'a',()=>{}).loadout.player_info.wet,12);assert.equal(state(f,'a',()=>{}).loadout.player_info.tum,6);
  f.restart();assert.ok(f.map().manaCaves.puzzles[0].solved);assert.deepEqual(f.map().mist,mist);f.place('a',{x:h.x-1,y:h.y});f.act('a','move',{direction:'east'});assert.equal(state(f,'a',()=>{}).loadout.player_info.wet,12);
  const sealed=f.snap().dive.chests.find(c=>c.requires_resonance&&!c.claimed);f.place('a',sealed);assert.throws(()=>f.act('a','dive_claim',{chest:sealed.id}),/resonance/);
  const guardian=f.snap().dive.chests.find(c=>c.requires_encounter);f.place('a',guardian);assert.throws(()=>f.act('a','dive_claim',{chest:guardian.id}),/Defeat/);
 }finally{f.close();}
});

test('direct entry rejects old clients and weekly rollover keeps old receipts without entering a stale edition',()=>{
 const f=fixture();try{
  f.create('a','utopia-arcanum');const portal=f.map().portals.find(p=>p.target===MANA);f.place('a',portal);state(f,'a',s=>s.manaCavesVersion=0);
  assert.throws(()=>f.act('a','dive_enter',{zone:MANA}),/Update/);assert.equal(f.snap().zone,'utopia-arcanum');state(f,'a',s=>s.manaCavesVersion=1);f.act('a','dive_enter',{zone:MANA});
  const old=f.snap().dive.edition;f.advance(8*86400000);f.restart();f.snap();f.act('a','enter',{zone:MANA,mana_caves_version:1,catacombs_version:1,full_dungeon_version:1,quest_version:1,content_version:1,combat_version:3});assert.equal(f.snap().zone,'utopia-arcanum');
  assert.ok(f.db.prepare('SELECT state FROM dive_progress WHERE character_id=? AND route=? AND edition=?').get(f.ids.a,'mana-tunnels',old));
 }finally{f.close();}
});


test('three prepared players defeat the Unbound Prism, retain personal eligibility and can claim after making inventory space',()=>{
 const f=fixture();try{
  for(const who of ['a','b','c']){f.create(who,'utopia-arcanum');state(f,who,s=>s.loadout.player_info.level=55);} // Prepared level-55 party, with the shared combat formulas.
  for(const who of ['b','c']){f.act('a','party_invite',{member:f.ids[who]});f.act(who,'party_accept',{invitation:f.db.prepare('SELECT id FROM quest_party_invites WHERE target=?').get(f.ids[who]).id});}
  const portal=f.map().portals.find(p=>p.target===MANA);f.place('a',portal);f.act('a','dive_enter',{zone:MANA});
  const map=f.map(),keeper=f.snap().dive.enemies.find(e=>e.id==='unbound-prism'),near=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>({x:keeper.x+dx,y:keeper.y+dy})).find(p=>map.walls[p.y][p.x]===0&&!map.props[p.y][p.x]);
  for(const who of ['a','b','c'])f.place(who,near);
  let result=f.act('a','dive_engage',{encounter:keeper.id});assert.equal(result.encounter.players.length,3);const started=result.serverTime;let actions=0;
  for(let round=0;round<80&&f.snap().encounter;round++)for(const who of ['a','b','c']){
   let snap=f.snap(who);if(!snap.encounter||!snap.character.run||snap.encounter.players.find(p=>p.id===f.ids[who])?.status!=='active')continue;f.advance(Math.max(0,snap.character.run.readyAt-snap.serverTime));snap=f.snap(who);if(!snap.character.run||snap.character.run.status!=='active')continue;
   const args={battle:snap.encounter.id,cycle:snap.character.run.cycle};snap=f.act(who,'turn_ready',{...args,patch:[],forfeit:false});if(!snap.encounter)continue;
   f.act(who,'attack',{...args,target:snap.encounter.enemies.find(e=>e.hp>0).id});actions++;
  }
  assert.ok(!f.snap().encounter,'prepared party wins within the bounded encounter');assert.ok(!f.snap().character.pendingDefeat);
  console.log('Mana Caves party encounter:',JSON.stringify({actions,simulatedSeconds:(f.snap().serverTime-started)/1000,remainingHP:['a','b','c'].map(who=>f.snap(who).character.loadout.player_info.playerHealth)}));
  const chest=f.snap().dive.chests.find(c=>c.id==='prismatic-pendant');
  for(const who of ['a','b','c']){
   const before=state(f,who,()=>{}).loadout.inventory;state(f,who,s=>s.loadout.inventory=Array.from({length:99},(_,i)=>({item_id:'boots',instance_id:'full-'+i,category:'shoes'})));f.place(who,chest);
   assert.throws(()=>f.act(who,'dive_claim',{chest:chest.id}),/Inventory full/);assert.equal(f.snap(who).dive.chests.find(c=>c.id===chest.id).claimed,false);
   state(f,who,s=>s.loadout.inventory=before);f.act(who,'dive_claim',{chest:chest.id});assert.ok(f.snap(who).character.loadout.inventory.some(i=>i.item_id==='prismatic_pendant'&&i.rarity==='rare'));
  }
 }finally{f.close();}
});

