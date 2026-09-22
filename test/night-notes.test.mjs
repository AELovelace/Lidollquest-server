import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {awardExperience,MAX_LEVEL,MAX_STAT} from '../server/combat.mjs';

function fixture(){ /* Same in-memory harness as global-chat.test.mjs: two linked accounts, deterministic clock, no wallet side effects. */
 const db=new DatabaseSync(':memory:'),characters={},blocked={},muted=new Set();let now=Date.parse('2026-09-21T12:00:00Z'),api;
 const restart=()=>api=createQuestZones(db,{now:()=>now,grant:owner=>({owner,id:owner,client:'lidollquest',blockedAccounts:blocked[owner]??[]}),wallet:()=>({coins:0}),adjust:()=>{},muted:owner=>muted.has(owner)});
 restart();
 const read=owner=>api.read(owner,characters[owner]?.id);
 function command(owner,action,extra={}){const s=read(owner);return {action,request_id:randomUUID(),controller:owner,character_id:s.character?.id,revision:s.character?.revision,...(s.character?.dive?{edition:s.dive.edition}:{}),...extra};}
 const raw=(owner,input)=>{now+=250;const result=api.act(owner,input);characters[owner]=result.character;return result;};
 const act=(owner,action,extra)=>raw(owner,command(owner,action,extra));
 function player(owner,zone,info={}){act(owner,'create',{name:owner});return act(owner,'enter',{zone,loadout:{player_info:{playerHealth:100,playerHealthMax:100,str:10,def:10,dex:10,int:10,cha:10,level:10,stat_points:0,...info},inventory:[]},combat_version:3});}
 return {db,read,command,raw,act,player,blocked,muted,restart,advance:ms=>now+=ms,close:()=>db.close()};
}

test('/me stores an emote flag, strips the prefix and rejects other slash commands',()=>{
 const f=fixture();try{
  f.player('Alice','honeydew-lantern');f.player('Bob','honeydew-lantern');
  f.act('Alice','chat',{text:'/me waves at everyone'});
  const seen=f.read('Bob').chat.at(-1);
  assert.equal(seen.text,'waves at everyone');assert.equal(seen.emote,true);assert.equal(seen.name,'Alice'); // The client renders "* Alice waves at everyone".
  f.act('Alice','chat',{text:'plain speech'});assert.equal(f.read('Bob').chat.at(-1).emote,false);
  assert.throws(()=>f.act('Alice','chat',{text:'/me'}),/Describe the action/);
  assert.throws(()=>f.act('Alice','chat',{text:'/dance wildly'}),/Unknown chat command/);
  assert.equal(f.read('Alice').emoteSupport,true);
 }finally{f.close();}
});

test('party chat reaches only party members and follows them across hubs',()=>{
 const f=fixture();try{
  f.player('Alice','honeydew-lantern');f.player('Bob','honeydew-lantern');f.player('Cara','honeydew-lantern');
  assert.throws(()=>f.act('Alice','chat',{channel:'party',text:'nobody yet'}),/Join a party/);
  const bob=f.read('Bob').character.id;
  f.act('Alice','party_invite',{member:bob});
  const invite=f.read('Bob').partyInvitations[0];f.act('Bob','party_accept',{invitation:invite.id});
  f.act('Alice','chat',{channel:'party',text:'secret plan'});
  assert.equal(f.read('Bob').partyChat.at(-1).text,'secret plan');assert.equal(f.read('Bob').partyChat.at(-1).channel,'party');
  assert.equal(f.read('Cara').partyChat.length,0);assert.equal(f.read('Cara').chat.length,0); // Never leaks into area speech.
  assert.equal(f.read('Bob').partyChatSupport,true);
  f.act('Bob','enter',{zone:'littlebig-clockwork',combat_version:3});assert.equal(f.read('Bob').partyChat.at(-1).text,'secret plan'); // Scoped by party id, not by room.
  f.act('Bob','party_leave');assert.equal(f.read('Bob').partyChat.length,0);
 }finally{f.close();}
});

test('Ctrl+direction facing is stored and shown to other players; walking also turns the avatar',()=>{
 const f=fixture();try{
  f.player('Alice','honeydew-lantern');f.player('Bob','honeydew-lantern');
  const alice=f.read('Alice').character.id;
  f.act('Alice','face',{direction:'west'});
  assert.equal(f.read('Bob').peers.find(p=>p.id===alice).facing,3);
  assert.equal(f.read('Alice').facingSupport,true);
  assert.throws(()=>f.act('Alice','face',{direction:'up'}),/facing direction/);
  const before=f.read('Alice').character;
  f.act('Alice','face',{direction:'north'});
  assert.equal(f.read('Bob').peers.find(p=>p.id===alice).facing,1);
  f.advance(1000);f.act('Alice','move',{direction:'east'});
  assert.equal(f.read('Bob').peers.find(p=>p.id===alice).facing,2);
  assert.equal(before.revision<f.read('Alice').character.revision,true); // Facing is a journaled command like any other.
 }finally{f.close();}
});

test('stats stop at 100 and levels stop at 100',()=>{
 const f=fixture();try{
  f.player('Alice','honeydew-lantern',{str:MAX_STAT,stat_points:2});
  assert.throws(()=>f.act('Alice','allocate',{stat:'str'}),/maximum of 100/);
  f.act('Alice','allocate',{stat:'def'}); // Banked points still spend on other stats.
  const info=f.read('Alice').character.loadout.player_info;assert.equal(info.def,11);assert.equal(info.stat_points,1);
  assert.equal(f.read('Alice').levelCap,MAX_LEVEL);assert.equal(f.read('Alice').statCap,MAX_STAT);
  const state={run:{enemy:{exp:10000000},log:[],maxHp:50,hp:50},loadout:{player_info:{level:98,xp:0,stat_points:0,playerHealthMax:50,shame:0,class_id:'fighter'}}};
  awardExperience(state,()=>0.5);
  assert.equal(state.loadout.player_info.level,MAX_LEVEL);assert.equal(state.loadout.player_info.xp<50*MAX_LEVEL,true); // Two level-ups then the cap holds XP under the next threshold.
  awardExperience(state,()=>0.5);assert.equal(state.loadout.player_info.level,MAX_LEVEL);assert.match(state.run.log.at(-1),/maximum/);
 }finally{f.close();}
});
