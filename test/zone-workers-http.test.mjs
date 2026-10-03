import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

test('shared-world zone workers preserve cross-zone chat, ownership, replay and fresh state',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'quest-zone-http-')),filename=join(directory,'world.sqlite'),now=()=>Date.parse('2026-10-03T12:00:00Z');
 const service=createQuestService({filename,now,zoneWorkers:2,log:()=>{},walletClient:{authenticate:async token=>({owner:token,id:token,client:'lidollquest',coins:0,scope:'wallet:read wallet:write social:read'})}}),states={};
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
  service.db.prepare("INSERT INTO gm_sanctions(owner,kind,until,reason,created) VALUES (?,'suspend',0,'test',?)").run(token('alice'),now());assert.equal((await read('alice')).status,403);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));await service.shards?.close();rmSync(directory,{recursive:true,force:true});}
});
