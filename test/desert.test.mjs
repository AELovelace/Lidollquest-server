import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,desertData,DESERT_ZONE} from '../server/zones.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {pathTo,inside} from '../server/dive-generation.mjs';

function fixture(options={}){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-16T12:00:00Z'),owner='alice',api;
 const loadout={player_info:{class_id:'fighter',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const setup=()=>api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>assert.fail('The Desert does not mint boss coins'),diveOptions:{log:()=>{}},desertOptions:{log:()=>{},generate:(...args)=>{const f=generateDesert(...args);f.enemies.forEach(e=>e.roaming=false);return f;},...options}});setup(); // Freeze roaming only in command tests so synthetic positioning cannot race the clock.
 const snap=id=>api.read('',id);
 function command(id,action,extra={}){const s=snap(id);return {action,request_id:randomUUID(),controller:'window',character_id:id,revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra};}
 function act(id,action,extra={}){time+=350;return api.act('',command(id,action,extra));}
 function player(who,hub){owner=who;const s=api.act('',{action:'create',name:who,controller:'window',request_id:randomUUID()});act(s.character.id,'enter',{zone:hub,loadout});return act(s.character.id,'dive_enter',{zone:DESERT_ZONE,loadout}).character.id;}
 function place(id,p){const state=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id).state);state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=time+600000;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),id);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(p.x,p.y,time,id);}
 const floor=id=>snap(id).zones.find(z=>z.id===DESERT_ZONE);
 function near(id,p){const f=floor(id),path=pathTo(f,f.entrance,p);place(id,path.length>1?path.at(-2):f.entrance);}
 return {db,loadout,snap,act,command,raw:i=>api.act('',i),player,place,near,floor,restart:setup,as:n=>owner=n,time:t=>time=Date.parse(t),tick:()=>api.tick()};
}

test('100 seeded Desert maps keep native scenery, connected exits, safe ends and food in every basin',()=>{
 for(let n=0;n<100;n++){
  const f=generateDesert(desertData,'seed-'+n);assert.ok(validateDesert(f));assert.deepEqual(f,generateDesert(desertData,'seed-'+n));
  assert.equal(f.width,100);assert.equal(f.height,50);assert.equal(f.chests.length,7);assert.equal(f.enemies.length,21);assert.equal(f.pickups.filter(p=>p.kind==='food').length,7);
  assert.equal(f.decorations.length>=12,true);assert.ok(f.decorations.some(p=>p.span_w>1||p.span_h>1));
  assert.ok(pathTo(f,f.exits[0],f.exits[1]));assert.ok(f.enemies.every(p=>!f.safeRooms.some(r=>inside(r,p.x,p.y))));
 }
});

test('both hub entrances share one Desert; loot, chat, replay and reconnect are personal and route-scoped',()=>{
 const f=fixture();try{
  const a=f.player('alice','honeydew-lantern'),b=f.player('bob','littlebig-clockwork');
  const east=f.snap(b).position;f.as('alice');const west=f.snap(a).position;assert.ok(east.x>west.x);assert.equal(f.snap(a).peers.length,2);
  const chest=f.snap(a).dive.chests[0];f.near(a,chest);const claim=f.command(a,'dive_claim',{chest:chest.id});f.raw(claim);f.raw(claim);
  assert.equal(f.snap(a).character.loadout.inventory.filter(i=>i.category!=='ingredient').length,1);assert.ok(f.snap(a).character.loadout.inventory[0].online_item);
  const room=f.floor(a).rooms[2];f.place(a,room);f.act(a,'chat',{text:'Desert friends'});
  f.as('bob');assert.equal(f.snap(b).dive.claimed,0);assert.equal(f.snap(b).chat.length,0);f.place(b,room);assert.equal(f.snap(b).chat[0].text,'Desert friends');f.near(b,chest);f.act(b,'dive_claim',{chest:chest.id});assert.equal(f.snap(b).dive.claimed,1);
  f.restart();assert.equal(f.snap(b).dive.claimed,1);assert.equal(f.snap(b).zone,DESERT_ZONE);
  f.act(b,'dive_exit');assert.equal(f.snap(b).zone,'littlebig-clockwork');f.act(b,'enter',{zone:'princess-rose'});f.act(b,'dive_enter');assert.equal(f.snap(b).zone,'dive-quarters');assert.equal(f.snap(b).dive.claimed,0);
  f.as('alice');assert.equal(f.snap(a).zone,DESERT_ZONE);assert.equal(f.snap(a).dive.claimed,1);assert.equal(f.snap(a).peers.length,1);
  assert.throws(()=>f.act(a,'enter',{zone:'dive-quarters'}),/Leave your current dungeon/);
 }finally{f.db.close();}
});

test('crossing requires reaching the marked exit; Escape retains the original lobby',()=>{
 const f=fixture();try{
  const id=f.player('alice','honeydew-lantern'),floor=f.floor(id);
  assert.throws(()=>f.act(id,'dive_exit',{zone:'littlebig-clockwork'}),/Stand beside/);
  const exit=floor.exits[1];f.place(id,{x:exit.x-1,y:exit.y});const crossed=f.act(id,'move',{direction:'east',world_step:true});
  assert.equal(crossed.zone,'littlebig-clockwork');assert.equal(crossed.character.worldTurnDue,undefined);
  f.act(id,'dive_enter',{zone:DESERT_ZONE});assert.ok(f.snap(id).position.x>50);f.act(id,'dive_exit');assert.equal(f.snap(id).zone,'littlebig-clockwork');
  f.act(id,'dive_enter',{zone:DESERT_ZONE});const west=f.floor(id).exits[0];f.place(id,{x:west.x+1,y:west.y});f.act(id,'dive_exit',{zone:'honeydew-lantern'});assert.equal(f.snap(id).zone,'honeydew-lantern');
 }finally{f.db.close();}
});

test('Desert reset and restart retain committed loot, isolate Quarters fights, and reject stale claims',()=>{
 const f=fixture();try{
  const a=f.player('alice','honeydew-lantern'),old=f.snap(a).dive.edition,chest=f.snap(a).dive.chests[0];f.near(a,chest);f.act(a,'dive_claim',{chest:chest.id});
  const b=f.player('bob','littlebig-clockwork');f.act(b,'dive_exit');f.act(b,'enter',{zone:'princess-rose'});f.act(b,'dive_enter');const quarters=f.snap(b),iris=quarters.dive.enemies.find(e=>e.id==='iris'),qfloor=quarters.zones.find(z=>z.id==='dive-quarters'),path=pathTo(qfloor,qfloor.entrance,iris);f.place(b,path.at(-2));f.act(b,'dive_engage',{encounter:'iris'});
  f.as('alice');f.time('2026-09-21T11:00:01Z');f.tick();f.act(a,'enter',{zone:DESERT_ZONE});assert.equal(f.snap(a).zone,'honeydew-lantern');
  f.act(a,'dive_enter',{zone:DESERT_ZONE});assert.notEqual(f.snap(a).dive.edition,old);assert.equal(f.snap(a).dive.claimed,0);assert.equal(f.snap(a).character.loadout.inventory.filter(i=>i.category!=='ingredient').length,1);
  assert.throws(()=>f.act(a,'dive_claim',{edition:old,chest:chest.id}),/edition changed/);
  f.restart();assert.equal(f.snap(a).character.loadout.inventory.filter(i=>i.category!=='ingredient').length,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dive_editions WHERE route=?').get(desertData.config.route).n,2);
  f.as('bob');assert.equal(f.snap(b).character.dive,null,'expired disconnected Quarters fight returns independently');
 }finally{f.db.close();}
});

test('all classes fight authored Desert enemies; engagement locks and committed fights survive restart',()=>{
 for(const cls of ['fighter','mage','diplomat']){
  const f=fixture();try{
   f.loadout.player_info.class_id=cls;
   const a=f.player('alice','honeydew-lantern'),enemy=f.snap(a).dive.enemies[0];f.near(a,enemy);const fighting=f.act(a,'dive_engage',{encounter:enemy.id});assert.equal(fighting.character.run.enemy.authored.hp,desertData.enemies[enemy.type].hp);assert.ok(fighting.character.run.enemy.level>=1,'enemies fight at the encounter level');
   const b=f.player('bob','littlebig-clockwork');f.near(b,enemy);assert.throws(()=>f.act(b,'dive_engage',{encounter:enemy.id}),/not available/);
   f.as('alice');f.restart();assert.equal(f.snap(a).character.run.encounter,enemy.id);
   for(let n=0;n<12&&f.snap(a).character.run;n++){let s=f.snap(a);if(!s.character.run.turnReady)f.act(a,'turn_ready',{loadout:s.character.loadout,forfeit:false});f.act(a,cls==='mage'?'cast':cls==='diplomat'?'allure':'attack',{spell:'fireball'});}
   assert.equal(f.snap(a).character.run,null);assert.equal(f.snap(a).character.lastResult.outcome,'win');assert.equal(f.snap(a).dive.claimableCoins,0);
  }finally{f.db.close();}
 }
});
