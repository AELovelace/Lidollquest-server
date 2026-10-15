import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createQuestService} from '../server/service.mjs';
import {trimLine} from '../server/follower-chat.mjs';

// 2026-10-15 chat audit: lines invisible after a rolled-back transaction, history eaten by unheard rows, mid-word cuts.
async function twoPlayers(){
 const dir=mkdtempSync(join(tmpdir(),'chat-delivery-')),filename=join(dir,'quest.sqlite');let time=Date.parse('2026-10-15T12:00:00Z');
 const tokens={alice:'a'.repeat(43),bob:'b'.repeat(43)},ids={};
 const service=createQuestService({filename,walletClient:{authenticate:async token=>({owner:token,id:token,client:'lidollquest',coins:0})},now:()=>time,authTtlMs:0,log:()=>{}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
 const read=async who=>(await fetch(base+'/zones?character_id='+ids[who],{headers:{Authorization:'Bearer '+tokens[who]}})).json();
 const send=async(who,input)=>{time+=1000;const r=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+tokens[who],'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:r.status,data:await r.json()};};
 const command=async(who,action,extra={})=>{const s=await read(who);const r=await send(who,{action,request_id:randomUUID(),controller:who,character_id:ids[who],revision:s.character.revision,...extra});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 for(const who of Object.keys(tokens)){
  ids[who]=(await send(who,{action:'create',name:who==='alice'?'Alice':'Bob',request_id:randomUUID(),controller:who})).data.character.id;
  await command(who,'enter',{zone:'honeydew-lantern',quest_version:1,content_version:1,flow_version:1,follower_version:1,loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[]}});
 }
 const place=(who,x,y)=>service.db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(x,y,time,ids[who]);
 place('alice',20,20);place('bob',22,20);
 return {service,ids,read,command,place,close:async()=>{await new Promise(r=>service.server.close(r));rmSync(dir,{recursive:true,force:true});}};
}

test('a rolled-back transaction never makes the next line invisible (SQLite reuses rolled-back seq numbers)',async()=>{
 const h=await twoPlayers();
 try{
  const {db}=h.service;
  db.exec('BEGIN IMMEDIATE');db.prepare("INSERT INTO quest_chat(zone,owner,character_id,name,text,created,emote,x,y) VALUES ('honeydew-lantern','x','ghost','Ghost','gone',?,0,20,20)").run(Date.now());
  h.service.zones.stampHearers();db.exec('ROLLBACK'); // The old in-memory watermark moved past this seq here.
  await h.command('alice','chat',{text:'can you hear me now?'});
  assert.ok((await h.read('bob')).chat.some(m=>m.text==='can you hear me now?'),'Bob heard the line that reused the rolled-back seq');
 }finally{await h.close();}
});

test('history keeps the lines a reader heard even when many unheard lines came after them',async()=>{
 const h=await twoPlayers();
 try{
  await h.command('alice','chat',{text:'the line Bob heard'});
  const ins=h.service.db.prepare("INSERT INTO quest_chat(zone,owner,character_id,name,text,created,emote,x,y,stamped) VALUES ('honeydew-lantern','far','far-away','Far',?,?,0,59,59,1)");
  for(let n=0;n<150;n++)ins.run('far line '+n,Date.now()); // Spoken off Bob's screen: never stamped for him.
  const chat=(await h.read('bob')).chat;
  assert.ok(chat.some(m=>m.text==='the line Bob heard'),'the heard line is still in his history');
  assert.ok(!chat.some(m=>m.text.startsWith('far line')),'and nothing he did not hear');
 }finally{await h.close();}
});

test('long lines are trimmed at a sentence or word, never mid-word',()=>{
 assert.equal(trimLine('short'),'short');
 const sentence='First sentence here. '+'More words follow on and on '.repeat(12);
 assert.equal(trimLine(sentence,100),'First sentence here.'.length>33?'First sentence here.':trimLine(sentence,100));
 const words=trimLine('a '.repeat(10)+'supercalifragilistic '.repeat(20),120);
 assert.ok(words.endsWith('...')&&words.length<=120&&!/supercalifragilisti\.\.\.$/.test(words)&&/supercalifragilistic\.\.\.$/.test(words),words);
 assert.equal(trimLine('She said "stay." '+'x'.repeat(300),40),'She said "stay."');
});
