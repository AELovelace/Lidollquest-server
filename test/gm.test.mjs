import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

const gmToken='g'.repeat(43),playerToken='p'.repeat(43),owner='o'.repeat(64);
const mateToken='m'.repeat(43),mate='n'.repeat(64);

function harness(){
 let now=1000000;
 const accounts={[playerToken]:owner,[mateToken]:mate};
 const service=createQuestService({gmToken,now:()=>now,walletClient:{authenticate:async secret=>{
  if(!accounts[secret])throw Object.assign(Error('No account'),{status:401});
  return {owner:accounts[secret],id:'grant-'+accounts[secret].slice(0,4),client:'lidollquest',coins:0};
 }}});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base=()=>'http://127.0.0.1:'+service.server.address().port;
 const characters={};
 async function play(secret,action,extra={}){ // Drives the ordinary player gateway exactly as the game client would.
  now+=500;
  const held=characters[secret];
  const body={action,character_id:held?.id,revision:held?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch(base()+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(result.character)characters[secret]=result.character;
  return {status:response.status,result};
 }
 async function ok(secret,action,extra={}){const r=await play(secret,action,extra);assert.equal(r.status,200,JSON.stringify(r.result));return r.result;}
 const gm=async(path,init={})=>{ // Every staff call carries the shared secret and nothing else.
  const headers={Authorization:'Bearer '+(init.token??gmToken)};
  if(init.body)headers['Content-Type']='application/json';
  const response=await fetch(base()+path,{method:init.method??'GET',headers:{...headers,...(init.headers??{})},body:init.body?JSON.stringify(init.body):undefined});
  return {status:response.status,body:await response.json().catch(()=>({})),type:response.headers.get('content-type')};
 };
 const act=(action,payload={})=>gm('/gm/action',{method:'POST',body:{action,...payload}});
 return {service,started,base,play,ok,gm,act,advance:ms=>{now+=ms;},time:()=>now,
  close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('the panel is unreachable without the staff secret',async()=>{
 const h=harness();await h.started;
 try{
  assert.equal((await h.gm('/gm/overview',{token:''})).status,401);                       // A missing credential is refused.
  assert.equal((await h.gm('/gm/overview',{token:playerToken})).status,401);              // A perfectly valid player token grants no staff access.
  assert.equal((await h.gm('/gm/overview',{token:gmToken+'x'})).status,401);              // A near miss is refused in constant time.
  assert.equal((await h.gm('/gm/overview',{headers:{Origin:'https://evil.invalid'}})).status,403); // A foreign page cannot drive the panel.
  const page=await fetch(h.base()+'/gm');
  assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/); // The shell itself loads so an operator can type the secret in.
  const html=await page.text();
  assert.doesNotMatch(html,new RegExp(gmToken));                                          // The served page never embeds the secret.
  assert.equal((await fetch(h.base()+'/gm',{method:'POST'})).status,405);
  assert.equal((await h.gm('/gm/nowhere')).status,404);
 }finally{await h.close();}
});

test('a deployment without a configured secret exposes no panel at all',async()=>{
 const {server}=createQuestService({gmToken:'',walletClient:{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/gm')).status,503);
  assert.equal((await fetch(base+'/gm/overview')).status,503);
  assert.equal((await fetch(base+'/gm/action',{method:'POST'})).status,503);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('a malformed secret is rejected at construction rather than at request time',()=>{
 assert.throws(()=>createQuestService({gmToken:'short',walletClient:{}}),/32-128/);
});

test('the overview reports live presence, rooms and totals',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  let view=(await h.gm('/gm/overview')).body;
  assert.equal(view.totals.online,0);assert.equal(view.totals.characters,1);assert.equal(view.totals.accounts,1);

  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  view=(await h.gm('/gm/overview')).body;
  assert.equal(view.totals.online,1);
  assert.equal(view.players[0].name,'Poppy');
  assert.equal(view.players[0].zone,'honeydew-lantern');
  assert.equal(view.players[0].zoneName,'Lantern Court');
  assert.equal(view.players[0].muted,false);
  assert.equal(view.zones.find(z=>z.id==='honeydew-lantern').players,1);
  assert.equal(view.zones.find(z=>z.id==='dive-desert').warp,false);          // Instanced dives are listed but never offered as destinations.
  assert.ok(view.zones.find(z=>z.id==='honeydew-lantern-shops').warp);        // Every hub annexe is a legitimate destination.

  h.advance(31000);                                                          // Past the presence window every module shares.
  assert.equal((await h.gm('/gm/overview')).body.totals.online,0);
 }finally{await h.close();}
});

test('a kick returns the player to character select without touching their character',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  assert.equal((await h.act('kick',{owner:'nobody'})).body.error,'gm_not_online');

  const kicked=await h.act('kick',{owner,reason:'testing'});
  assert.equal(kicked.status,200);
  assert.equal(kicked.body.result.zoneName,'Lantern Court');
  assert.equal((await h.gm('/gm/overview')).body.totals.online,0);

  const blocked=await h.play(playerToken,'heartbeat');
  assert.equal(blocked.status,409);                                          // The client is told to enter again rather than silently desyncing.
  assert.equal((await h.gm('/gm/player?owner='+owner)).body.characters[0].name,'Poppy'); // The character itself survived the kick untouched.

  const entry=(await h.gm('/gm/overview')).body.audit[0];
  assert.equal(entry.action,'kick');assert.equal(entry.target,owner);assert.equal(entry.detail.reason,'testing');
 }finally{await h.close();}
});

test('a mute withholds speech only, and lifts cleanly',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  await h.ok(playerToken,'chat',{text:'hello everyone'});

  assert.equal((await h.act('mute',{owner:'nobody',minutes:5})).body.error,'gm_unknown_player');
  assert.equal((await h.act('mute',{owner,minutes:-1})).body.error,'gm_bad_duration');
  assert.equal((await h.act('mute',{owner,minutes:10,reason:'spam'})).status,200);

  const silenced=await h.play(playerToken,'chat',{text:'again'});
  assert.equal(silenced.status,403);
  assert.match(silenced.result.error_description,/muted/);
  assert.equal((await h.ok(playerToken,'heartbeat')).zone,'honeydew-lantern'); // Ordinary play continues while muted.

  assert.equal((await h.gm('/gm/overview')).body.players[0].muted,true);
  h.advance(11*60000);                                                        // The timer runs out on its own.
  assert.equal((await h.gm('/gm/overview')).body.sanctions.length,0);
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});                  // That jump also outlived the presence window, so rejoin as the client would.
  assert.equal((await h.play(playerToken,'chat',{text:'back again'})).status,200);

  assert.equal((await h.act('mute',{owner,minutes:0,reason:'indefinite'})).body.result.until,0);
  assert.equal((await h.play(playerToken,'chat',{text:'nope'})).status,403);
  assert.equal((await h.act('unmute',{owner})).status,200);
  assert.equal((await h.act('unmute',{owner})).body.error,'gm_no_sanction');
  assert.equal((await h.play(playerToken,'chat',{text:'free at last'})).status,200);
 }finally{await h.close();}
});

test('a suspension drops the session and blocks the gateway until it is lifted',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  await h.ok(mateToken,'create',{name:'Mate'});
  await h.ok(mateToken,'enter',{zone:'honeydew-lantern'});
  assert.equal((await h.ok(mateToken,'heartbeat')).peers.length,2);           // Both are visible to one another first.

  assert.equal((await h.act('suspend',{owner,minutes:60,reason:'review'})).status,200);
  const refused=await h.play(playerToken,'heartbeat');
  assert.equal(refused.status,403);
  assert.equal(refused.result.error,'account_suspended');
  assert.equal((await h.gm('/gm/overview')).body.totals.online,1);            // Their presence row went with the suspension.
  assert.equal((await h.ok(mateToken,'heartbeat')).peers.length,1);           // And they no longer appear beside anyone.

  assert.equal((await h.act('unsuspend',{owner})).status,200);
  assert.equal((await h.play(playerToken,'enter',{zone:'honeydew-lantern'})).status,200);
 }finally{await h.close();}
});

test('a gamemaster can move a player between rooms but never into a dive',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});

  assert.equal((await h.act('warp',{owner,zone:'nowhere'})).body.error,'gm_unknown_zone');
  assert.equal((await h.act('warp',{owner,zone:'dive-desert'})).body.error,'gm_zone_not_warpable');

  const moved=await h.act('warp',{owner,zone:'honeydew-lantern-shops',reason:'stuck'});
  assert.equal(moved.status,200);
  assert.equal(moved.body.result.to,'Lantern Market Hall');
  const after=(await h.gm('/gm/overview')).body.players[0];
  assert.equal(after.zone,'honeydew-lantern-shops');
  assert.deepEqual({x:after.x,y:after.y},{x:20,y:21});                        // They arrive on that room's declared spawn tile.
  assert.equal((await h.ok(playerToken,'heartbeat')).zone,'honeydew-lantern-shops'); // The client sees the move on its next command.
 }finally{await h.close();}
});

test('announcements and message removal work on shared chat',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  await h.ok(playerToken,'chat',{text:'a rude thing'});

  assert.equal((await h.act('broadcast',{zone:'honeydew-lantern',text:'   '})).body.error,'gm_empty_message');
  const cast=await h.act('broadcast',{zone:'honeydew-lantern',text:'Server restarting in ten minutes.',speaker:'Lumi'});
  assert.equal(cast.status,200);

  let feed=(await h.gm('/gm/chat?zone=honeydew-lantern')).body;
  const announcement=feed.messages.find(m=>m.activity);
  assert.equal(announcement.name,'Lumi');
  assert.equal(announcement.text,'Server restarting in ten minutes.');
  assert.equal((await h.ok(playerToken,'heartbeat')).chat.at(-1).text,'Server restarting in ten minutes.'); // Players actually receive it.

  const rude=feed.messages.find(m=>m.text==='a rude thing');
  assert.equal(rude.owner,owner);
  assert.equal((await h.act('delete_chat',{seq:rude.seq,reason:'rule 1'})).status,200);
  assert.equal((await h.act('delete_chat',{seq:rude.seq})).body.error,'gm_unknown_message');

  feed=(await h.gm('/gm/chat')).body;
  assert.equal(feed.messages.some(m=>m.text==='a rude thing'),false);
  assert.equal((await h.gm('/gm/chat?limit=0')).status,400);
  assert.equal((await h.gm('/gm/chat?zone=nowhere')).status,400);
 }finally{await h.close();}
});

test('player detail summarises an account without exposing its inventory',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  await h.ok(playerToken,'chat',{text:'hello'});
  await h.act('mute',{owner,minutes:5,reason:'noise'});

  assert.equal((await h.gm('/gm/player?owner=nobody')).status,404);
  const detail=(await h.gm('/gm/player?owner='+owner)).body;
  assert.equal(detail.owner,owner);
  assert.equal(detail.characters[0].name,'Poppy');
  assert.equal(detail.presence.zoneName,'Lantern Court');
  assert.equal(detail.sanctions[0].kind,'mute');
  assert.equal(detail.chat.at(-1).text,'hello');
  assert.equal(detail.audit[0].action,'mute');
  assert.equal(JSON.stringify(detail).includes('"inventory"'),false);        // Only flat character values travel to the staff console.

  const byCharacter=(await h.gm('/gm/player?character_id='+detail.characters[0].id)).body;
  assert.equal(byCharacter.owner,owner);                                     // Either handle resolves to the same account.
 }finally{await h.close();}
});

test('unknown actions and malformed bodies are refused',async()=>{
 const h=harness();await h.started;
 try{
  assert.equal((await h.act('__proto__')).body.error,'gm_unknown_action');    // Prototype keys are not callable actions.
  assert.equal((await h.act('constructor')).body.error,'gm_unknown_action');
  assert.equal((await h.act('nonsense')).body.error,'gm_unknown_action');
  const raw=await fetch(h.base()+'/gm/action',{method:'POST',headers:{Authorization:'Bearer '+gmToken,'Content-Type':'application/json'},body:'{not json'});
  assert.equal(raw.status,400);
  const noType=await fetch(h.base()+'/gm/action',{method:'POST',headers:{Authorization:'Bearer '+gmToken},body:'{}'});
  assert.equal(noType.status,415);
 }finally{await h.close();}
});
