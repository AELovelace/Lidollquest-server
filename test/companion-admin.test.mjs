import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFollowers,followerData} from '../server/followers.mjs';
import {createCompanionMemory} from '../server/companion-memory.mjs';
import {createCompanionAdmin,COMPANION_SETTING_BOUNDS} from '../server/companion-admin.mjs';
import {companionLore} from '../server/follower-chat.mjs';

// GM Companions tab (companion-admin.mjs): bounded tuning, backstory review on top of the exported drafts, and
// per-character memory tools.

function world(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-12T12:00:00Z'),changes=0;
 db.exec('CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,name TEXT,state TEXT,revision INTEGER DEFAULT 0)');
 db.prepare("INSERT INTO quest_characters(id,owner,name,state) VALUES ('doll','o','Doll','{}')").run();
 const followers=createFollowers(db,{enabled:true,now:()=>time}),memory=createCompanionMemory(db,{now:()=>time,log:()=>{}});
 const admin=createCompanionAdmin(db,{memory,followers,now:()=>time,onLoreChange:()=>{changes++;}});
 return {db,followers,memory,admin,changes:()=>changes,close:()=>{memory.close();db.close();}};
}

test('settings are bounded, typed and persisted; unknown keys are refused',()=>{
 const w=world();try{
  const a=w.admin.actions;
  assert.equal(w.admin.settings().slip_chance,.15);assert.equal(w.admin.settings().lore_drafts,'live');
  assert.throws(()=>a.companion_settings({values:{slip_chance:2}},'gm'),/0 to 1/);
  assert.throws(()=>a.companion_settings({values:{slip_chance:'0.5'}},'gm'),/number/);
  assert.throws(()=>a.companion_settings({values:{everything:1}},'gm'),/Unknown setting/);
  assert.throws(()=>a.companion_settings({values:{lore_drafts:'maybe'}},'gm'),/live, hidden/);
  assert.throws(()=>a.companion_settings({},'gm'),/Nothing to change/);
  const saved=a.companion_settings({values:{slip_chance:.3,bond_hourly_cap:20}},'gm');assert.equal(saved.slip_chance,.3);assert.equal(saved.bond_hourly_cap,20);
  assert.equal(w.changes(),0,'tuning alone does not touch the lore');a.companion_settings({values:{lore_drafts:'hidden'}},'gm');assert.equal(w.changes(),1);
  assert.deepEqual(Object.keys(COMPANION_SETTING_BOUNDS).filter(k=>!k.startsWith('ambient_')).sort(),Object.keys(w.admin.gmView().bounds).sort()); // Ambient Life knobs have their own tab (2026-10-15).
  assert.deepEqual(Object.keys(COMPANION_SETTING_BOUNDS).filter(k=>k.startsWith('ambient_')).sort(),Object.keys(w.admin.ambientView().bounds).sort());
 }finally{w.close();}
});

test('GM lore edits override the exported drafts: edit, add, sign off, delete',()=>{
 const w=world();try{
  const a=w.admin.actions,first=followerData.paladin_aegis.online.backstory[0];
  assert.equal(w.admin.lore().paladin_aegis.online.backstory[0].source,'export');
  a.companion_lore_save({npc:'paladin_aegis',section:{...first,text:'Edited by a GM.',draft:true}},'gm');
  let elowen=w.admin.lore().paladin_aegis.online.backstory;assert.equal(elowen[0].text,'Edited by a GM.');assert.equal(elowen[0].source,'gm');
  a.companion_lore_save({npc:'paladin_aegis',section:{id:'elowen-new',heading:'Something new',text:'A brand new section.',reveal:{bond:30,flag:'story_test'}}},'gm');
  elowen=w.admin.lore().paladin_aegis.online.backstory;assert.deepEqual(elowen.at(-1).reveal,{bond:30,flag:'story_test'});
  assert.equal(a.companion_lore_signoff({npc:'paladin_aegis',id:first.id},'gm').draft,false);
  a.companion_lore_delete({npc:'paladin_aegis',id:'elowen-new'},'gm');assert.ok(!w.admin.lore().paladin_aegis.online.backstory.some(s=>s.id==='elowen-new'));
  assert.equal(w.changes(),4,'every lore change re-versions the AI nodes');
  assert.throws(()=>a.companion_lore_save({npc:'nobody',section:first},'gm'),/Choose a companion/);
  assert.throws(()=>a.companion_lore_save({npc:'paladin_aegis',section:{...first,id:'Bad Id'}},'gm'),/Section id/);
  assert.throws(()=>a.companion_lore_save({npc:'paladin_aegis',section:{...first,reveal:{bond:101}}},'gm'),/Reveal bond/);
  assert.throws(()=>a.companion_lore_signoff({npc:'paladin_aegis',id:'missing'},'gm'),/does not exist/);
  const before=companionLore(followerData).version,after=companionLore(w.admin.lore()).version;assert.notEqual(before,after,'the pushed version follows the GM edits');
 }finally{w.close();}
});

test('character tools: look up by name, set a bond, delete one memory, wipe everything',()=>{
 const w=world();try{
  const a=w.admin.actions;
  w.memory.db.prepare("INSERT INTO memories(id,npc,character_id,kind,text,importance,embarrassing,created) VALUES ('m1','paladin_aegis','doll','zone','Doll and I explored.',2,0,1),('m2','paladin_aegis','doll','accident','Doll had an accident.',3,1,2)").run();
  assert.equal(w.admin.gmView({character:'doll'}).character.memories.length,2,'by id');
  const view=w.admin.gmView({character:'DOLL'});assert.equal(view.character.name,'Doll','by name, any case');assert.equal(w.admin.gmView({character:'nobody'}).character,null);
  assert.equal(view.companions.length,Object.keys(followerData).length);assert.ok(view.companions.every(c=>c.drafts>=0));
  a.companion_bond_set({npc:'paladin_aegis',character_id:'doll',bond:45});assert.equal(w.memory.bondOf('paladin_aegis','doll'),45);
  assert.throws(()=>a.companion_bond_set({npc:'paladin_aegis',character_id:'doll',bond:400}),/0-100/);
  a.companion_memory_delete({id:'m2'});assert.deepEqual(w.memory.view('doll').memories.map(m=>m.id),['m1']);
  assert.throws(()=>a.companion_memory_delete({id:'m2'}),/does not exist/);
  a.companion_memory_wipe({character_id:'doll'});assert.deepEqual(w.memory.view('doll'),{bonds:[],memories:[],summaries:[],pending:0});
  assert.throws(()=>a.companion_memory_wipe({character_id:'ghost'}),/Choose a character/);
 }finally{w.close();}
});

test('the GM Companions tab over HTTP: staff only, audited, and a lore edit re-versions the companion lore',async()=>{
 const {createQuestService}=await import('../server/service.mjs');
 const staffToken='s'.repeat(43),playerToken='p'.repeat(43),accounts={[staffToken]:{owner:'a'.repeat(64),gamemaster:true},[playerToken]:{owner:'o'.repeat(64),gamemaster:false}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant-'+a.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({gmAllow:'',gmEnabled:true,now:()=>1000000,walletClient,log:()=>{}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const call=async(path,{token=staffToken,body}={})=>{const r=await fetch('http://127.0.0.1:'+service.server.address().port+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json().catch(()=>({}))};};
 try{
  assert.equal((await call('/gm/companions',{token:playerToken})).status,403);
  const view=(await call('/gm/companions')).body;assert.equal(view.settings.slip_chance,.15);assert.equal(view.companions.length,7);assert.ok(view.companions.every(c=>c.sections.length>=3));
  const before=service.zones.followerChat.lore().version;
  const s=view.companions.find(c=>c.npc==='paladin_aegis').sections[0];
  assert.equal((await call('/gm/action',{body:{action:'companion_lore_save',npc:'paladin_aegis',section:{...s,text:'A GM rewrote this.'}}})).status,200);
  assert.notEqual(service.zones.followerChat.lore().version,before,'the chat sends the new lore version, so every AI node is re-pushed');
  assert.equal((await call('/gm/action',{body:{action:'companion_settings',values:{slip_chance:9}}})).status,400);
  assert.equal((await call('/gm/action',{body:{action:'companion_settings',values:{slip_chance:.5}}})).body.result.slip_chance,.5);
  const audit=service.db?.prepare?.("SELECT action FROM gm_audit WHERE action LIKE 'companion_%'").all()??null;if(audit)assert.ok(audit.length>=2,'changes are audited');
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
