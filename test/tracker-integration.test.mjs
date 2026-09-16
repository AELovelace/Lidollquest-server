import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
import {createWalletClient} from '../server/wallet.mjs';
const tracker=resolve(process.env.TRACKER_ROOT??'../omo-trainer');
test('real tracker browser gateway enforces CSRF and the separate service pays one signed arena reward', {skip:!existsSync(resolve(tracker,'server/api.mjs'))},async()=>{
 const {openDatabase}=await import(pathToFileURL(resolve(tracker,'server/database.mjs'))),{createApi}=await import(pathToFileURL(resolve(tracker,'server/api.mjs')));
 const key='synthetic-quest-integration-key-000000000000000';process.env.NODE_ENV='test';process.env.LIDOLLCOIN_REWARD_KEYS=JSON.stringify({lidollquest:key});
 const db=openDatabase(':memory:'),member=db.ensureParticipant('test','quest-member','Arena member'),token=db.economy.coins('browserIssue',member.id),session=db.economy.coins('browserSession',token);
 const login={origin:'',session:()=>null},api=createApi(db,login),gateway=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice('/api/'.length)));
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));const root='http://127.0.0.1:'+gateway.address().port;login.origin=root;
 let now=1000000;const service=createQuestService({walletClient:createWalletClient({baseUrl:root+'/api/lidollcoin/v1/',key}),now:()=>now,roll:()=>0});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));process.env.LIDOLLQUEST_API_URL='http://127.0.0.1:'+service.server.address().port+'/';
 const base=root+'/api/lidollcoin/browser/zones',headers={Cookie:'lidollquest_wallet='+token,Origin:root,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
 const act=async(action,c,extra={})=>{now+=500;const body={action,character_id:c?.id,revision:c?.revision,controller:'integration',request_id:randomUUID(),...extra};const response=await fetch(base+'/action',{method:'POST',headers,body:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return {data,body};};
 try{
  const noCsrf=await fetch(base+'/action',{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body:JSON.stringify({action:'create'})});assert.equal(noCsrf.status,403);
  assert.equal((await fetch(base)).status,401);
  let c=(await act('create',null,{name:'Arena member'})).data.character;c=(await act('enter',c,{zone:'honeydew-lantern'})).data.character;c=(await act('start',c)).data.character;
  while(c.run.phase==='fight')c=(await act('attack',c)).data.character;
  const {data,body}=await act('cashout',c);assert.equal(data.coins,55);assert.equal(data.pendingCoins,0);
  const replay=await (await fetch(base+'/action',{method:'POST',headers,body:JSON.stringify(body)})).json();assert.equal(replay.coins,55);assert.equal(db.economy.snapshot(member.id).wallet.coins,55);
  assert.equal(service.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='economy_wallets'").get().n,0,'The arena database is separate from the shared wallet');
  db.economy.coins('revoke',member.id,db.economy.coins('grant',token).id);assert.equal((await fetch(base,{headers})).status,401);
 }finally{await new Promise(r=>service.server.close(r));await new Promise(r=>gateway.close(r));db.close();}
});
