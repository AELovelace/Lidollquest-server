import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createQuestService} from '../server/service.mjs';

function fixture(){ // Players in one hub room, driven exactly as the client (and the companion applet) drive the gateway. Each player name doubles as its account owner.
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-30T12:00:00Z');const ids={},awards=[],blocked={}; // A Wednesday: the weekly window started Monday 2026-09-28.
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,grant:secret=>({id:secret,owner:secret,client:'lidollquest',blockedAccounts:blocked[secret]??[]}),wallet:()=>({coins:0}),adjust:(owner,asset,n,id,reason)=>awards.push({owner,n,id,reason}),diveOptions:{log:()=>{}}});
 const snap=(name,view)=>zones.read(name,ids[name],view);
 function command(name,action,extra={}){const s=snap(name);return {action,request_id:randomUUID(),controller:'window',character_id:ids[name],revision:s.character.revision,...extra};}
 function act(name,action,extra={}){time+=100;return zones.act(name,command(name,action,extra));}
 function player(name){const s=zones.act(name,{action:'create',name,controller:'window',request_id:randomUUID()});ids[name]=s.character.id;const r=act(name,'enter',{zone:'princess-rose',combat_version:3,loadout:{player_info:{class_id:'fighter',playerHealth:100,playerHealthMax:100,str:10,def:2,dex:8,int:5,cha:5,level:10,xp:0,stat_points:0},inventory:[],player_spells:[],player_mp:0,player_mp_max:0}});db.prepare('UPDATE quest_presence SET x=5,y=5 WHERE character_id=?').run(ids[name]);return r;}
 function settleCoins(name,paid=true){const id=snap(name).character.pendingPurchase;assert.ok(id,'a coin debit is pending');zones.completePurchase(id,paid);}
 function found(name,guild,tag){act(name,'guild_create',{name:guild,tag});settleCoins(name,true);return snap(name).guild;}
 function invite(from,to){act(from,'guild_invite',{member:ids[to]});return act(to,'guild_accept',{invitation:snap(to).guildInvitations[0].id});}
 const guild=name=>snap(name).guild;
 return {db,ids,awards,blocked,snap,act,player,settleCoins,found,invite,guild,zones,advance:ms=>{time+=ms;zones.tick();},now:()=>time,close:()=>db.close()};
}

test('founding a guild reserves the name, settles through the wallet and enforces unique names and tags',()=>{
 const f=fixture();try{
  for(const name of ['alice','bob','carol'])f.player(name);
  assert.equal(f.snap('alice').guildSupport,true);assert.equal(f.snap('alice').guildRules.fee,1000);assert.equal(f.snap('alice').guild,null);
  assert.throws(()=>f.act('alice','guild_create',{name:'Ni',tag:'NAP'}),/3 to 24/);
  assert.throws(()=>f.act('alice','guild_create',{name:'Night Nappers',tag:'toolong'}),/2 to 4/);
  f.act('alice','guild_create',{name:'Night Nappers',tag:'nap'});
  let g=f.guild('alice');assert.equal(g.status,'pending');assert.equal(g.tag,'NAP','tags are upper-cased');assert.ok(f.snap('alice').character.pendingPurchase);
  assert.throws(()=>f.act('bob','guild_create',{name:'night NAPPERS',tag:'ZZZ'}),/already uses that name/,'pending charters hold their name');
  assert.throws(()=>f.act('bob','guild_create',{name:'Other Guild',tag:'Nap'}),/already uses that tag/);
  assert.throws(()=>f.act('alice','guild_invite',{member:f.ids.bob}),/still settling/);
  f.settleCoins('alice',true);
  g=f.guild('alice');assert.equal(g.status,'active');assert.equal(g.rank,'leader');assert.equal(g.memberCap,30);assert.equal(g.members.length,1);assert.equal(g.members[0].online,true);
  assert.equal(g.treasury.ledger[0].kind,'create');assert.match(f.snap('alice').character.hubNotice,/is founded/);
  f.act('carol','guild_create',{name:'Other Guild',tag:'OTH'});f.settleCoins('carol',false);
  assert.equal(f.guild('carol'),null,'a declined fee founds nothing');assert.match(f.snap('carol').character.hubNotice,/Not enough LiDollCoins/);
  f.act('bob','guild_create',{name:'Other Guild',tag:'OTH'});assert.equal(f.guild('bob').status,'pending','a declined charter frees its name');
  f.zones.loot.tune({guild_create_fee:0},'test');
  f.act('carol','guild_create',{name:'Free Folk',tag:'FF'});assert.equal(f.guild('carol').status,'active','a zero fee founds immediately');assert.equal(f.snap('carol').character.pendingPurchase,undefined);
  assert.throws(()=>f.act('carol','guild_create',{name:'Second',tag:'SEC'}),/Leave your current guild/);
  assert.throws(()=>f.act('carol','guild_nonsense'),/Unknown guild action/);
  assert.throws(()=>f.zones.act('carol',{...f.act('carol','heartbeat')&&{},action:'guild_motd',request_id:randomUUID(),controller:'window',character_id:f.ids.carol,revision:f.snap('carol').character.revision,companion:'yes'}),/companion must be true or false/);
 }finally{f.close();}
});

test('invitations, applications, the member cap, blocks and expiry',()=>{
 const f=fixture();try{
  for(const name of ['alice','bob','carol','dave','erin'])f.player(name);
  f.found('alice','Night Nappers','NAP');
  assert.throws(()=>f.act('alice','guild_invite',{member:f.ids.alice}),/another player/);
  f.act('alice','guild_invite',{member:f.ids.bob});
  const inv=f.snap('bob').guildInvitations;assert.equal(inv.length,1);assert.equal(inv[0].name,'Night Nappers');assert.equal(inv[0].tag,'NAP');assert.equal(inv[0].sender,'alice');
  assert.equal(f.snap('bob').peers.find(p=>p.id===f.ids.alice).tag,'NAP','peers carry the guild tag');assert.equal(f.snap('alice').peers.find(p=>p.id===f.ids.bob).tag,'');
  f.act('bob','guild_accept',{invitation:inv[0].id});
  assert.equal(f.guild('bob').rank,'member');assert.equal(f.guild('alice').members.length,2);assert.equal(f.snap('bob').guildInvitations.length,0);
  f.act('alice','guild_invite',{name:'CAROL'});assert.equal(f.snap('carol').guildInvitations.length,1,'invite by name is case-insensitive');
  f.act('carol','guild_decline',{invitation:f.snap('carol').guildInvitations[0].id});assert.equal(f.snap('carol').guildInvitations.length,0);
  f.blocked.alice=['dave'];
  assert.throws(()=>f.act('alice','guild_invite',{member:f.ids.dave}),/unavailable/,'an inviter cannot reach an account on their block list');
  f.blocked.alice=[];f.act('alice','guild_invite',{member:f.ids.dave});f.blocked.dave=['alice']; // Now dave's own block list names alice.
  assert.throws(()=>f.act('dave','guild_apply',{tag:'NAP'}),/unavailable/,'nor can a player apply to a guild whose member they blocked');
  assert.equal(f.snap('dave').guildInvitations.length,0,'invitations from blocked accounts are hidden');
  assert.throws(()=>f.act('dave','guild_accept',{invitation:f.db.prepare('SELECT id FROM quest_guild_invites WHERE target=?').get(f.ids.dave).id}),/unavailable/);
  f.blocked.dave=[];
  f.act('carol','guild_apply',{name:'night nappers'});
  assert.equal(f.snap('carol').guildApplications.length,1);assert.equal(f.guild('alice').applications.length,1);assert.equal(f.guild('bob').applications.length,0,'members do not see applications');
  assert.throws(()=>f.act('bob','guild_approve',{application:f.guild('alice').applications[0].id}),/officers/);
  f.act('alice','guild_reject',{application:f.guild('alice').applications[0].id});assert.equal(f.snap('carol').guildApplications.length,0);
  f.act('alice','guild_settings',{mode:'closed'});assert.throws(()=>f.act('carol','guild_apply',{tag:'NAP'}),/not taking applications/);
  f.act('alice','guild_settings',{mode:'open'});f.act('carol','guild_apply',{tag:'nap'});f.act('alice','guild_approve',{application:f.guild('alice').applications[0].id});
  assert.equal(f.guild('carol').rank,'member');assert.equal(f.guild('alice').members.length,3);
  f.zones.loot.tune({guild_member_cap:3},'test');
  assert.throws(()=>f.act('alice','guild_invite',{member:f.ids.erin}),/full/);
  assert.throws(()=>f.act('erin','guild_apply',{tag:'NAP'}),/full/);
  assert.throws(()=>f.act('dave','guild_accept',{invitation:f.db.prepare('SELECT id FROM quest_guild_invites WHERE target=?').get(f.ids.dave).id}),/full/);
  f.zones.loot.tune({guild_member_cap:30},'test');
  f.advance(8*86400000);assert.equal(f.snap('dave').guildInvitations.length,0,'invitations expire after a week');
 }finally{f.close();}
});

test('ranks: officers manage the roster, only the leader promotes, transfers, disbands or upgrades',()=>{
 const f=fixture();try{
  for(const name of ['alice','bob','carol','dave'])f.player(name);
  f.found('alice','Night Nappers','NAP');for(const name of ['bob','carol','dave'])f.invite('alice',name);
  assert.throws(()=>f.act('bob','guild_motd',{text:'hi'}),/officers/);
  assert.throws(()=>f.act('bob','guild_kick',{member:f.ids.carol}),/officers/);
  assert.throws(()=>f.act('bob','guild_promote',{member:f.ids.carol}),/leader/);
  f.act('alice','guild_promote',{member:f.ids.bob});assert.equal(f.guild('bob').rank,'officer');
  f.act('bob','guild_motd',{text:'  Nap  time \u0007 everyone  '});assert.equal(f.guild('carol').motd,'Nap time everyone','officers edit the MOTD; control characters and doubled spaces are cleaned');
  assert.throws(()=>f.act('bob','guild_promote',{member:f.ids.carol}),/leader/);
  f.act('alice','guild_promote',{member:f.ids.carol});
  assert.throws(()=>f.act('bob','guild_kick',{member:f.ids.carol}),/below your rank/,'officers cannot remove officers');
  f.act('bob','guild_kick',{member:f.ids.dave});assert.equal(f.guild('dave'),null);assert.equal(f.guild('alice').members.length,3);
  f.act('alice','guild_demote',{member:f.ids.carol});assert.equal(f.guild('carol').rank,'member');
  assert.throws(()=>f.act('alice','guild_leave'),/Transfer leadership or disband/);
  f.act('alice','guild_transfer',{member:f.ids.bob});
  assert.equal(f.guild('bob').rank,'leader');assert.equal(f.guild('alice').rank,'officer');assert.equal(f.guild('carol').leader,f.ids.bob);
  assert.equal(f.guild('carol').members[0].rank,'leader','the roster lists the leader first');
  f.act('alice','guild_leave');assert.equal(f.guild('alice'),null);
  f.act('carol','guild_leave');
  assert.throws(()=>f.act('carol','guild_disband'),/not in a guild/);
  f.act('bob','guild_leave');assert.equal(f.guild('bob'),null,'the last member leaving disbands the guild');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM quest_guilds').get().n,0);
  assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM quest_guild_ledger').get().n>0,'the ledger survives as an audit trail');
  f.found('dave','Solo Club','SOLO');f.invite('dave','alice');f.act('dave','guild_disband');assert.equal(f.guild('alice'),null);assert.equal(f.guild('dave'),null);
 }finally{f.close();}
});

test('treasury: donations settle through the wallet, upgrades spend guild coins only, refunds when the guild is gone',()=>{
 const f=fixture();try{
  for(const name of ['alice','bob'])f.player(name);
  f.found('alice','Night Nappers','NAP');f.invite('alice','bob');
  assert.throws(()=>f.act('bob','guild_donate',{amount:0}),/between 1 and/);
  assert.throws(()=>f.act('bob','guild_donate',{amount:12.5}),/between 1 and/);
  f.act('bob','guild_donate',{amount:100});assert.ok(f.snap('bob').character.pendingPurchase);
  assert.throws(()=>f.act('bob','guild_donate',{amount:5}),/still settling/);
  f.settleCoins('bob',true);
  let g=f.guild('alice');assert.equal(g.treasury.balance,100);assert.equal(g.treasury.ledger[0].kind,'donation');assert.equal(g.treasury.ledger[0].amount,100);assert.equal(g.treasury.ledger[0].name,'bob');
  assert.equal(g.members.find(m=>m.id===f.ids.bob).donated,100);assert.match(f.snap('bob').character.hubNotice,/Donated 100/);
  f.act('alice','guild_donate',{amount:50});f.settleCoins('alice',false);assert.equal(f.guild('alice').treasury.balance,100,'a declined donation adds nothing');
  assert.throws(()=>f.act('bob','guild_upgrade',{kind:'cap'}),/leader/);
  assert.throws(()=>f.act('alice','guild_upgrade',{kind:'cap'}),/treasury needs 2000/);
  assert.throws(()=>f.act('alice','guild_upgrade',{kind:'wings'}),/member cap, MOTD length or crest/);
  f.act('alice','guild_donate',{amount:4000});f.settleCoins('alice',true);assert.equal(f.guild('alice').treasury.balance,4100);
  f.act('alice','guild_upgrade',{kind:'cap'});g=f.guild('bob');assert.equal(g.memberCap,35);assert.equal(g.treasury.balance,2100);assert.equal(g.upgrades.cap,1);assert.equal(g.treasury.ledger[0].amount,-2000);
  assert.throws(()=>f.act('alice','guild_crest',{value:'#ff00aa'}),/crest upgrade/);
  f.act('alice','guild_upgrade',{kind:'crest'});f.act('alice','guild_crest',{value:'#FF00AA'});assert.equal(f.guild('bob').crest,'#ff00aa');
  assert.throws(()=>f.act('alice','guild_crest',{value:'pink'}),/#rrggbb/);
  f.act('alice','guild_upgrade',{kind:'motd'});assert.equal(f.guild('alice').upgrades.motdLength,480);assert.equal(f.guild('alice').treasury.balance,100);
  assert.deepEqual(f.awards,[],'no wallet credit so far');
  f.act('bob','guild_donate',{amount:30});const pending=f.snap('bob').character.pendingPurchase;
  f.act('alice','guild_kick',{member:f.ids.bob});
  f.zones.completePurchase(pending,true);
  assert.deepEqual(f.awards.map(a=>[a.owner,a.n,a.reason]),[['bob',30,'Guild donation returned']],'a donation that lands after leaving is refunded');
  assert.match(f.snap('bob').character.hubNotice,/returned/);
 }finally{f.close();}
});

test('guild chat: a scoped stream members read anywhere, posted with or without a zone presence',()=>{
 const f=fixture();try{
  for(const name of ['alice','bob','carol'])f.player(name);
  assert.throws(()=>f.act('alice','chat',{text:'hello?',channel:'guild'}),/Join a guild/);
  f.found('alice','Night Nappers','NAP');f.invite('alice','bob');
  f.act('alice','chat',{text:'hello guild',channel:'guild'});
  assert.deepEqual(f.snap('bob').guildChat.map(r=>[r.name,r.text,r.channel]),[['alice','hello guild','guild']]);
  assert.equal(f.snap('carol').guildChat.length,0);assert.equal(f.snap('carol').chat.length,0,'guild lines never reach the room');
  assert.throws(()=>f.act('carol','chat',{text:'let me in',channel:'guild'}),/Join a guild/);
  f.db.prepare('DELETE FROM quest_presence WHERE character_id=?').run(f.ids.bob); // Bob is offline: the companion applet still speaks for him.
  f.act('bob','guild_chat',{text:'/me waves from the tracker'});
  const rows=f.snap('alice').guildChat;assert.equal(rows.length,2);assert.equal(rows[1].text,'waves from the tracker');assert.equal(rows[1].emote,true);
  assert.throws(()=>f.act('bob','guild_chat',{text:'/dance'}),/Unknown chat command/);
  assert.throws(()=>f.act('carol','guild_chat',{text:'psst'}),/Join a guild/);
  f.act('bob','guild_chat',{text:'/me waves from the tracker'});assert.equal(f.snap('alice').guildChat.length,2,'an echoed line is not stored twice');
  f.act('alice','chat',{text:'room line'});assert.equal(f.snap('bob').guildChat.length,2);
 }finally{f.close();}
});

test('weekly goal: points from dives, quests and accidents; the rollover pays each member account once under the daily cap',()=>{
 const f=fixture();try{
  for(const name of ['alice','bob','carol'])f.player(name);
  f.zones.loot.tune({guild_goal_target:5,guild_goal_reward:150},'test');
  f.found('alice','Night Nappers','NAP');f.invite('alice','bob');
  assert.equal(f.zones.guilds.progress(f.ids.carol,'dive'),false,'guildless characters score nothing');
  assert.equal(f.zones.guilds.progress(f.ids.alice,'dive'),true);
  let goal=f.guild('bob').goal;assert.equal(goal.points,3);assert.equal(goal.dives,1);assert.equal(goal.target,5);assert.equal(goal.reward,150);assert.equal(goal.lastWeek,null);
  f.zones.guilds.progress(f.ids.bob,'quest');f.zones.guilds.progress(f.ids.bob,'accident');
  goal=f.guild('alice').goal;assert.equal(goal.points,6);assert.equal(goal.quests,1);assert.equal(goal.accidents,1);
  f.zones.loot.tune({guild_goal_target:99},'test');assert.equal(f.guild('alice').goal.target,5,'the target froze when the week began');
  const board=f.snap('carol').guildLeaderboard;assert.equal(board.length,1);assert.equal(board[0].tag,'NAP');assert.equal(board[0].points,6);assert.equal(board[0].members,2);
  f.found('carol','Free Folk','FF');assert.equal(f.snap('carol').guildLeaderboard.length,2);assert.equal(f.snap('carol').guildLeaderboard[1].tag,'FF');
  f.advance(7*86400000); // Next Wednesday: last week closed.
  assert.deepEqual(f.awards.map(a=>[a.owner,a.n,a.reason]).sort(),[['alice',150,'Guild goal: Night Nappers'],['bob',150,'Guild goal: Night Nappers']]);
  assert.equal(new Set(f.awards.map(a=>a.id)).size,2,'idempotent outbox ids per guild, week and account');
  goal=f.guild('alice').goal;assert.equal(goal.points,0);assert.deepEqual(goal.lastWeek,{points:6,target:5,reward:150,met:true,paid:true});
  assert.equal(f.guild('alice').treasury.ledger[0].kind,'goal_reward');
  f.advance(31000);assert.equal(f.awards.length,2,'a paid week never pays twice');
  assert.equal(f.db.prepare('SELECT coins FROM quest_reward_days WHERE owner=?').get('alice').coins,150,'the payout counts toward the daily earnings cap');
 }finally{f.close();}
});

test('companion view carries the guild, deleted leaders are replaced and gamemaster tools rename, transfer and disband',()=>{
 const f=fixture();try{
  for(const name of ['alice','bob','carol'])f.player(name);
  f.found('alice','Night Nappers','NAP');f.invite('alice','bob');f.invite('alice','carol');f.act('alice','guild_promote',{member:f.ids.carol});
  f.act('bob','chat',{text:'companion test',channel:'guild'});
  const view=f.snap('alice',{companion:true});
  assert.equal(view.guild.tag,'NAP');assert.equal(view.guildChat.length,1);assert.equal(view.guildRules.fee,1000);assert.equal(view.zones,undefined,'the slim view has no geometry');
  assert.equal(JSON.stringify(view).includes('"owner"'),false,'no account ids leak');
  const list=f.zones.guilds.gm.list('nap');assert.equal(list.length,1);assert.equal(list[0].leaderName,'alice');assert.equal(list[0].members,3);
  const renamed=f.zones.guilds.gm.rename(list[0].id,{name:'Nap Squad',tag:'NPS'});assert.equal(renamed.to.tag,'NPS');assert.equal(f.guild('bob').name,'Nap Squad');
  assert.throws(()=>f.zones.guilds.gm.rename(list[0].id,{name:'Nap Squad',tag:'X'}),/2 to 4/);
  f.zones.guilds.gm.transfer(list[0].id,f.ids.bob);assert.equal(f.guild('bob').rank,'leader');assert.equal(f.guild('alice').rank,'officer');
  f.zones.guilds.gm.adjust(list[0].id,500,'test grant');assert.equal(f.guild('bob').treasury.balance,500);
  for(const table of ['quest_guild_members','quest_presence'])f.db.prepare(`DELETE FROM ${table} WHERE character_id=?`).run(f.ids.bob);f.db.prepare('DELETE FROM quest_characters WHERE id=?').run(f.ids.bob); // What character-management.mjs does on delete.
  f.advance(31000);
  assert.equal(f.guild('alice').rank,'leader','the most senior officer inherits a deleted leader\'s guild');assert.equal(f.guild('carol').rank,'officer');assert.equal(f.guild('carol').members.length,2);
  const gone=f.zones.guilds.gm.disband(list[0].id);assert.equal(gone.members,2);assert.equal(f.guild('alice'),null);assert.equal(f.snap('alice').guildLeaderboard.length,0);
  assert.throws(()=>f.zones.guilds.gm.detail(list[0].id),/No such guild/);
 }finally{f.close();}
});

const staffToken='s'.repeat(43),staff='a'.repeat(64),playerToken='p'.repeat(43),owner='o'.repeat(64); // A gamemaster LiDollID and an ordinary player, as in announcements.test.mjs.
const httpLoadout={player_info:{playerHealth:50,playerHealthMax:50,level:2,str:10,def:10,dex:10,int:10,cha:2},inventory:[],player_spells:[]};
function harness(){ // Drives the player gateway and the /gm panel over HTTP exactly as the game, the companion applet and the browser do.
 let now=Date.parse('2026-09-30T12:00:00Z');
 const accounts={[staffToken]:{owner:staff,gamemaster:true},[playerToken]:{owner,gamemaster:false}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant-'+a.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({now:()=>now,walletClient,gmEnabled:true});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const held={},base=()=>'http://127.0.0.1:'+service.server.address().port;
 async function play(secret,action,extra={}){
  now+=500;
  const body={action,character_id:held[secret]?.id,revision:held[secret]?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch(base()+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(result.character)held[secret]=result.character;
  return {status:response.status,result};
 }
 const ok=async(secret,action,extra={})=>{const r=await play(secret,action,extra);assert.equal(r.status,200,JSON.stringify(r.result));return r.result;};
 const join=async(secret,name,zone)=>{await ok(secret,'create',{name});return ok(secret,'enter',{zone,loadout:httpLoadout,quest_version:1,content_version:1,combat_version:3});};
 const gm=async(path,init={})=>{const response=await fetch(base()+path,{method:init.method??'GET',headers:{Authorization:'Bearer '+(init.token??staffToken),...(init.body?{'Content-Type':'application/json'}:{})},body:init.body?JSON.stringify(init.body):undefined});return {status:response.status,body:await response.json().catch(()=>({}))};};
 const act=(action,payload={},init={})=>gm('/gm/action',{method:'POST',body:{action,...payload},...init});
 const audit=action=>service.db.prepare('SELECT * FROM gm_audit WHERE action=?').all(action);
 return {service,started,play,ok,join,gm,act,audit,close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('over HTTP: companion:true returns the slim view, and the /gm panel lists, renames, transfers, adjusts and disbands guilds with audit rows',async()=>{
 const h=harness();await h.started;try{
  assert.equal((await h.act('loot_tune',{tuning:{guild_create_fee:0},reason:'test'})).status,200); // No wallet in this harness: found for free.
  await h.join(playerToken,'alice','princess-rose');
  const created=await h.ok(playerToken,'guild_create',{name:'Night Nappers',tag:'NAP',companion:true});
  assert.equal(created.guild.tag,'NAP');assert.equal(created.zones,undefined,'companion:true answers with the slim companion view');assert.ok('sheet' in created);assert.equal(created.capabilities.guilds,true);
  const full=await h.ok(playerToken,'guild_motd',{text:'Nap time'});assert.ok(Array.isArray(full.zones),'without the flag the game keeps its full snapshot');assert.equal(full.guild.motd,'Nap time');
  assert.equal((await h.play(playerToken,'guild_motd',{text:'x',companion:'yes'})).status,400);
  assert.notEqual((await h.gm('/gm/guilds',{token:playerToken})).status,200,'players cannot read the panel');
  const list=await h.gm('/gm/guilds?q=nap');assert.equal(list.status,200,JSON.stringify(list.body));assert.equal(list.body.guilds.length,1);assert.equal(list.body.guilds[0].leaderName,'alice');assert.equal(list.body.tuning.guild_create_fee,0);
  const id=list.body.guilds[0].id,detail=await h.gm('/gm/guilds?id='+id);assert.equal(detail.body.detail.members.length,1);assert.equal(detail.body.detail.motd,'Nap time');
  const renamed=await h.act('guild_rename',{id,name:'Nap Squad',tag:'NPS',reason:'test'});assert.equal(renamed.status,200,JSON.stringify(renamed.body));assert.equal(renamed.body.result.to.tag,'NPS');assert.equal(h.audit('guild_rename').length,1);
  assert.equal((await h.act('guild_rename',{id,name:'Nap Squad',tag:'X'})).status,400);
  assert.equal((await h.act('guild_motd_clear',{id})).status,200);assert.equal((await h.ok(playerToken,'heartbeat')).guild.motd,'');
  const money=await h.act('guild_treasury',{id,amount:250,note:'test'});assert.equal(money.body.result.balance,250);assert.equal(h.audit('guild_treasury').length,1);
  const gone=await h.act('guild_disband',{id,reason:'test'});assert.equal(gone.status,200);assert.equal(gone.body.result.balance,250);assert.equal(h.audit('guild_disband').length,1);
  assert.equal((await h.ok(playerToken,'heartbeat')).guild,null);
  assert.equal((await h.gm('/gm/guilds?id='+id)).status,404);
 }finally{await h.close();}
});
