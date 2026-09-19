import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:'),characters={},blocked={},muted=new Set();let now=Date.parse('2026-09-19T12:00:00Z'),api;
 const restart=()=>api=createQuestZones(db,{now:()=>now,grant:owner=>({owner,id:owner,client:'lidollquest',blockedAccounts:blocked[owner]??[]}),wallet:()=>({coins:0}),adjust:()=>{},muted:owner=>muted.has(owner)});
 restart();
 const read=owner=>api.read(owner,characters[owner]?.id);
 function command(owner,action,extra={}){const s=read(owner);return {action,request_id:randomUUID(),controller:owner,character_id:s.character?.id,revision:s.character?.revision,...(s.character?.dive?{edition:s.dive.edition}:{}),...extra};}
 const raw=(owner,input)=>{now+=250;const result=api.act(owner,input);characters[owner]=result.character;return result;};
 const act=(owner,action,extra)=>raw(owner,command(owner,action,extra));
 function player(owner,zone){act(owner,'create',{name:owner});return act(owner,'enter',{zone,loadout:{player_info:{playerHealth:100,playerHealthMax:100,str:10,def:10,dex:10,int:10,level:10,stat_points:0},inventory:[]},combat_version:3});}
 return {db,read,command,raw,act,player,blocked,muted,restart,advance:ms=>now+=ms,close:()=>db.close()};
}

test('global speech crosses hubs, stays distinct from area speech, and retries publish once',()=>{
 const f=fixture();try{
  f.player('Alice','honeydew-lantern');f.player('Bob','littlebig-clockwork');
  f.act('Alice','chat',{text:'Area only'}); // A legacy client with no channel still sends only to its current area.
  const input=f.command('Alice','chat',{channel:'global',text:'Across the world'}),first=f.raw('Alice',input);
  assert.equal(first.globalChatSupport,true);assert.equal(first.chat.at(-1).text,'Area only');
  const other=f.read('Bob');assert.equal(other.chat.length,0);assert.equal(other.globalChat.at(-1).text,'Across the world');
  assert.equal(other.globalChat.at(-1).channel,'global');assert.equal(other.globalChat.at(-1).owner,undefined);
  f.raw('Alice',input);assert.equal(f.read('Bob').globalChat.length,1);
  assert.throws(()=>f.raw('Alice',{...input,channel:'area'}),/another action/);
  assert.throws(()=>f.act('Alice','chat',{channel:'both',text:'bad destination'}),/Area or OOC/);
  assert.throws(()=>f.act('Alice','move',{channel:'global',direction:'left'}),/Area or OOC/);
  f.restart();assert.equal(f.read('Bob').globalChat.length,1);
  f.act('Alice','enter',{zone:'littlebig-clockwork'});const moved=f.read('Alice');assert.equal(moved.chat.length,0);assert.equal(moved.globalChat.length,1);
 }finally{f.close();}
});

test('blocks, mutes and the account spam budget apply to both chat channels',()=>{
 const f=fixture();try{
  f.player('Alice','honeydew-lantern');f.player('Bob','honeydew-lantern');
  f.act('Alice','chat',{channel:'area',text:'Area hello'});f.act('Alice','chat',{channel:'global',text:'Global hello'});
  f.blocked.Bob=['Alice'];assert.equal(f.read('Bob').chat.length,0);assert.equal(f.read('Bob').globalChat.length,0);
  f.blocked.Bob=[];assert.equal(f.read('Bob').globalChat.length,1);
  f.muted.add('Alice');for(const channel of ['area','global'])assert.throws(()=>f.act('Alice','chat',{channel,text:'muted'}),/muted/);
  f.muted.delete('Alice');for(let i=0;i<3;i++)f.act('Alice','chat',{channel:i%2?'area':'global',text:'Budget '+i});
  for(const channel of ['area','global'])assert.throws(()=>f.act('Alice','chat',{channel,text:'over budget'}),error=>error.status===429);
  f.advance(11000);f.act('Alice','chat',{channel:'global',text:'After cooldown'});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM quest_chat WHERE owner='Alice'").get().n,6);
 }finally{f.close();}
});

test('dungeon rooms keep area boundaries while OOC reaches other rooms and hubs with mute enforcement',()=>{
 const f=fixture();try{
  f.player('Alice','princess-rose');f.player('Bob','princess-rose');f.player('Cara','honeydew-lantern');
  f.act('Alice','dive_enter');const entered=f.act('Bob','dive_enter');
  const room=entered.zones.find(z=>z.id==='dive-quarters').rooms[1];
  f.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(room.x,room.y,f.read('Bob').character.id);
  f.act('Alice','chat',{text:'At the entrance'});f.act('Alice','chat',{channel:'global',text:'Dungeon OOC'});
  assert.equal(f.read('Bob').chat.length,0);assert.equal(f.read('Bob').globalChat.at(-1).text,'Dungeon OOC');
  assert.equal(f.read('Cara').globalChat.at(-1).text,'Dungeon OOC');
  f.act('Cara','chat',{channel:'global',text:'Hub reply'});assert.equal(f.read('Alice').globalChat.at(-1).text,'Hub reply');
  f.muted.add('Alice');for(const channel of ['area','global'])assert.throws(()=>f.act('Alice','chat',{channel,text:'muted in dungeon'}),/muted/);
  f.muted.delete('Alice');assert.throws(()=>f.act('Alice','chat',{channel:'global',text:'stale',edition:'old'}),/edition changed/);
 }finally{f.close();}
});

test('global history remains bounded, expires, sanitizes text and requires live presence to send',()=>{
 const f=fixture();try{
  f.player('Alice','honeydew-lantern');f.act('Alice','chat',{channel:'global',text:'hello#\nworld'});
  assert.equal(f.read('Alice').globalChat[0].text,'hello  world');
  const insert=f.db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created) VALUES (?,?,?,?,?,?)');
  for(let i=0;i<110;i++)insert.run('global:ooc','Bob','synthetic','Bob','old '+i,Date.parse('2026-09-19T12:00:00Z'));
  f.act('Alice','chat',{channel:'global',text:'Latest'});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM quest_chat WHERE zone='global:ooc'").get().n,100);
  assert.equal(f.read('Alice').globalChat.length,40);assert.equal(f.read('Alice').globalChat.at(-1).text,'Latest');
  f.advance(86400001);assert.equal(f.read('Alice').globalChat.length,0);
  assert.throws(()=>f.act('Alice','chat',{channel:'global',text:'expired presence'}),/connection|Enter|enter/);
 }finally{f.close();}
});
