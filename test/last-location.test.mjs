import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

// Logging back in lands a character where they logged off (2026-09-28): the server records the hub tile after every
// committed command (state.lastLocation), the client's lobby asks for that room, and the tile is restored when they match.
function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-30T12:00:00Z');const ids={};
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,grant:secret=>({id:secret,owner:'owner-'+secret,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const loadout={player_info:{class_id:'fighter',playerHealth:100,playerHealthMax:100,str:10,def:2,dex:8,int:5,cha:5,level:10,xp:0,stat_points:0},inventory:[],player_spells:[],player_mp:0,player_mp_max:0};
 const snap=(token,name)=>zones.read(token,ids[name]);
 function act(token,name,action,extra={}){time+=1500;const s=snap(token,name);return zones.act(token,{action,request_id:randomUUID(),controller:'window',character_id:ids[name],revision:s.character.revision,...extra});}
 function create(token,name){const s=zones.act(token,{action:'create',name,controller:'window',request_id:randomUUID()});ids[name]=s.character.id;}
 const enter=(token,name,zone)=>act(token,name,'enter',{zone,combat_version:3,loadout});
 const lobby=(token,name)=>{const c=snap(token,name).character;return c.lastLocation?.zone??c.homeHub??'princess-rose';}; // What online_lobby_destination() asks for.
 function step(token,name){for(const direction of ['south','east','north','west']){try{const r=act(token,name,'move',{direction});return r.position;}catch{}}throw Error('no free step');} // One real step off the spawn, whichever way is open.
 const spawnOf=(token,name,zone)=>snap(token,name).zones.find(z=>z.id===zone).spawn;
 const presence=name=>db.prepare('SELECT zone,x,y FROM quest_presence WHERE character_id=?').get(ids[name]);
 const state=name=>JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]).state);
 const patch=(name,fn)=>{const s=state(name);fn(s);db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),ids[name]);};
 return {db,ids,zones,snap,act,create,enter,lobby,step,spawnOf,presence,state,patch,close:()=>db.close()};
}

test('a proper log-out remembers the hub tile; the lobby asks for that room and the tile comes back',()=>{
 const f=fixture();try{
  f.create('a','alice');
  assert.equal(f.lobby('a','alice'),'princess-rose','nothing remembered yet: the home hub');
  let s=f.enter('a','alice','honeydew-lantern');assert.equal(s.zone,'honeydew-lantern');
  const moved=f.step('a','alice');assert.notDeepEqual(moved,f.spawnOf('a','alice','honeydew-lantern'),'the step left the spawn tile');
  assert.deepEqual(f.state('alice').lastLocation,{zone:'honeydew-lantern',x:moved.x,y:moved.y},'every committed command records the hub tile');
  f.act('a','alice','leave');assert.equal(f.presence('alice'),undefined,'leaving drops the presence row as before');
  assert.equal(f.lobby('a','alice'),'honeydew-lantern','the roster carries the remembered room for the lobby');
  s=f.enter('a','alice',f.lobby('a','alice'));assert.equal(s.zone,'honeydew-lantern');assert.deepEqual(s.position,moved,'the exact tile is restored');
  f.act('a','alice','leave');
  s=f.enter('a','alice','princess-rose');assert.equal(s.zone,'princess-rose','an explicit different zone still wins');assert.deepEqual(s.position,f.spawnOf('a','alice','princess-rose'));
  assert.equal(f.state('alice').lastLocation.zone,'princess-rose','...and becomes the new memory');
  f.act('a','alice','leave');
  f.patch('alice',st=>{st.lastLocation={zone:'princess-rose',x:0,y:0};}); // A regenerated district can wall a remembered tile.
  s=f.enter('a','alice','princess-rose');assert.deepEqual(s.position,f.spawnOf('a','alice','princess-rose'),'a blocked tile falls back to the room spawn');
  f.act('a','alice','leave');
  f.patch('alice',st=>{st.lastLocation={zone:'retired-room',x:3,y:3};st.homeHub='honeydew-lantern';});
  assert.equal(f.lobby('a','alice'),'retired-room');
  s=f.enter('a','alice','retired-room');assert.equal(s.zone,'honeydew-lantern','a retired remembered room starts at the home hub instead of failing');assert.equal(f.state('alice').lastLocation.zone,'honeydew-lantern');
  assert.throws(()=>f.enter('a','alice','nowhere-at-all'),/Choose an online zone/,'other unknown zones are still refused');
 }finally{f.close();}
});

test('a lapsed session still resumes on its presence tile, and each character of one account keeps its own spot',()=>{
 const f=fixture();try{
  f.create('a','alice');f.create('a','alina'); // Two characters, one account (one presence row).
  f.enter('a','alice','littlebig-clockwork');const at=f.step('a','alice');
  let s=f.enter('a','alice',f.lobby('a','alice')); // The window closed without leaving: the presence row is still there and the lobby asks for the same room.
  assert.equal(s.zone,'littlebig-clockwork');assert.deepEqual(s.position,at);
  f.act('a','alice','leave');
  assert.equal(f.lobby('a','alina'),'princess-rose','a fresh character has nothing remembered');
  s=f.enter('a','alina','utopia-arcanum');assert.equal(s.zone,'utopia-arcanum');
  const there=f.step('a','alina');f.act('a','alina','leave');
  s=f.enter('a','alice',f.lobby('a','alice'));assert.equal(s.zone,'littlebig-clockwork');assert.deepEqual(s.position,at,'switching characters never mixes their remembered tiles');
  f.act('a','alice','leave');
  s=f.enter('a','alina',f.lobby('a','alina'));assert.equal(s.zone,'utopia-arcanum');assert.deepEqual(s.position,there);
 }finally{f.close();}
});
