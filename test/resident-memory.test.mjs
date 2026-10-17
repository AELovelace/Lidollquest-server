import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createResidentMemory,gossipEligible,RESIDENT_MEMORY_LIMITS} from '../server/resident-memory.mjs';

const entry=(extra={})=>({resident:'resident:wren',peerKind:'player',peer:'p1',conversation:'visit1',sourceSeq:1,speaker:'Alice',speakerKind:'player',text:'My favourite drink is mint tea.',...extra});

test('resident memories survive reopening and remain isolated by placement and player ID',()=>{
 const dir=mkdtempSync(join(tmpdir(),'resident-memory-')),file=join(dir,'game.sqlite'),sidecar=join(dir,'resident-memory.sqlite');let db=new DatabaseSync(file),memory=createResidentMemory(db,{file:sidecar});
 try{
  memory.remember(entry());memory.close();db.close();db=new DatabaseSync(file);memory=createResidentMemory(db,{file:sidecar});
  assert.match(memory.recall('resident:wren','player','p1').join(),/Alice said: My favourite drink is mint tea/);
  assert.deepEqual(memory.recall('resident:felix','player','p1'),[]);
  assert.deepEqual(memory.recall('resident:wren','player','different-id-same-name'),[]);
  assert.deepEqual(memory.recall('resident:wren','npc','p1'),[]);
  assert.deepEqual(memory.recall('resident:wren','player','p1',{conversation:'visit1'}),[]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='memories'").get().n,0,'the game database only holds the outbox');
  memory.recall('resident:wren','player','p1',{conversation:'visit2',requestId:'audit-request'});
  memory.gossip('resident:wren',{conversation:'visit2',requestId:'audit-request'});
  const audit=new DatabaseSync(sidecar,{readOnly:true});try{
   assert.deepEqual(audit.prepare('SELECT purpose FROM uses ORDER BY id').all().map(r=>r.purpose),['recall','gossip']);
   assert.equal(audit.prepare('SELECT source_seq FROM uses LIMIT 1').get().source_seq,1);
   assert.equal(audit.prepare('SELECT COUNT(*) n FROM memories').get().n,1);
  }finally{audit.close();}
 }finally{memory.close();db.close();unlinkSync(file);unlinkSync(sidecar);rmdirSync(dir);} // Remove only this test's known files and empty temporary directory.
});

test('recall keeps new corrections, finds relevant older details, and bounds storage',()=>{
 const db=new DatabaseSync(':memory:');try{
  const memory=createResidentMemory(db);
  for(let i=0;i<50;i++)memory.remember(entry({sourceSeq:i+1,conversation:'v'+i,text:i===30?'My favourite flower is a violet.':'I visited stall number '+i+'.'}));
  memory.remember(entry({sourceSeq:51,conversation:'v51',text:'Actually, my favourite flower is now a rose.'}));
  assert.equal(memory.view().entries,RESIDENT_MEMORY_LIMITS.perPair);
  const recall=memory.recall('resident:wren','player','p1',{message:'flower violet'});
  assert.ok(recall.length<=4);assert.match(recall.join(),/violet/);assert.match(recall.at(-1),/now a rose/);
  for(let i=0;i<140;i++)memory.remember(entry({peer:'visitor'+i,sourceSeq:100+i}));
  assert.equal(memory.view().pairs,RESIDENT_MEMORY_LIMITS.peersPerResident);
 }finally{db.close();}
});

test('gossip uses attributed first-person player statements and never NPC outputs or private remarks',()=>{
 const db=new DatabaseSync(':memory:');try{
  const memory=createResidentMemory(db);memory.remember(entry());
  memory.remember(entry({resident:'resident:felix',peer:'p2',speaker:'Bob',text:'My hobby is collecting clocks.'}));
  assert.deepEqual(memory.gossip('resident:wren'),['Alice said: My favourite drink is mint tea.']);
  memory.remember(entry({sourceSeq:2,speaker:'Wren',speakerKind:'npc',text:'Alice secretly stole all the silver.'}));
  assert.equal(memory.gossip('resident:wren').length,1,'generated replies never become player claims');
  memory.remember(entry({sourceSeq:3,text:"Please don't tell anyone my favourite drink."}));
  assert.deepEqual(memory.gossip('resident:wren'),[],'newer privacy request blocks the older remark');
  for(const text of ['My diaper is wet today.','My password is hunter2.','Do I like tea?','My private medical diagnosis is complicated.','My phone is 5551234567.'])assert.equal(gossipEligible(text),false,text);
 }finally{db.close();}
});

test('chat transaction rollback and character deletion cannot leave orphan memories',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("CREATE TABLE quest_characters(id TEXT PRIMARY KEY); INSERT INTO quest_characters VALUES ('p1')");
  const memory=createResidentMemory(db);
  db.exec('BEGIN');memory.remember(entry());db.exec('ROLLBACK');assert.equal(memory.view().entries,0);
  memory.remember(entry());db.prepare('DELETE FROM quest_characters WHERE id=?').run('p1');assert.equal(memory.view().entries,0);
 }finally{db.close();}
});

test('a committed sidecar batch is not duplicated when its outbox acknowledgement is replayed',()=>{
 const db=new DatabaseSync(':memory:'),memory=createResidentMemory(db);
 try{
  memory.remember(entry());const pending=db.prepare('SELECT * FROM quest_resident_memory_outbox').get();
  assert.equal(memory.drain(),1);
  db.prepare('INSERT INTO quest_resident_memory_outbox(id,kind,peer_kind,peer,body,created) VALUES (?,?,?,?,?,?)')
   .run(pending.id,pending.kind,pending.peer_kind,pending.peer,pending.body,pending.created); // Simulate a crash after sidecar commit but before deleting the queued event.
  assert.equal(memory.drain(),0);assert.equal(memory.view().entries,1);assert.equal(memory.view().pending,0);
 }finally{memory.close();db.close();}
});

test('a privacy request after the retained text boundary still blocks gossip',()=>{
 const db=new DatabaseSync(':memory:'),memory=createResidentMemory(db);
 try{
  memory.remember(entry({text:'My favourite book is lovely. '.repeat(20)+" Don't tell anyone."}));
  assert.equal(memory.recall('resident:wren','player','p1').length,1);
  assert.deepEqual(memory.gossip('resident:wren'),[]);
 }finally{memory.close();db.close();}
});
