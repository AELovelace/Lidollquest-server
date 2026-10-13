import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFollowers,followerData} from '../server/followers.mjs';
import {createFollowerChat} from '../server/follower-chat.mjs';
import {createCompanionMemory} from '../server/companion-memory.mjs';
import {situationFacts,placeOf,timeOfDay} from '../server/companion-situation.mjs';
import {importLoadout} from '../server/loadout.mjs';

// COMPANION_LIFELIKE_PLAN.md phase B: what a companion notices. Word facts only (no numbers); wetness, messes, urges and
// smell are private and only reach the prompt when nobody else can hear.

test('places and times read as words',()=>{
 assert.equal(placeOf('honeydew-lantern'),'in Honeydew Village, a safe town');
 assert.equal(placeOf('honeydew-lantern-beds'),'inside a building in Honeydew Village, a safe town');
 assert.equal(placeOf('overworld-autumnal-plains'),'out in the Autumnal Plains');
 assert.equal(placeOf('dive-forest'),'in the Forest, a dangerous place');
 assert.deepEqual(['2026-10-13T17:00:00Z','2026-10-13T22:00:00Z','2026-10-14T02:00:00Z','2026-10-14T09:00:00Z'].map(t=>timeOfDay(Date.parse(t))),['morning','afternoon','evening','night'],'Pacific time');
});

test('health, hunger and thirst are public words; urges, wet or messy padding, accidents and smell are private',()=>{
 const at=Date.parse('2026-10-13T17:00:00Z');
 const facts=situationFacts({name:'Doll',zone:'dive-forest',now:at,speakerId:'d',hire:{character_id:'d',expires:at+300000},recent:{text:'Doll had an accident in the Forest.',embarrassing:true},
  state:{loadout:{player_info:{playerHealth:20,playerHealthMax:100,hunger:30,thirst:90,wet:85,diaper_tum_absorbed:1,had_wet_accident:0}}}});
 const pub=facts.filter(f=>!f.private).map(f=>f.text),priv=facts.filter(f=>f.private).map(f=>f.text);
 assert.deepEqual(pub,['You are in the Forest, a dangerous place. It is morning.','Doll hired you; you are traveling together.','Your contract with Doll ends in a few minutes.','Doll looks badly hurt.','Doll looks very hungry.','Doll looks a bit thirsty.']);
 assert.deepEqual(priv,['Doll is fidgeting badly, clearly desperate for a toilet.',"Doll's padding is messy.",'There is a smell of a mess around Doll.','Just now: Doll had an accident in the Forest.']);
 assert.ok(facts.every(f=>!/\d/.test(f.text)),'no numbers the model could read out');
 const stranger=situationFacts({name:'Bea',zone:'honeydew-lantern',now:at,speakerId:'b',hire:{character_id:'d',expires:at+300000},state:{loadout:{player_info:{playerHealth:100,playerHealthMax:100}}}});
 assert.deepEqual(stranger.map(f=>f.text),['You are in Honeydew Village, a safe town. It is morning.'],'a healthy stranger: just the place; no contract talk');
});

test('the reply carries private facts only when nobody else can hear, and the GM switch turns it all off',async()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-13T17:00:00Z'),listeners=0,tuning={};
 db.exec(`CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,name TEXT,state TEXT,revision INTEGER DEFAULT 0);
  CREATE TABLE quest_presence(character_id TEXT PRIMARY KEY,owner TEXT,zone TEXT,x INTEGER,y INTEGER,seen INTEGER);
  CREATE TABLE quest_chat(seq INTEGER PRIMARY KEY,zone TEXT,owner TEXT,character_id TEXT,name TEXT,text TEXT,created INTEGER,emote INTEGER,x INTEGER,y INTEGER);`);
 const followers=createFollowers(db,{enabled:true,now:()=>time}),geometry={width:20,height:20,entrance:{x:5,y:5},walls:[]},memory=createCompanionMemory(db,{now:()=>time,log:()=>{}});
 const state={followerVersion:1,loadout:importLoadout({player_info:{class_id:'fighter',level:1,playerHealth:100,playerHealthMax:100},inventory:[]})};state.loadout.player_info.diaper_wet_absorbed=2;
 const doll={id:'doll',owner:'doll',name:'Doll',state:JSON.stringify(state)};db.prepare('INSERT INTO quest_characters(id,owner,name,state) VALUES (?,?,?,?)').run(doll.id,doll.owner,doll.name,doll.state);
 const npc='paladin_aegis',zone=followerData[npc].online.home_zone,at=followers.placement(npc,zone,geometry);
 db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?)').run('doll','doll',zone,at.x,at.y,time);
 followers.complete(followers.reserve(doll,JSON.parse(doll.state),{npc,request_id:'r1'},{zone,...at},geometry,['doll']),true);followers.move(doll,JSON.parse(doll.state),null,{zone,x:5,y:5},'room');
 const bodies=[];
 const chat=createFollowerChat(db,{followers,now:()=>time,memoryStore:memory,audience:()=>listeners,roll:()=>1,slipTuning:()=>tuning,locate:(c,area)=>followers.chatTargets(c,{area,geometry}),
  fetcher:async(url,opts)=>{const path=new URL(url).pathname,body=JSON.parse(opts.body);if(path==='/v1/companion/chat')bodies.push(body);return Response.json(path==='/v1/chat/completions'?{choices:[{message:{content:'YES'}}]}:{reply:'Hm.',facts:[]});}});
 const say=async(text,seq)=>{time+=11000;db.prepare('UPDATE quest_presence SET seen=?').run(time);chat.enqueue(doll,text,seq,'room');chat.kick();for(let i=0;i<100&&!chat.idle();i++)await new Promise(r=>setTimeout(r,5));};
 try{
  await say('Elowen, how do I look?',1);assert.ok(bodies[0].situation.includes("Doll's padding is wet."),'alone: she notices');
  assert.ok(bodies[0].situation.some(s=>s.startsWith('You are ')));
  listeners=2;await say('Elowen, how do I look?',2);assert.ok(!bodies[1].situation.some(s=>/padding/.test(s)),'others listening: private facts stay out');
  assert.ok(bodies[1].situation.some(s=>s.startsWith('You are ')),'public facts still go');
  tuning={situation_enabled:'off'};await say('Elowen, how do I look?',3);assert.equal(bodies[2].situation,undefined,'switched off');
 }finally{chat.close();memory.close();db.close();}
});
