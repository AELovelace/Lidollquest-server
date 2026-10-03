import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
import {createZoneSnapshotRuntime} from '../server/zone-snapshot-runtime.mjs';
import {installZoneSnapshotEpochs} from '../server/zone-snapshot-epochs.mjs';
import {openZoneSnapshotDatabase} from '../server/zone-snapshot-database.mjs';
import {pathTo} from '../server/dive-generation.mjs';

test('zone snapshot runtime matches the shared world and cannot mutate its database',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'quest-zone-snapshot-')),filename=join(directory,'world.sqlite');let at=Date.parse('2026-10-03T12:00:00Z');
 const identity={owner:'alice',id:'a',client:'lidollquest',coins:0,scope:'wallet:read wallet:write'},service=createQuestService({filename,now:()=>at,log:()=>{},walletClient:{authenticate:async()=>identity}});let runtime;
 try{
  await service.prepare();await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port,token='a'.repeat(43);
  const call=async input=>{const response=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),controller:'test',...input})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
  let current=await call({action:'create',name:'Alice'});current=await call({action:'enter',character_id:current.character.id,revision:current.character.revision,zone:'princess-rose',combat_version:3,follower_version:1,quest_version:1,content_version:1,full_dungeon_version:1,loadout:{player_info:{level:1,playerHealth:100,playerHealthMax:100},inventory:[]}});
  installZoneSnapshotEpochs(service.db);runtime=createZoneSnapshotRuntime({filename});const input={at,identity,character:current.character.id,view:{},badges:service.zones.snapshotBadges(),capabilities:current.capabilities};
  const before=service.db.prepare('SELECT total_changes() n').get().n,rendered=JSON.parse(new TextDecoder().decode(runtime.render(input).bytes));
  const {receipt,...expected}=current;assert.deepEqual(rendered,expected);assert.equal(service.db.prepare('SELECT total_changes() n').get().n,before);
  const epoch=()=>service.db.prepare("SELECT revision FROM zone_snapshot_epochs WHERE domain='content'").get().revision,prior=epoch(),sheet=service.live.view().sheets.find(s=>s.draft.category==='tutor');
  service.db.exec('BEGIN');service.db.prepare("INSERT INTO world_content VALUES ('sheet','epoch_probe',1,'{}',NULL)").run();assert.equal(epoch(),prior+1);service.db.exec('ROLLBACK');assert.equal(epoch(),prior,'cache epochs roll back with their data');
  service.live.change({action:'content_publish',kind:'sheet',id:sheet.id,revision:sheet.revision,entry:{...sheet.draft,body:{...sheet.draft.body,name:'Pip Across Cores'}}},'test');
  const updated=JSON.parse(new TextDecoder().decode(runtime.render(input).bytes));assert.equal(updated.zones.find(z=>z.id==='princess-rose').fixtures.find(f=>f.id==='tutor').name,'Pip Across Cores','published content invalidates an already warm worker');
  const readonly=openZoneSnapshotDatabase(filename);readonly.ready();try{assert.throws(()=>readonly.db.prepare('DELETE FROM quest_characters').run(),/readonly/);}finally{readonly.db.close();}
  service.zones.loot.tune({guild_create_fee:0},'test');
  current=await call({action:'guild_create',character_id:current.character.id,revision:current.character.revision,name:'Shared Guild',tag:'CORE'});
  const {receipt:guildReceipt,...guildExpected}=current,guildRendered=JSON.parse(new TextDecoder().decode(runtime.render(input).bytes));
  assert.deepEqual(guildRendered,guildExpected,'a warm worker observes new guild membership, tags, treasury and tuning');assert.equal(guildRendered.peers.find(p=>p.id===current.character.id).tag,'CORE');
  const companion=await fetch(base+'/zones?character_id='+current.character.id+'&view=companion',{headers:{Authorization:'Bearer '+token}});assert.equal(companion.status,200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(runtime.render({...input,view:{companion:true}}).bytes)),await companion.json(),'companion bank/shop and guild views remain read-only');
  current=await call({action:'dive_enter',character_id:current.character.id,revision:current.character.revision,zone:'dive-quarters'});
  const {receipt:diveReceipt,...diveExpected}=current;assert.deepEqual(JSON.parse(new TextDecoder().decode(runtime.render(input).bytes)),diveExpected,'dungeon geometry, loot claims, editions and companions match the coordinator');
  const foe=current.dive.enemies.find(e=>e.id==='iris'),floor=current.zones.find(z=>z.id===current.zone),position=pathTo(floor,floor.entrance,foe).at(-2);
  const state=JSON.parse(service.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(current.character.id).state);state.dive.position=position;state.dive.safeUntil=at+600000;
  service.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),current.character.id);
  service.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(position.x,position.y,current.character.id); // Position the fixture beside a real foe; engagement still goes through the authoritative HTTP command.
  current=await call({action:'dive_engage',character_id:current.character.id,revision:current.character.revision,edition:current.dive.edition,encounter:foe.id});assert.ok(current.encounter);
  const {receipt:fightReceipt,...fightExpected}=current;assert.deepEqual(JSON.parse(new TextDecoder().decode(runtime.render(input).bytes)),fightExpected,'active encounters render without repeating combat decisions or writes');
  assert.throws(()=>runtime.render({...input,identity:{...identity,owner:'bob'}}),/not found/);
 }finally{runtime?.close();service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
