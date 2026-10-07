import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

test('shared-world zone workers preserve cross-zone chat, ownership, replay and fresh state',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'quest-zone-http-')),filename=join(directory,'world.sqlite'),now=()=>Date.parse('2026-10-03T12:00:00Z');
 const service=createQuestService({filename,now,zoneWorkers:2,zoneCapacity:128,log:()=>{},walletClient:{authenticate:async token=>({owner:token,id:token,client:'lidollquest',coins:0,scope:'wallet:read wallet:write social:read'})}}),states={};
 try{
  await service.prepare();await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port,token=who=>who.padEnd(43,'x');
  const command=async(who,input)=>{const response=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token(who),'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),controller:who,character_id:states[who]?.character.id,revision:states[who]?.character.revision,...input})}),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));states[who]=result;return result;};
  const read=async(who,id=states[who].character.id)=>{const response=await fetch(base+'/zones?character_id='+id,{headers:{Authorization:'Bearer '+token(who)}});return {status:response.status,result:await response.json()};};
  for(const [who,zone] of [['alice','princess-rose'],['bob','honeydew-lantern']]){await command(who,{action:'create',name:who});await command(who,{action:'enter',zone,combat_version:3,follower_version:1,loadout:{player_info:{level:1,playerHealth:100,playerHealthMax:100},inventory:[]}});}
  const before=await Promise.all(['alice','bob'].map(who=>read(who)));assert.equal(before[0].result.zone,'princess-rose');assert.equal(before[1].result.zone,'honeydew-lantern');assert.ok(service.shards.snapshot().workers.every(w=>w.completed>0));
  const chat={action:'chat',channel:'global',text:'Shared world across cores',request_id:randomUUID(),revision:states.alice.character.revision};const first=await command('alice',chat);await command('alice',chat);
  const bob=(await read('bob')).result;assert.equal(bob.globalChat.filter(m=>m.text===chat.text).length,1);assert.equal(states.alice.character.revision,first.character.revision);
  assert.equal((await read('bob',states.alice.character.id)).status,404);
  service.db.prepare('UPDATE quest_characters SET name=?,revision=revision+1 WHERE id=?').run('Updated Alice',states.alice.character.id);assert.equal((await read('alice')).result.character.name,'Updated Alice');
  for(let i=0;i<128;i++){
   const id='capacity-peer-'+i;
   service.db.prepare('INSERT INTO quest_characters(id,owner,name,created,revision,state,creation_id) SELECT ?,?,name,created,revision,state,creation_id FROM quest_characters WHERE id=?').run(id,id,states.alice.character.id);
   service.db.prepare('INSERT INTO quest_presence(owner,character_id,zone,grant_id,controller,x,y,seen,moved) SELECT ?,?,zone,grant_id,controller,x,y,seen,moved FROM quest_presence WHERE character_id=?').run(id,id,states.alice.character.id);
  } // Simulate a crowd surviving a capacity reduction: the worker must honor 128, neither the old 64 nor the new default 256.
  assert.equal((await read('alice')).result.peers.length,128);
  service.db.prepare("INSERT INTO gm_sanctions(owner,kind,until,reason,created) VALUES (?,'suspend',0,'test',?)").run(token('alice'),now());assert.equal((await read('alice')).status,403);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));await service.shards?.close();rmSync(directory,{recursive:true,force:true});}
});

test('zone workers redraw a cached neighbour as soon as their save changes',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'quest-peer-cache-')),filename=join(directory,'world.sqlite');
 const service=createQuestService({filename,zoneWorkers:2,log:()=>{},walletClient:{authenticate:async token=>({owner:token,id:token,client:'lidollquest',coins:0,scope:'wallet:read wallet:write social:read'})}}),states={};
 try{
  await service.prepare();await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port,token=who=>who.padEnd(43,'x');
  const command=async(who,input)=>{const response=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token(who),'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),controller:who,character_id:states[who]?.character.id,revision:states[who]?.character.revision,...input})}),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));states[who]=result;return result;};
  const aliceSeenBy=async who=>{const response=await fetch(base+'/zones?character_id='+states[who].character.id,{headers:{Authorization:'Bearer '+token(who)}}),result=await response.json();return result.peers.find(p=>p.id===states.alice.character.id);};
  for(const who of ['alice','bob']){await command(who,{action:'create',name:who});await command(who,{action:'enter',zone:'honeydew-lantern',combat_version:3,follower_version:1,loadout:{player_info:{level:1,playerHealth:100,playerHealthMax:100},inventory:[]}});}
  for(let n=0;n<4;n++)assert.equal((await aliceSeenBy('bob')).fighting,false); // Prime the peer cache on both workers.
  const row=service.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(states.alice.character.id),state=JSON.parse(row.state);state.run={phase:'fight',stage:3};
  service.db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),states.alice.character.id); // Same write shape every state change uses: the revision moves with it.
  for(let n=0;n<4;n++){const alice=await aliceSeenBy('bob');assert.equal(alice.fighting,true);assert.equal(alice.stage,3);} // Every worker re-reads Alice instead of serving the cached view.
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));await service.shards?.close();rmSync(directory,{recursive:true,force:true});}
});
