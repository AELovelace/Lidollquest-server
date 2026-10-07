import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {createQuestService} from '../server/service.mjs';
import {enemyRoams,inside,walkable} from '../server/dive-generation.mjs';
import {diveData} from '../server/dive.mjs';

test('online service starts combat beside a hostile enemy with real compute and snapshot workers',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'quest-contact-service-')),logs=[];
 const service=createQuestService({filename:join(directory,'world.sqlite'),workerCount:1,zoneWorkers:1,log:(...args)=>logs.push(args),walletClient:{authenticate:async()=>({owner:'alice',id:'alice',client:'lidollquest',coins:0,scope:'wallet:read wallet:write social:read'})}});
 try{
  await service.prepare();await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+service.server.address().port,headers={Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json'};let current;
  const act=async(action,extra={})=>{const response=await fetch(base+'/zones/action',{method:'POST',headers,body:JSON.stringify({action,controller:'contact-test',request_id:randomUUID(),character_id:current?.character.id,revision:current?.character.revision,...extra})});current=await response.json();assert.equal(response.status,200,JSON.stringify(current));};
  await act('create',{name:'Contact tester'});await act('enter',{zone:'princess-rose',combat_version:3,content_version:1,follower_version:1,loadout:{player_info:{level:1,playerHealth:100,playerHealthMax:100},inventory:[]}});await act('dive_enter');
  const id=current.character.id,visit=current.character.dive,row=service.db.prepare('SELECT * FROM dive_editions WHERE route=? AND edition=?').get(visit.route,visit.edition),floor=JSON.parse(row.content);
  const foe=floor.enemies.find(e=>enemyRoams(diveData,e)&&e.definition?.temperament!=='neutral'),safe=floor.safeRooms??[floor.rooms[0]];
  assert.ok(foe);let target;
  for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const p={x:foe.x+dx,y:foe.y+dy};if(walkable(floor,p.x,p.y)&&!safe.some(r=>inside(r,p.x,p.y))){target=p;break;}}
  assert.ok(target);for(const enemy of floor.enemies)enemy.nextStep=enemy.id===foe.id?0:Date.now()+60000;
  service.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=?').run(JSON.stringify(floor),visit.route,visit.edition);
  const state=JSON.parse(service.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id).state);state.dive.safeUntil=0;state.dive.position=target;
  service.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),id);service.db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(target.x,target.y,Date.now(),id); // Place an eligible player beside the enemy without relying on movement to trigger the simulation.
  const deadline=Date.now()+5000;let observed;
  do{await sleep(100);const response=await fetch(base+'/zones?character_id='+id,{headers});observed=await response.json();assert.equal(response.status,200,JSON.stringify(observed));}while(!observed.character.run&&Date.now()<deadline);
  assert.equal(observed.character.run?.encounter,foe.id,JSON.stringify(logs));assert.ok(observed.character.run.sharedEncounter);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));await service.shards?.close();rmSync(directory,{recursive:true,force:true});}
});
