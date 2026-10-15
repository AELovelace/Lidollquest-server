import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createQuestService} from '../server/service.mjs';

// Map Editor "Move offline player" (2026-10-15): world_move_player puts an offline character on a chosen tile; their next login starts there.
async function harness(){
 const dir=mkdtempSync(join(tmpdir(),'move-player-')),filename=join(dir,'quest.sqlite');let time=Date.parse('2026-10-15T12:00:00Z');
 const token='m'.repeat(43);let id;
 const staff='g'.repeat(43);const service=createQuestService({filename,walletClient:{authenticate:async t=>({owner:t,id:t,client:'lidollquest',coins:0,gamemaster:t===staff,scope:'social:read'})},now:()=>time,authTtlMs:0,log:()=>{}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
 const read=async()=>(await fetch(base+'/zones?character_id='+id,{headers:{Authorization:'Bearer '+token}})).json();
 const send=async input=>{time+=1000;const r=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:r.status,data:await r.json()};};
 const command=async(action,extra={})=>{const s=await read();const r=await send({action,request_id:randomUUID(),controller:'m',character_id:id,revision:s.character.revision,...extra});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 id=(await send({action:'create',name:'Mover',request_id:randomUUID(),controller:'m'})).data.character.id;
 const entry={quest_version:1,content_version:1,flow_version:1,follower_version:1,combat_version:3,loadout:{player_info:{playerHealth:50,playerHealthMax:50,level:1,str:10,def:5},inventory:[]}};
 const goOffline=()=>{time+=120000;}; // The presence lease (30 s) lapses without a proper logout.
 const move=(zone,x,y)=>{const view=service.zones.world.map(zone);service.db.exec('BEGIN IMMEDIATE');try{const r=service.zones.world.act({action:'world_move_player',zone,edition:view.edition,revision:view.revision,character_id:id,x,y});service.db.exec('COMMIT');return r;}catch(e){service.db.exec('ROLLBACK');throw e;}};
 const gm=async input=>{const r=await fetch(base+'/gm/action',{method:'POST',headers:{Authorization:'Bearer '+staff,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),...input})});return {status:r.status,data:await r.json()};};
 return {service,id:()=>id,read,command,entry,goOffline,move,gm,close:async()=>{await new Promise(r=>service.server.close(r));rmSync(dir,{recursive:true,force:true});}};
}

test('an offline player moved to a room tile logs back in on that exact tile',async()=>{
 const h=await harness();
 try{
  await h.command('enter',{zone:'honeydew-lantern',...h.entry});
  assert.throws(()=>h.move('utopia-arcanum-tower',12,13),/online/,'online players go through the Players tab instead');
  h.goOffline();
  assert.throws(()=>h.move('utopia-arcanum-tower',0,0),/wall|open tile/,'walls are refused');
  const r=h.move('utopia-arcanum-tower',12,13);assert.deepEqual(r.moved.to,{zone:'utopia-arcanum-tower',x:12,y:13});assert.equal(r.moved.from.zone,'honeydew-lantern');
  const state=JSON.parse(h.service.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(h.id()).state);
  assert.equal(state.hubVisit,'utopia-arcanum-tower');assert.deepEqual(state.lastLocation,{zone:'utopia-arcanum-tower',x:12,y:13});
  const back=await h.command('enter',{zone:state.hubVisit,...h.entry}); // The client asks for hubVisit on login.
  assert.equal(back.zone,'utopia-arcanum-tower');assert.deepEqual([back.position.x,back.position.y],[12,13]);
 }finally{await h.close();}
});

test('an offline player stuck in a dungeon can be pulled out to a hub tile',async()=>{
 const h=await harness();
 try{
  await h.command('enter',{zone:'princess-rose',...h.entry});await h.command('dive_enter',{zone:'dive-quarters'});
  assert.ok(JSON.parse(h.service.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(h.id()).state).dive,'in the dungeon');
  h.goOffline();
  let spot=null;for(const [x,y] of [[33,32],[27,32],[30,35],[30,29],[34,34],[26,30]]){try{h.move('utopia-arcanum',x,y);spot={x,y};break;}catch{}} // Any open tile that is not the arrival spawn (30,32).
  assert.ok(spot,'found an open lobby tile');
  const state=JSON.parse(h.service.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(h.id()).state);
  assert.equal(state.dive,null);assert.equal(state.hubVisit,undefined,'a lobby clears the annex visit');
  const back=await h.command('enter',{zone:'utopia-arcanum',...h.entry});
  assert.equal(back.zone,'utopia-arcanum','the stale dungeon presence no longer pulls them back in');assert.deepEqual([back.position.x,back.position.y],[spot.x,spot.y]);

 }finally{await h.close();}
});

test('the GM route moves an offline player and audits it under their account',async()=>{
 const h=await harness();
 try{
  await h.command('enter',{zone:'honeydew-lantern',...h.entry});h.goOffline();
  const view=h.service.zones.world.map('utopia-arcanum-tower');
  const r=await h.gm({action:'world_move_player',zone:'utopia-arcanum-tower',edition:view.edition,revision:view.revision,character_id:h.id(),x:12,y:13,reason:'stuck in a wall'});
  assert.equal(r.status,200,JSON.stringify(r.data));
  const row=h.service.db.prepare("SELECT target,detail FROM gm_audit WHERE action='world_move_player'").get();
  assert.equal(row.target,'m'.repeat(43),'audited under the player account');const detail=JSON.parse(row.detail);
  assert.deepEqual(detail.to,{zone:'utopia-arcanum-tower',x:12,y:13});assert.equal(detail.reason,'stuck in a wall');
  const players=(await (await fetch('http://127.0.0.1:'+h.service.server.address().port+'/gm/map?zone=utopia-arcanum-tower&paint=1',{headers:{Authorization:'Bearer '+'g'.repeat(43)}})).json()).players;
  assert.deepEqual(players.map(p=>[p.name,p.x,p.y,p.online]),[['Mover',12,13,false]],'the editor shows them there, offline');
 }finally{await h.close();}
});
