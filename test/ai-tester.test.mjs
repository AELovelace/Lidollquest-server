import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createQuestService} from '../server/service.mjs';
import {createAiTester,parseHistory,quickChecks} from '../server/ai-tester.mjs';

// GM AI Tester (2026-10-19): every node's /health on the GM panel, and test queries built exactly like live play
// (persona, voice, style, lore version) sent to the node the GM picks. Nothing is stored on any character.

function fakeNode(){ // A pretend npc-rag: /health, the companion routes, and a 409 until it has been sent the lore.
 const seen=[];let hasLore=false;
 const server=createServer((req,res)=>{let raw='';req.on('data',d=>{raw+=d;});req.on('end',()=>{
  const body=raw?JSON.parse(raw):null,send=(status,json)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(json));};
  seen.push({path:req.url,body,key:req.headers['x-api-key']});
  if(req.url==='/health')return send(200,{ok:true,llm:true,student_fleet:{enabled:true,model:'lidoll-fm-0.4',copies:[{port:9100,alive:true}]},capacity:{slots:8},openai_api_key:'never-shown'});
  if(req.url==='/v1/companion/lore'){hasLore=true;return send(200,{ok:true});}
  if(req.url==='/v1/companion/chat')return hasLore?send(200,{reply:'As an AI, hello '+body.player_name+'!',category:'chat',guard:'passed',lane:'local'}):send(409,{detail:'lore_version'});
  if(req.url==='/v1/participation/decide')return send(200,{decision:'join',join:true,join_probability:.8});
  send(404,{detail:'nope'});
 });});
 return {server,seen};
}

test('the GM AI Tester shows node health and sends a live-shaped companion request to the chosen node',async()=>{
 const node=fakeNode();await new Promise(r=>node.server.listen(0,'127.0.0.1',r));
 const host='127.0.0.1:'+node.server.address().port,saved={nodes:process.env.NPC_RAG_NODES,key:process.env.NPC_RAG_KEY};
 process.env.NPC_RAG_NODES='http://'+host;process.env.NPC_RAG_KEY='k'.repeat(32);
 const staff='s'.repeat(43),service=createQuestService({log:()=>{},walletClient:{authenticate:async token=>({owner:'staff',gamemaster:token===staff,client:'lidollquest',coins:0,scope:'social:read'})}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port,auth={Authorization:'Bearer '+staff};
 const post=async body=>{const r=await fetch(base+'/gm/ai-test',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 try{
  const page=await (await fetch(base+'/gm')).text();assert.match(page,/id="tab-aitester"/);assert.match(page,/id="panel-aitester"/);new Function(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.equal((await fetch(base+'/gm/ai-tester')).status,401,'GM sign-in required');
  const view=await (await fetch(base+'/gm/ai-tester',{headers:auth})).json();
  assert.equal(view.configured,true);assert.equal(view.nodes[0].host,host);assert.equal(view.nodes[0].body.capacity.slots,8);
  assert.equal(view.nodes[0].body.openai_api_key,undefined,'credential-looking fields never reach the panel');
  const npc=view.companions[0];assert.ok(npc?.id,'companions come from the live catalog');
  const r=await post({node:host,route:'chat',npc:npc.id,player:'Moss',message:'hi there',bond:40,flags:'a_flag, Bad Flag',history:'Moss: earlier\n'+npc.name+': yes?',memories:'Moss likes tea'});
  assert.equal(r.status,200);const res=r.data.result;
  assert.equal(res.status,200);assert.equal(res.node,host);assert.equal(res.lorePushed,true,'a 409 pushes the lore and retries, as live play does');
  assert.match(res.reply,/hello Moss/);assert.ok(res.checks.includes('talks about being an AI'));
  const chat=node.seen.filter(s=>s.path==='/v1/companion/chat').at(-1);
  assert.equal(chat.key,'k'.repeat(32),'the server adds the npc-rag key; the panel never sees it');
  assert.equal(chat.body.npc_id,npc.id);assert.equal(chat.body.player_name,'Moss');assert.equal(chat.body.bond,40);assert.deepEqual(chat.body.flags,['a_flag'],'invalid flags are dropped');
  assert.ok(chat.body.persona&&chat.body.lore_version,'persona and the lore version come from the live builder');
  assert.deepEqual(chat.body.history,[{role:'player',content:'earlier'},{role:'npc',content:'yes?'}]);
  assert.deepEqual(chat.body.memories,[{id:'gm-test-1',text:'Moss likes tea',importance:2}]);
  const gate=await post({node:'',route:'gate',npc:npc.id,message:'anyone around?'});
  assert.equal(gate.data.result.response.decision,'join');assert.equal(node.seen.at(-1).body.candidate.name,npc.name);
  assert.equal((await post({node:'elsewhere:1',route:'chat',npc:npc.id,message:'x'})).status,400,'only configured nodes');
  assert.equal((await post({route:'chat',npc:'nobody',message:'x'})).status,400);
  assert.equal((await post({route:'sql',message:'x'})).status,400);
 }finally{await new Promise(r=>service.server.close(r));await new Promise(r=>node.server.close(r));
  for(const [k,v] of [['NPC_RAG_NODES',saved.nodes],['NPC_RAG_KEY',saved.key]])if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('a chosen node gets no failover, and at most three tests run at once',async()=>{
 const calls=[];let release;const gate=new Promise(r=>{release=r;});
 const pool={configured:true,hosts:()=>['a:1','b:1'],view:()=>[],health:async()=>[],
  request:async(path,body,opts)=>{calls.push(opts);await gate;return {status:200,ok:true,body:{reply:'ok'},node:'a:1'};}};
 const tester=createAiTester({pool:()=>pool,chat:()=>({companionBody:()=>({}),lore:()=>null}),followers:()=>({catalog:{}})});
 const runs=[1,2,3].map(()=>tester.run({node:'a:1',route:'pip',message:'hi'}));
 await assert.rejects(tester.run({route:'pip',message:'hi'}),/already running/);
 release();await Promise.all(runs);
 assert.equal(calls[0].attempts,1);assert.equal(calls[0].only({host:'a:1'}),true);assert.equal(calls[0].only({host:'b:1'}),false);
});

test('quick checks flag obvious slips only, and history lines map to turns',()=>{
 assert.deepEqual(quickChecks('chat','Vex: {"secret":"open"} hi',{npcName:'Vex'}),['prompt marker leaked','labelled its own line']);
 assert.deepEqual(quickChecks('chat','a wittle nap-nap?',{style:'baby_talk'}),[]);
 assert.ok(quickChecks('chat','x'.repeat(241)).includes('over 240 characters'));
 assert.deepEqual(quickChecks('summarize',''),[],'only replies are checked');
 assert.deepEqual(parseHistory('Kit: hello\nVex: hey\njust words','Kit','Vex'),[{role:'player',content:'hello'},{role:'npc',content:'hey'},{role:'player',content:'just words'}]);
});
