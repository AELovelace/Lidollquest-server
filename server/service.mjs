import {createWorldContent} from './world-content.mjs';
import {createWorldJobs} from './world-jobs.mjs';
import {combatData} from './combat.mjs';
import {hubData} from './hubs.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {createQuestZones} from './zones.mjs';
import {createCloudSaves} from './cloud-saves.mjs';
import {createCharacterManagement} from './character-management.mjs';
import {createPrivateSprites} from './private-sprites.mjs';
import {DAILY_COIN_CAP} from './hubs.mjs';
import {createOnlineFeed} from './online-feed.mjs';
import {createMommybotProfile} from './mommybot-profile.mjs';
import {createGameMasterPanel} from './gm.mjs';
import {createEnchantmentStore} from './enchantment-store.mjs';
import {createLootStore} from './loot-store.mjs';
import {diveData} from './dive.mjs';
import {createPerformanceMonitor} from './performance.mjs';
import {createComputePool,computeWorkerCount} from './compute-pool.mjs';

export function loadQuestPack(path){ // LIDOLLQUEST_QUEST_PACK names a shipped quest file; unset means no live quests, exactly as before.
 if(!path)return [];
 const file=isAbsolute(path)?path:fileURLToPath(new URL('../'+path,import.meta.url)); // Relative to the package root, so the service's working directory cannot change which file loads.
 let pack;
 try{pack=JSON.parse(readFileSync(file,'utf8'));}
 catch(error){throw Error('LIDOLLQUEST_QUEST_PACK could not be read: '+error.message);}
 if(pack?.kind!=='quest'||!Array.isArray(pack.quests))throw Error('LIDOLLQUEST_QUEST_PACK must be a JSON object with kind "quest" and a quests array.');
 if(new Set(pack.quests.map(q=>q?.id)).size!==pack.quests.length)throw Error('LIDOLLQUEST_QUEST_PACK contains duplicate quest IDs.');
 return pack.quests;
} // Publishing live quest content refuses clients without quest_version:1, so this stays an explicit deployment choice.

export function createQuestService({filename=':memory:',walletClient,spriteProvider,artJobOptions={},now=Date.now,roll,log=console.warn,performanceOptions={},workerCount=0,onlineToken=process.env.MOMMYBOT_ONLINE_TOKEN||'',gmAllow=process.env.LIDOLLQUEST_GM_ALLOW||'',gmEnabled=process.env.LIDOLLQUEST_GM_ENABLED!=='false',gmTrustProxy=process.env.LIDOLLQUEST_GM_TRUST_PROXY||'',gmRequireTls=process.env.LIDOLLQUEST_GM_REQUIRE_TLS==='true',questPack=loadQuestPack(process.env.LIDOLLQUEST_QUEST_PACK||'')}={}){
 const poolSize=computeWorkerCount(workerCount);let compute=null; // Validate configuration before opening persistent resources.
 const db=new DatabaseSync(filename);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
 db.exec(`CREATE TABLE IF NOT EXISTS wallet_cache(owner TEXT PRIMARY KEY,coins INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS reward_outbox(id TEXT PRIMARY KEY,owner TEXT NOT NULL,amount INTEGER NOT NULL,reason TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS reward_delivery ON reward_outbox(owner,delivered);`);
 let identity=null; // The simulation below is synchronous; the HTTP layer never awaits while this identity is in use.
 const onlineFeed=createOnlineFeed(db,{token:onlineToken,now});
 const mommybotProfile=createMommybotProfile(db,{token:onlineToken,enabled:owner=>!gm.suspended(owner),now});
 const metrics=createPerformanceMonitor(db,{log,...performanceOptions,workers:()=>compute?.snapshot()??null}); // Process CPU includes workers; event-loop delay still describes the coordinator.
 if(poolSize)compute=createComputePool({size:poolSize,observe:metrics.observe});
 const live=createWorldContent(db,{now,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment,questPack});
 const artJobs=createWorldJobs(db,{live,now,...artJobOptions});
 const gm=createGameMasterPanel(db,{walletClient,live,artJobs,world:()=>zones.world,performanceSnapshot:metrics.snapshot,enchantments:createEnchantmentStore(db,{now}),enchantmentTable:()=>diveData.enchantments,loot:createLootStore(db,{now}),lootTable:()=>diveData.loot,lootItems:()=>diveData.items,lootBases:()=>diveData.bases,allow:gmAllow,trustProxy:gmTrustProxy,requireTls:gmRequireTls,enabled:gmEnabled,now,log}); // Staff moderation owns its own tables and never touches wallet credentials.
 const zones=createQuestZones(db,{now,roll,compute,live,measure:metrics.measure,onPresence:onlineFeed.record,enabled:owner=>!gm.suspended(owner),muted:gm.muted,audit:gm.record,grant:()=>{if(!identity)throw Error('Missing request identity');return identity;},wallet:owner=>({coins:db.prepare('SELECT coins FROM wallet_cache WHERE owner=?').get(owner)?.coins??0}),adjust:(owner,asset,amount,id,reason)=>{
  if(asset!=='coins'||!Number.isSafeInteger(amount)||amount<1||amount>DAILY_COIN_CAP)throw Error('Invalid server award'); // A single entitlement can never exceed one day's whole allowance.
  db.prepare('INSERT INTO reward_outbox(id,owner,amount,reason) VALUES (?,?,?,?)').run(id,owner,amount,reason);
 }});
 db.prepare('INSERT OR IGNORE INTO mommybot_online_seen SELECT owner,seen FROM quest_presence').run(); // Seed existing sessions on rollout without announcing their next heartbeat as a fresh join.
 const cloud=createCloudSaves(db,{now});
 const sprites=createPrivateSprites(db,{walletClient,provider:spriteProvider,now,log});zones.setPrivateSprites(sprites);
 const management=createCharacterManagement(db,{walletClient,cloud,sprites,now,log});
 const deliveries=new Map();
 async function flush(owner,token){
  if(deliveries.has(owner))return deliveries.get(owner);
  const task=(async()=>{
   for(const row of db.prepare('SELECT * FROM reward_outbox WHERE owner=? AND delivered=0 LIMIT 8').all(owner)){
    try{const receipt=await metrics.measureAsync('account.credit',()=>walletClient.credit(token,{request_id:'arena-'+row.id,kind:'credit',amount:row.amount}));db.prepare('UPDATE reward_outbox SET delivered=1 WHERE id=?').run(row.id);db.prepare('UPDATE wallet_cache SET coins=? WHERE owner=?').run(receipt.balance,owner);}
    catch(error){console.warn('quest_reward_delivery_failed',row.id,error?.status??'transport');return;} // Log no credentials; retry this same entitlement on the next authenticated visit.
   }
  })();deliveries.set(owner,task);try{await task;}finally{deliveries.delete(owner);}
 }
 const purchases=new Map();
 async function settlePurchases(owner,token){
  if(purchases.has(owner))return purchases.get(owner);
  const task=(async()=>{for(const row of db.prepare("SELECT * FROM hub_purchases WHERE owner=? AND status='pending'").all(owner)){
   try{const receipt=await metrics.measureAsync('account.debit',()=>walletClient.credit(token,{request_id:'shop-'+row.id,kind:'debit',amount:row.price}));zones.completePurchase(row.id,true);db.prepare('UPDATE wallet_cache SET coins=? WHERE owner=?').run(receipt.balance,owner);}
   catch(error){if(error.code==='insufficient_balance')zones.completePurchase(row.id,false);else log('quest_purchase_delivery_pending',row.id,error.status??'transport');}
  }})();purchases.set(owner,task);try{await task;}finally{purchases.delete(owner);}
 } // Retry a durable debit ID before accepting any subsequent inventory-changing command.
 let active=0;const perToken=new Map();
 const server=createServer((req,res)=>{void (async()=>{
  if(!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))throw Object.assign(Error('Invalid request target.'),{status:400});
  const url=new URL(req.url,'http://localhost');
  if(onlineFeed.route(req,res,url))return;
  if(mommybotProfile.route(req,res,url))return;
  if(await gm.route(req,res,url))return; // The staff surface authenticates itself and never reaches the player gateway below.
  if(url.pathname==='/health'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
  const methods={'/quests/detail':'GET','/content/asset':'GET','/zones':'GET','/zones/action':'POST','/zones/inspect':'GET','/cloud':'GET','/cloud/action':'POST','/characters/action':'POST','/sprites':'GET','/sprites/asset':'GET','/sprites/action':'POST'};
  if(methods[url.pathname]!==req.method)throw Object.assign(Error('Endpoint not found.'),{status:404});
  metrics.request(res); // Count gameplay load only; admin refreshes and health probes do not inflate request throughput.
  if(req.headers.origin)throw Object.assign(Error('Use the authenticated game gateway.'),{status:403});
  const token=/^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization??'')?.[1];if(!token)throw Object.assign(Error('A linked account is required.'),{status:401});
  if(active>=32||(perToken.get(token)??0)>=2)throw Object.assign(Error('Online zones are busy.'),{status:429});active++;perToken.set(token,(perToken.get(token)??0)+1);
  try{
   let input;if(req.method==='POST'){
    if(!String(req.headers['content-type']??'').startsWith('application/json'))throw Object.assign(Error('Send JSON.'),{status:415});
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>256*1024)throw Object.assign(Error('Request too large.'),{status:413});chunks.push(chunk);} // Bounded campaign inventory imports fit the existing tracker gateway limit.
    try{input=JSON.parse(Buffer.concat(chunks));}catch{throw Object.assign(Error('Invalid JSON.'),{status:400});}
   }
   const verified=await metrics.measureAsync('account.authenticate',()=>walletClient.authenticate(token));db.prepare('INSERT INTO wallet_cache VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET coins=excluded.coins').run(verified.owner,verified.coins);
   if(gm.suspended(verified.owner))throw Object.assign(Error('This account is suspended from online play.'),{status:403,code:'account_suspended'}); // Checked before any command runs, so a suspension cannot be outlasted by a held connection.
   if(String(verified.scope??'').split(' ').includes('stars:write'))await management.recover(verified.owner,token); // Finish an already-authorized debit before accepting gameplay after reconnect.
   if(url.pathname==='/quests/detail'){if(!String(verified.scope??'').split(' ').includes('social:read'))throw Object.assign(Error('Approve social access.'),{status:403});identity=verified;let result;try{result=zones.questRead(token,url.searchParams.get('character_id'),url.searchParams.get('quest'));}finally{identity=null;}res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return;}
   if(url.pathname==='/content/asset'){if(!String(verified.scope??'').split(' ').includes('social:read'))throw Object.assign(Error('Approve social access.'),{status:403});const result=live.asset(url.searchParams.get('asset_id'));res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return;}
   if(url.pathname.startsWith('/sprites')){
    const scopes=String(verified.scope??'').split(' ');if(!scopes.includes(req.method==='GET'?'saves:read':'saves:write'))throw Object.assign(Error('Reconnect to approve sprite storage access.'),{status:403});
    if(req.method==='POST'&&input?.action==='generate'&&!scopes.includes('diamonds:write'))throw Object.assign(Error('Reconnect and approve diamond spending.'),{status:403,code:'insufficient_scope'});
    if(scopes.includes('diamonds:write'))await sprites.recover(verified.owner,token);
    const result=url.pathname==='/sprites/asset'?sprites.asset(verified.owner,url.searchParams.get('sprite_id')):req.method==='GET'?sprites.list(verified.owner,url.searchParams.get('character_id')??''):await sprites.act(verified.owner,token,input);
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return;
   }
   if(url.pathname==='/characters/action'){
    const scopes=String(verified.scope??'').split(' ');if(!scopes.includes('saves:write')||(['rename','appearance'].includes(input?.action)&&!scopes.includes('stars:write')))throw Object.assign(Error('Reconnect and approve character management access.'),{status:403,code:'insufficient_scope'});
    const result=await management.act(verified.owner,token,input);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return;
   }
   if(url.pathname.startsWith('/cloud')||url.pathname==='/zones/inspect'){
    const scope=url.pathname.startsWith('/cloud')?(req.method==='GET'?'saves:read':'saves:write'):'social:read';
    if(!String(verified.scope??'').split(' ').includes(scope))throw Object.assign(Error('Reconnect and approve social and cloud save access.'),{status:403,code:'insufficient_scope'});
    let result;
    if(url.pathname.startsWith('/cloud'))result=req.method==='GET'?cloud.read(verified.owner,Object.fromEntries(url.searchParams)):cloud.act(verified.owner,input);
    else {identity=verified;try{result=zones.inspect(token,url.searchParams.get('character_id'),url.searchParams.get('target'),url.searchParams.get('controller'));}finally{identity=null;}result.social=await walletClient.profile(token,result.account_id);}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return;
   }
   await settlePurchases(verified.owner,token);
   const rawPage=url.searchParams.get('bank_page'); // The companion reads its own bank from anywhere and pages without disturbing the in-game drawer.
   const view={companion:url.searchParams.get('view')==='companion',bankPage:/^\d{1,4}$/.test(rawPage??'')?Number(rawPage):null};
   let result;identity=verified;try{result=req.method==='GET'?{character:{id:url.searchParams.get('character_id')}}:metrics.measure('zones.action',()=>zones.act(token,input,{buildSnapshot:false}));}catch(error){
    if(input?.action==='enter'&&error.status===409)log('quest_lobby_entry_conflict',error.message); // Fixed gameplay rejection text only: never log credentials, request bodies or inventories.
    throw error;
   }finally{identity=null;}
   await settlePurchases(verified.owner,token);
   const receipt=result.receipt;identity=verified;try{result=metrics.measure(req.method==='GET'?'zones.read':'zones.refresh',()=>zones.read(token,result.character?.id,req.method==='GET'?view:{companion:['bank_sell','companion_equip','companion_unequip'].includes(input?.action)}));if(receipt)result.receipt=receipt;}finally{identity=null;} // Build exactly one final view after purchase settlement, including durable replay receipts.
   await flush(verified.owner,token);result.coins=db.prepare('SELECT coins FROM wallet_cache WHERE owner=?').get(verified.owner).coins;
   result.pendingCoins=db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM reward_outbox WHERE owner=? AND delivered=0').get(verified.owner).n;
   result.capabilities={unifiedCreation:true,inspection:true,friends:true,cloudSaves:true,saveManagement:true,characterManagement:true,characterDescriptions:true,companionEquipment:true,companionBank:true,bankSales:true};
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(metrics.measure('response.serialize',()=>JSON.stringify(result)));
  }finally{active--;const count=perToken.get(token)-1;if(count)perToken.set(token,count);else perToken.delete(token);}
 })().catch(error=>{if(res.destroyed)return;if(res.headersSent){res.destroy();return;}res.writeHead(error.status??503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:error.code??'zone_request_failed',error_description:error.status?error.message:'Online zones are temporarily unavailable.'}));});});
 const diveTimer=setInterval(()=>metrics.measure('world.timer',()=>zones.tick()),1000);diveTimer.unref(); // Weekly resets and roaming continue without browser requests.
 const onlinePrune=setInterval(()=>onlineFeed.prune(),3600000);onlinePrune.unref();server.on('close',()=>clearInterval(onlinePrune));
 server.requestTimeout=10000;server.headersTimeout=5000;server.on('close',()=>{clearInterval(diveTimer);zones.close();artJobs.close();void compute?.close();sprites.close();metrics.close();db.close();});return {server,db,gm,metrics,live,artJobs,zones,prepare:zones.prepare};
} // The standalone database owns characters, fights, chat, presence and durable payouts; the tracker owns only shared currency.
