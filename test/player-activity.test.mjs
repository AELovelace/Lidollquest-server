import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

test('shared activity commits once, remains area-scoped and does not consume player chat quota',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.now(),api;const characters={};
 const setup=()=>api=createQuestZones(db,{now:()=>time,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});setup();
 const body=(owner,action,extra={})=>({action,controller:owner,character_id:characters[owner]?.id,revision:characters[owner]?.revision,request_id:randomUUID(),...extra});
 const send=(owner,input)=>{time+=400;const value=api.act(owner,input);characters[owner]=value.character;return value;};
 const act=(owner,action,extra)=>send(owner,body(owner,action,extra));
 const notes=owner=>api.read(owner,characters[owner].id).chat.filter(m=>m.name==='Activity');
 try{
  for(const owner of ['Alice','Bob','Carol']){act(owner,'create',{name:owner});act(owner,'enter',{zone:owner==='Carol'?'princess-rose':'honeydew-lantern',loadout:{player_info:{online_accident_seq:4,online_change_seq:2},inventory:[]}});}
  assert.equal(notes('Alice').length,0,'joining with old events never broadcasts them');
  act('Alice','move',{direction:'east',world_step:true});
  const loadout=structuredClone(characters.Alice.loadout);loadout.player_info.online_accident_seq=6;
  const accident=body('Alice','world_turn',{world_turn_id:characters.Alice.worldTurnDue.id,loadout});
  send('Alice',accident);send('Alice',accident);setup();send('Alice',accident);
  assert.deepEqual(notes('Bob').map(n=>n.text),['Alice had an accident.']);assert.equal(notes('Carol').length,0);
  const changed=structuredClone(characters.Alice.loadout);changed.player_info.online_change_seq++;
  const change=body('Alice','loadout',{loadout:changed});send('Alice',change);send('Alice',change);
  assert.deepEqual(notes('Alice').map(n=>n.text),['Alice had an accident.','Alice changed their diaper.']);
  act('Alice','heartbeat');act('Alice','loadout',{loadout:changed});assert.equal(notes('Bob').length,2,'heartbeat and unchanged drafts stay quiet');
  for(let n=0;n<5;n++)act('Alice','chat',{text:'Chat '+n}); // Automatic activity uses a separate owner bucket, leaving the normal five-message quota intact.
  assert.throws(()=>act('Alice','chat',{text:'too soon'}),/Wait a moment/);
  const stale=structuredClone(changed);stale.player_info.online_accident_seq=0;act('Alice','loadout',{loadout:stale});
  assert.equal(characters.Alice.loadout.player_info.online_accident_seq,6);
  const rejected=structuredClone(changed);rejected.player_info.online_change_seq++;
  assert.throws(()=>act('Alice','world_turn',{world_turn_id:'missing',loadout:rejected}),/no longer pending/);
  assert.equal(notes('Bob').length,2,'failed commands do not announce changes');
  const suspense=structuredClone(characters.Alice.loadout);suspense.player_info.online_hold_seq=1;suspense.player_info.online_excitement_seq=1;
  const publicEvents=body('Alice','loadout',{loadout:suspense});send('Alice',publicEvents);send('Alice',publicEvents);
  assert.deepEqual(notes('Bob').slice(-2).map(n=>n.text),['Alice fidgets and shifts their weight around','Uh-Oh, Alice got way too excited in public ;)']);
  assert.ok(notes('Bob').every(n=>n.activity===1));
  assert.ok(api.read('Alice',characters.Alice.id).chat.filter(n=>n.name!=='Activity').every(n=>n.activity===0));
  assert.equal(notes('Carol').length,0,'fidgeting and excitement also remain in the current area');
 }finally{db.close();}
});

test('Dive activity uses the committed room, route and weekly edition',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.now(),c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=400;const s=api.act('',{action,controller:'a',character_id:c?.id,revision:c?.revision,request_id:randomUUID(),...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 try{
  act('create',{name:'Alice'});act('enter',{zone:'princess-rose',loadout:{player_info:{},inventory:[]}});
  db.prepare('UPDATE quest_presence SET x=9,y=0 WHERE character_id=?').run(c.id);
  act('hub_visit',{zone:'princess-rose-dives'});
  db.prepare('UPDATE quest_presence SET x=6,y=5 WHERE character_id=?').run(c.id);
  const entered=act('dive_enter',{zone:'dive-quarters'}),loadout=structuredClone(c.loadout);loadout.player_info.online_accident_seq=1;
  const result=act('loadout',{loadout});assert.equal(result.chat.at(-1).text,'Alice had an accident.');
  assert.equal(db.prepare('SELECT zone FROM quest_chat').get().zone,entered.chatArea.id);
  act('dive_exit');assert.equal(api.read('',c.id).chat.some(m=>m.name==='Activity'),false,'route notices do not leak into the hall');
 }finally{db.close();}
});
