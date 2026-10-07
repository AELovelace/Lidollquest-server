// Crowd test: a manual, one-off load test that packs 64, then 128, then 256 players into one hub and measures how the
// real quest service holds up. It is NOT part of `npm test` (that only runs test/*.test.mjs) because it takes minutes and
// its numbers depend on the machine.
//
// What runs where:
//   - This process boots the real service (service.mjs) on a throwaway database file, with zone workers, compute workers
//     and the one-second world timer, exactly like main.mjs does. Its event loop is the coordinator we want to measure.
//   - A forked child process plays the crowd over real HTTP, so the bots' own CPU never counts against the server.
//   - Each bot behaves like the GameMaker client: one request in flight, then a 500 ms pause (scrOnlineZones), mixing
//     polls (GET /zones), single-step moves and the occasional area chat line, and it sends the snapshot-diet `known=`
//     list so responses are as slim as a real client's. Moves carry world_step:true and are followed by the world_turn
//     that hands the loadout back, as scrOnlineRoom does, so every step bumps the walker's revision like live play.
//     (--no-warnings only hides node:sqlite's experimental notice.)
//
// Usage (from the server repo root):
//   node --no-warnings deploy/crowd-test.mjs                     # 64, 128, 256 players, 60 s each, honeydew-lantern
//   node deploy/crowd-test.mjs --players=8 --seconds=10          # quick smoke run
//   node deploy/crowd-test.mjs --zone=princess-rose --zone-workers=5 --compute-workers=5 --out=crowd.json
//   node deploy/crowd-test.mjs --server=../lq-baseline/server    # A/B an older checkout, like benchmark-world
// Options: --players (comma list), --seconds (measured window per stage), --warmup (unmeasured seconds per stage),
//   --zone, --move (share of cycles that step), --chat (share that chat), --poll-ms (pause between requests),
//   --zone-workers / --compute-workers (auto or a number, as on the live server), --server (checkout to load),
//   --out (also write the full results as JSON), --keep (keep the temporary database folder for inspection),
//   --needs-turns=off (plain moves with no world_turn, to compare with runs made before needs turns were added),
//   --gm (also print each stage worded exactly like the /gm Performance tab, with every timing row, so a line from the
//   test can be matched against the live panel; with --out the full panel sample is saved per stage too).
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir,availableParallelism} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';

const CROWD_FLAG='--crowd-driver'; // argv marker that turns the forked copy of this file into the bot process.
const arg=(name,fallback)=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3)??fallback; // --name=value options, same helper as benchmark-world.
const sleep=ms=>new Promise(done=>setTimeout(done,ms)); // Promise pause used by the bots between requests.
const round=v=>Number.isFinite(v)?Math.round(v*100)/100:null; // Two decimals for printing; null for "no data".

if(process.argv.includes(CROWD_FLAG))runCrowd(); // Child process: play the bots and report back over IPC.
else await runServer(); // Parent process: host the service and conduct the stages.

// ---------------------------------------------------------------------------------------------------------------------
// Parent: the server under test
// ---------------------------------------------------------------------------------------------------------------------
async function runServer(){
 const stages=String(arg('players','64,128,256')).split(',').map(Number).filter(n=>Number.isInteger(n)&&n>0).sort((a,b)=>a-b); // Ascending, so each stage only adds players.
 if(!stages.length)throw Error('--players must be a comma list of positive whole numbers, e.g. 64,128,256');
 const seconds=Number(arg('seconds',60)),warmup=Number(arg('warmup',10)),zone=arg('zone','honeydew-lantern'); // Measured window, unmeasured settle time, and which hub to crowd.
 const behaviour={move:Number(arg('move',0.5)),chat:Number(arg('chat',0.03)),pollMs:Number(arg('poll-ms',500)),needsTurns:arg('needs-turns','on')!=='off'}; // Bot mix: half the cycles step (step + needs turn), ~3% chat, the rest poll.
 const gmView=process.argv.includes('--gm'); // Also print the /gm Performance wording with every timing row.
 const serverDir=resolve(arg('server','server')),out=arg('out',''),keep=process.argv.includes('--keep'); // Checkout to load, optional JSON report, keep the temp DB?
 const load=file=>import(pathToFileURL(resolve(serverDir,file)).href); // Import a module from the chosen checkout.
 const [{createQuestService},{worldWorkerBudget}]=await Promise.all([load('service.mjs'),load('zone-shards.mjs')]);
 const {zoneWorkers,workerCount}=worldWorkerBudget(arg('zone-workers','auto'),arg('compute-workers','auto')); // Same automatic budget as main.mjs, so a default run matches a default deploy on this machine.

 const directory=mkdtempSync(join(tmpdir(),'quest-crowd-')),failures=new Map(); // Throwaway world; unexpected server errors are tallied by message.
 const log=(kind,...rest)=>{const key=[kind,...rest.slice(0,3)].join(' ').slice(0,200);failures.set(key,(failures.get(key)??0)+1);}; // Count instead of spamming the console 256 times per second.
 const service=createQuestService({
  filename:join(directory,'quest.sqlite'),workerCount,zoneWorkers,zoneCapacity:Math.max(256,stages.at(-1)),log, // A file database (zone workers need one) and a cap that admits the biggest stage.
  performanceOptions:{automatic:false,probeLag:true}, // Our own samples at the edges of each window instead of every 60 s, keeping the 100 ms stall heartbeat so lag counts match /gm.
  walletClient:{authenticate:async token=>({owner:token,id:token,client:'lidollquest',coins:0,scope:'wallet:read wallet:write social:read'})}, // Every bot token is its own account; no tracker involved.
 });
 await service.prepare();await new Promise(done=>service.server.listen(0,'127.0.0.1',done)); // Boot workers, then listen on a random free port.
 const base='http://127.0.0.1:'+service.server.address().port;
 console.log(`Crowd test: ${stages.join(' / ')} players in ${zone}, ${warmup} s warm-up + ${seconds} s measured per stage`);
 console.log(`Machine: ${availableParallelism()} cores · ${zoneWorkers} zone workers · ${workerCount} compute workers · server ${serverDir}`);

 const crowd=fork(fileURLToPath(import.meta.url),[CROWD_FLAG],{stdio:['ignore','inherit','inherit','ipc']}); // Separate process: bot CPU stays out of the server's numbers.
 const replies=[];let waiting=null;crowd.on('message',m=>{if(waiting){const w=waiting;waiting=null;w(m);}else replies.push(m);}); // One request -> one reply, in order.
 const ask=message=>{crowd.send(message);return replies.length?Promise.resolve(replies.shift()):new Promise(done=>{waiting=done;});}; // Send a command to the crowd and wait for its answer.
 crowd.on('exit',code=>{if(code)console.error('Crowd process exited with code',code);});

 const results=[];
 try{
  for(const players of stages){
   const setup=await ask({type:'grow',base,zone,players}); // Create and seat any bots this stage still needs (earlier stages' bots stay online).
   if(setup.error)throw Error('Crowd setup failed: '+setup.error);
   process.stdout.write(`\n▶ ${players} players: seated ${setup.seated} new bots in ${round(setup.ms/1000)} s, warming up...`);
   const run=ask({type:'run',warmupMs:warmup*1000,measureMs:seconds*1000,behaviour}); // Bots start playing now and report after warm-up + window.
   await sleep(warmup*1000);service.metrics.sample();failures.clear(); // Throw away warm-up timings so the window starts clean.
   const started=performance.now();process.stdout.write(' measuring...');
   const crowdReport=await run;const server=service.metrics.sample(); // The sample covers exactly the measured window (plus a few ms of report hand-off).
   const row=summarise(players,crowdReport,server,performance.now()-started,service.shards?.snapshot(),failures);if(gmView)row.panel=server;results.push(row); // --gm keeps the whole /gm sample (every timing, lag, workers) in the JSON.
   process.stdout.write(' done\n');printStage(row);if(gmView)printPanel(server,players);
  }
 }finally{
  crowd.send({type:'stop'});crowd.disconnect(); // Let the crowd exit; it holds no state worth saving.
  service.server.closeAllConnections();await new Promise(done=>service.server.close(done));await service.shards?.close(); // Same shutdown order as the HTTP tests.
  if(keep)console.log('\nDatabase kept at',directory);else rmSync(directory,{recursive:true,force:true}); // Temp world removed unless --keep.
 }
 printComparison(results);
 if(out){writeFileSync(out,JSON.stringify({zone,seconds,warmup,behaviour,cores:availableParallelism(),zoneWorkers,workerCount,serverDir,results},null,1));console.log('\nFull results written to',out);}
}

function summarise(players,crowd,server,elapsedMs,shards,failures){ // Join what the bots saw with what the server measured.
 return {players,elapsedSeconds:round(elapsedMs/1000),
  coordinator:{eventLoopPercent:server?.eventLoopPercent,delayP95Ms:server?.delayP95Ms,delayMaxMs:server?.delayMaxMs,processCpuPercent:server?.cpuPercent,rssMiB:server?.rssMiB}, // Event-loop busy is the number that says "write-bound or not".
  requests:{perSecond:round(crowd.total/(crowd.windowMs/1000)),...crowd.statuses}, // Throughput and outcome counts as the bots saw them.
  latency:crowd.latency, // Bot-side round trip per kind of request: p50 / p95 / p99 / max in ms.
  snapshotKiB:crowd.snapshotKiB, // Average response size; grows with the crowd because every peer is in every snapshot.
  serverTimings:(server?.timings??[]).slice(0,25).map(t=>({name:t.name,calls:t.calls,totalMs:t.totalMs,meanMs:t.meanMs,maxMs:t.maxMs})), // Where the time went, biggest first (coordinator and worker rows together, as on /gm Performance).
  zoneWorkers:shards?{size:shards.size,busy:shards.busy,queued:shards.queued,rejected:shards.rejected}:null,
  unexpectedErrors:[...failures].map(([message,count])=>({message,count})), // zone_request_failed and friends logged by the service during the window.
  verdict:verdict(server?.eventLoopPercent,crowd)};
}

function verdict(loop,crowd){ // Plain-language reading, using the same cut-offs as the MariaDB evaluation memory.
 const busy=crowd.statuses.busy??0,fatal=(crowd.statuses.serverError??0)+(crowd.statuses.network??0);
 if(fatal)return 'FAILING: server errors or dropped connections';
 if(busy)return 'OVERLOADED: "Online zones are busy" refusals';
 if(loop==null)return 'unknown';
 if(loop>=85)return 'SATURATED: coordinator nearly always busy';
 if(loop>=60)return 'WARM: approaching the coordinator ceiling';
 return 'OK: plenty of headroom';
}

function printStage(row){ // Human-readable block per stage.
 const l=row.latency,c=row.coordinator,r=row.requests;
 console.log(`  coordinator busy ${c.eventLoopPercent}% · loop delay p95 ${c.delayP95Ms} ms / max ${c.delayMaxMs} ms · process CPU ${c.processCpuPercent}% · RSS ${c.rssMiB} MiB`);
 console.log(`  ${r.perSecond} req/s · ok ${r.ok??0} · refused ${r.refused??0} · busy ${r.busy??0} · 5xx ${r.serverError??0} · network ${r.network??0} · snapshot ~${row.snapshotKiB} KiB`);
 for(const kind of Object.keys(l))console.log(`  ${kind.padEnd(5)} p50 ${l[kind].p50} · p95 ${l[kind].p95} · p99 ${l[kind].p99} · max ${l[kind].max} ms (${l[kind].count} calls)`);
 const offThread=t=>t.name.startsWith('shard.')||t.name.startsWith('worker.')||t.name==='zones.shard_refresh'||t.name.startsWith('account.'); // Worker execution and async waits overlap the coordinator, so they are listed apart.
 console.log('  coordinator work: '+row.serverTimings.filter(t=>!offThread(t)).slice(0,6).map(t=>`${t.name} ${t.totalMs} ms`).join(' · '));
 const worker=row.serverTimings.find(t=>t.name==='shard.snapshot');if(worker)console.log(`  zone workers: ${worker.calls} snapshots, mean ${worker.meanMs} ms, max ${worker.maxMs} ms`);
 if(row.unexpectedErrors.length)console.log('  unexpected: '+row.unexpectedErrors.slice(0,5).map(e=>`${e.count}× ${e.message}`).join(' | '));
 console.log('  → '+row.verdict);
}

function printPanel(row,players){ // The measured window in the /gm Performance tab's own words (gm-panel.html renderPerformance), so lines compare one-to-one.
 if(!row){console.log('  (no /gm sample for this window)');return;}
 const metric=(value,suffix='')=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(1)+suffix:'—'; // Same formatting as the panel's metric().
 const r=row.requests,w=row.workers,sh=row.shards,lag=row.lag;
 console.log(`\n  ── /gm Performance view · ${players} players · interval ending ${new Date(row.at).toLocaleString()} (${metric(row.elapsedMs/1000,' s')}) ──`);
 console.log(`  ${metric(row.cpuPercent,'%')} process CPU · ${metric(row.eventLoopPercent,'%')} event loop busy · ${metric(row.delayP95Ms,' ms')} loop delay p95 · ${metric(row.rssMiB,' MiB')} resident memory`); // The panel's top tiles.
 console.log(`  ${metric(r.perSecond)} game requests / sec · ${r.active} active requests · ${metric(r.p95Ms,' ms')} request p95 · ${lag?lag.slowRequests:'—'} requests ≥250 ms · ${lag?lag.loopStalls:'—'} loop stalls ≥100 ms`);
 console.log(`  Current interval: ${r.completed} completed requests · ${r.clientErrors} 4xx · ${r.serverErrors} 5xx · ${r.throttled} throttled · ${r.aborted} disconnected · mean ${metric(r.meanMs,' ms')} / max ${metric(r.maxMs,' ms')} · peak active ${r.peakActive} · heap ${metric(row.heapMiB,' MiB')} · max loop delay ${metric(row.delayMaxMs,' ms')}`);
 console.log(`  Request p95: ${metric(r.p95Ms,' ms')}. `+(w?`Compute workers: ${w.busy} / ${w.size} busy, ${w.queued} queued, ${w.rejected} queue rejections. Lifetime jobs: `+w.workers.map(x=>`#${x.index+1}: ${x.completed} completed / ${x.failed} failed`).join('; '):'Compute workers disabled (synchronous mode).'));
 console.log('  '+(sh?`Shared-world zone workers: ${sh.busy} / ${sh.size} busy, ${sh.queued} queued, ${sh.rejected} rejected. `+sh.workers.map(x=>`#${x.index+1}: ${x.completed} snapshots, ${x.failed} failures, ${x.restarts} restarts, ${x.zones.length} zones`).join('; ')+'.':'Zone workers disabled; snapshots run on the coordinator.'));
 if(lag)console.log(`  This interval: ${lag.slowRequests} / ${r.completed} requests took at least ${lag.requestThresholdMs} ms; ${lag.severeRequests} took at least ${lag.severeThresholdMs} ms. Request p95 ${metric(r.p95Ms,' ms')}. Loop stalls: ${lag.loopStalls}; longest heartbeat delay beyond its scheduled wait: ${metric(lag.maxLoopLagMs,' ms')}. Loop delay p95 ${metric(row.delayP95Ms,' ms')} / max ${metric(row.delayMaxMs,' ms')}.`);
 const timings=row.timings??[],width=Math.max(4,...timings.map(t=>t.name.length)); // Pad the Work column to the longest row name.
 console.log('  '+['Work'.padEnd(width),'Calls'.padStart(7),'Total ms'.padStart(10),'Mean ms'.padStart(8),'Max ms'.padStart(8),'Errors'.padStart(6)].join('  '));
 for(const t of timings)console.log('  '+[t.name.padEnd(width),String(t.calls).padStart(7),metric(t.totalMs).padStart(10),metric(t.meanMs).padStart(8),metric(t.maxMs).padStart(8),String(t.errors).padStart(6)].join('  ')); // Every row, biggest total first, like the panel's table.
}

function printComparison(results){ // One table across stages so the trend is easy to read.
 if(results.length<2)return;
 console.log('\nplayers | coord busy | req/s | read p95 | move p95 | snapshot | verdict');
 for(const r of results)console.log(`${String(r.players).padStart(7)} | ${String(r.coordinator.eventLoopPercent+'%').padStart(10)} | ${String(r.requests.perSecond).padStart(5)} | ${String((r.latency.read?.p95??'—')+' ms').padStart(8)} | ${String((r.latency.move?.p95??'—')+' ms').padStart(8)} | ${String(r.snapshotKiB+' KiB').padStart(8)} | ${r.verdict}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Child: the crowd
// ---------------------------------------------------------------------------------------------------------------------
function runCrowd(){
 const bots=[];let stopping=false; // Every seated bot, kept across stages.
 const LOADOUT={player_info:{class_id:'fighter',level:12,playerHealth:500,playerHealthMax:500,str:10,def:8,dex:8,int:20,cha:10,xp:0,stat_points:0},inventory:[{item_id:'adult_food'}],player_spells:[],player_mp:10,player_mp_max:10}; // Same mid-level adventurer as benchmark-world.
 const DIRECTIONS=['north','south','east','west'];
 process.on('message',async message=>{
  try{
   if(message.type==='grow')process.send(await grow(message));
   else if(message.type==='run')process.send(await play(message));
   else if(message.type==='stop'){stopping=true;process.exit(0);}
  }catch(error){process.send({error:String(error?.message??error)});}
 });

 async function request(bot,method,path,body){ // One HTTP round trip; returns status, parsed JSON, size and elapsed ms.
  const started=performance.now();
  try{
   const response=await fetch(bot.base+path,{method,headers:{Authorization:'Bearer '+bot.token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
   const text=await response.text();let data=null;try{data=JSON.parse(text);}catch{} // Errors are JSON too; tolerate anything else.
   return {status:response.status,data,bytes:text.length,ms:performance.now()-started};
  }catch(error){return {status:0,data:{error_description:String(error?.message??error)},bytes:0,ms:performance.now()-started};} // Timeout or refused connection.
 }
 const known=bot=>bot.known?'known='+[...bot.known].join(','):''; // Snapshot diet: the cache keys this bot holds, like online_zone_known() in scrOnlineZones.
 const command=(bot,input)=>request(bot,'POST','/zones/action'+(bot.known?'?'+known(bot):''),{request_id:randomUUID(),controller:bot.controller,character_id:bot.character?.id,revision:bot.character?.revision,...input}); // Same envelope the client sends.
 const poll=bot=>request(bot,'GET','/zones?character_id='+encodeURIComponent(bot.character.id)+(bot.known?'&'+known(bot):'')); // The client's 500 ms read.
 const remember=(bot,result)=>{ // Track id + revision so the next command is accepted, and the cache keys this response referenced.
  if(result.status!==200||!result.data)return;
  if(result.data.character)bot.character=result.data.character;
  if(result.data.capabilities?.snapshotCache&&result.data.cacheKeys){ // Same pieces online_zone_cache_merge keeps: rooms, cached sections and player looks.
   bot.known=new Set([...(result.data.zones??[]).map(z=>z.cacheKey).filter(Boolean),...Object.values(result.data.cacheKeys),...Object.keys(result.data.looks??{})]);
  }else if(result.data.capabilities?.snapshotCache&&!bot.known)bot.known=new Set(); // Server advertised the diet: opt in with an empty list, then the next response carries keys.
 };

 async function grow({base,zone,players}){ // Create and enter bots until `players` are seated, 16 at a time.
  const started=performance.now(),before=bots.length;
  while(bots.length<players){
   const batch=[];
   for(let n=0;n<16&&bots.length+batch.length<players;n++){
    const index=bots.length+batch.length,bot={base,index,token:('crowdbot'+index+'_').padEnd(43,'x'),controller:'crowd-'+index,character:null,facing:DIRECTIONS[index%4]}; // Token must be 20-100 URL-safe characters.
    batch.push(bot);
   }
   await Promise.all(batch.map(async bot=>{
    let r=await command(bot,{action:'create',name:'Crowd '+bot.index});if(r.status!==200)throw Error('create '+r.status+' '+(r.data?.error_description??''));remember(bot,r);
    r=await command(bot,{action:'enter',zone,combat_version:3,content_version:1,quest_version:1,follower_version:1,loadout:LOADOUT});if(r.status!==200)throw Error('enter '+r.status+' '+(r.data?.error_description??''));remember(bot,r);
   }));
   bots.push(...batch);
  }
  return {seated:bots.length-before,ms:performance.now()-started};
 }

 async function play({warmupMs,measureMs,behaviour}){ // Every bot loops until the window ends; only the measured part is recorded.
  const begin=performance.now(),measureFrom=begin+warmupMs,end=measureFrom+measureMs;
  const samples={read:[],move:[],turn:[],chat:[]},statuses={},bytes={total:0,count:0};
  const tally=key=>{statuses[key]=(statuses[key]??0)+1;};
  const record=(kind,result)=>{const at=performance.now();if(at<measureFrom||at>end+1000)return;samples[kind].push(result.ms);tally(classify(result));if(result.status===200){bytes.total+=result.bytes;bytes.count++;}}; // Measured-window traffic only.
  const classify=r=>{ // Map a response onto the buckets the report prints.
   if(r.status===200)return 'ok';
   if(r.status===0)return 'network';
   if(r.status>=500)return 'serverError';
   if(r.status===429&&r.data?.error_description==='Online zones are busy.')return 'busy'; // The global in-flight cap: the one 429 that means "server overloaded".
   return 'refused'; // Walls, revision races, movement pacing, chat quota: normal gameplay refusals.
  };
  async function loop(bot){
   await sleep(Math.random()*behaviour.pollMs); // Stagger so 256 bots don't fire in lock-step.
   while(!stopping&&performance.now()<end){
    const roll=Math.random();let kind,result;
    if(roll<behaviour.move){ // Wander: mostly keep going the same way, sometimes turn, like a player crossing town.
     if(Math.random()<0.25)bot.facing=DIRECTIONS[Math.floor(Math.random()*4)];
     kind='move';result=await command(bot,{action:'move',direction:bot.facing,...(behaviour.needsTurns?{world_step:true}:{})}); // world_step: a walking step that reserves one needs turn, as scrOnlineRoom sends it.
     if(result.status===409&&/blocked/i.test(result.data?.error_description??''))bot.facing=DIRECTIONS[Math.floor(Math.random()*4)]; // Bumped a wall: pick a new heading.
     const due=result.status===200?result.data?.character?.worldTurnDue?.id:null; // The server reserved a needs turn for this step.
     if(due){ // The client runs the turn locally and hands the loadout straight back, bumping the walker's revision a second time.
      remember(bot,result);record('move',result); // The step itself is done; log it before the follow-up.
      kind='turn';result=await command(bot,{action:'world_turn',world_turn_id:due,loadout:result.data.character.loadout??LOADOUT}); // The shared code below records and remembers the turn.
     }
    }else if(roll<behaviour.move+behaviour.chat){kind='chat';result=await command(bot,{action:'chat',channel:'area',text:'Crowd bot '+bot.index+' says hi'});}
    else{kind='read';result=await poll(bot);}
    remember(bot,result);
    if(result.status===409&&/refresh/i.test(result.data?.error_description??''))remember(bot,await poll(bot)); // Revision race: refresh like the client would.
    record(kind,result);
    await sleep(behaviour.pollMs); // The client's 500 ms poll delay after every response.
   }
  }
  await Promise.all(bots.map(loop));
  const pct=(list,p)=>{if(!list.length)return null;const sorted=[...list].sort((a,b)=>a-b);return round(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]);};
  const latency=Object.fromEntries(Object.entries(samples).filter(([,list])=>list.length).map(([kind,list])=>[kind,{count:list.length,p50:pct(list,0.5),p95:pct(list,0.95),p99:pct(list,0.99),max:round(Math.max(...list))}]));
  return {total:Object.values(samples).reduce((n,list)=>n+list.length,0),windowMs:measureMs,statuses,latency,snapshotKiB:bytes.count?round(bytes.total/bytes.count/1024):null};
 }
}
