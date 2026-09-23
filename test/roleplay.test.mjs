import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createQuestZones} from '../server/zones.mjs';
import {createRoleplay} from '../server/roleplay.mjs';

function fixture(filename=':memory:'){
 const db=new DatabaseSync(filename),blocked={},muted=new Set();let now=Date.parse('2026-09-19T12:00:00Z');
 const api=createQuestZones(db,{now:()=>now,grant:owner=>({owner,id:owner,client:'lidollquest',blockedAccounts:blocked[owner]??[]}),wallet:()=>({coins:0}),adjust:()=>{},muted:owner=>muted.has(owner)}),ids={};
 const read=owner=>api.read(owner,ids[owner]);
 const command=(owner,action,extra={})=>{const s=read(owner);return {action,request_id:randomUUID(),controller:owner,character_id:s.character?.id,revision:s.character?.revision,...(s.character?.dive?{edition:s.dive.edition}:{}),...extra};};
 const raw=(owner,input)=>{now+=100;const s=api.act(owner,input);ids[owner]=s.character.id;return s;};
 const act=(owner,action,extra)=>raw(owner,command(owner,action,extra));
 function player(owner,zone='princess-rose'){act(owner,'create',{name:owner});return act(owner,'enter',{zone,loadout:{player_info:{playerHealth:80,playerHealthMax:100,str:10,def:10,dex:10,int:10,level:2,stat_points:0,xp:12,class_id:'mage'},inventory:[]},combat_version:3});}
 const rp=createRoleplay(db,{now:()=>now,roll:()=>0});
 return {db,ids,api,rp,blocked,muted,read,raw,act,command,player,advance:ms=>now+=ms,close:()=>db.close()};
}
test('RP read cursor survives database reopen, remains character-specific and allows later posts',()=>{
 const directory=mkdtempSync(join(tmpdir(),'quest-rp-read-')),filename=join(directory,'quest.sqlite'),f=fixture(filename);let reopened;
 try{
  f.player('Alice');f.player('Bob');f.player('Cara');
  const id=f.act('Alice','rp_post',{text:'A saved scene.',partners:[f.ids.Bob,f.ids.Cara]}).receipt.rpId;
  const before=f.read('Bob');assert.equal(before.rp.seen,0);
  const command=f.command('Bob','rp_read',{rp_id:id}),opened=f.raw('Bob',command);
  assert.equal(opened.rp.seen,id,'Read response already contains the durable cursor');assert.equal(opened.character.revision,before.character.revision);
  f.raw('Bob',command);assert.equal(f.read('Cara').rp.seen,0,'Other recipients have their own read state');
  f.advance(11000);f.act('Bob','heartbeat');
  const next=f.act('Alice','rp_post',{text:'A new scene.',partners:[f.ids.Bob]}).receipt.rpId;
  assert.ok(next>f.read('Bob').rp.seen,'New posts still notify after a read');
  f.act('Bob','rp_read',{rp_id:next});f.act('Bob','rp_read',{rp_id:id});assert.equal(f.read('Bob').rp.seen,next,'Reopening older history never rewinds delivery');
  f.close();reopened=new DatabaseSync(filename);const rp=createRoleplay(reopened),bob=reopened.prepare('SELECT * FROM quest_characters WHERE id=?').get(f.ids.Bob);
  assert.equal(rp.snapshot(bob,'princess-rose').seen,next,'Fresh process state reads the persisted cursor');
  assert.equal(rp.read(bob,id,'princess-rose').text,'A saved scene.','Read history remains available');
 }finally{if(reopened)reopened.close();else if(f.db.isOpen)f.close();rmSync(directory,{recursive:true,force:true});}
});
test('unavailable RP reads and ordinary snapshots never advance delivery state',()=>{
 const f=fixture();try{
  f.player('Alice');f.player('Bob');f.player('Cara','honeydew-lantern');
  const id=f.act('Alice','rp_post',{text:'A shared scene.',partners:[f.ids.Bob]}).receipt.rpId;
  assert.equal(f.read('Bob').rp.seen,0);assert.equal(f.read('Bob').rp.seen,0);
  assert.throws(()=>f.act('Cara','rp_read',{rp_id:id}),/not available/);assert.equal(f.read('Cara').rp.seen,0);
  f.blocked.Bob=['Alice'];assert.throws(()=>f.act('Bob','rp_read',{rp_id:id}),/not available/);assert.equal(f.read('Bob').rp.seen,0);
  assert.throws(()=>f.act('Bob','rp_read',{rp_id:999999}),/not available/);assert.equal(f.db.prepare('SELECT count(*) n FROM quest_rp_reads').get().n,0);
 }finally{f.close();}
});
test('shared RP persists paragraphs, appearance, notices and author-only counts exactly once',()=>{
 const f=fixture();try{
  f.player('Alice');f.player('Bob');f.player('Cara');
  const text="Café doors open.\n\nAlice waves—hello, Bob!",cmd=f.command('Alice','rp_post',{text,partners:[f.ids.Bob]});
  const posted=f.raw('Alice',cmd),id=posted.receipt.rpId;
  assert.equal(posted.rp.progress.total_words,7);assert.equal(posted.rp.progress.level_chars,Array.from(text).length);
  assert.equal(posted.chat.at(-1).text,'Alice posted an rp');assert.equal(posted.chat.at(-1).rpId,id);assert.equal(posted.globalChat.length,0);
  assert.equal(f.read('Bob').rp.posts[0].id,id);assert.equal(f.read('Bob').rp.progress.total_words,0);assert.equal(f.read('Cara').rp.posts.length,0);
  const body=f.act('Bob','rp_read',{rp_id:id}).receipt.rpPost;assert.equal(body.text,text);assert.equal(body.appearance.name,'Alice');assert.equal(body.appearance.account_id,undefined);assert.equal(body.appearance.player_info.inventory,undefined);
  assert.equal(f.act('Cara','rp_read',{rp_id:id}).receipt.rpPost.text,text,'Area notice readers can open the same narrative');
  f.raw('Alice',cmd);assert.equal(f.read('Alice').rp.progress.total_words,7);assert.equal(f.db.prepare('SELECT count(*) n FROM quest_rp_posts').get().n,1);
  assert.throws(()=>f.raw('Alice',{...cmd,text:'Different'}),/another action/);
  const fresh=createRoleplay(f.db);assert.equal(fresh.journal().posts[0].text,text);
 }finally{f.close();}
});
test('RP partners follow area chat; blocks, mute, presence and input bounds cannot be bypassed',()=>{
 const f=fixture();try{
  f.player('Alice');f.player('Bob');f.player('Cara','honeydew-lantern');
  assert.deepEqual(f.read('Alice').rp.candidates.map(c=>c.name),['Bob']);
  for(const partners of [[],[f.ids.Alice],[f.ids.Cara],[f.ids.Bob,f.ids.Bob]])assert.throws(()=>f.act('Alice','rp_post',{text:'Hello',partners}));
  for(const text of ['', '  !!! ', 'a'.repeat(12001)])assert.throws(()=>f.act('Alice','rp_post',{text,partners:[f.ids.Bob]}));
  f.blocked.Alice=['Bob'];assert.equal(f.read('Alice').rp.candidates.length,0);assert.throws(()=>f.act('Alice','rp_post',{text:'Hello',partners:[f.ids.Bob]}));f.blocked.Alice=[];
  f.muted.add('Alice');assert.throws(()=>f.act('Alice','rp_post',{text:'Hello',partners:[f.ids.Bob]}),/muted/);f.muted.clear();
  const id=f.act('Alice','rp_post',{text:'Hello friend',partners:[f.ids.Bob]}).receipt.rpId;
  assert.throws(()=>f.act('Alice','rp_post',{text:'Too soon',partners:[f.ids.Bob]}),/ten seconds/);
  assert.throws(()=>f.act('Cara','rp_read',{rp_id:id}),/not available/);
  f.blocked.Bob=['Alice'];assert.equal(f.read('Bob').rp.posts.length,0);assert.equal(f.read('Bob').chat.length,0);assert.throws(()=>f.act('Bob','rp_read',{rp_id:id}),/not available/);
  f.advance(31000);assert.throws(()=>f.act('Alice','rp_read',{rp_id:id}),/connection|Enter/);
  assert.equal(f.rp.journal().total,1);
 }finally{f.close();}
});
test('dungeon partner selection uses room and edition boundaries, while partners retain their shared history after moving',()=>{
 const f=fixture();try{
  f.player('Alice');f.player('Bob');f.act('Alice','dive_enter');let s=f.act('Bob','dive_enter');
  const id=f.act('Alice','rp_post',{text:'We explore together.',partners:[f.ids.Bob]}).receipt.rpId;
  const room=s.zones.find(z=>z.id==='dive-quarters').rooms[1];f.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(room.x,room.y,f.ids.Bob);
  assert.equal(f.read('Alice').rp.candidates.length,0);assert.equal(f.act('Bob','rp_read',{rp_id:id}).receipt.rpPost.text,'We explore together.');
  f.advance(11000);assert.throws(()=>f.act('Alice','rp_post',{text:'Different room',partners:[f.ids.Bob]}),/area-chat/);
 }finally{f.close();}
});
test('admin RP awards grant exactly one normal level, grow the target, and reject duplicate or ineligible awards',()=>{
 const f=fixture();try{
  f.player('Alice');f.player('Bob');const text=Array(1000).fill('story').join(' ');
  f.act('Alice','rp_post',{text,partners:[f.ids.Bob]});const before=f.read('Alice'),p=before.character.loadout.player_info;
  const input={character_id:f.ids.Alice,expected_awards:0,expected_level:p.level,reason:'Reviewed the shared scene.'};
  const result=f.rp.award(input,'Admin');assert.equal(result.level,p.level+1);
  const after=f.read('Alice');assert.equal(after.character.loadout.player_info.xp,p.xp);assert.equal(after.character.loadout.player_info.stat_points,p.stat_points+3);assert.equal(after.character.loadout.player_info.playerHealthMax,p.playerHealthMax+5); // One level on the HP curve.
  assert.equal(after.rpp.freePicks,1,'An admin-awarded mage level grants one stored choice');assert.deepEqual(after.character.loadout.player_spells,before.character.loadout.player_spells);
  assert.equal(after.rp.progress.target,1500);assert.equal(after.rp.progress.total_words,1000);assert.equal(after.rp.progress.level_words,0);assert.equal(after.rp.progress.level_chars,0);
  assert.throws(()=>f.rp.award(input,'Admin'),/Progress changed/);assert.throws(()=>f.rp.award({...input,expected_awards:1,expected_level:3},'Admin'),/not reached/);
  assert.equal(f.rp.journal({character:f.ids.Alice}).awards.length,1);assert.equal(f.rp.journal({character:f.ids.Bob}).posts.length,1);
  assert.equal(f.rp.journal({search:'Bob'}).total,1);assert.equal(f.rp.journal({search:'not present'}).total,0);
 }finally{f.close();}
});
test('ordinary level changes reset current counters while lifetime word and character totals remain',()=>{
 const f=fixture();try{
  f.player('Alice');f.player('Bob');f.act('Alice','rp_post',{text:'One two three',partners:[f.ids.Bob]});
  const state=f.read('Alice').character;state.loadout.player_info.level++;
  f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),f.ids.Alice);
  const progress=f.read('Alice').rp.progress;assert.equal(progress.level_chars,0);assert.equal(progress.level_words,0);assert.equal(progress.total_chars,13);assert.equal(progress.total_words,3);assert.equal(progress.target,1000);
 }finally{f.close();}
});
