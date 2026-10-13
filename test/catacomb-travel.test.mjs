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
 const create=(who,zone,version=1)=>{ids[who]=api.act(who,{action:'create',name:who==='a'?'Alice':who==='b'?'Bob':'Cora',controller:who,request_id:randomUUID()}).character.id;act(who,'enter',{zone,catacombs_version:1,sewer_version:1,full_dungeon_version:version,content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{class_id:'warrior',playerHealth:1000,playerHealthMax:1000,stamina:100,stamina_max:100,str:100,def:100,dex:100,cha:10,level:50,xp:0},inventory:[],player_spells:[]}});};
 const map=(who='a')=>{const s=snap(who);return s.zones.find(z=>z.id===s.zone);};
 return {db,live,ids,snap,act,send,command,place,create,map,get api(){return api;},advance(ms){time+=ms;},restart(){api.close();start();},close(){api.close();db.close();}};
}

const CAT='dungeon-honeydew-catacombs-1',SECOND='dungeon-honeydew-catacombs-2',THIRD='dungeon-honeydew-catacombs-3';
function entry(f,who='a',host='honeydew-lantern',target=CAT){f.create(who,host);const p=f.map(who).portals.find(p=>p.target===target);assert.ok(p);f.place(who,p);f.act(who,'dive_enter',{zone:target});}
function crossing(f,target,who='a'){const e=f.map(who).exits.find(e=>e.zone===target);assert.ok(e,'Missing exit to '+target);f.place(who,{x:e.x,y:e.y+1});f.act(who,'dive_exit',{zone:target});assert.equal(f.snap(who).zone,target);}
function state(f,who,change){const s=JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.ids[who]).state);change(s);f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),f.ids[who]);return s;}
function closeScene(f,who){const s=f.snap(who).dive.scene;if(s)f.act(who,'dungeon_scene_choice',{scene:s.id,page:s.page,mechanism_revision:s.revision,choice:-1});}
test('Castle -> Dungeon -> Catacombs -> Sewers -> LittleBigCity and reverse; arbitrary floors preserve Escape',()=>{
 const f=fixture();try{
  f.create('a','princess-rose');f.place('a',f.map().portals.find(p=>p.target==='princess-rose-garden'));f.act('a','hub_visit',{zone:'princess-rose-garden'});
  f.place('a',f.map().portals.find(p=>p.target==='dungeon-castle-dungeon'));f.act('a','dive_enter',{zone:'dungeon-castle-dungeon'});
  crossing(f,CAT);crossing(f,SECOND);crossing(f,THIRD);crossing(f,SECOND);crossing(f,CAT);crossing(f,'dungeon-littlebig-sewers');
  f.act('a','dive_exit');assert.equal(f.snap().zone,'princess-rose-garden');
  f.place('a',f.map().portals.find(p=>p.target==='dungeon-castle-dungeon'));f.act('a','dive_enter',{zone:'dungeon-castle-dungeon'});crossing(f,CAT);crossing(f,'dungeon-littlebig-sewers');crossing(f,'littlebig-clockwork');
  f.place('a',f.map().portals.find(p=>p.target==='dungeon-littlebig-sewers'));f.act('a','dive_enter',{zone:'dungeon-littlebig-sewers'});crossing(f,CAT);crossing(f,'dungeon-castle-dungeon');crossing(f,'princess-rose-garden');
 }finally{f.close();}
});
test('three-player atomic travel rejects old clients, preserves individual state, reconnects and returns home',()=>{
 const f=fixture();try{
  for(const who of ['a','b','c'])f.create(who,'honeydew-lantern');
  for(const who of ['b','c']){f.act('a','party_invite',{member:f.ids[who]});const invitation=f.db.prepare('SELECT id FROM quest_party_invites WHERE target=?').get(f.ids[who]).id;f.act(who,'party_accept',{invitation});}
  const p=f.map().portals.find(p=>p.target===CAT);f.place('a',p);state(f,'c',s=>s.catacombsVersion=0);
  assert.throws(()=>f.act('a','dive_enter',{zone:CAT}),/update/);for(const who of ['a','b','c'])assert.equal(f.snap(who).zone,'honeydew-lantern');
  state(f,'c',s=>s.catacombsVersion=1);f.act('a','dive_enter',{zone:CAT});for(const who of ['a','b','c'])assert.equal(f.snap(who).zone,CAT);
  state(f,'b',s=>s.graveChill={steps:7});crossing(f,SECOND);assert.equal(state(f,'b',()=>{}).graveChill.steps,7);assert.ok(!state(f,'c',()=>{}).graveChill);
  f.restart();for(const who of ['a','b','c'])assert.equal(f.snap(who).zone,SECOND);
  f.act('a','dive_exit');for(const who of ['a','b','c']){assert.equal(f.snap(who).zone,'honeydew-lantern');assert.ok(!state(f,who,()=>{}).graveChill);}
 }finally{f.close();}
});
test('shared candles serialize simultaneous revisions and duplicate receipts; personal treasure and mist persist',()=>{
 const f=fixture();try{
  entry(f);entry(f,'b');const map=f.map(),q=map.catacombs.puzzles[0],mist=map.mist;
  const light=(who,symbol,revision)=>{const candle=f.map().fixtures.find(c=>c.puzzle===q.id&&c.symbol===symbol);f.place(who,{x:candle.x,y:candle.y+1});return f.command(who,'dungeon_interact',{fixture:candle.id,mechanism_revision:revision});};
  const revision=map.mechanismRevision,a=light('a',q.order[0],revision),b=light('b',q.order[0],revision);f.send('a',a);f.send('a',a);assert.equal(f.map().mechanismRevision,revision+1);assert.throws(()=>f.send('b',b),/changed/);closeScene(f,'a');
  for(const symbol of q.order.slice(1)){f.send('a',light('a',symbol,f.map().mechanismRevision));closeScene(f,'a');}
  assert.ok(f.map('b').catacombs.puzzles[0].solved);
  for(const who of ['a','b']){const chest=f.snap(who).dive.chests.find(c=>c.requires_memorial===q.id);f.place(who,chest);const receipt=f.command(who,'dive_claim',{chest:chest.id});f.send(who,receipt);f.send(who,receipt);assert.equal(f.snap(who).dive.claimed,1);}
  f.restart();assert.ok(f.map().catacombs.puzzles[0].solved);assert.deepEqual(f.map().mist,mist);
  const reserved=f.map().catacombs.reserved.find(p=>p.target==='dungeon-steam-network');f.place('a',{x:reserved.x,y:reserved.y+1});assert.throws(()=>f.act('a','dive_exit',{zone:reserved.target}),/exit/);assert.throws(()=>f.act('a','dive_enter',{zone:reserved.target}),/Unknown|unavailable|zone|changing routes/i);
 }finally{f.close();}
});
test('authoritative duplicate movement causes one haunting; refuge clears chill; guardian reward requires participation',()=>{
 const f=fixture();try{
  entry(f);const h=f.map().catacombs.haunts[0];state(f,'a',s=>{s.loadout.player_info.wet=0;s.loadout.player_info.tum=0;});f.place('a',{x:h.x,y:h.y+1});const move=f.command('a','move',{direction:'north'});f.send('a',move);f.send('a',move);
  let s=state(f,'a',()=>{});assert.equal(s.loadout.player_info.wet,15);assert.equal(s.loadout.player_info.tum,8);
  state(f,'a',s=>s.graveChill={steps:9});const refuge=f.map().catacombs.refuges[0];f.place('a',{x:refuge.cx,y:refuge.cy+2});f.act('a','move',{direction:'west'});assert.ok(!state(f,'a',()=>{}).graveChill);
  crossing(f,SECOND);crossing(f,THIRD);const chest=f.snap().dive.chests.find(c=>c.id==='keeper-relic');f.place('a',chest);assert.throws(()=>f.act('a','dive_claim',{chest:chest.id}),/Defeat/);
 }finally{f.close();}
});

test('three prepared players defeat the Keeper, retain personal eligibility and can claim after making inventory space',()=>{
 const f=fixture();try{
  for(const who of ['a','b','c']){f.create(who,'honeydew-lantern');state(f,who,s=>s.loadout.player_info.level=70);} // Prepared level-70 party, with the shared combat formulas.
  for(const who of ['b','c']){f.act('a','party_invite',{member:f.ids[who]});f.act(who,'party_accept',{invitation:f.db.prepare('SELECT id FROM quest_party_invites WHERE target=?').get(f.ids[who]).id});}
  const portal=f.map().portals.find(p=>p.target===CAT);f.place('a',portal);f.act('a','dive_enter',{zone:CAT});crossing(f,SECOND);crossing(f,THIRD);
  const map=f.map(),keeper=f.snap().dive.enemies.find(e=>e.id==='catacomb-keeper'),near=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>({x:keeper.x+dx,y:keeper.y+dy})).find(p=>map.walls[p.y][p.x]===0&&!map.props[p.y][p.x]);
  for(const who of ['a','b','c'])f.place(who,near);
  let result=f.act('a','dive_engage',{encounter:keeper.id});assert.equal(result.encounter.players.length,3);const started=result.serverTime;let actions=0;
  for(let round=0;round<80&&f.snap().encounter;round++)for(const who of ['a','b','c']){
   let snap=f.snap(who);if(!snap.encounter||!snap.character.run||snap.encounter.players.find(p=>p.id===f.ids[who])?.status!=='active')continue;f.advance(Math.max(0,snap.character.run.readyAt-snap.serverTime));snap=f.snap(who);if(!snap.character.run||snap.character.run.status!=='active')continue;
   const args={battle:snap.encounter.id,cycle:snap.character.run.cycle};snap=f.act(who,'turn_ready',{...args,patch:[],forfeit:false});if(!snap.encounter)continue;
   f.act(who,'attack',{...args,target:snap.encounter.enemies.find(e=>e.hp>0).id});actions++;
  }
  assert.ok(!f.snap().encounter,'prepared party wins within the bounded encounter');assert.ok(!f.snap().character.pendingDefeat);
  console.log('Catacomb party encounter:',JSON.stringify({actions,simulatedSeconds:(f.snap().serverTime-started)/1000,remainingHP:['a','b','c'].map(who=>f.snap(who).character.loadout.player_info.playerHealth)}));
  const chest=f.snap().dive.chests.find(c=>c.id==='keeper-relic');
  for(const who of ['a','b','c']){
   const before=state(f,who,()=>{}).loadout.inventory;state(f,who,s=>s.loadout.inventory=Array.from({length:99},(_,i)=>({item_id:'boots',instance_id:'full-'+i,category:'shoes'})));f.place(who,chest);
   assert.throws(()=>f.act(who,'dive_claim',{chest:chest.id}),/Inventory full/);assert.equal(f.snap(who).dive.chests.find(c=>c.id===chest.id).claimed,false);
   state(f,who,s=>s.loadout.inventory=before);f.act(who,'dive_claim',{chest:chest.id});assert.ok(f.snap(who).character.loadout.inventory.some(i=>i.item_id==='remembrance_locket'&&i.rarity==='rare'));
  }
 }finally{f.close();}
});

test('regenerating destinations roll back travel, and weekly retirement clears personal chill without deleting receipts',()=>{
 const f=fixture();try{
  f.create('a','honeydew-lantern');f.place('a',f.map().portals.find(p=>p.target===CAT));
  f.db.prepare("INSERT INTO world_regeneration(id,route,status,edition,week,source,candidate,error,created) VALUES (?,?,?,?,'2026-09-21','test',NULL,NULL,?)").run('held-entry','honeydew-catacombs-1','generating','held-entry',Date.now());
  assert.throws(()=>f.act('a','dive_enter',{zone:CAT}),/regenerated/);assert.equal(f.snap().zone,'honeydew-lantern'); // Surface entry must obey the same busy check as connected travel.
  f.db.prepare('DELETE FROM world_regeneration WHERE id=?').run('held-entry');f.act('a','dive_enter',{zone:CAT});
  state(f,'a',s=>s.graveChill={steps:8});const e=f.map().exits.find(e=>e.zone===SECOND);f.place('a',{x:e.x,y:e.y+1});
  const before=f.snap().position;
  f.db.prepare("INSERT INTO world_regeneration(id,route,status,edition,week,source,candidate,error,created) VALUES (?,?,?,?,'2026-09-21','test',NULL,NULL,?)").run('held-test','honeydew-catacombs-2','generating','held-test',Date.now());
  assert.throws(()=>f.act('a','dive_exit',{zone:SECOND}),/regenerated/);assert.equal(f.snap().zone,CAT);assert.deepEqual(f.snap().position,before);assert.equal(state(f,'a',()=>{}).graveChill.steps,8);
  f.db.prepare('DELETE FROM world_regeneration WHERE id=?').run('held-test');crossing(f,SECOND);crossing(f,CAT);
  const old=f.snap().dive.edition;f.advance(8*86400000);f.restart();f.snap();f.act('a','enter',{zone:CAT,catacombs_version:1,full_dungeon_version:1,quest_version:1,content_version:1,combat_version:3});assert.equal(f.snap().zone,'honeydew-lantern');assert.ok(!state(f,'a',()=>{}).graveChill);
  assert.ok(f.db.prepare('SELECT state FROM dive_progress WHERE character_id=? AND route=? AND edition=?').get(f.ids.a,'honeydew-catacombs-1',old));
 }finally{f.close();}
});

