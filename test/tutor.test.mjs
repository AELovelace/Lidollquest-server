import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {hubCatalog,hubPortals} from '../server/hubs.mjs';
import {reachableDistrict} from '../server/hub-districts.mjs';
import {createTutor,TUTOR_LOBBIES,TUTOR_FIXTURE_ID} from '../server/tutor.mjs';

// Pip (tutor.mjs): a tutorial NPC in every starting lobby. Questions are stored by tutor_ask inside the command
// transaction; kick() asks npc-rag afterwards and view() carries the answer in the next snapshot.

const answer={reply:'Open Items and equip a clean diaper in the underwear slot.',category:'game',guard:'passed',fallback:false,
 sources:[{title:'Needs & recovery',section:'Wearing and changing protection',url:'https://lidoll.dev/wiki/#/needs-and-care/wearing-and-changing-protection'}],timings_ms:{total:1800}};
const reply=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});

function world({fetch=async()=>reply(200,answer),...tutorOptions}={}){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-26T12:00:00Z'),c;
 const calls=[];
 const tutor=createTutor(db,{url:'http://npc-rag.test:9092/',key:'k'.repeat(32),now:()=>time,log:()=>{},cooldownMs:4000,
  fetch:async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return fetch(url,init);},...tutorOptions});
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:1000}),adjust:()=>{},diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 api.setTutor(tutor);
 const act=(action,extra={})=>{time+=350;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 act('create',{name:'Alice'});
 const lobby=act('enter',{zone:'honeydew-lantern',loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[]}});
 return {db,tutor,api,act,place,lobby,calls,advance:ms=>{time+=ms;},character:()=>c};
}
const pipIn=(snapshot,id)=>snapshot.zones.find(z=>z.id===id).fixtures.find(f=>f.id===TUTOR_FIXTURE_ID);
function standBeside(w,snapshot){ // An open, reachable tile next to Pip in the lobby the player is in.
 const z=snapshot.zones.find(z=>z.id===snapshot.zone),pip=pipIn(snapshot,snapshot.zone),seen=reachableDistrict(z);
 const beside=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>({x:pip.x+dx,y:pip.y+dy})).find(t=>seen.has(t.x+','+t.y));
 w.place(beside.x,beside.y);return pip;
}

test('Pip stands on a reachable floor tile near the spawn of every starting lobby, clear of doors',()=>{
 const w=world();
 assert.deepEqual([...TUTOR_LOBBIES].sort(),hubCatalog.map(h=>h.id).sort(),'every catalog lobby is a starting hub with a Pip');
 for(const id of TUTOR_LOBBIES){
  const s=w.act('enter',{zone:id,loadout:{player_info:{},inventory:[]}}); // Monthly towns are only fully resolved for the room a player stands in.
  const z=s.zones.find(z=>z.id===id),pip=pipIn(s,id);
  assert.ok(pip,`Pip is in ${id}`);
  assert.deepEqual([pip.kind,pip.service,pip.name,pip.solid,pip.avatar],['npc','tutor','Pip',false,'objNPCLibrarian']);
  assert.equal(z.walls[pip.y][pip.x],0,`${id}: Pip stands on floor`);
  const d=Math.abs(pip.x-z.spawn.x)+Math.abs(pip.y-z.spawn.y);assert.ok(d>=2&&d<=8,`${id}: Pip is ${d} steps from the spawn`);
  assert.equal(z.fixtures.filter(f=>f.x===pip.x&&f.y===pip.y).length,1,`${id}: nothing else on Pip's tile`);
  for(const door of hubPortals(z))assert.ok(Math.abs(pip.x-door.x)>1||Math.abs(pip.y-door.y)>1,`${id}: Pip keeps clear of ${door.target}`);
  const seen=reachableDistrict(z);assert.ok([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen.has((pip.x+dx)+','+(pip.y+dy))),`${id}: a player can walk up beside Pip`);
 }
});

test('talking to Pip greets; asking stores one pending question that npc-rag answers into the next snapshot',async()=>{
 const w=world();const pip=standBeside(w,w.lobby);
 const talk=w.act('hub_talk',{fixture:pip.id});assert.match(talk.character.hubNotice,/^Pip: Hi there! I'm Pip/);
 const asked=w.act('tutor_ask',{fixture:pip.id,text:'  how do I\nchange my diaper?  '});
 assert.equal(w.tutor.view(asked.character.id).status,'pending');
 assert.equal(w.tutor.view(asked.character.id).question,'how do I change my diaper?'); // One tidy line.
 await w.tutor.kick();
 assert.equal(w.calls.length,1);
 assert.equal(w.calls[0].url,'http://npc-rag.test:9092/v1/npc/chat');
 assert.equal(w.calls[0].init.headers['X-Api-Key'],'k'.repeat(32));
 assert.deepEqual(w.calls[0].body,{message:'how do I change my diaper?',player_id:asked.character.id,player_name:'Alice',npc_name:'Pip'});
 const view=w.tutor.view(asked.character.id);
 assert.equal(view.status,'answered');assert.equal(view.reply,answer.reply);
 assert.deepEqual(view.sources,[{title:'Needs & recovery',section:'Wearing and changing protection',url:answer.sources[0].url}]);
 await w.tutor.kick();assert.equal(w.calls.length,1,'an answered row is never sent again');
 w.advance(11*60*1000);assert.equal(w.tutor.view(asked.character.id),null,'old exchanges leave the snapshot');
});

test('asking needs Pip beside you, words, patience and a daily allowance',async()=>{
 const w=world({dailyLimit:2});const pip=standBeside(w,w.lobby);
 assert.throws(()=>w.act('tutor_ask',{fixture:pip.id,text:'   '}),/Type a question/);
 w.place(w.lobby.position.x,w.lobby.position.y);assert.throws(()=>w.act('tutor_ask',{fixture:pip.id,text:'hi'}),/Stand next to/);
 standBeside(w,w.lobby);
 w.act('tutor_ask',{fixture:pip.id,text:'first question'});
 assert.throws(()=>w.act('tutor_ask',{fixture:pip.id,text:'second'}),/still thinking/);
 await w.tutor.kick();
 assert.throws(()=>w.act('tutor_ask',{fixture:pip.id,text:'too soon'}),/moment/);
 w.advance(5000);w.act('tutor_ask',{fixture:pip.id,text:'second question'});await w.tutor.kick();
 w.advance(5000);assert.throws(()=>w.act('tutor_ask',{fixture:pip.id,text:'third'}),/all the questions/);
 assert.throws(()=>w.act('tutor_ask',{fixture:'innkeeper',text:'hello'}),/Stand next to|Only Pip/);
});

test('npc-rag trouble: a busy reply waits, a failure retries once, then Pip says a friendly line',async()=>{
 let script=[reply(429,{}),reply(500,{})];
 const w=world({fetch:async()=>script.shift()??Promise.reject(Object.assign(Error('timeout'),{name:'TimeoutError'}))});
 const pip=standBeside(w,w.lobby);const id=w.act('tutor_ask',{fixture:pip.id,text:'where is the inn'}).character.id;
 await w.tutor.kick();assert.equal(w.tutor.view(id).status,'pending','429: try again later, no attempt used');
 w.advance(3500);await w.tutor.kick();assert.equal(w.tutor.view(id).status,'pending','first failure is retried');
 w.advance(16000);await w.tutor.kick();
 const v=w.tutor.view(id);assert.equal(v.status,'failed');assert.match(v.reply,/ask me again/);
 assert.equal(w.tutor.gmView().health.ok,false);
 const stuck=world({fetch:()=>new Promise(()=>{})}); // npc-rag never answers at all
 const p2=standBeside(stuck,stuck.lobby);const id2=stuck.act('tutor_ask',{fixture:p2.id,text:'hello?'}).character.id;
 void stuck.tutor.kick();stuck.advance(4*60*1000);await stuck.tutor.kick();
 assert.equal(stuck.tutor.view(id2).status,'failed','a question stuck for minutes is given up on');
});

test('the GM switch hides and renames Pip and validates input; an unconfigured server never shows Pip',()=>{
 const w=world();
 assert.throws(()=>w.tutor.gmSet({name:'<script>'}),/Name/);
 assert.throws(()=>w.tutor.gmSet({enabled:'yes'}),/true or false/);
 assert.throws(()=>w.tutor.gmSet({}),/Nothing to change/);
 w.tutor.gmSet({name:'Tilly',greeting:'Hello, new friend!'},'gm-1');
 let s=w.act('heartbeat');assert.equal(pipIn(s,'honeydew-lantern').name,'Tilly');assert.equal(pipIn(s,'honeydew-lantern').line,'Hello, new friend!');
 w.tutor.gmSet({enabled:false},'gm-1');
 s=w.act('heartbeat');assert.equal(pipIn(s,'honeydew-lantern'),undefined,'switched off: gone from every lobby');
 assert.throws(()=>w.act('tutor_ask',{fixture:TUTOR_FIXTURE_ID,text:'hello'}),/not taking questions/);
 const view=w.tutor.gmView();assert.equal(view.configured,true);assert.equal(view.service,'npc-rag.test:9092');assert.equal(view.settings.enabled,false);
 const bare=createTutor(new DatabaseSync(':memory:'),{url:'',log:()=>{}});
 assert.equal(bare.decorate({id:'honeydew-lantern',fixtures:[],walls:[[0]],spawn:{x:0,y:0}}).fixtures.length,0,'no NPC_RAG_URL: no Pip');
});
