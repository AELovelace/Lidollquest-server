import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createTestingStore,compareVersions} from '../server/gm-testing.mjs';
import {createQuestService} from '../server/service.mjs';

// GM panel "Testing" tab (2026-10-02): a shared QA checklist with a pass/fail/blocked mark and a note per item, per game version.
const seed={areas:[{area:'Social',items:[{id:'chat',title:'Area chat',detail:'Only on-screen players hear it.'},{id:'party',title:'Parties',detail:'Cap of 3.'}]},{area:'Combat',items:[{id:'rows',title:'Rows',detail:''}]}]};

function store(){let now=1000;const db=new DatabaseSync(':memory:');const clock={advance:ms=>{now+=ms;}};return {db,clock,s:createTestingStore(db,{now:()=>now++,seed}),reopen:()=>createTestingStore(db,{now:()=>now++,seed})};}

test('versions sort numerically, with pre-releases before their release',()=>{
 const list=['0.2.9','0.2.10','0.3.0','0.3.0-beta.2','0.3.0-beta.10','0.2.0'].sort(compareVersions);
 assert.deepEqual(list,['0.2.0','0.2.9','0.2.10','0.3.0-beta.2','0.3.0-beta.10','0.3.0']);
});

test('a game client on a new version opens its checklist; the highest version is current',()=>{
 const {s,clock}=store();
 assert.equal(s.view().current,null);
 assert.equal(s.seen('0.2.0'),true,'first sighting adds the version');
 assert.equal(s.seen('0.2.0'),false,'repeat heartbeats inside a minute write nothing');
 assert.equal(s.seen('not a version'),false);assert.equal(s.seen(undefined),false);
 s.seen('0.2.1');s.seen('0.1.9');
 let v=s.view();
 assert.equal(v.current.label,'0.2.1');assert.deepEqual(v.builds.map(b=>b.label),['0.2.1','0.2.0','0.1.9']);
 assert.equal(v.current.source,'client');
 const before=v.builds.find(b=>b.label==='0.2.0').last_seen;clock.advance(61000);s.seen('0.2.0');
 assert.ok(s.view().builds.find(b=>b.label==='0.2.0').last_seen>before,'last seen refreshes once a minute');
});

test('items start untested, and a mark with a note sticks to the selected version',()=>{
 const {s}=store();
 let v=s.view();assert.deepEqual(v.counts,{total:3,pass:0,fail:0,blocked:0,untested:3});
 assert.deepEqual(v.areas,['Social','Combat'],'areas keep report order');
 s.seen('0.2.0');const b=s.view().current;
 s.mark({build:b.id,item:'chat',status:'pass',note:'Heard only on screen',tester:'Doll'},'staff');
 s.mark({build:b.id,item:'party',status:'fail',note:'4th player got in'},'staff');
 v=s.view();
 const chat=v.items.find(i=>i.id==='chat'),party=v.items.find(i=>i.id==='party');
 assert.equal(chat.status,'pass');assert.equal(chat.note,'Heard only on screen');assert.equal(chat.tester,'Doll');
 assert.equal(party.status,'fail');assert.equal(party.note,'4th player got in');
 assert.deepEqual(v.counts,{total:3,pass:1,fail:1,blocked:0,untested:1});
 s.mark({build:b.id,item:'party',status:'untested'},'staff');
 assert.equal(s.view().items.find(i=>i.id==='party').status,'untested','Clear removes the mark');
 assert.equal(s.buildNotes({build:b.id,notes:'Guild fixes'}).notes,'Guild fixes');
});

test('a new version starts fresh but shows each item\'s result from the version below it',()=>{
 const {s}=store();
 s.seen('0.2.0');const old=s.view().current;s.mark({build:old.id,item:'rows',status:'pass'},'staff');
 s.seen('0.2.1');
 const v=s.view();
 assert.equal(v.current.label,'0.2.1');
 const rows=v.items.find(i=>i.id==='rows');
 assert.equal(rows.status,'untested');assert.deepEqual({status:rows.previous.status,label:rows.previous.label},{status:'pass',label:'0.2.0'});
 assert.equal(s.view(old.id).items.find(i=>i.id==='rows').status,'pass','older versions stay viewable');
 assert.equal(s.view(old.id).items.find(i=>i.id==='rows').previous,null,'a higher version never counts as "previous"');
 const early=s.startBuild({label:'0.3.0-beta.1'},'staff');assert.equal(early.source,'manual');assert.equal(s.view().current.label,'0.3.0-beta.1');
 assert.throws(()=>s.startBuild({label:'0.2.1'}),/already on the list/);
 assert.throws(()=>s.startBuild({label:'Alpha 2'}),/game version number/);
 assert.throws(()=>s.mark({build:early.id,item:'rows',status:'maybe'}),/Status must be/);
});

test('custom items, edits and retirements survive a restart; seeds are never overwritten',()=>{
 const {s,reopen}=store();
 const added=s.saveItem({area:'Combat',title:'Revive',detail:'30% HP'});
 assert.ok(added.id.startsWith('custom-'));
 s.saveItem({id:'chat',area:'Social',title:'Area chat range',detail:'15x10 tiles'});
 s.retireItem({id:'party'});
 const v=reopen().view();
 assert.equal(v.items.find(i=>i.id==='chat').title,'Area chat range','a GM edit beats the seed text');
 assert.equal(v.items.some(i=>i.id==='party'),false);assert.equal(v.retired[0].id,'party');
 assert.deepEqual(v.items.map(i=>i.id),['chat','rows',added.id],'custom items join the end of their area');
 s.retireItem({id:'party',retired:false});assert.equal(s.view().items.length,4);
});

test('game commands report their version, and the Testing tab is staff-only',async()=>{
 const staffToken='s'.repeat(43),playerToken='p'.repeat(43);
 const accounts={[staffToken]:{owner:'a'.repeat(64),gamemaster:true},[playerToken]:{owner:'o'.repeat(64),gamemaster:false}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant',client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({walletClient,now:()=>1000000,log:()=>{}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+service.server.address().port;
 const call=async(path,{token=staffToken,body}={})=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 try{
  assert.equal((await call('/gm/testing',{token:playerToken})).status,403);
  let r=await call('/gm/testing');assert.equal(r.status,200);assert.ok(r.body.items.length>=100,'the shipped checklist is seeded');assert.equal(r.body.current,null);
  r=await call('/zones/action',{token:playerToken,body:{action:'create',name:'Tester',request_id:randomUUID(),controller:'window',client_version:'0.2.0'}});
  assert.equal(r.status,200,'client_version rides along without upsetting the game command: '+JSON.stringify(r.body));
  r=await call('/gm/testing');assert.equal(r.body.current.label,'0.2.0');assert.equal(r.body.current.source,'client');
  const build=r.body.current;
  r=await call('/gm/action',{body:{action:'test_mark',build:build.id,item:'social-trade',status:'fail',note:'Coins vanished on timeout',tester:'Doll'}});assert.equal(r.status,200);
  const trade=(await call('/gm/testing')).body.items.find(i=>i.id==='social-trade');
  assert.equal(trade.status,'fail');assert.equal(trade.note,'Coins vanished on timeout');
  assert.equal((await call('/gm/action',{token:playerToken,body:{action:'test_mark',build:build.id,item:'social-trade',status:'pass'}})).status,403);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
