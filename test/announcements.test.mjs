import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createQuestService} from '../server/service.mjs';
import {createAnnouncements} from '../server/announcements.mjs';

const staffToken='s'.repeat(43),staff='a'.repeat(64);  // A LiDollID account holding the gamemaster role.
const playerToken='p'.repeat(43),owner='o'.repeat(64); // An ordinary player.
const loadout={player_info:{playerHealth:50,playerHealthMax:50,level:2,str:10,def:10,dex:10,int:10,cha:2},inventory:[],player_spells:[]};

function harness(){ // Drives the player gateway and the /gm panel exactly as the game and the browser do.
 let now=Date.parse('2026-09-23T12:00:00Z');
 const accounts={[staffToken]:{owner:staff,gamemaster:true},[playerToken]:{owner,gamemaster:false}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant-'+a.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({now:()=>now,walletClient,gmEnabled:true});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const held={},base=()=>'http://127.0.0.1:'+service.server.address().port;
 async function play(secret,action,extra={}){
  now+=500;
  const body={action,character_id:held[secret]?.id,revision:held[secret]?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch(base()+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(result.character)held[secret]=result.character;
  return {status:response.status,result};
 }
 const ok=async(secret,action,extra={})=>{const r=await play(secret,action,extra);assert.equal(r.status,200,JSON.stringify(r.result));return r.result;};
 const join=async(secret,name,zone)=>{await ok(secret,'create',{name});return ok(secret,'enter',{zone,loadout,quest_version:1,content_version:1,combat_version:3});};
 const gm=async(path,init={})=>{const response=await fetch(base()+path,{method:init.method??'GET',headers:{Authorization:'Bearer '+(init.token??staffToken),...(init.body?{'Content-Type':'application/json'}:{})},body:init.body?JSON.stringify(init.body):undefined});return {status:response.status,body:await response.json().catch(()=>({}))};};
 const act=(action,payload={},init={})=>gm('/gm/action',{method:'POST',body:{action,...payload},...init});
 const audit=action=>service.db.prepare('SELECT * FROM gm_audit WHERE action=?').all(action);
 return {service,started,play,ok,join,gm,act,audit,advance:ms=>{now+=ms;},close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('the announcement store keeps one active banner, validates input and expires on time',()=>{
 const db=new DatabaseSync(':memory:');let time=1000000;
 const a=createAnnouncements(db,{now:()=>time});
 try{
  assert.equal(a.active(),null);
  assert.throws(()=>a.post({text:'   '},'gm'),/Write an announcement/);
  assert.throws(()=>a.post({text:'x',minutes:0},'gm'),/1 to 1440/);
  assert.throws(()=>a.post({text:'x',minutes:'soon'},'gm'),/1 to 1440/);
  const first=a.post({text:'Line\nbreaks\x07 vanish',speaker:'',minutes:2},'gm');
  assert.equal(first.text,'Line breaks  vanish');assert.equal(first.speaker,'Gamemaster');assert.equal(first.expires,time+120000);assert.equal(first.minutes,2);
  const second=a.post({text:'Newer wins'},'gm');assert.equal(a.active().id,second.id);assert.equal(a.active().expires,time+600000,'ten minutes by default');
  assert.equal(a.history().length,2);assert.ok(a.history()[1].ended,'the replaced banner is marked ended');
  time+=600001;assert.equal(a.active(),null,'expired banners disappear without a tick');
  assert.equal(a.end(),null);
  const third=a.post({text:'Manual'},'gm');assert.equal(a.end().id,third.id);assert.equal(a.active(),null);
 }finally{db.close();}
});

test('gamemasters announce from the web panel or in game; every online snapshot carries the banner until it ends',async()=>{
 const h=harness();await h.started;
 try{
  const player=await h.join(playerToken,'Poppy','honeydew-lantern');assert.equal(player.announcement,null);
  await h.join(staffToken,'Lumi','princess-rose');
  // Ordinary players cannot announce, and are not signed out for trying.
  const refused=await h.play(playerToken,'gm_announce',{text:'nope'});assert.equal(refused.status,409);assert.equal(refused.result.error,'gm_not_gamemaster');
  assert.equal((await h.act('announce',{text:'x'},{token:playerToken})).status,403);
  // Web panel: empty text and silly durations are refused; a real one reaches everyone, in any room.
  assert.equal((await h.act('announce',{text:'   '})).body.error,'gm_empty_message');
  assert.equal((await h.act('announce',{text:'Maintenance soon',minutes:99999})).body.error,'gm_invalid_minutes');
  const posted=await h.act('announce',{text:'Server restart in ten minutes. Finish your fights!',speaker:'Doll',minutes:15});
  assert.equal(posted.status,200,JSON.stringify(posted.body));const banner=posted.body.result;assert.equal(banner.speaker,'Doll');assert.equal(banner.minutes,15);
  const seen=await h.ok(playerToken,'heartbeat');assert.equal(seen.announcement.text,'Server restart in ten minutes. Finish your fights!');assert.equal(seen.announcement.id,banner.id);
  assert.equal((await h.ok(staffToken,'heartbeat')).announcement.id,banner.id,'the gamemaster in another hub sees it too');
  const feed=(await h.gm('/gm/chat')).body;assert.equal(feed.announcement.id,banner.id,'the chat tab reports the live banner');
  assert.equal(h.audit('announce').length,1);
  // In game: /announce from chat becomes gm_announce, signed with the character name, replacing the older banner.
  const inGame=await h.ok(staffToken,'gm_announce',{text:'Rose garden opens tonight'});
  assert.equal(inGame.character.hubNotice,'[GM] Announced to everyone for 10 minutes.');
  const replaced=await h.ok(playerToken,'heartbeat');assert.equal(replaced.announcement.speaker,'Lumi');assert.equal(replaced.announcement.text,'Rose garden opens tonight');assert.notEqual(replaced.announcement.id,banner.id);
  assert.equal(h.audit('announce').length,2);assert.equal(JSON.parse(h.audit('announce')[1].detail).reason,'in-game');
  // A player inside a Dive still receives it.
  const dive=await h.ok(staffToken,'dive_enter',{zone:'dive-quarters',loadout});assert.equal(dive.announcement.text,'Rose garden opens tonight');
  // Ending it in game clears it for everyone; ending again is harmless; expiry clears it on its own.
  const ended=await h.ok(staffToken,'gm_announce_end');assert.equal(ended.character.hubNotice,'[GM] Announcement ended.');assert.equal(ended.announcement,null);
  assert.equal((await h.ok(playerToken,'heartbeat')).announcement,null);
  assert.equal((await h.ok(staffToken,'gm_announce_end')).character.hubNotice,'[GM] No announcement is up right now.');
  assert.equal(h.audit('announce_end').length,1);
  await h.act('announce',{text:'Short one',minutes:1});assert.ok((await h.ok(playerToken,'heartbeat')).announcement);
  h.advance(61000);assert.equal((await h.ok(playerToken,'enter',{zone:'honeydew-lantern',loadout})).announcement,null,'expired after one minute (a fresh entry, since the idle presence lease lapsed too)');
  assert.equal((await h.act('announce_end',{})).body.result.ended,null);
 }finally{await h.close();}
});
