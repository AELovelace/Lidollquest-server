import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFollowers,followerData} from '../server/followers.mjs';
import {createFollowerChat} from '../server/follower-chat.mjs';
import {createCompanionMemory} from '../server/companion-memory.mjs';
import {importLoadout} from '../server/loadout.mjs';

// COMPANION_LIFELIKE_PLAN.md phase D: musings while the hirer waits around in a town (every 5-7 minutes, never while
// moving, outside towns or mid-fight) and banter between two hired companions nearby (two lines, public lore only).

const TOWN='honeydew-lantern';
function world({hirers=['doll'],npcs=['paladin_aegis'],tuning={}}={}){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-13T12:00:00Z');
 db.exec(`CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,name TEXT,state TEXT,revision INTEGER DEFAULT 0);
  CREATE TABLE quest_presence(character_id TEXT PRIMARY KEY,owner TEXT,zone TEXT,x INTEGER,y INTEGER,seen INTEGER);
  CREATE TABLE quest_chat(seq INTEGER PRIMARY KEY,zone TEXT,owner TEXT,character_id TEXT,name TEXT,text TEXT,created INTEGER,emote INTEGER,x INTEGER,y INTEGER);`);
 const followers=createFollowers(db,{enabled:true,now:()=>time}),geometry={width:20,height:20,entrance:{x:5,y:5},walls:[]},memory=createCompanionMemory(db,{now:()=>time,log:()=>{}});
 const people=hirers.map((id,i)=>{
  const c={id,owner:id,name:id[0].toUpperCase()+id.slice(1),state:JSON.stringify({followerVersion:1,loadout:importLoadout({player_info:{class_id:'fighter',level:1},inventory:[]})})};
  db.prepare('INSERT INTO quest_characters(id,owner,name,state) VALUES (?,?,?,?)').run(c.id,c.owner,c.name,c.state);
  const npc=npcs[i],home=followerData[npc].online.home_zone,at=followers.placement(npc,home,geometry);
  db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?)').run(c.id,c.owner,home,at.x,at.y,time);
  followers.complete(followers.reserve(c,JSON.parse(c.state),{npc,request_id:'r-'+id},{zone:home,...at},geometry,[c.id]),true);
  followers.move(c,JSON.parse(c.state),{zone:home,...at},{zone:TOWN,x:5+i,y:5},'square');db.prepare('UPDATE quest_presence SET zone=?,x=?,y=? WHERE character_id=?').run(TOWN,5+i,5,c.id); // Both walk into town.
  return c;
 });
 const calls=[];let n=0;
 const chat=createFollowerChat(db,{followers,now:()=>time,memoryStore:memory,roll:()=>0,audience:()=>0,slipTuning:()=>({reactions_enabled:'off',...tuning}),locate:(c,area)=>followers.chatTargets(c,{area,geometry}),
  fetcher:async(url,opts)=>{const path=new URL(url).pathname,body=JSON.parse(opts.body);if(path==='/v1/companion/lore')return Response.json({ok:true});calls.push({path,body});n++;return Response.json({reply:`Line ${n} from ${body.npc_name}.`});}});
 const lines=()=>db.prepare("SELECT name,text FROM quest_chat WHERE character_id LIKE 'follower:%' ORDER BY seq").all().map(r=>r.text);
 const tick=async ms=>{time+=ms;db.prepare('UPDATE quest_presence SET seen=?').run(time);chat.kick();for(let i=0;i<40;i++)await new Promise(r=>setTimeout(r,3));};
 return {db,followers,chat,memory,people,calls,lines,tick,setTime:t=>{time=t;},now:()=>time,close:()=>{chat.close();memory.close();db.close();}};
}

test('a companion muses after the hirer has stood still in town for a while, then not again for 5-7 minutes',async()=>{
 const w=world();try{
  await w.tick(1000);await w.tick(200000);assert.equal(w.lines().length,0,'not yet: under 4 minutes of standing still');
  for(let i=0;i<20&&!w.lines().length;i++)await w.tick(60000); // Within the next 5-7 minutes the first musing is due.
  assert.equal(w.lines().length,1);const ask=w.calls.at(-1).body;
  assert.equal(ask.kind,'musing');assert.ok(ask.situation.some(s=>/Honeydew Village/.test(s)),'it knows where they are');
  await w.tick(120000);assert.equal(w.lines().length,1,'not again within 5 minutes');
  for(let i=0;i<10&&w.lines().length<2;i++)await w.tick(60000);assert.equal(w.lines().length,2,'and again after 5-7 minutes');
 }finally{w.close();}
});

test('no musings while moving, mid-fight, or switched off',async()=>{
 const moving=world();try{
  for(let i=0;i<12;i++){moving.db.prepare("UPDATE quest_presence SET x=x+1 WHERE character_id='doll'").run();await moving.tick(60000);}
  assert.equal(moving.lines().length,0,'walking around resets the idle clock');
 }finally{moving.close();}
 const fighting=world();try{
  const s=JSON.parse(fighting.db.prepare("SELECT state FROM quest_characters WHERE id='doll'").get().state);s.run={phase:'fight'};fighting.db.prepare("UPDATE quest_characters SET state=? WHERE id='doll'").run(JSON.stringify(s));
  for(let i=0;i<12;i++)await fighting.tick(60000);assert.equal(fighting.lines().length,0);
 }finally{fighting.close();}
 const off=world({tuning:{musings_enabled:'off'}});try{for(let i=0;i<12;i++)await off.tick(60000);assert.equal(off.lines().length,0,'switched off');}finally{off.close();}
});

test('two hired companions near each other trade exactly two lines, without any player memories',async()=>{
 const w=world({hirers:['doll','bea'],npcs:['paladin_aegis','defector_wick'],tuning:{musings_enabled:'off'}});try{
  w.followers.remember(w.people[0],'accident',{zone:TOWN});
  for(let i=0;i<10&&w.lines().length<2;i++)await w.tick(60000);
  assert.equal(w.lines().length,2);
  const [first,second]=w.calls.filter(c=>c.body.kind==='banter').map(c=>c.body);
  assert.equal(first.npc_id,'defector_wick');assert.equal(first.partner.name,'Dame Elowen');assert.equal(first.partner.line,'');
  assert.equal(second.npc_id,'paladin_aegis');assert.equal(second.partner.line,w.lines()[0],'the second answers the first');
  for(const body of [first,second])assert.ok(!body.memories&&!body.slip&&!body.summary&&!body.gossip,'banter never carries player memories, slips or gossip');
  for(let i=0;i<4;i++)await w.tick(60000);assert.equal(w.lines().length,2,'no loop: the pair waits 5-7 minutes');
 }finally{w.close();}
});
