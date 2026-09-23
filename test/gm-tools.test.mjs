import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

const staffToken='s'.repeat(43),staff='a'.repeat(64);  // A LiDollID account holding the gamemaster role.
const playerToken='p'.repeat(43),owner='o'.repeat(64); // An ordinary player.
const helperToken='h'.repeat(43),helper='b'.repeat(64);  // A second gamemaster, used to stand inside a Dive.
const loadout={player_info:{playerHealth:50,playerHealthMax:50,level:2,str:10,def:10,dex:10,int:10,cha:2},inventory:[],player_spells:[]};

function harness(){ // Drives the ordinary /zones/action gateway exactly as the game client does.
 let now=Date.parse('2026-09-21T12:00:00Z');
 const accounts={[staffToken]:{owner:staff,gamemaster:true},[playerToken]:{owner,gamemaster:false},[helperToken]:{owner:helper,gamemaster:true}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant-'+a.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({now:()=>now,walletClient});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const held={};
 async function play(secret,action,extra={}){
  now+=500;
  const body={action,character_id:held[secret]?.id,revision:held[secret]?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch('http://127.0.0.1:'+service.server.address().port+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(result.character)held[secret]=result.character;
  return {status:response.status,result};
 }
 const ok=async(secret,action,extra={})=>{const r=await play(secret,action,extra);assert.equal(r.status,200,JSON.stringify(r.result));return r.result;};
 const join=async(secret,name,zone)=>{await ok(secret,'create',{name});return ok(secret,'enter',{zone,loadout,quest_version:1,content_version:1,combat_version:3});};
 const audit=action=>service.db.prepare('SELECT * FROM gm_audit WHERE action=?').all(action);
 return {service,started,play,ok,join,audit,held,
  close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('only gamemaster accounts see the flag and can use GM tools, without losing their session',async()=>{
 const h=harness();await h.started;
 try{
  const player=await h.join(playerToken,'Player','honeydew-lantern');
  assert.equal(player.gamemaster,false);
  for(const action of ['gm_catalog','gm_warp_zone','gm_zone_reload']){
   const r=await h.play(playerToken,action,{zone:'littlebig-clockwork-shops'});
   assert.equal(r.status,409,action);assert.equal(r.result.error,'gm_not_gamemaster'); // 409, never 401/403, so the client does not drop its sign-in.
  }
  assert.equal((await h.ok(playerToken,'heartbeat')).zone,'honeydew-lantern'); // Still playing normally afterwards.
  assert.equal((await h.join(staffToken,'Staff','honeydew-lantern')).gamemaster,true);
 }finally{await h.close();}
});

test('the catalogue lists online players and warpable rooms only',async()=>{
 const h=harness();await h.started;
 try{
  await h.join(playerToken,'Player','princess-rose');await h.join(staffToken,'Staff','honeydew-lantern');
  const before=h.held[staffToken].revision;
  const {receipt}=await h.ok(staffToken,'gm_catalog');
  assert.equal(receipt.action,'gm_catalog');
  assert.deepEqual(receipt.gm.players.map(p=>[p.name,p.zone,p.self]).sort(),[['Player','princess-rose',false],['Staff','honeydew-lantern',true]]);
  assert.ok(receipt.gm.zones.some(z=>z.id==='littlebig-clockwork-shops'));
  assert.ok(!receipt.gm.zones.some(z=>z.kind==='chat')); // Global chat is never a destination.
  assert.ok(receipt.gm.zones.some(z=>z.id==='dive-quarters')); // Shared weekly Dives are, once their floor exists.
  assert.equal(h.held[staffToken].revision,before); // Reading the list never changes the character.
 }finally{await h.close();}
});

test('warp to zone moves the GM, keeps annex bookkeeping, refuses non-rooms and is audited',async()=>{
 const h=harness();await h.started;
 try{
  await h.join(staffToken,'Staff','honeydew-lantern');
  assert.equal((await h.play(staffToken,'gm_warp_zone',{zone:'global:ooc'})).result.error,'gm_zone_not_warpable');
  assert.equal((await h.play(staffToken,'gm_warp_zone',{zone:'nowhere'})).result.error,'gm_unknown_zone');
  const moved=await h.ok(staffToken,'gm_warp_zone',{zone:'littlebig-clockwork-shops'});
  assert.equal(moved.zone,'littlebig-clockwork-shops');
  assert.equal(moved.character.hubVisit,'littlebig-clockwork-shops'); // Reconnects resume in the annex, exactly as if the GM had walked in.
  const exit=moved.zones.find(z=>z.id==='littlebig-clockwork-shops').exit;
  assert.ok(moved.position.x!==exit.x||moved.position.y!==exit.y); // Never land on the exit tile, which would bounce the client back to the campaign.
  const back=await h.ok(staffToken,'gm_warp_zone',{zone:'princess-rose'});
  assert.equal(back.zone,'princess-rose');assert.equal(back.character.hubVisit,undefined);
  assert.equal(h.audit('gm_warp_zone').length,2);
 }finally{await h.close();}
});

test('warp to player lands beside them; summon brings them over and forces their refresh',async()=>{
 const h=harness();await h.started;
 try{
  await h.join(playerToken,'Player','princess-rose');await h.join(staffToken,'Staff','honeydew-lantern');
  const target=h.held[playerToken].id;
  const warped=await h.ok(staffToken,'gm_warp_player',{target});
  assert.equal(warped.zone,'princess-rose');
  const them=warped.peers.find(p=>p.id===target);
  assert.ok(Math.abs(them.x-warped.position.x)+Math.abs(them.y-warped.position.y)<=6);
  assert.equal((await h.play(staffToken,'gm_warp_player',{target:h.held[staffToken].id})).result.error,'gm_unknown_player'); // Not yourself.

  await h.ok(staffToken,'gm_warp_zone',{zone:'honeydew-lantern'});
  const stale=h.held[playerToken].revision;
  await h.ok(staffToken,'gm_summon',{target});
  const refused=await h.play(playerToken,'move',{direction:'north'});
  assert.equal(refused.status,409); // Their old revision cannot act in the room they left.
  h.held[playerToken].revision=stale+1;
  const arrived=await h.ok(playerToken,'heartbeat');
  assert.equal(arrived.zone,'honeydew-lantern');
  assert.match(arrived.character.hubNotice,/gamemaster brought you/);
  assert.equal(h.audit('gm_summon').length,1);
 }finally{await h.close();}
});

test('quest tools start, advance, complete and reset without bypassing the normal reward claim',async()=>{
 const h=harness();await h.started;
 try{
  const live=h.service.live;
  live.change({action:'content_publish',kind:'npc',id:'guide_npc',revision:0,entry:{id:'guide_npc',name:'Guide',description:'A guide',dialogue:[{id:'hello',text:'Hi',next:'close',actions:[]}],quests:[]}},'dm');
  live.change({action:'content_publish',kind:'quest',id:'gm_test',revision:0,entry:{id:'gm_test',name:'GM test',description:'Two stages',givers:['guide_npc'],turn_in:{mode:'journal'},
   stages:[{id:'wait',objectives:[{id:'wait',type:'timer',count:100000}],next:'talk'},{id:'talk',objectives:[{id:'talk',type:'talk',target:'guide_npc',count:1}],next:'complete'}],rewards:{xp:1,coins:0,rpp:2}}},'dm');
  await h.join(staffToken,'Staff','honeydew-lantern');
  const quest=s=>s.onlineQuests.instances.find(q=>q.quest==='gm_test');

  assert.equal((await h.ok(staffToken,'gm_catalog')).receipt.gm.quests.find(q=>q.id==='gm_test').status,'');
  assert.equal(quest(await h.ok(staffToken,'gm_quest_start',{quest:'gm_test'})).stage,'wait'); // No NPC conversation required.
  assert.equal((await h.play(staffToken,'gm_quest_start',{quest:'gm_test'})).status,409);
  assert.equal(quest(await h.ok(staffToken,'gm_quest_advance',{quest:'gm_test'})).stage,'talk');
  const ready=quest(await h.ok(staffToken,'gm_quest_complete',{quest:'gm_test'}));
  assert.equal(ready.status,'ready');
  assert.equal(h.service.db.prepare('SELECT COUNT(*) AS n FROM online_quest_claims').get().n,0); // Completing never pays out by itself.
  const claimed=await h.ok(staffToken,'quest_claim',{quest:'gm_test',quest_revision:ready.revision});
  assert.equal(quest(claimed).status,'claimed');

  const reset=await h.ok(staffToken,'gm_quest_reset',{quest:'gm_test'});
  assert.equal(quest(reset),undefined);
  assert.equal((await h.ok(staffToken,'gm_catalog')).receipt.gm.quests.find(q=>q.id==='gm_test').status,'');
  assert.equal(quest(await h.ok(staffToken,'gm_quest_start',{quest:'gm_test'})).status,'active'); // A once-only quest can be tested again.
  assert.equal(h.audit('gm_quest_start').length,2);
 }finally{await h.close();}
});

test('zone reload drops cached content and is audited',async()=>{
 const h=harness();await h.started;
 try{
  await h.join(staffToken,'Staff','honeydew-lantern');
  const result=await h.ok(staffToken,'gm_zone_reload');
  assert.equal(result.receipt.action,'gm_zone_reload');
  assert.match(result.character.hubNotice,/Reloaded/);
  assert.equal(h.audit('gm_zone_reload').length,1);
 }finally{await h.close();}
});

test('GM warps enter shared Dives with a real visit, join players there and walk back out',async()=>{
 const h=harness();await h.started;
 try{
  await h.join(staffToken,'Staff','princess-rose');await h.join(helperToken,'Helper','honeydew-lantern');await h.join(playerToken,'Player','honeydew-lantern');
  const inside=await h.ok(staffToken,'gm_warp_zone',{zone:'dive-quarters'});
  assert.equal(inside.zone,'dive-quarters');
  assert.equal(inside.character.dive.origin,'princess-rose'); // The hub the GM warped from is the Dive's way home.
  assert.ok(inside.dive.edition);
  const start={...inside.position};
  let moved=null; // Prove the visit is playable: at least one ordinary step succeeds on the shared floor.
  for(const direction of ['north','south','east','west']){const r=await h.play(staffToken,'move',{direction,edition:inside.dive.edition});if(r.status===200){moved=r.result;break;}}
  assert.ok(moved,'No open step beside the Dive arrival tile.');
  assert.notDeepEqual(moved.position,start);

  const joined=await h.ok(helperToken,'gm_warp_player',{target:h.held[staffToken].id}); // Warp to someone who is inside a Dive.
  assert.equal(joined.zone,'dive-quarters');
  assert.equal(joined.character.dive.edition,moved.character.dive.edition); // Same shared weekly floor, not a copy.
  assert.ok(joined.peers.some(p=>p.id===h.held[staffToken].id)); // They can see each other.
  assert.equal(joined.character.dive.returnZone,moved.character.dive.returnZone); // Shares the way back.

  assert.equal((await h.play(staffToken,'gm_summon',{target:h.held[playerToken].id})).result.error,'gm_zone_not_warpable'); // No pulling players into a Dive.
  const out=await h.ok(staffToken,'gm_warp_zone',{zone:'honeydew-lantern'});
  assert.equal(out.zone,'honeydew-lantern');assert.equal(out.character.dive,null); // Left cleanly; the next reconnect resumes in the hub.
  assert.equal((await h.play(staffToken,'gm_summon',{target:h.held[helperToken].id})).result.error,'gm_tool_rejected'); // Summon never lifts someone out of a Dive either.
 }finally{await h.close();}
});

test('branch Dives are entered along the trail from their parent',async()=>{
 const h=harness();await h.started;
 try{
  await h.join(staffToken,'Staff','princess-rose');
  const listed=(await h.ok(staffToken,'gm_catalog')).receipt.gm.zones.map(z=>z.id);
  assert.ok(listed.includes('dive-taiga')); // Its weekly floor is generated at startup like every other route.
  const taiga=await h.ok(staffToken,'gm_warp_zone',{zone:'dive-taiga'});
  assert.equal(taiga.zone,'dive-taiga');
  assert.equal(taiga.character.dive.origin,'dive-tundra');
  assert.equal(taiga.character.dive.hubEntryZone,'dive-tundra');
  assert.equal(taiga.character.dive.hubOrigin,'princess-rose'); // The client uses this to pick the campaign hub to return to.
 }finally{await h.close();}
});

test('in-game chat moderation lists the area, removes one line or clears everything, and is audited',async()=>{
 const h=harness();await h.started;
 try{
  await h.join(playerToken,'Player','honeydew-lantern');await h.join(staffToken,'Staff','honeydew-lantern');
  await h.ok(playerToken,'chat',{text:'first'});await h.ok(playerToken,'chat',{text:'second'});
  let {receipt}=await h.ok(staffToken,'gm_catalog');
  assert.equal(receipt.gm.chatArea,'honeydew-lantern');assert.deepEqual(receipt.gm.chat.map(m=>m.text),['first','second']);
  const denied=await h.play(playerToken,'gm_chat_clear');assert.equal(denied.status,409);assert.equal(denied.result.error,'gm_not_gamemaster');
  assert.equal((await h.play(staffToken,'gm_chat_delete',{seq:0})).status,400);
  const removed=await h.ok(staffToken,'gm_chat_delete',{seq:receipt.gm.chat[0].seq});assert.match(removed.character.hubNotice,/Removed a line by Player/);
  assert.equal((await h.play(staffToken,'gm_chat_delete',{seq:receipt.gm.chat[0].seq})).status,404);
  ({receipt}=await h.ok(staffToken,'gm_catalog'));assert.deepEqual(receipt.gm.chat.map(m=>m.text),['second']);
  assert.deepEqual((await h.ok(playerToken,'heartbeat')).chat.map(m=>m.text),['second']);
  const cleared=await h.ok(staffToken,'gm_chat_clear');assert.match(cleared.character.hubNotice,/Cleared 1 message from/);
  assert.equal((await h.ok(playerToken,'heartbeat')).chat.length,0);
  assert.equal(h.audit('delete_chat').length,1);assert.equal(h.audit('clear_chat').length,1);
 }finally{await h.close();}
});
