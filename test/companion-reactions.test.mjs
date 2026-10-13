import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFollowers,followerData} from '../server/followers.mjs';
import {createFollowerChat} from '../server/follower-chat.mjs';
import {createCompanionMemory} from '../server/companion-memory.mjs';
import {planReaction,fillTemplate,GENERIC_REACTIONS,REACTION_KINDS} from '../server/companion-reactions.mjs';
import {importLoadout} from '../server/loadout.mjs';

// COMPANION_LIFELIKE_PLAN.md phase C: companions speak up after hires, wins, losses, revives, quests, new places and
// accidents. Written lines by default, AI lines for big moments, public accidents only through the slip rules.

const always=()=>0,never=()=>0.99;
test('what happens decides how the companion reacts',()=>{
 assert.deepEqual(planReaction('hire',{},{roll:never}),{mode:'template',line:'hire'});
 assert.deepEqual(planReaction('battle_win',{boss:true},{roll:always}),{mode:'ai',line:'boss_win'},'bosses: an AI line when the roll says so');
 assert.deepEqual(planReaction('battle_win',{boss:true},{roll:never}),{mode:'template',line:'boss_win'},'...and always a line');
 assert.equal(planReaction('battle_win',{},{roll:never}),null,'an ordinary win only sometimes');
 assert.deepEqual(planReaction('battle_win',{},{roll:always}),{mode:'template',line:'battle_win'});
 assert.deepEqual(planReaction('accident',{},{listeners:0,roll:never}),{mode:'template',line:'comfort'},'alone: comfort');
 assert.equal(planReaction('accident',{},{listeners:2,roll:never}),null,'in public: usually nothing');
 assert.deepEqual(planReaction('accident',{},{listeners:2,roll:always}),{mode:'slip',line:null},'...or a slip, with its Dignity rules');
 assert.equal(planReaction('quest',{},{knobs:{reactions_enabled:'off'}}),null,'switched off');
 assert.deepEqual([...REACTION_KINDS].sort(),Object.keys(GENERIC_REACTIONS).sort(),'every kind has fallback lines');
});

test('templates use the companion\'s own lines and fill placeholders',()=>{
 const line=fillTemplate(followerData.paladin_aegis,'boss_win',{player:'Doll',enemy:'the Ember Wyrm'},always);
 assert.equal(line,'the Ember Wyrm has fallen. You fought well, Doll.');
 assert.equal(fillTemplate({online:{}},'zone',{zone:'the Forest'},always),'So this is the Forest. Stay sharp.','no own lines: the generic ones');
 for(const [npc,def] of Object.entries(followerData))for(const kind of REACTION_KINDS)assert.ok((def.online.reactions?.[kind]??[]).length>=1,`${npc} has drafted ${kind} lines`);
});

function world({roll=never,listeners=0,tuning={}}={}){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-13T12:00:00Z');
 db.exec(`CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,name TEXT,state TEXT,revision INTEGER DEFAULT 0);
  CREATE TABLE quest_presence(character_id TEXT PRIMARY KEY,owner TEXT,zone TEXT,x INTEGER,y INTEGER,seen INTEGER);
  CREATE TABLE quest_chat(seq INTEGER PRIMARY KEY,zone TEXT,owner TEXT,character_id TEXT,name TEXT,text TEXT,created INTEGER,emote INTEGER,x INTEGER,y INTEGER);
  CREATE TABLE quest_chat_heard(seq INTEGER NOT NULL,character_id TEXT NOT NULL,PRIMARY KEY(seq,character_id));`);
 const followers=createFollowers(db,{enabled:true,now:()=>time}),geometry={width:20,height:20,entrance:{x:5,y:5},walls:[]},memory=createCompanionMemory(db,{now:()=>time,log:()=>{}});
 const doll={id:'doll',owner:'doll',name:'Doll',state:JSON.stringify({followerVersion:1,loadout:importLoadout({player_info:{class_id:'fighter',level:1},inventory:[]})})};
 db.prepare('INSERT INTO quest_characters(id,owner,name,state) VALUES (?,?,?,?)').run(doll.id,doll.owner,doll.name,doll.state);
 const npc='paladin_aegis',zone=followerData[npc].online.home_zone,at=followers.placement(npc,zone,geometry);
 db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?)').run('doll','doll',zone,at.x,at.y,time);
 const calls=[],state={listeners,reply:'We did it, Doll. I will remember this.',slip:false,hearers:[]};
 const chat=createFollowerChat(db,{followers,now:()=>time,memoryStore:memory,roll,slipTuning:()=>tuning,audience:()=>state.listeners,locate:(c,area)=>followers.chatTargets(c,{area,geometry}),
  stamp:()=>{const seq=db.prepare('SELECT MAX(seq) s FROM quest_chat').get().s;for(const id of state.hearers)db.prepare('INSERT OR IGNORE INTO quest_chat_heard VALUES (?,?)').run(seq,id);},
  fetcher:async(url,opts)=>{const path=new URL(url).pathname,body=JSON.parse(opts.body);calls.push({path,body});if(path==='/v1/companion/lore')return Response.json({ok:true});
   return Response.json({reply:state.reply,...(state.slip&&body.slip?{slip:{memory_id:body.slip.id}}:{})});}});
 const hire=()=>{followers.complete(followers.reserve(doll,JSON.parse(doll.state),{npc,request_id:'r1'},{zone,...at},geometry,['doll']),true);followers.move(doll,JSON.parse(doll.state),null,{zone,x:5,y:5},'room');};
 const settle=async()=>{chat.kick();for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,5));}};
 const lines=()=>db.prepare("SELECT text FROM quest_chat WHERE character_id='follower:paladin_aegis' ORDER BY seq").all().map(r=>r.text);
 return {db,followers,chat,memory,doll,zone,calls,state,hire,settle,lines,advance:ms=>{time+=ms;db.prepare('UPDATE quest_presence SET seen=?').run(time);},close:()=>{chat.close();memory.close();db.close();}};
}

test('a hire is greeted with a written line, a boss win gets an AI line, and the cooldown keeps it from chattering',async()=>{
 const w=world({roll:always});try{
  w.hire();await w.settle();
  assert.deepEqual(w.lines(),['Then I swear my shield to you, Doll.'],'the greeting goes at once, no AI call');
  assert.equal(w.calls.filter(c=>c.path==='/v1/companion/chat').length,0);
  w.followers.remember(w.doll,'battle_win',{zone:w.zone,enemy:'Rat'},{present:true});await w.settle();
  assert.equal(w.lines().length,1,'inside the cooldown: no remark');
  w.advance(181000);w.followers.remember(w.doll,'battle_win',{zone:w.zone,enemy:'Slime Knight',boss:true},{present:true});await w.settle();
  const ask=w.calls.find(c=>c.path==='/v1/companion/chat').body;
  assert.equal(ask.kind,'reaction');assert.match(ask.about,/Slime Knight/);assert.equal(w.lines().at(-1),'We did it, Doll. I will remember this.');
 }finally{w.close();}
});

test('accidents: comfort when alone; in public only a confirmed and heard slip, which costs Dignity',async()=>{
 const alone=world({roll:never});try{
  alone.hire();await alone.settle();alone.advance(181000);
  alone.followers.remember(alone.doll,'accident',{zone:alone.zone});await alone.settle();
  assert.equal(alone.lines().at(-1),'No one saw. I\'m right here. Let\'s take care of it.');
 }finally{alone.close();}
 const crowd=world({roll:always,listeners:2});try{
  crowd.hire();await crowd.settle();crowd.advance(181000);crowd.state.slip=true;crowd.state.hearers=['bea'];crowd.state.reply='Remember your little accident in the Forest, Doll?';
  crowd.followers.remember(crowd.doll,'accident',{zone:crowd.zone});await crowd.settle();
  const ask=crowd.calls.filter(c=>c.path==='/v1/companion/chat').at(-1).body;assert.ok(ask.slip,'the slip memory is offered');
  assert.equal(crowd.lines().at(-1),'Remember your little accident in the Forest, Doll?');
  assert.match(JSON.parse(crowd.db.prepare("SELECT state FROM quest_characters WHERE id='doll'").get().state).lastResult.log[0],/let something embarrassing slip/);
 }finally{crowd.close();}
});

test('no reaction mid-fight, offline, or after the AI budget runs out (a written line instead)',async()=>{
 const w=world({roll:always});try{
  w.hire();await w.settle();w.advance(181000);
  const s=JSON.parse(w.db.prepare("SELECT state FROM quest_characters WHERE id='doll'").get().state);s.run={phase:'fight'};w.db.prepare("UPDATE quest_characters SET state=? WHERE id='doll'").run(JSON.stringify(s));
  w.followers.remember(w.doll,'revived',{zone:w.zone},{present:true});await w.settle();assert.equal(w.lines().length,1,'mid-fight: quiet');
  delete s.run;w.db.prepare("UPDATE quest_characters SET state=? WHERE id='doll'").run(JSON.stringify(s));
  w.db.prepare('UPDATE quest_presence SET seen=0').run();w.followers.remember(w.doll,'revived',{zone:w.zone},{present:true});await w.settle();assert.equal(w.lines().length,1,'offline: quiet');
 }finally{w.close();}
 const b=world({roll:always,tuning:{ai_calls_per_minute:0}});try{ // No AI budget left: the written boss line instead.
  b.hire();await b.settle();b.advance(181000);
  b.followers.remember(b.doll,'battle_win',{zone:b.zone,enemy:'Slime Knight',boss:true},{present:true});await b.settle();
  assert.equal(b.calls.filter(c=>c.path==='/v1/companion/chat').length,0);assert.equal(b.lines().at(-1),'Slime Knight has fallen. You fought well, Doll.');
 }finally{b.close();}
});
