import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

test('real area chat reaches hired and unhired companions, with local replies and Pip restored',async()=>{
 let time=Date.parse('2026-10-03T12:00:00Z');const ids={},calls=[];
 const service=createQuestService({now:()=>time,log:()=>{},walletClient:{authenticate:async token=>({owner:token,id:token,client:'lidollquest',coins:0,scope:'wallet:read diamonds:write'}),diamonds:async(_,body)=>({request_id:body.request_id})},followerChatOptions:{fetcher:async(url,opts)=>{const body=JSON.parse(opts.body);calls.push(body);return Response.json(String(url).includes(':9091')?{choices:[{message:{content:'GAME'}}]}:{reply:'Hello '+body.player_name+'.'});}}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
 const token=who=>who.padEnd(43,'x'),read=async who=>(await fetch(base+'/zones?character_id='+ids[who],{headers:{Authorization:'Bearer '+token(who)}})).json();
 const send=async(who,body)=>{const res=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token(who),'Content-Type':'application/json'},body:JSON.stringify({controller:who,request_id:randomUUID(),...body})});return {status:res.status,data:await res.json()};};
 const command=async(who,action,extra={})=>{const s=await read(who);return send(who,{action,character_id:ids[who],revision:s.character.revision,...extra});};
 const advance=()=>{time+=11000;service.db.prepare('UPDATE quest_presence SET seen=?').run(time);};
 const idle=async()=>{for(let n=0;n<100;n++){if(service.zones.followerChat.idle())return;await new Promise(r=>setTimeout(r,10));}throw Error('AI fixture did not finish');};
 const place=(who,x,y)=>{const row=service.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[who]),state=JSON.parse(row.state);state.dive.position={x,y};service.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids[who]);service.db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(x,y,time,ids[who]);}; // Position both the authoritative visit and presence row without asking the fixture to walk through random terrain.
 try{
  for(const who of ['alice','bob','far']){
   const c=await send(who,{action:'create',name:who});ids[who]=c.data.character.id;
   const entered=await command(who,'enter',{zone:'princess-rose',combat_version:3,follower_version:1,loadout:{player_info:{level:1,playerHealth:100,playerHealthMax:100},inventory:[]}});assert.equal(entered.status,200);
   assert.ok(entered.data.zones.find(z=>z.id==='princess-rose').fixtures.some(f=>f.id==='tutor'),'Pip is present in the default online world');
   assert.equal((await command(who,'dive_enter',{zone:'dive-quarters'})).status,200);
  }
  const npc=(await read('bob')).followers.entities.find(n=>n.npc==='merchant_mira'&&n.available);assert.ok(npc,'unhired companions return by default');
  place('alice',npc.x,npc.y);place('bob',npc.x,npc.y);place('far',npc.x+16,npc.y+11);
  const say=async(who,text,channel='area')=>{const s=await read(who),result=await command(who,'chat',{text,channel,edition:s.dive.edition});assert.equal(result.status,200,JSON.stringify(result.data));await idle();};
  await say('bob','Mira, hello before hiring');assert.equal(calls.length,2);assert.equal(service.zones.followers.get(ids.bob),undefined);
  assert.ok(calls[1].player_id.length<=128,'idle companion context fits npc-rag ChatRequest.player_id');
  for(const who of ['alice','bob'])assert.ok((await read(who)).chat.some(m=>m.npc&&m.text==='Hello bob.'),'nearby listeners hear an unhired companion');
  assert.ok(!(await read('far')).chat.some(m=>m.npc),'the reply cannot reach a distant listener');
  advance();await say('far','Mira, too far away');await say('bob','Mira, global chat','global');await say('bob','/me waves to Mira');assert.equal(calls.length,2,'distance, channel and emotes cannot trigger replies');
  assert.equal((await command('alice','follower_hire',{npc:'merchant_mira'})).status,200);advance();
  await say('bob','Mira, hello while Alice hires you');assert.equal(calls.length,4);assert.equal(calls[3].player_name,'bob');assert.deepEqual(calls[3].history,[],'a different companion context starts a fresh conversation');
  assert.ok(calls[3].player_id.length<=128);assert.notEqual(calls[3].player_id,calls[1].player_id,'hiring changes the agent context as well as local memory');
  assert.ok((await read('alice')).chat.filter(m=>m.npc&&m.text==='Hello bob.').length>=2);
  assert.ok(!(await read('far')).chat.some(m=>m.npc));
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
