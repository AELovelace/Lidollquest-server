import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {createQuestZones} from './zones.mjs';
import {createCloudSaves} from './cloud-saves.mjs';
import {createCharacterManagement} from './character-management.mjs';
import {DAILY_COIN_CAP} from './hubs.mjs';

export function createQuestService({filename=':memory:',walletClient,now=Date.now,roll,log=console.warn}={}){
 const db=new DatabaseSync(filename);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
 db.exec(`CREATE TABLE IF NOT EXISTS wallet_cache(owner TEXT PRIMARY KEY,coins INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS reward_outbox(id TEXT PRIMARY KEY,owner TEXT NOT NULL,amount INTEGER NOT NULL,reason TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS reward_delivery ON reward_outbox(owner,delivered);`);
 let identity=null; // The simulation below is synchronous; the HTTP layer never awaits while this identity is in use.
 const zones=createQuestZones(db,{now,roll,grant:()=>{if(!identity)throw Error('Missing request identity');return identity;},wallet:owner=>({coins:db.prepare('SELECT coins FROM wallet_cache WHERE owner=?').get(owner)?.coins??0}),adjust:(owner,asset,amount,id,reason)=>{
  if(asset!=='coins'||!Number.isSafeInteger(amount)||amount<1||amount>DAILY_COIN_CAP)throw Error('Invalid server award'); // A single entitlement can never exceed one day's whole allowance.
  db.prepare('INSERT INTO reward_outbox(id,owner,amount,reason) VALUES (?,?,?,?)').run(id,owner,amount,reason);
 }});
 const cloud=createCloudSaves(db,{now});
 const management=createCharacterManagement(db,{walletClient,cloud,now,log});
 const deliveries=new Map();
 async function flush(owner,token){
  if(deliveries.has(owner))return deliveries.get(owner);
  const task=(async()=>{
   for(const row of db.prepare('SELECT * FROM reward_outbox WHERE owner=? AND delivered=0 LIMIT 8').all(owner)){
    try{const receipt=await walletClient.credit(token,{request_id:'arena-'+row.id,kind:'credit',amount:row.amount});db.prepare('UPDATE reward_outbox SET delivered=1 WHERE id=?').run(row.id);db.prepare('UPDATE wallet_cache SET coins=? WHERE owner=?').run(receipt.balance,owner);}
    catch(error){console.warn('quest_reward_delivery_failed',row.id,error?.status??'transport');return;} // Log no credentials; retry this same entitlement on the next authenticated visit.
   }
  })();deliveries.set(owner,task);try{await task;}finally{deliveries.delete(owner);}
 }
 const purchases=new Map();
 async function settlePurchases(owner,token){
  if(purchases.has(owner))return purchases.get(owner);
  const task=(async()=>{for(const row of db.prepare("SELECT * FROM hub_purchases WHERE owner=? AND status='pending'").all(owner)){
   try{const receipt=await walletClient.credit(token,{request_id:'shop-'+row.id,kind:'debit',amount:row.price});zones.completePurchase(row.id,true);db.prepare('UPDATE wallet_cache SET coins=? WHERE owner=?').run(receipt.balance,owner);}
   catch(error){if(error.code==='insufficient_balance')zones.completePurchase(row.id,false);else log('quest_purchase_delivery_pending',row.id,error.status??'transport');}
  }})();purchases.set(owner,task);try{await task;}finally{purchases.delete(owner);}
 } // Retry a durable debit ID before accepting any subsequent inventory-changing command.
 let active=0;const perToken=new Map();
 const server=createServer((req,res)=>{void (async()=>{
  if(!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))throw Object.assign(Error('Invalid request target.'),{status:400});
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
  const methods={'/zones':'GET','/zones/action':'POST','/zones/inspect':'GET','/cloud':'GET','/cloud/action':'POST','/characters/action':'POST'};
  if(methods[url.pathname]!==req.method)throw Object.assign(Error('Endpoint not found.'),{status:404});
  if(req.headers.origin)throw Object.assign(Error('Use the authenticated game gateway.'),{status:403});
  const token=/^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization??'')?.[1];if(!token)throw Object.assign(Error('A linked account is required.'),{status:401});
  if(active>=32||(perToken.get(token)??0)>=2)throw Object.assign(Error('Online zones are busy.'),{status:429});active++;perToken.set(token,(perToken.get(token)??0)+1);
  try{
   let input;if(req.method==='POST'){
    if(!String(req.headers['content-type']??'').startsWith('application/json'))throw Object.assign(Error('Send JSON.'),{status:415});
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>256*1024)throw Object.assign(Error('Request too large.'),{status:413});chunks.push(chunk);} // Bounded campaign inventory imports fit the existing tracker gateway limit.
    try{input=JSON.parse(Buffer.concat(chunks));}catch{throw Object.assign(Error('Invalid JSON.'),{status:400});}
   }
   const verified=await walletClient.authenticate(token);db.prepare('INSERT INTO wallet_cache VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET coins=excluded.coins').run(verified.owner,verified.coins);
   if(String(verified.scope??'').split(' ').includes('stars:write'))await management.recover(verified.owner,token); // Finish an already-authorized debit before accepting gameplay after reconnect.
   if(url.pathname==='/characters/action'){
    const scopes=String(verified.scope??'').split(' ');if(!scopes.includes('saves:write')||(input?.action!=='delete'&&!scopes.includes('stars:write')))throw Object.assign(Error('Reconnect and approve character management access.'),{status:403,code:'insufficient_scope'});
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
   let result;identity=verified;try{result=req.method==='GET'?zones.read(token,url.searchParams.get('character_id'),view):zones.act(token,input);}catch(error){
    if(input?.action==='enter'&&error.status===409)log('quest_lobby_entry_conflict',error.message); // Fixed gameplay rejection text only: never log credentials, request bodies or inventories.
    throw error;
   }finally{identity=null;}
   await settlePurchases(verified.owner,token);
   const receipt=result.receipt;identity=verified;try{result=zones.read(token,result.character?.id,{companion:input?.action==='bank_sell'});if(receipt)result.receipt=receipt;}finally{identity=null;}
   await flush(verified.owner,token);result.coins=db.prepare('SELECT coins FROM wallet_cache WHERE owner=?').get(verified.owner).coins;
   result.pendingCoins=db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM reward_outbox WHERE owner=? AND delivered=0').get(verified.owner).n;
   result.capabilities={unifiedCreation:true,inspection:true,friends:true,cloudSaves:true,saveManagement:true,characterManagement:true,companionBank:true,bankSales:true};
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));
  }finally{active--;const count=perToken.get(token)-1;if(count)perToken.set(token,count);else perToken.delete(token);}
 })().catch(error=>{if(res.destroyed)return;if(res.headersSent){res.destroy();return;}res.writeHead(error.status??503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:error.code??'zone_request_failed',error_description:error.status?error.message:'Online zones are temporarily unavailable.'}));});});
 const diveTimer=setInterval(()=>zones.tick(),1000);diveTimer.unref(); // Weekly resets and roaming continue without browser requests.
 server.requestTimeout=10000;server.headersTimeout=5000;server.on('close',()=>{clearInterval(diveTimer);db.close();});return {server,db};
} // The standalone database owns characters, fights, chat, presence and durable payouts; the tracker owns only shared currency.
