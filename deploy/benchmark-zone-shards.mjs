import {DEFAULT_ZONE_CAPACITY} from '../server/zone-capacity.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,cpus,totalmem,platform,release} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
import {hubTileBlocked} from '../server/zones.mjs';

const arg=(name,fallback)=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
const workers=Number(arg('workers',5)),computeWorkers=Number(arg('compute-workers',0)),count=Number(arg('players',200)),seconds=Number(arg('seconds',30)),hz=Number(arg('hz',2));
const singleZone=arg('zone',''),zoneCapacity=Number(arg('zone-capacity',DEFAULT_ZONE_CAPACITY)); // Override capacity only for this isolated service; otherwise use the shared default.
if(!Number.isInteger(count)||count<1||count>300||!Number.isFinite(seconds)||seconds<5||seconds>300||!Number.isFinite(hz)||hz<.1||hz>4)throw Error('Use 1-300 players, 5-300 seconds, and 0.1-4 requests/sec/player');
if(!Number.isSafeInteger(zoneCapacity)||zoneCapacity<1)throw Error('Use a positive integer zone capacity');
if(singleZone&&count>zoneCapacity)throw Error('Single-zone population exceeds --zone-capacity'); // Reject invalid runs before creating temporary data or worker threads.
const directory=mkdtempSync(join(tmpdir(),'quest-zone-load-')),filename=join(directory,'world.sqlite');
const service=createQuestService({filename,zoneWorkers:workers,workerCount:computeWorkers,zoneCapacity,log:()=>{},walletClient:{authenticate:async token=>({owner:token,id:token,client:'lidollquest',coins:0,scope:'wallet:read wallet:write social:read'})}});
let child;
try{
 await service.prepare();await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port,players=[],hubs=['princess-rose','honeydew-lantern','littlebig-clockwork','utopia-arcanum','arcadia-foundry'];
 for(let index=0;index<count;index++){
  const token=('load-'+index).padEnd(43,'x'),zone=singleZone||hubs[index%hubs.length];
  service.db.prepare('UPDATE quest_presence SET seen=?').run(Date.now()); // Keep the entire seeded crowd active even when setup lasts longer than a presence lease.
  const command=async input=>{const response=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),controller:'benchmark',...input})}),result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));return result;};
  const created=await command({action:'create',name:'Load player '+index});
  const state=await command({action:'enter',character_id:created.character.id,revision:created.character.revision,zone,combat_version:3,content_version:1,quest_version:1,full_dungeon_version:1,flow_version:1,follower_version:1,loadout:{player_info:{level:10,playerHealth:200,playerHealthMax:200,str:10,def:10,dex:10,int:10,cha:10},inventory:[]}});
  const room=state.zones.find(z=>z.id===state.zone),point=state.position,step=[['east','west',1,0],['west','east',-1,0],['north','south',0,-1],['south','north',0,1]].find(([, ,dx,dy])=>!hubTileBlocked(room,point.x+dx,point.y+dy));
  players.push({token,state,direction:step?.[0],reverse:step?.[1]});
  if((index+1)%32===0||index+1===count)console.error(`Prepared ${index+1}/${count} players`);
 }
 if(singleZone){
  service.db.prepare('UPDATE quest_presence SET seen=?').run(Date.now());
  const response=await fetch(base+'/zones?character_id='+players[0].state.character.id,{headers:{Authorization:'Bearer '+players[0].token}}),snapshot=await response.json();
  if(!response.ok||snapshot.zone!==singleZone||snapshot.peers?.length!==count)throw Error(`Single-zone visibility check failed: expected ${count}, received ${snapshot.peers?.length}`); // Reject misleading runs where a worker silently truncates peers at 64.
  console.error(`Verified ${count} visible players in ${singleZone}; starting ${seconds}s load`);
 }
 service.db.prepare('UPDATE quest_presence SET seen=?').run(Date.now());service.metrics.sample();const firstSample=service.db.prepare('SELECT MAX(id) id FROM server_performance_samples').get().id;
 child=fork(new URL('./zone-load-client.mjs',import.meta.url),[],{stdio:['ignore','ignore','inherit','ipc']});
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{reject(Error('Load client exited before results: '+code));});child.once('message',resolve);child.send({base,players,seconds,hz,expectedPeers:singleZone?count:null});});
 const metrics=service.metrics.sample(),samples=service.db.prepare('SELECT data FROM server_performance_samples WHERE id>? ORDER BY id').all(firstSample).map(r=>JSON.parse(r.data)),duration=samples.reduce((n,r)=>n+r.elapsedMs,0),weighted=key=>samples.reduce((n,r)=>n+r[key]*r.elapsedMs,0)/duration;
 const lag={...metrics.lag};for(const key of ['slowRequests','severeRequests','loopStalls'])lag[key]=samples.reduce((n,r)=>n+r.lag[key],0);lag.maxLoopLagMs=Math.max(...samples.map(r=>r.lag.maxLoopLagMs));
 console.log(JSON.stringify({workers,computeWorkers,zone:singleZone||'five hubs',zoneCapacity,seconds,hz,host:{node:process.version,platform:platform(),release:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,ramGiB:totalmem()/1024**3},...result,server:{cpuPercent:weighted('cpuPercent'),eventLoopPercent:weighted('eventLoopPercent'),delayP95Ms:Math.max(...samples.map(r=>r.delayP95Ms??0)),delayMaxMs:Math.max(...samples.map(r=>r.delayMaxMs??0)),rssMiB:metrics.rssMiB,lag,workers:metrics.workers,shards:metrics.shards,timings:metrics.timings.slice(0,20)},scope:'Isolated SQLite, synthetic wallets, '+(singleZone?'one populated safe hub':'five populated safe hubs')+', paced heartbeat/move/Area-chat mix; excludes combat, real wallet latency, remote network and browser rendering. Loop delay p95 is the maximum interval p95; operation timings are the final interval.'},null,2));
}finally{child?.kill();service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));await service.shards?.close();rmSync(directory,{recursive:true,force:true});}
