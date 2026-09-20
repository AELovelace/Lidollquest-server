import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
import {createWalletClient} from '../server/wallet.mjs';
const tracker=resolve(process.env.TRACKER_ROOT??'../omo-trainer'),bot=resolve(process.env.MOMMYBOT_ROOT??'../MommyBot');
const load=(root,file)=>import(pathToFileURL(resolve(root,file)));

test('real tracker and MommyBot resolve and showcase an existing game character across pairwise IDs',{
 skip:!existsSync(resolve(tracker,'server/api.mjs'))||!existsSync(resolve(bot,'src/wallet/client.js'))
},async()=>{
 const {openDatabase}=await load(tracker,'server/database.mjs'),{createApi}=await load(tracker,'server/api.mjs');
 const {WalletClient}=await load(bot,'src/wallet/client.js'),{WalletService}=await load(bot,'src/wallet/service.js');
 const {createCharacterShowcase}=await load(bot,'src/mmo/showcase.js');
 const previousApps=process.env.LIDOLLCOIN_APPS;
 process.env.LIDOLLCOIN_APPS=JSON.stringify(['lidollbot','lidollquest'].map(id=>({id,name:id,origins:[],dailyLimit:1000})));
 const db=openDatabase(':memory:'),a=db.ensureParticipant('test','alice','Alice'),b=db.ensureParticipant('test','bob','Bob');
 const call=(method,...args)=>db.economy.coins(method,...args);
 const grant=(owner,client)=>call('exchange',owner,client,'wallet:read',owner+client).access_token;
 const gameToken=grant(a.id,'lidollquest'),botToken=grant(a.id,'lidollbot'),strangerToken=grant(b.id,'lidollbot');
 const gameId=call('balance',gameToken).account_id,botId=call('balance',botToken).account_id;
 const login={origin:'http://localhost',session:()=>null},api=createApi(db,login);
 const gateway=createServer((req,res)=>api(req,res,new URL(req.url,login.origin).pathname.slice('/api/'.length)));
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+gateway.address().port;
 const baseUrl=login.origin+'/api/lidollcoin/v1/',onlineToken='b'.repeat(43);
 const game=createQuestService({onlineToken,walletClient:createWalletClient({baseUrl,key:'k'.repeat(43)})});
 await new Promise(r=>game.server.listen(0,'127.0.0.1',r));const gameBase='http://127.0.0.1:'+game.server.address().port;
 const wallet=new WalletService(':memory:',new WalletClient({baseUrl,clientId:'lidollbot'}));
 for(const [id,token] of [['alice',botToken],['bob',strangerToken]])wallet.db.prepare('INSERT INTO online_wallets VALUES (?,?,?,?,?,?)').run(id,token,Date.now()+60000,call('balance',token).account_id,baseUrl,'lidollbot');
 const sent=[],replies=[];
 const discord={channels:{fetch:async()=>({guildId:'test',isTextBased:()=>true,send:async payload=>{sent.push(payload);return {id:'synthetic'};}})}};
 const showcase=createCharacterShowcase(discord,wallet,{get:id=>({issuer:'test',subject:id})},{LIDOLLMMO_CHARACTERS_ENABLED:'true',LIDOLLMMO_ONLINE_URL:gameBase+'/integrations/mommybot/joins',MOMMYBOT_ONLINE_TOKEN:onlineToken},{settings:()=>({showcase:{enabled:true,channel:'synthetic'}}),logger:{log(){},error(){}}});
 const show=async(user,selection=null)=>showcase.handleInteraction({id:randomUUID(),guildId:'test',user:{id:user},isChatInputCommand:()=>true,commandName:'lidollmmo',options:{getString:()=>selection},deferReply:async()=>{},editReply:async body=>replies.push(body),reply:async body=>replies.push(body)});
 try{
  const created=await fetch(gameBase+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+gameToken,'Content-Type':'application/json'},body:JSON.stringify({action:'create',name:'Existing character',controller:'test',request_id:randomUUID()})});
  assert.equal(created.status,200);const character=(await created.json()).character;
  const headers={Authorization:'Bearer '+onlineToken};
  assert.notEqual(gameId,botId);
  assert.equal((await fetch(gameBase+'/integrations/mommybot/character?account_id='+botId,{headers})).status,404,'Reproduce the old lookup failure.');
  assert.equal(await wallet.questAccount('alice'),gameId);
  await show('alice');assert.equal(sent.length,3);assert.match(replies.at(-1).content,/Existing character/);
  assert.equal(game.db.prepare('SELECT owner FROM quest_characters WHERE id=?').get(character.id).owner,gameId,'Existing ownership needs no migration.');
  assert.equal(wallet.connection('alice').account_id,botId,'Payment IDs remain unchanged.');
  await show('bob',character.id);assert.equal(sent.length,3,'Another linked account cannot showcase this character.');
  call('revoke',b.id,call('grant',strangerToken).id);await show('bob');assert.equal(sent.length,3);assert.match(replies.at(-1).content,/expired or was revoked/);
  assert.equal(db.economy.snapshot(a.id).wallet.coins,50,'Showing a character spends no currency.');
 }finally{
  await showcase.stop();await wallet.close();game.server.closeAllConnections();await new Promise(r=>game.server.close(r));gateway.closeAllConnections();await new Promise(r=>gateway.close(r));db.close();
  if(previousApps===undefined)delete process.env.LIDOLLCOIN_APPS;else process.env.LIDOLLCOIN_APPS=previousApps;
 }
});
