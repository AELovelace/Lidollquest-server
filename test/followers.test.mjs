import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFollowers,followerData,HIRE_MS,followerStats} from '../server/followers.mjs';
import {createFollowerChat,mentionsFollower} from '../server/follower-chat.mjs';
import {createDiveEncounters} from '../server/dive-encounters.mjs';
import {followerAction,guardianTarget} from '../server/follower-combat.mjs';
import {beginRound,combatData} from '../server/combat.mjs';
import {importLoadout} from '../server/loadout.mjs';
import {createParties} from '../server/parties.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');let time=1000000;
 db.exec(`CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,name TEXT,state TEXT,revision INTEGER DEFAULT 0);
 CREATE TABLE quest_presence(character_id TEXT PRIMARY KEY,owner TEXT,zone TEXT,x INTEGER,y INTEGER,seen INTEGER);
 CREATE TABLE quest_chat(seq INTEGER PRIMARY KEY,zone TEXT,owner TEXT,character_id TEXT,name TEXT,text TEXT,created INTEGER,emote INTEGER,x INTEGER,y INTEGER);`);
 const followers=createFollowers(db,{enabled:true,now:()=>time});
 const geometry={width:20,height:20,entrance:{x:5,y:5},walls:[]};
 function player(id){const c={id,owner:id,name:id,state:JSON.stringify({followerVersion:1,loadout:importLoadout({player_info:{class_id:'fighter',level:1,str:9,def:8,dex:5,int:10,playerHealth:100,playerHealthMax:100},inventory:[],player_spells:['heal_light'],player_mp:90,player_mp_max:90})})};db.prepare('INSERT INTO quest_characters(id,owner,name,state) VALUES (?,?,?,?)').run(id,id,id,c.state);return c;}
 const alice=player('alice'),bob=player('bob'),eve=player('eve');
 function hire(c=alice,npc='sorceress_arcana',ids=[c.id]){
  const zone=followerData[npc].online.home_zone,at=followers.placement(npc,zone,geometry),p={zone,...at};
  db.prepare('INSERT OR REPLACE INTO quest_presence VALUES (?,?,?,?,?,?)').run(c.id,c.owner,zone,p.x,p.y,time);
  const id=followers.reserve(c,JSON.parse(c.state),{npc,request_id:'request-'+npc},p,geometry,ids);return id;
 }
 function active(c=alice,npc='sorceress_arcana'){const id=hire(c,npc);followers.complete(id,true);followers.move(c,JSON.parse(c.state),null,{zone:followerData[npc].online.home_zone,x:5,y:5},'room');return id;}
 return {db,followers,alice,bob,eve,geometry,hire,active,now:()=>time,advance:n=>{time+=n;},close:()=>db.close()};
}

test('exclusive reservations, one per player/party, three slots, decline and confirmed payment',()=>{
 const f=fixture();try{
  const id=f.hire();assert.throws(()=>f.hire(f.bob),/travelling/);assert.throws(()=>f.hire(f.alice,'merchant_mira'),/already/);
  assert.throws(()=>f.hire({...f.eve,owner:f.alice.owner},'merchant_mira'),/account/,'Changing characters must not bypass the one-hire player limit');
  assert.throws(()=>f.hire(f.bob,'merchant_mira',['alice','bob']),/party already/);
  assert.equal(f.followers.slots(['alice','bob']),3);assert.throws(()=>f.followers.assertSlots(['alice','bob','eve']),/three/);
  f.followers.complete(id,true);const expiry=f.followers.get('alice').expires;f.advance(1000);f.followers.complete(id,true);assert.equal(f.followers.get('alice').expires,expiry);
  assert.equal(expiry,1000000+HIRE_MS);f.followers.dismiss(f.alice);assert.equal(f.followers.get('alice'),undefined);
  const second=f.hire(f.bob);f.followers.complete(second,false);assert.equal(f.followers.get('bob'),undefined);
  const a=f.active(f.alice,'merchant_mira'),b=f.active(f.bob,'nurse_vex');assert.ok(a&&b);assert.throws(()=>f.followers.assertSlots(['alice','bob']),/only one/);
 }finally{f.close();}
});

test('expiry survives restart, waits for battle settlement, and progression is persistent and idempotent',()=>{
 const f=fixture();try{
  f.active();const actors=f.followers.actors([f.alice],'battle'),a=actors[0];a.run={hp:0};
  f.advance(HIRE_MS+1);const restarted=createFollowers(f.db,{enabled:true,now:f.now});restarted.tick();assert.ok(restarted.get('alice'));
  restarted.settle(a,'battle',160);assert.equal(restarted.get('alice'),undefined);assert.equal(restarted.progression(a.npc).level,3);
  const saved=restarted.progression(a.npc);restarted.settle(a,'battle',160);assert.deepEqual(restarted.progression(a.npc),saved);assert.equal(saved.hp,Math.ceil(followerStats(followerData[a.npc],3).hp/4));
  f.active(f.bob);assert.equal(f.followers.progression(a.npc).level,3);assert.equal(f.followers.progression(a.npc).hp,followerStats(followerData[a.npc],3).hp);
  f.advance(HIRE_MS+1);restarted.tick();assert.equal(restarted.get('bob'),undefined,'A disconnected hire expires without a battle');
 }finally{f.close();}
});

test('invitations recheck intervening hires, one follower per party, and the third allied slot',()=>{
 const f=fixture();try{
  f.db.exec('CREATE TABLE quest_management(character_id TEXT,status TEXT)');
  const parties=createParties(f.db,{now:f.now});parties.setFollowers(f.followers);
  for(const c of [f.alice,f.bob,f.eve]){const s=JSON.parse(c.state);s.diveCombatVersion=3;c.state=JSON.stringify(s);f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(c.state,c.id);f.db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?)').run(c.id,c.owner,'dungeon-castle-dungeon',5,5,f.now());}
  for(const c of [f.bob,f.eve])parties.act(f.alice,{action:'party_invite',member:c.id});
  const invitation=c=>parties.snapshot(c).partyInvitations[0].id;
  f.active(f.alice);f.active(f.bob,'merchant_mira');f.db.prepare("UPDATE quest_presence SET zone='dungeon-castle-dungeon'").run();
  assert.throws(()=>parties.act(f.bob,{action:'party_accept',invitation:invitation(f.bob)}),/only one/,'Two independently hired followers cannot merge through an old invitation');
  f.followers.dismiss(f.bob);parties.act(f.bob,{action:'party_accept',invitation:invitation(f.bob)});assert.equal(parties.snapshot(f.bob).party.slots,3);
  assert.throws(()=>parties.act(f.eve,{action:'party_accept',invitation:invitation(f.eve)}),/three/,'An older invitation cannot add a fourth participant');
 }finally{f.close();}
});

test('walk trails and portal transitions are server-derived; old clients and distant recruitment rejected',()=>{
 const f=fixture();try{
  f.active();f.followers.move(f.alice,{}, {zone:'dungeon-castle-dungeon',x:5,y:5},{zone:'dungeon-castle-dungeon',x:6,y:5},'room');assert.equal(f.followers.get('alice').x,5);
  f.followers.move(f.alice,{dive:{edition:'new'}},null,{zone:'new-zone',x:10,y:10},'new-area');assert.equal(f.followers.get('alice').x,10);
  assert.throws(()=>f.followers.actors([f.alice,{...f.bob,state:'{}'}],'fight'),/Every player/);
  assert.throws(()=>f.followers.reserve(f.bob,{followerVersion:0},{npc:'merchant_mira'},{zone:'honeydew-lantern',x:5,y:5},f.geometry,['bob']),/Update/);
  assert.throws(()=>f.followers.reserve(f.bob,{followerVersion:1},{npc:'merchant_mira'},{zone:'honeydew-lantern',x:19,y:19},f.geometry,['bob']),/Stand beside/);
 }finally{f.close();}
});

const wait=async pred=>{for(let i=0;i<100;i++){if(pred())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');};
test('slow AI is asynchronous, with two global pipelines and one pending reply per follower',async()=>{
 const f=fixture();let chat,release;try{
  for(const [c,npc] of [[f.alice,'sorceress_arcana'],[f.bob,'merchant_mira'],[f.eve,'nurse_vex']])f.active(c,npc);
  const gate=new Promise(r=>release=r);let calls=0;
  chat=createFollowerChat(f.db,{followers:f.followers,now:f.now,fetcher:async url=>{calls++;await gate;return Response.json({choices:[{message:{content:String(url).includes(':9091')?'CHAT':'Hello!'}}]});}});
  chat.enqueue(f.alice,'Astra hello',1,'room');chat.enqueue(f.alice,'Astra again',2,'room');chat.enqueue(f.bob,'Mira hello',3,'room');chat.enqueue(f.eve,'Vex hello',4,'room');
  chat.kick();assert.equal(calls,2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM quest_follower_chat_jobs').get().n,3);
  f.followers.move(f.alice,{},null,null,null);assert.equal(f.db.prepare('SELECT status FROM quest_follower_chat_jobs WHERE seq=1').get().status,'discarded','Game commands can commit and cancel speech while the model is delayed');
  release();await wait(chat.idle);chat.kick();await wait(chat.idle);assert.equal(calls,6);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM quest_chat').get().n,2);
 }finally{release?.();chat?.close();f.close();}
});
test('AI uses classifier, personal chat and RAG endpoints; only owner mentions enqueue; retries do not duplicate',async()=>{
 const f=fixture();let chat;try{
  f.followers.complete(f.hire(),true);const calls=[];let game=false; // Exercise immediate speech before the first post-hire presence tick.
  chat=createFollowerChat(f.db,{followers:f.followers,now:f.now,fetcher:async(url,opts)=>{calls.push({url:String(url),body:JSON.parse(opts.body)});return Response.json(String(url).includes(':9091')?{choices:[{message:{content:game?'GAME':'CHAT'}}]}:String(url).includes(':9092')?{reply:'Use the bank in town.'}:{choices:[{message:{content:'Good to see you!'}}]});}});
  assert.equal(mentionsFollower('ASTRA, hello!',followerData.sorceress_arcana),true);assert.equal(mentionsFollower('astral lights',followerData.sorceress_arcana),false);
  chat.enqueue(f.bob,'Astra hello',1,'room');chat.enqueue(f.alice,'hello',2,'room');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM quest_follower_chat_jobs').get().n,0);
  chat.enqueue(f.alice,'Astra hello',3,'room');chat.enqueue(f.alice,'Astra hello',3,'room');f.followers.move(f.alice,JSON.parse(f.alice.state),{zone:'dungeon-castle-dungeon',x:5,y:5},{zone:'dungeon-castle-dungeon',x:5,y:5},'room');chat.kick();await wait(chat.idle);
  assert.equal(calls.length,2);assert.match(calls[0].url,/:9091\/v1\/chat/);assert.match(calls[1].url,/:9090\/v1\/chat/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM quest_chat').get().n,1);
  game=true;f.advance(11000);chat.enqueue(f.alice,'Astra where is the bank?',4,'room');chat.kick();await wait(chat.idle);assert.match(calls[3].url,/:9092\/v1\/npc\/chat/);assert.equal(calls[3].body.history.length,2);
  assert.equal(f.db.prepare('SELECT text FROM quest_chat ORDER BY seq DESC').get().text,'Use the bank in town.');
  f.followers.dismiss(f.alice);f.active(f.bob);chat.enqueue(f.bob,'Astra, how do I travel?',5,'room');chat.kick();await wait(chat.idle);assert.equal(calls[5].body.history.length,0,'A new hirer never receives another rental conversation');
  f.advance(1800001);f.db.prepare('UPDATE quest_presence SET seen=?').run(f.now());chat.enqueue(f.bob,'Astra, where is town?',6,'room');chat.kick();await wait(chat.idle);assert.equal(calls[7].body.history.length,0,'Thirty minutes of inactivity forgets conversation history');
 }finally{chat?.close();f.close();}
});

test('late AI replies after a zone change are discarded; failures give bounded authored fallback',async()=>{
 const f=fixture();let chat,release;try{
  f.active();const gate=new Promise(r=>release=r);chat=createFollowerChat(f.db,{followers:f.followers,now:f.now,fetcher:async()=>{await gate;throw Error('offline');}});
  chat.enqueue(f.alice,'Astra hello',1,'room');chat.kick();f.followers.move(f.alice,{},null,{zone:'elsewhere',x:3,y:3},'elsewhere');f.followers.move(f.alice,{},null,{zone:'dungeon-castle-dungeon',x:5,y:5},'room');release();await wait(chat.idle);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM quest_chat').get().n,0);
  f.followers.move(f.alice,{},null,{zone:'dungeon-castle-dungeon',x:5,y:5},'room');f.advance(11000);chat.enqueue(f.alice,'Astra hello',2,'room');chat.kick();await wait(chat.idle);assert.ok(f.db.prepare('SELECT text FROM quest_chat').get().text.length<=240);
 }finally{release?.();chat?.close();f.close();}
});

test('all seven companions choose legal actions with their authored abilities',()=>{
 for(const [id,def] of Object.entries(followerData)){
  const f=fixture();try{
   f.active(f.alice,id);const actor=f.followers.actors([f.alice],'fight')[0],s=actor.state,owner=JSON.parse(f.alice.state);
   const enemy={data:{name:'Test monster',hp:1000,maxHp:1000,str:1,def:2,dex:0,exp:5},dots:[],debuffs:[]};
   const run=()=>({id:'fight',phase:'fight',hp:70,maxHp:100,enemy:enemy.data,handicaps:[],log:[]});
   s.run=run();owner.run=run();beginRound(s,{},()=>0,enemy.data);beginRound(owner,{},()=>0,enemy.data);s.run.turnReady=true;actor.run=s.run;actor.status='active';
   const o={a:{id:'alice',name:'Alice',status:'active',run:owner.run},s:owner},row={a:actor,s};o.a.run.hp=10;owner.loadout.player_info.equipped_panties='printed_diaper';owner.loadout.player_info.diaper_wet_absorbed=20;
   followerAction(row,[row,o],enemy,{activeTime:true},()=>99,def);assert.ok(s.run.log.length>0,id);assert.ok(s.loadout.player_mp>=0,id);
   if(id==='paladin_aegis')assert.equal(guardianTarget(o,[row,o],followerData),row);
   if(['merchant_mira','matron_haven','nurse_vex','defector_wick'].includes(id))assert.ok(o.a.run.hp>10,id+' heals its injured hirer');
   if(id==='sorceress_arcana')assert.equal(owner.loadout.player_info.diaper_wet_absorbed,0);
   if(id==='brawler_kai')assert.ok(enemy.data.hp<1000,'Iron Fist damages the enemy');
   // Repeated healthy turns must not waste actions repeating an existing support effect.
   o.a.run.hp=o.a.run.maxHp;row.a.run.hp=row.a.run.maxHp;owner.loadout.player_info.diaper_wet_absorbed=0;
   for(let turn=0;turn<4;turn++){s.run.turnReady=true;followerAction(row,[row,o],enemy,{activeTime:true},()=>99,def);}
   assert.ok(enemy.data.hp<1000,id+' eventually attacks instead of repeating support');
  }finally{f.close();}
 }
});

test('real PvE encounter adds an autonomous actor, supports targeting, and grants no player rewards to NPCs',()=>{
 const f=fixture();try{
  f.active();const state=JSON.parse(f.alice.state),record={edition:'test',ends:Infinity,floor:{enemies:[]}},rewards=[];
  const foe={id:'foe',type:'foe',x:5,y:6,spawn:{x:5,y:6},respawnAt:0};record.floor.enemies=[foe];
  const data={config:{zone_id:'dungeon-castle-dungeon',route:'test',static:true,boss_id:'foe',boss_respawn_seconds:10},enemies:{foe:{name:'Test monster',hp:200,str:1,def:1,dex:0,exp:60,enemy_id:'goblin'}}};
  const save=(c,s)=>f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);
  const engine=createDiveEncounters(f.db,{now:f.now,roll:()=>99,data,parties:{members:()=>[f.alice],followers:f.followers},saveFloor:()=>{},progress:()=>({}),saveProgress:()=>{},pay:c=>{rewards.push(c.id);return 0;},back:()=>{},entry:()=>({x:5,y:5}),saveCharacter:save,relocate:()=>{},context:{eligible:()=>true}});
  engine.start(f.alice,state,record,foe);save(f.alice,state);let snapshot=engine.snapshot(state);assert.equal(snapshot.players.length,2);assert.ok(snapshot.players[1].npc);assert.equal(snapshot.players[1].maxMp,followerStats(followerData.sorceress_arcana,1).mp);
  const wounded=JSON.parse(f.db.prepare('SELECT state FROM quest_dive_encounters').get().state);wounded.followers[0].run.hp=5;wounded.followers[0].state.loadout.player_info.playerHealth=5;f.db.prepare('UPDATE quest_dive_encounters SET state=?').run(JSON.stringify(wounded));
  f.advance(5000);engine.act(f.alice,state,{action:'turn_ready',battle:wounded.id,cycle:1,forfeit:false,patch:[]},record);
  engine.act(f.alice,state,{action:'cast',spell:'heal_light',target:snapshot.players[1].id,battle:wounded.id,cycle:1},record);save(f.alice,state);
  assert.ok(engine.snapshot(state).players[1].hp>5,'A player can heal the actual companion actor');
  f.advance(5000);f.db.prepare('UPDATE quest_presence SET seen=?').run(f.now());engine.tick(()=>record);f.advance(6000);f.db.prepare('UPDATE quest_presence SET seen=?').run(f.now());engine.tick(()=>record);
  let e=JSON.parse(f.db.prepare('SELECT state FROM quest_dive_encounters').get().state);assert.ok(e.followers[0].cycle>1);e.enemies[0].data.hp=0;f.db.prepare('UPDATE quest_dive_encounters SET state=?').run(JSON.stringify(e));
  f.advance(6000);const current=JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get('alice').state);engine.act(f.alice,current,{action:'turn_ready',battle:e.id,cycle:e.players[0].cycle,forfeit:false,patch:[]},record);assert.deepEqual(rewards,['alice']);assert.equal(f.followers.get('alice').battle,null);assert.ok(f.followers.progression('sorceress_arcana').xp>0||f.followers.progression('sorceress_arcana').level>1);
  save(f.alice,current);const earned=f.followers.progression('sorceress_arcana').xp;
  for(const action of ['flee','submit']){
   const next=engine.start(f.alice,current,record,foe);save(f.alice,current);engine.act(f.alice,current,{action,battle:next.id,cycle:1},record);save(f.alice,current);
   assert.equal(engine.snapshot(current),null,'The NPC cannot continue without its hirer');assert.equal(f.followers.get('alice').battle,null);assert.equal(f.followers.progression('sorceress_arcana').xp,earned);
  }
 }finally{f.close();}
});
