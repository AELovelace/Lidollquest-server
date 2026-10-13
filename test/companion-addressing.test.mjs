import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFollowers,followerData} from '../server/followers.mjs';
import {createFollowerChat} from '../server/follower-chat.mjs';
import {addressees,nameMatch,gateSaysYes,ADDRESS_DEFAULTS} from '../server/companion-addressing.mjs';
import {importLoadout} from '../server/loadout.mjs';

// COMPANION_LIFELIKE_PLAN.md phase A: who a line is meant for. Names, typos and nicknames, 3-minute follow-ups within
// earshot, the hirer's lines (classifier-gated when others are around), "you" to the only companion nearby, and emotes.

const catalog={...followerData,paladin_aegis:{...followerData.paladin_aegis,online:{...followerData.paladin_aegis.online,nicknames:['shield lady']}}};
const elowen={npc:'paladin_aegis',rental:'r-elowen'},astra={npc:'sorceress_arcana',rental:'r-astra'};
const pick=(text,o={})=>addressees({text,targets:[elowen],catalog,speaker:'doll',...o}).map(p=>`${p.target.npc}:${p.reason}:${p.gate?'gate':'go'}`);

test('names, one-letter typos and GM nicknames; short words never fuzzy-match',()=>{
 assert.equal(nameMatch('Elowen, hi!',catalog.paladin_aegis),'name');
 assert.equal(nameMatch('elwen are you ok',catalog.paladin_aegis),'fuzzy','one letter missing');
 assert.equal(nameMatch('Elowne, wait up',catalog.paladin_aegis),'fuzzy','two letters swapped');
 assert.equal(nameMatch('hey shield lady!',catalog.paladin_aegis),'fuzzy','a GM nickname');
 assert.equal(nameMatch('elbow pain',catalog.paladin_aegis),null);
 assert.equal(nameMatch('Elwen hi',catalog.paladin_aegis,{fuzzy:false}),null,'fuzzy_names off');
 assert.equal(nameMatch('Mira!',catalog.merchant_mira),'name');assert.equal(nameMatch('Mora!',catalog.merchant_mira),null,'4-letter names never fuzzy-match');
});

test('who answers: names first, then an open conversation, then the hirer, then "you" to the only companion nearby',()=>{
 assert.deepEqual(pick('Elowen, hi!'),['paladin_aegis:name:go']);
 assert.deepEqual(addressees({text:'Astra and Elowen, hello',targets:[elowen,astra],catalog,speaker:'doll'}).map(p=>p.target.npc).sort(),['paladin_aegis','sorceress_arcana']);
 assert.deepEqual(pick('glad to hear it',{convo:[{npc:'paladin_aegis'}]}),['paladin_aegis:followup:go'],'a follow-up, alone');
 assert.deepEqual(pick('glad to hear it',{convo:[{npc:'paladin_aegis'}],listeners:2}),['paladin_aegis:followup:gate'],'others around: ask the classifier');
 assert.deepEqual(addressees({text:'Astra, hi',targets:[elowen,astra],catalog,speaker:'doll',convo:[{npc:'paladin_aegis'}]}).map(p=>p.target.npc),['sorceress_arcana'],'naming another companion turns to them');
 const hire={npc:'paladin_aegis',id:'r-elowen'};
 assert.deepEqual(pick('what a day',{hire}),['paladin_aegis:hirer:go'],'the hirer, alone');
 assert.deepEqual(pick('what a day',{hire,listeners:1}),['paladin_aegis:hirer:gate'],'the hirer with others around: classifier');
 assert.deepEqual(pick('what a day',{hire,tuning:{hirer_default:'off'}}),[]);
 assert.deepEqual(pick('how are you?'),['paladin_aegis:you:gate'],'"you" to the only companion nearby');
 assert.deepEqual(pick('how are you?',{targets:[elowen,astra]}),[],'two companions: say a name');
 assert.deepEqual(pick('nice weather'),[],'nothing addressed');
});

test('crowded places fall back to names; emotes need a name and can be switched off',()=>{
 const hire={npc:'paladin_aegis',id:'r-elowen'},busy=ADDRESS_DEFAULTS.busy_threshold;
 assert.deepEqual(pick('what a day',{hire,listeners:busy}),[],'busy hub: the hirer must use the name');
 assert.deepEqual(pick('how are you?',{listeners:busy}),[]);
 assert.deepEqual(pick('glad to hear it',{convo:[{npc:'paladin_aegis'}],listeners:busy}),['paladin_aegis:followup:gate'],'the same speaker keeps their conversation');
 assert.deepEqual(pick('hugs Elowen',{emote:true}),['paladin_aegis:name:go']);
 assert.deepEqual(pick('hugs Elowen',{emote:true,tuning:{emote_replies:'off'}}),[]);
 assert.deepEqual(pick('waves at you',{emote:true}),[],'emotes never take the "you" guess');
 assert.equal(gateSaysYes('YES.'),true);assert.equal(gateSaysYes(' no'),false);assert.equal(gateSaysYes(''),false);
});

function world(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-13T12:00:00Z');
 db.exec(`CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,name TEXT,state TEXT,revision INTEGER DEFAULT 0);
  CREATE TABLE quest_presence(character_id TEXT PRIMARY KEY,owner TEXT,zone TEXT,x INTEGER,y INTEGER,seen INTEGER);
  CREATE TABLE quest_chat(seq INTEGER PRIMARY KEY,zone TEXT,owner TEXT,character_id TEXT,name TEXT,text TEXT,created INTEGER,emote INTEGER,x INTEGER,y INTEGER);`);
 const followers=createFollowers(db,{enabled:true,now:()=>time}),geometry={width:20,height:20,entrance:{x:5,y:5},walls:[]};
 const doll={id:'doll',owner:'doll',name:'Doll',state:JSON.stringify({followerVersion:1,loadout:importLoadout({player_info:{class_id:'fighter',level:1},inventory:[]})})};
 db.prepare('INSERT INTO quest_characters(id,owner,name,state) VALUES (?,?,?,?)').run(doll.id,doll.owner,doll.name,doll.state);
 const npc='paladin_aegis',zone=followers.catalog[npc].online.home_zone,at=followers.placement(npc,zone,geometry);
 db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?)').run('doll','doll',zone,at.x,at.y,time);
 followers.complete(followers.reserve(doll,JSON.parse(doll.state),{npc,request_id:'r1'},{zone,...at},geometry,['doll']),true);followers.move(doll,JSON.parse(doll.state),null,{zone,x:5,y:5},'room');
 return {db,followers,geometry,doll,now:()=>time,advance:n=>{time+=n;db.prepare('UPDATE quest_presence SET seen=?').run(time);}};
}

test('through the chat queue: a reply opens a 3-minute conversation; unclear lines ask the classifier; emotes become actions',async()=>{
 const w=world();let listeners=0,gateAnswer='YES';const calls=[];
 const chat=createFollowerChat(w.db,{followers:w.followers,now:w.now,audience:()=>listeners,roll:()=>1,locate:(c,area)=>w.followers.chatTargets(c,{area,geometry:w.geometry}),
  fetcher:async(url,opts)=>{const path=new URL(url).pathname,body=JSON.parse(opts.body);calls.push({path,body});
   if(path==='/v1/chat/completions')return Response.json({choices:[{message:{content:gateAnswer}}]});
   return Response.json({reply:'Of course, Doll.'});}});
 const say=async(text,seq,o={})=>{chat.enqueue(w.doll,text,seq,'room',o);chat.kick();for(let i=0;i<100&&!chat.idle();i++)await new Promise(r=>setTimeout(r,5));};
 const replies=()=>w.db.prepare("SELECT COUNT(*) n FROM quest_chat WHERE character_id LIKE 'follower:%'").get().n;
 try{
  await say('Elowen, how are you?',1);assert.equal(replies(),1);
  w.advance(5000);listeners=2;await say('glad to hear it',2); // Follow-up with others around: classifier says yes.
  assert.equal(replies(),2);assert.match(calls.find(c=>c.path==='/v1/chat/completions').body.messages[0].content,/natural for Dame Elowen to answer/);
  w.advance(5000);gateAnswer='NO';await say('anyway, where is everyone',3); // The classifier says no: quietly skipped.
  assert.equal(replies(),2);
  w.advance(200000);gateAnswer='YES';listeners=0;await say('still there?',4); // Over 3 minutes later, but she's the hirer's companion and they're alone.
  assert.equal(replies(),3);
  w.advance(5000);await say('hugs Elowen',5,{emote:true});
  const emote=calls.filter(c=>c.path==='/v1/companion/chat').at(-1).body;assert.equal(emote.kind,'emote');assert.equal(emote.message,'*Doll hugs Elowen*');
  assert.ok(w.db.prepare('SELECT until FROM quest_follower_convo WHERE npc=? AND speaker=?').get('paladin_aegis','doll').until>w.now(),'the conversation stays open after each reply');
 }finally{chat.close();w.db.close();}
});
