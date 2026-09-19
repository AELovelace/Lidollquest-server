import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';
import {buildAllowList} from '../server/gm.mjs';

const staffToken='s'.repeat(43),staff='a'.repeat(64);          // A LiDollID account holding the gamemaster role.
const playerToken='p'.repeat(43),owner='o'.repeat(64);         // An ordinary player.
const mateToken='m'.repeat(43),mate='n'.repeat(64);
const grantedToken='g'.repeat(43);                             // Issued by the device flow during a sign-in test.

function harness({allow='',enabled=true,identityDown=false,trustProxy='',requireTls=false}={}){
 let now=1000000;
 const accounts={
  [staffToken]:{owner:staff,gamemaster:true},
  [playerToken]:{owner,gamemaster:false},
  [mateToken]:{owner:mate,gamemaster:false},
  [grantedToken]:{owner:staff,gamemaster:true},
 };
 const device={approved:false,gamemaster:true,polls:0}; // Drives the simulated LiDollID device authorisation.
 const walletClient={
  async authenticate(secret){
   if(identityDown)throw Object.assign(Error('wallet down'),{status:503,code:'wallet_unavailable'});
   const account=accounts[secret];
   if(!account)throw Object.assign(Error('No account'),{status:401});
   return {owner:account.owner,id:'grant-'+account.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:account.gamemaster,blockedAccounts:[]};
  },
  async device(){return {device_code:'dev-'+randomUUID(),user_code:'ABC123-DEF456',verification_uri:'https://lidoll.example/coins/',interval:0,expires_in:600};},
  async deviceToken(){
   device.polls++;
   if(!device.approved)throw Object.assign(Error('Waiting for account approval.'),{status:400,code:'authorization_pending'});
   accounts[grantedToken]={owner:device.gamemaster?staff:owner,gamemaster:device.gamemaster};
   return {access_token:grantedToken,token_type:'Bearer',expires_in:2592000,scope:'wallet:read'};
  },
 };
 const service=createQuestService({gmAllow:allow,gmEnabled:enabled,gmTrustProxy:trustProxy,gmRequireTls:requireTls,now:()=>now,walletClient});
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
 const gm=async(path,init={})=>{
  const token=init.token===undefined?staffToken:init.token;
  const headers={...(token?{Authorization:'Bearer '+token}:{}),...(init.body?{'Content-Type':'application/json'}:{}),...(init.headers??{})};
  const response=await fetch(base()+path,{method:init.method??'GET',headers,body:init.body?JSON.stringify(init.body):undefined});
  return {status:response.status,body:await response.json().catch(()=>({})),type:response.headers.get('content-type')};
 };
 const act=(action,payload={},init={})=>gm('/gm/action',{method:'POST',body:{action,...payload},...init});
 return {service,started,base,play,ok,gm,act,device,accounts,advance:ms=>{now+=ms;},
  close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('only a LiDollID gamemaster reaches the panel',async()=>{
 const h=harness();await h.started;
 try{
  assert.equal((await h.gm('/gm/overview',{token:''})).body.error,'gm_unauthenticated');       // No credential at all.
  assert.equal((await h.gm('/gm/overview',{token:'not-a-known-grant'})).body.error,'gm_unauthenticated'); // An unknown grant.
  const ordinary=await h.gm('/gm/overview',{token:playerToken});
  assert.equal(ordinary.status,403);
  assert.equal(ordinary.body.error,'gm_not_gamemaster');                                        // A perfectly valid player is still refused.
  assert.equal((await h.gm('/gm/overview')).status,200);                                        // The gamemaster account is admitted.
  assert.equal((await h.gm('/gm/whoami')).body.owner,staff);
  assert.equal((await h.gm('/gm/overview')).body.actor,staff);

  const page=await fetch(h.base()+'/gm');
  assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);    // The sign-in shell loads for anyone who can reach it.
  assert.doesNotMatch(await page.text(),new RegExp(staffToken));                                 // It carries no credential of its own.
  assert.equal((await fetch(h.base()+'/gm',{method:'POST'})).status,405);
  assert.equal((await h.gm('/gm/nowhere')).status,404);
  assert.equal((await h.gm('/gm/overview',{headers:{Origin:'https://evil.invalid'}})).status,403);
 }finally{await h.close();}
});

test('performance history is staff-only, records real gameplay work, and rechecks role revocation',async()=>{
 const h=harness();await h.started;
 try{
  assert.equal((await h.gm('/gm/performance',{token:''})).status,401);
  assert.equal((await h.gm('/gm/performance',{token:playerToken})).status,403);
  assert.equal((await h.gm('/gm/performance',{headers:{Origin:'https://evil.invalid'}})).status,403);
  await h.ok(playerToken,'create',{name:'Private player name'});
  await h.gm('/health'); // Monitoring probes and staff reads must not appear as gameplay requests.
  h.service.metrics.sample();
  const read=await h.gm('/gm/performance');assert.equal(read.status,200);
  const data=read.body,last=data.latest;assert.equal(data.sampleMs,60000);assert.equal(data.retentionMs,86400000);
  assert.ok(data.availableCores>=1);assert.equal(last.requests.completed,1);
  for(const name of ['account.authenticate','zones.action','zones.refresh','snapshot.build','response.serialize'])assert.ok(last.timings.some(t=>t.name===name),name);
  assert.ok(last.timings.some(t=>t.name.startsWith('simulation.')));
  assert.ok(last.timings.some(t=>t.name.startsWith('generate.')));
  const serialized=JSON.stringify(data);for(const secret of [playerToken,staffToken,owner,'Private player name'])assert.ok(!serialized.includes(secret));
  assert.equal((await h.gm('/gm/performance',{method:'POST',body:{}})).status,404);
  h.accounts[staffToken].gamemaster=false;assert.equal((await h.gm('/gm/performance')).status,403);
  const health=await h.gm('/health',{token:''});assert.deepEqual(health.body,{ok:true});
 }finally{await h.close();}
});

test('losing the gamemaster role revokes panel access on the very next request',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  assert.equal((await h.gm('/gm/overview')).status,200);
  assert.equal((await h.act('kick',{owner})).status,200);                                       // Moderating normally while the role is held.

  h.accounts[staffToken].gamemaster=false;                                                      // Demoted in Little Log user management.

  const after=await h.gm('/gm/overview');
  assert.equal(after.status,403);
  assert.equal(after.body.error,'gm_not_gamemaster');                                           // No cached session survives the demotion.
  assert.equal((await h.act('broadcast',{zone:'honeydew-lantern',text:'still here?'})).status,403);
  assert.equal((await h.gm('/gm/whoami')).status,403);
  assert.equal((await fetch(h.base()+'/gm')).status,200);                                       // The sign-in page itself stays reachable.
 }finally{await h.close();}
});

test('a disabled deployment exposes no panel at all',async()=>{
 const h=harness({enabled:false});await h.started;
 try{
  assert.equal((await fetch(h.base()+'/gm')).status,503);
  assert.equal((await h.gm('/gm/overview')).status,503);
  assert.equal((await h.gm('/gm/signin/start',{method:'POST',body:{}})).status,503);
 }finally{await h.close();}
});

test('an unreachable identity service refuses moderation rather than assuming rights',async()=>{
 const h=harness({identityDown:true});await h.started;
 try{
  const refused=await h.gm('/gm/overview');
  assert.equal(refused.status,503);
  assert.equal(refused.body.error,'gm_identity_unavailable');                                   // Never fail open when LiDollID cannot be asked.
 }finally{await h.close();}
});

test('device sign-in waits for approval and hands back a usable grant',async()=>{
 const h=harness();await h.started;
 try{
  const started=await h.gm('/gm/signin/start',{method:'POST',body:{}});
  assert.equal(started.status,200);
  assert.equal(started.body.user_code,'ABC123-DEF456');
  assert.equal(started.body.verification_uri,'https://lidoll.example/coins/');
  assert.ok(started.body.device_code);

  const pending=await h.gm('/gm/signin/poll',{method:'POST',body:{device_code:started.body.device_code}});
  assert.equal(pending.status,400);
  assert.equal(pending.body.error,'authorization_pending');                                     // Relayed unchanged so the page can keep polling.

  h.device.approved=true;
  const granted=await h.gm('/gm/signin/poll',{method:'POST',body:{device_code:started.body.device_code}});
  assert.equal(granted.status,200);
  assert.equal(granted.body.owner,staff);
  assert.equal((await h.gm('/gm/overview',{token:granted.body.access_token})).status,200);       // The issued grant really works on the panel.
  assert.equal((await h.gm('/gm/signin/poll',{method:'POST',body:{device_code:123}})).body.error,'gm_bad_device_code');
 }finally{await h.close();}
});

test('device sign-in refuses an approved account that is not a gamemaster',async()=>{
 const h=harness();await h.started;
 try{
  const started=await h.gm('/gm/signin/start',{method:'POST',body:{}});
  h.device.approved=true;h.device.gamemaster=false;                                             // The operator approved with an ordinary account.
  const refused=await h.gm('/gm/signin/poll',{method:'POST',body:{device_code:started.body.device_code}});
  assert.equal(refused.status,403);
  assert.equal(refused.body.error,'gm_not_gamemaster');
  assert.equal(refused.body.access_token,undefined);                                            // The page never receives a session it could not use.
 }finally{await h.close();}
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
  assert.equal(view.players[0].zoneName,'Lantern Court');
  assert.equal(view.zones.find(z=>z.id==='honeydew-lantern').players,1);
  assert.equal(view.zones.find(z=>z.id==='dive-desert').warp,false);
  assert.ok(view.zones.find(z=>z.id==='honeydew-lantern-shops').warp);

  h.advance(31000);
  assert.equal((await h.gm('/gm/overview')).body.totals.online,0);
 }finally{await h.close();}
});

test('a kick returns the player to character select and names the gamemaster',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  assert.equal((await h.act('kick',{owner:'nobody'})).body.error,'gm_not_online');

  assert.equal((await h.act('kick',{owner,reason:'testing'})).status,200);
  assert.equal((await h.gm('/gm/overview')).body.totals.online,0);
  assert.equal((await h.play(playerToken,'heartbeat')).status,409);
  assert.equal((await h.gm('/gm/player?owner='+owner)).body.characters[0].name,'Poppy');

  const entry=(await h.gm('/gm/overview')).body.audit[0];
  assert.equal(entry.action,'kick');assert.equal(entry.target,owner);
  assert.equal(entry.actor,staff);                                                              // Attribution is the whole point of dropping the shared secret.
  assert.equal(entry.detail.reason,'testing');
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
  assert.equal((await h.ok(playerToken,'heartbeat')).zone,'honeydew-lantern');

  h.advance(11*60000);
  assert.equal((await h.gm('/gm/overview')).body.sanctions.length,0);
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  assert.equal((await h.play(playerToken,'chat',{text:'back again'})).status,200);

  assert.equal((await h.act('mute',{owner,minutes:0,reason:'indefinite'})).body.result.until,0);
  assert.equal((await h.play(playerToken,'chat',{text:'nope'})).status,403);
  assert.equal((await h.act('unmute',{owner})).status,200);
  assert.equal((await h.act('unmute',{owner})).body.error,'gm_no_sanction');
  assert.equal((await h.play(playerToken,'chat',{text:'free at last'})).status,200);
 }finally{await h.close();}
});

test('a gamemaster cannot sanction their own account',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(staffToken,'create',{name:'Lumi'});                                                // A gamemaster plays the game too.
  assert.equal((await h.act('mute',{owner:staff,minutes:5})).body.error,'gm_self_target');
  assert.equal((await h.act('suspend',{owner:staff,minutes:5})).body.error,'gm_self_target');
 }finally{await h.close();}
});

test('a suspension drops the session and blocks the gateway until it is lifted',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  await h.ok(mateToken,'create',{name:'Mate'});
  await h.ok(mateToken,'enter',{zone:'honeydew-lantern'});
  assert.equal((await h.ok(mateToken,'heartbeat')).peers.length,2);

  assert.equal((await h.act('suspend',{owner,minutes:60,reason:'review'})).status,200);
  const refused=await h.play(playerToken,'heartbeat');
  assert.equal(refused.status,403);
  assert.equal(refused.result.error,'account_suspended');
  assert.equal((await h.gm('/gm/overview')).body.totals.online,1);
  assert.equal((await h.ok(mateToken,'heartbeat')).peers.length,1);

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
  assert.equal(moved.body.result.to,'Lantern Market Hall');
  const after=(await h.gm('/gm/overview')).body.players[0];
  assert.deepEqual({zone:after.zone,x:after.x,y:after.y},{zone:'honeydew-lantern-shops',x:20,y:21});
  assert.equal((await h.ok(playerToken,'heartbeat')).zone,'honeydew-lantern-shops');
 }finally{await h.close();}
});

test('announcements and message removal work on shared chat',async()=>{
 const h=harness();await h.started;
 try{
  await h.ok(playerToken,'create',{name:'Poppy'});
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern'});
  await h.ok(playerToken,'chat',{text:'a rude thing'});

  assert.equal((await h.act('broadcast',{zone:'honeydew-lantern',text:'   '})).body.error,'gm_empty_message');
  assert.equal((await h.act('broadcast',{zone:'honeydew-lantern',text:'Server restarting in ten minutes.',speaker:'Lumi'})).status,200);

  let feed=(await h.gm('/gm/chat?zone=honeydew-lantern')).body;
  const announcement=feed.messages.find(m=>m.activity);
  assert.equal(announcement.name,'Lumi');
  assert.equal((await h.ok(playerToken,'heartbeat')).chat.at(-1).text,'Server restarting in ten minutes.');

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
  assert.equal(detail.characters[0].name,'Poppy');
  assert.equal(detail.presence.zoneName,'Lantern Court');
  assert.equal(detail.sanctions[0].kind,'mute');
  assert.equal(detail.chat.at(-1).text,'hello');
  assert.equal(detail.audit[0].action,'mute');
  assert.equal(detail.audit[0].actor,staff);
  assert.equal(JSON.stringify(detail).includes('"inventory"'),false);

  assert.equal((await h.gm('/gm/player?character_id='+detail.characters[0].id)).body.owner,owner);
 }finally{await h.close();}
});

test('unknown actions and malformed bodies are refused',async()=>{
 const h=harness();await h.started;
 try{
  assert.equal((await h.act('__proto__')).body.error,'gm_unknown_action');
  assert.equal((await h.act('constructor')).body.error,'gm_unknown_action');
  assert.equal((await h.act('nonsense')).body.error,'gm_unknown_action');
  const raw=await fetch(h.base()+'/gm/action',{method:'POST',headers:{Authorization:'Bearer '+staffToken,'Content-Type':'application/json'},body:'{not json'});
  assert.equal(raw.status,400);
  const noType=await fetch(h.base()+'/gm/action',{method:'POST',headers:{Authorization:'Bearer '+staffToken},body:'{}'});
  assert.equal(noType.status,415);
 }finally{await h.close();}
});

test('the source allowlist parses addresses, blocks and typos',()=>{
 assert.equal(buildAllowList(''),null);
 assert.equal(buildAllowList('  , '),null);
 const list=buildAllowList('10.1.1.23, 192.168.0.0/16, ::1');
 assert.equal(list.check('10.1.1.23','ipv4'),true);
 assert.equal(list.check('10.1.1.24','ipv4'),false);
 assert.equal(list.check('192.168.4.9','ipv4'),true);
 assert.equal(list.check('::1','ipv6'),true);
 assert.throws(()=>buildAllowList('not-an-address'),/not an IP address or CIDR/);
 assert.throws(()=>buildAllowList('10.1.1.0/33'),/prefix must be 0-32/);
 assert.throws(()=>createQuestService({gmAllow:'10.1.1',walletClient:{}}),/not an IP address/);
});

test('an off-list host cannot reach the panel, the page or the sign-in flow',async()=>{
 const h=harness({allow:'10.1.1.23'});await h.started;
 try{
  assert.equal((await h.gm('/gm/overview')).body.error,'gm_forbidden_address');
  assert.equal((await fetch(h.base()+'/gm')).status,403);
  assert.equal((await h.gm('/gm/signin/start',{method:'POST',body:{}})).body.error,'gm_forbidden_address');
  assert.equal((await fetch(h.base()+'/health')).status,200);                                   // Ordinary service routes are untouched.
 }finally{await h.close();}
});

test('an allowlisted host reaches the panel normally',async()=>{
 const h=harness({allow:'127.0.0.1, ::1'});await h.started;
 try{
  assert.equal((await fetch(h.base()+'/gm')).status,200);
  assert.equal((await h.gm('/gm/overview')).status,200);
  assert.equal((await h.gm('/gm/overview',{token:playerToken})).status,403);                    // On-list but not a gamemaster.
 }finally{await h.close();}
});

test('requiring HTTPS refuses cleartext and cannot be talked out of it',async()=>{
 const h=harness({requireTls:true,trustProxy:'10.9.9.9'});                                      // The real proxy is elsewhere; this test client is not it.
 await h.started;
 try{
  const plain=await h.gm('/gm/overview');
  assert.equal(plain.status,403);
  assert.equal(plain.body.error,'gm_insecure_transport');
  assert.equal((await fetch(h.base()+'/gm')).status,403);                                       // Not even the sign-in page over cleartext.

  const spoofed=await h.gm('/gm/overview',{headers:{'X-Forwarded-Proto':'https'}});
  assert.equal(spoofed.status,403);
  assert.equal(spoofed.body.error,'gm_insecure_transport');                                     // An untrusted caller cannot assert its own scheme.
  assert.equal((await h.gm('/gm/signin/start',{method:'POST',body:{},headers:{'X-Forwarded-Proto':'https'}})).body.error,'gm_insecure_transport');
 }finally{await h.close();}
});

test('a trusted proxy may assert HTTPS for the caller',async()=>{
 const h=harness({requireTls:true,trustProxy:'127.0.0.1'});                                     // The test client now stands in for the proxy.
 await h.started;
 try{
  assert.equal((await h.gm('/gm/overview',{headers:{'X-Forwarded-Proto':'https'}})).status,200);
  assert.equal((await h.gm('/gm/overview',{headers:{'X-Forwarded-Proto':'https,http'}})).status,200); // The first hop is the browser-facing one.
  assert.equal((await h.gm('/gm/overview',{headers:{'X-Forwarded-Proto':'http'}})).body.error,'gm_insecure_transport'); // Honest reporting of a cleartext hop is still refused.
  assert.equal((await h.gm('/gm/overview')).body.error,'gm_insecure_transport');                // A proxy that forwards no scheme is not assumed secure.
 }finally{await h.close();}
});

test('the allowlist follows the forwarded client through a trusted proxy',async()=>{
 const h=harness({allow:'10.1.1.23',trustProxy:'127.0.0.1'});
 await h.started;
 try{
  assert.equal((await h.gm('/gm/overview',{headers:{'X-Forwarded-For':'10.1.1.23'}})).status,200);        // The listed operator, behind the proxy.
  assert.equal((await h.gm('/gm/overview',{headers:{'X-Forwarded-For':'10.1.1.99'}})).body.error,'gm_forbidden_address');
  assert.equal((await h.gm('/gm/overview',{headers:{'X-Forwarded-For':'10.1.1.23, 127.0.0.1'}})).status,200); // Trailing hops that are our own proxies are skipped.
  assert.equal((await h.gm('/gm/overview')).body.error,'gm_forbidden_address');                            // The proxy's own address is not an operator.
 }finally{await h.close();}
});

test('an untrusted caller cannot forge its way past the allowlist',async()=>{
 const h=harness({allow:'10.1.1.23',trustProxy:'10.9.9.9'});                                    // This client is not the declared proxy.
 await h.started;
 try{
  assert.equal((await h.gm('/gm/overview',{headers:{'X-Forwarded-For':'10.1.1.23'}})).body.error,'gm_forbidden_address');
  assert.equal((await h.gm('/gm/overview',{headers:{'X-Forwarded-For':'10.1.1.23, 10.1.1.23'}})).body.error,'gm_forbidden_address');
 }finally{await h.close();}
});

test('a malformed trusted-proxy list is rejected at startup',()=>{
 assert.throws(()=>createQuestService({gmTrustProxy:'nginx.example',walletClient:{}}),/LIDOLLQUEST_GM_TRUST_PROXY/);
 assert.throws(()=>createQuestService({gmTrustProxy:'10.1.1.20/40',walletClient:{}}),/LIDOLLQUEST_GM_TRUST_PROXY/);
});
