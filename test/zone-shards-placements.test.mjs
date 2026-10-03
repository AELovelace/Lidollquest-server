import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createQuestService} from '../server/service.mjs';

// Regression for 2026-10-03: snapshot workers hold a read-only database (zone-snapshot-database.mjs). When a zone's placement map
// was not committed yet (new zone, new edition, or freshly placed GM content), the snapshot's placements.view() tried to commit it
// from the worker and every /zones request failed with "attempt to write a readonly database" (shown as "Online zones are temporarily unavailable.").
test('read-only snapshot workers render uncommitted placement maps and the coordinator commits them',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'lidoll-shard-placements-')),owner='acct-placements',token='placements-token-aaaaaaaaaaaaaaaa',logs=[];
 const service=createQuestService({workerCount:2,zoneWorkers:2,filename:join(directory,'quest.sqlite'),log:(...parts)=>logs.push(parts),walletClient:{authenticate:async()=>({owner,id:'grant-a',client:'lidollquest',coins:50,scope:'saves:read saves:write social:read'})}});
 await service.prepare();await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+service.server.address().port,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 const act=async input=>{const res=await fetch(url+'/zones/action',{method:'POST',headers,body:JSON.stringify(input)});const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));return data;};
 const maps=()=>service.db.prepare("SELECT COUNT(*) AS n FROM world_placement_maps WHERE zone='honeydew-lantern'").get().n;
 try{
  const c=(await act({action:'create',request_id:randomUUID(),controller:'window',name:'Placement tester'})).character;
  await act({action:'enter',character_id:c.id,revision:c.revision,request_id:randomUUID(),controller:'window',zone:'honeydew-lantern'});
  const npc={id:'team_keeper',name:'Team Keeper',dialogue:[{id:'hello',text:'Written by the team.',next:'close',actions:[]}]}; // A published NPC makes every snapshot ask for the zone's placement map, like production.
  service.live.change({action:'content_save',kind:'npc',id:npc.id,revision:0,entry:npc},'Doll');service.live.change({action:'content_publish',kind:'npc',id:npc.id,revision:1},'Doll');
  const placement={id:'test-npc',zone:'honeydew-lantern',kind:'npc',content:npc.id,name:'Team Keeper',x:10,y:10,lifetime:'persistent'};
  service.db.prepare('INSERT INTO world_placements VALUES (?,?,?)').run(placement.id,placement.zone,JSON.stringify(placement));
  assert.equal(maps(),0); // Nothing committed yet: the worker must realize the map in memory.
  const identity={owner,client:'lidollquest',gamemaster:false,supporterUntil:null,blockedAccounts:[]};
  const bytes=await service.shards.render('honeydew-lantern',{at:Date.now(),identity,character:c.id,view:{companion:false},badges:service.zones.snapshotBadges(),receipt:null,capabilities:{},known:null});
  assert.ok(bytes.length>1000);assert.equal(maps(),0); // The read-only worker rendered without writing.
  const res=await fetch(url+'/zones?character_id='+c.id,{headers});assert.equal(res.status,200);
  assert.equal(maps(),1); // The ordinary client read commits the map on the writable coordinator (zones.mjs warmPlacements).
  assert.ok(!logs.some(parts=>parts[0]==='zone_request_failed'),JSON.stringify(logs));
 }finally{await new Promise(resolve=>service.server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
