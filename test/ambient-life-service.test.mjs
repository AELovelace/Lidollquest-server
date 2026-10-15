import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createQuestService} from '../server/service.mjs';
import {UTOPIA_TOWER_ZONE} from '../server/utopia-npcs.mjs';

// AMBIENT_NPC_LIFE_PLAN.md end to end: the shipped Arcanum Tower residents talk in real area chat, only players on screen
// hear them, the snapshot marks their lines as NPC lines, and a player who names one gets an answer. The AI is a fake pool.
test('Wren and Felix talk in the Arcanum Tower, Alice hears it and Bob across the room does not; Padma answers her name',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ambient-life-')),filename=join(dir,'quest.sqlite');let time=Date.parse('2026-10-14T18:00:00Z'),service,base;
 const tokens={alice:'a'.repeat(43),bob:'b'.repeat(43)},ids={},calls=[];
 const pool={configured:true,async request(path,body){calls.push({path,body});
  if(path==='/v1/participation/decide')return {ok:true,status:200,body:{decision:'join',join:true,join_probability:.8,policy:'participation-sociable-v1-schema_first',model:'lidoll/decider-chat-0-1'}};
  return {ok:true,status:200,body:{reply:body.npc_name+' says hello ('+body.kind+')',lane:'local',fallback:false}};}};
 const walletClient={authenticate:async token=>({owner:token,id:token,client:'lidollquest',coins:0})};
 service=createQuestService({filename,walletClient,now:()=>time,authTtlMs:0,log:()=>{},
  ambientOptions:{gateBackend:'decider',pool:()=>pool,roll:()=>0,sleep:async()=>{},tuning:()=>({ambient_enabled:'on',ambient_chance:1,ambient_chime_chance:0,ambient_max_responses:2,ambient_check_s:5})}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+service.server.address().port;
 const read=async who=>(await fetch(base+'/zones?character_id='+ids[who],{headers:{Authorization:'Bearer '+tokens[who]}})).json();
 const send=async(who,input)=>{time+=1000;const r=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+tokens[who],'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:r.status,data:await r.json()};};
 const command=async(who,action,extra={})=>{const s=await read(who);const r=await send(who,{action,request_id:randomUUID(),controller:who,character_id:ids[who],revision:s.character.revision,...extra});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 const place=(who,x,y)=>service.db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(x,y,time,ids[who]);
 const settle=async()=>{for(let i=0;i<80;i++)await new Promise(r=>setImmediate(r));};
 const tick=async()=>{time+=6000;for(const who of Object.keys(ids))service.db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(time,ids[who]);service.zones.tick();await settle();};
 try{
  for(const who of Object.keys(tokens)){
   ids[who]=(await send(who,{action:'create',name:who==='alice'?'Alice':'Bob',request_id:randomUUID(),controller:who})).data.character.id;
   const lobby=await command(who,'enter',{zone:'utopia-arcanum',quest_version:1,content_version:1,flow_version:1,follower_version:1,loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[]}});
   const door=lobby.zones.find(z=>z.id===lobby.zone).portals.find(p=>p.target===UTOPIA_TOWER_ZONE);place(who,door.x,door.y);
   assert.equal((await command(who,'hub_visit',{zone:UTOPIA_TOWER_ZONE})).zone,UTOPIA_TOWER_ZONE);
  }
  place('alice',12,13);place('bob',18,1); // Alice watches the commons from a step away; Bob is up in the archive, off Wren's screen.
  const snap=await read('alice');assert.deepEqual(snap.worldPlacements?.filter(p=>p.kind==='npc').map(p=>p.name).sort(),['Brittany','Felix','Padma','Wren'],'the residents are on the map');
  for(let i=0;i<6&&!service.db.prepare("SELECT 1 FROM quest_chat WHERE character_id LIKE 'npc:%'").get();i++)await tick();
  const rows=service.db.prepare("SELECT * FROM quest_chat WHERE character_id LIKE 'npc:%' ORDER BY seq").all();
  assert.ok(rows.length>=2,'a conversation happened: '+rows.map(r=>r.name+': '+r.text).join(' | '));
  assert.ok(rows.every(r=>r.zone===UTOPIA_TOWER_ZONE&&r.owner==='ambient:'+UTOPIA_TOWER_ZONE));
  const heard=new Set(service.db.prepare('SELECT character_id FROM quest_chat_heard WHERE seq=?').all(rows[0].seq).map(r=>r.character_id));
  assert.ok(heard.has(ids.alice),'Alice was on screen');assert.ok(!heard.has(ids.bob),'Bob was not');
  const aliceChat=(await read('alice')).chat,bobChat=(await read('bob')).chat;
  const line=aliceChat.find(m=>m.characterId===rows[0].character_id);assert.ok(line,'Alice sees the line');assert.equal(line.npc,true,'flagged as an NPC line for the bubble');
  assert.ok(!bobChat.some(m=>String(m.characterId).startsWith('npc:')),'Bob never sees what he did not hear');
  assert.ok(calls.filter(c=>c.path==='/v1/companion/chat').every(c=>c.body.kind.startsWith('ambient_')),'resident kinds only: never billable');
  time+=120000;await tick(); // Let the finished conversation go quiet.
  await command('alice','chat',{text:'Padma, which diapers are best?'});await tick();
  const answer=service.db.prepare("SELECT * FROM quest_chat WHERE name='Padma' ORDER BY seq DESC").get();
  assert.ok(answer,'Padma answered her name');assert.match(answer.text,/ambient_answer/); // She may have greeted Alice first; the answer is her newest line.
  await settle();service.zones.ambientLife.close();await settle(); // No AI step may outlive the service.
 }finally{await new Promise(r=>service.server.close(r));rmSync(dir,{recursive:true,force:true});} // One close: the server's own 'close' event shuts the database.
});
