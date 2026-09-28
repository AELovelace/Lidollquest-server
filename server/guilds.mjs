// Guilds (2026-09-28): persistent player groups that outlive a session. Membership is per CHARACTER, exactly like
// parties, so a player's alts may sit in different guilds. Unlike parties nothing here needs a zone presence lease:
// the omo-trainer companion applet manages a guild from the browser with the same `guild_*` zone actions the game
// sends. Money never moves inside this module directly - the charter fee and donations are `hub_purchases` rows the
// wallet settles (settle() below), payouts are `adjust()` outbox rows - and the tracker stays the only wallet.
import {randomUUID,createHash} from 'node:crypto';
import {weeklyWindow} from './dive-generation.mjs'; // UTC-Monday weeks, shared with the weekly Dive editions.
import {currentTuning} from './combat.mjs';         // Live loot tuning (fees, caps, goal targets) edited on the /gm Loot tab.

const CONTROL=/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g; // Control and bidi characters never reach a stored name, tag or MOTD.
const fail=(message,status=409,code='guild_conflict')=>{throw Object.assign(Error(message),{status,code});}; // 409 like parties: the client shows the text and keeps the session.
export const GUILD_RANKS=Object.freeze({leader:3,officer:2,member:1}); // Higher outranks lower; the permission matrix lives in act().
export const GUILD_LIMITS=Object.freeze({nameMin:3,nameMax:24,tagMin:2,tagMax:4,motdBase:240,chat:240,inviteTtl:7*86400000,applicationTtl:14*86400000,invitesPerGuild:20,applicationsPerCharacter:3,pendingTtl:15*60000,ledgerRows:30,capStep:5,capUpgradesMax:4,motdUpgradesMax:2,donationMax:100000,donationPresets:[100,500,1000],leaderboardRows:20}); // Fixed rules; the tunable numbers are in DEFAULTS.
const DEFAULTS=Object.freeze({guild_create_fee:1000,guild_member_cap:30,guild_cap_upgrade_price:2000,guild_motd_upgrade_price:500,guild_crest_upgrade_price:1500,guild_goal_target:50,guild_goal_reward:150,guild_goal_points_dive:3,guild_goal_points_quest:2,guild_goal_points_accident:1}); // Fallbacks when a tuning key is missing or malformed; loot.mjs DEFAULT_TUNING carries the same numbers.
export const GUILD_TUNING_KEYS=Object.freeze(Object.keys(DEFAULTS));
const GOAL_KINDS=Object.freeze(['dive','quest','accident']); // What progress() accepts: a cleared Dive boss, a turned-in online quest, an accident survived in public.
const ONLINE_WINDOW=30000; // Presence freshness, the same 30 s every other module uses.
const NAME_RE=/^[\p{L}\p{N} '\-]+$/u,TAG_RE=/^[A-Z0-9]{2,4}$/,CREST_RE=/^#[0-9a-f]{6}$/i;

export function createGuilds(db,{now=Date.now,adjust=()=>{},tuning=currentTuning,dailyCap=()=>9999}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_guilds(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,tag TEXT NOT NULL,tag_key TEXT NOT NULL UNIQUE,leader TEXT NOT NULL,motd TEXT NOT NULL DEFAULT '',crest TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',open INTEGER NOT NULL DEFAULT 1,balance INTEGER NOT NULL DEFAULT 0,cap_upgrades INTEGER NOT NULL DEFAULT 0,motd_upgrades INTEGER NOT NULL DEFAULT 0,crest_upgrade INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS quest_guild_members(character_id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,rank TEXT NOT NULL,joined INTEGER NOT NULL,donated INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS quest_guild_roster ON quest_guild_members(guild_id,joined);
 CREATE TABLE IF NOT EXISTS quest_guild_invites(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,sender TEXT NOT NULL,target TEXT NOT NULL,expires INTEGER NOT NULL,UNIQUE(guild_id,target));
 CREATE TABLE IF NOT EXISTS quest_guild_applications(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,character_id TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,UNIQUE(guild_id,character_id));
 CREATE TABLE IF NOT EXISTS quest_guild_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,character_id TEXT,name TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS quest_guild_ledger_guild ON quest_guild_ledger(guild_id,id);
 CREATE TABLE IF NOT EXISTS quest_guild_weeks(guild_id TEXT NOT NULL,week INTEGER NOT NULL,points INTEGER NOT NULL DEFAULT 0,dives INTEGER NOT NULL DEFAULT 0,quests INTEGER NOT NULL DEFAULT 0,accidents INTEGER NOT NULL DEFAULT 0,target INTEGER NOT NULL,reward INTEGER NOT NULL,paid INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guild_id,week));`); // status: pending (charter fee unsettled) | active. name_key/tag_key are lower-case for case-insensitive uniqueness. Ledger kinds: create|donation|upgrade_cap|upgrade_motd|upgrade_crest|goal_reward|gm_adjust.
 let nameFilter=()=>true,revisionCounter=0,lastTick=0,tagCache={rev:-1,map:new Map()},boardCache={rev:-1,at:0,rows:[]}; // revisionCounter changes on every guild mutation in this process, so the tag map and leaderboard memos know when to rebuild.
 const clean=(value,max)=>typeof value==='string'?value.replace(CONTROL,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
 const knob=key=>{const n=Number(tuning()?.[key]);return Number.isFinite(n)&&n>=0?n:DEFAULTS[key];}; // One tuning read; a malformed override falls back to the shipped default.
 const whole=key=>Math.floor(knob(key));
 const week=()=>weeklyWindow(now());
 const guildRow=id=>db.prepare('SELECT * FROM quest_guilds WHERE id=?').get(id??'');
 const membership=characterId=>db.prepare('SELECT m.*,g.status FROM quest_guild_members m JOIN quest_guilds g ON g.id=m.guild_id WHERE m.character_id=?').get(characterId??''); // The character's one membership row (plus the guild's status), or undefined.
 const character=id=>db.prepare('SELECT * FROM quest_characters WHERE id=?').get(id??'');
 const rankOf=m=>GUILD_RANKS[m?.rank]??0;
 const atLeast=(m,rank)=>rankOf(m)>=GUILD_RANKS[rank];
 const bump=id=>{db.prepare('UPDATE quest_guilds SET revision=revision+1 WHERE id=?').run(id);revisionCounter++;}; // Every mutation: invalidates memos and lets the GM panel spot changes.
 const capOf=g=>whole('guild_member_cap')+g.cap_upgrades*GUILD_LIMITS.capStep;
 const motdMax=g=>GUILD_LIMITS.motdBase*(1+g.motd_upgrades);
 const count=id=>db.prepare('SELECT COUNT(*) AS n FROM quest_guild_members WHERE guild_id=?').get(id).n;
 const online=seen=>(seen??0)>now()-ONLINE_WINDOW;
 const roster=id=>db.prepare("SELECT m.character_id AS id,m.rank,m.joined,m.donated,c.name,c.owner,p.seen,p.zone FROM quest_guild_members m JOIN quest_characters c ON c.id=m.character_id LEFT JOIN quest_presence p ON p.character_id=m.character_id WHERE m.guild_id=? ORDER BY CASE m.rank WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END,m.joined,m.character_id").all(id); // Leader first, then officers, then members by seniority.
 const ledgerRows=(id,limit)=>db.prepare('SELECT id,character_id AS characterId,name,kind,amount,note,created AS at FROM quest_guild_ledger WHERE guild_id=? ORDER BY id DESC LIMIT ?').all(id,limit);
 const log=(guildId,characterId,name,kind,amount,note='')=>db.prepare('INSERT INTO quest_guild_ledger(guild_id,character_id,name,kind,amount,note,created) VALUES (?,?,?,?,?,?,?)').run(guildId,characterId,name,kind,amount,note,now());
 const notice=(state,text)=>{state.hubNotice=text;state.hubNoticeAt=now();}; // The client already shows hubNotice once per stamp, in hubs and dungeons alike.

 function validName(value){const name=clean(value,GUILD_LIMITS.nameMax+1);if(name.length<GUILD_LIMITS.nameMin||name.length>GUILD_LIMITS.nameMax||!NAME_RE.test(name))fail('Guild names are 3 to 24 letters, digits, spaces, apostrophes or hyphens.',400,'guild_invalid_name');if(!nameFilter(name))fail('That guild name is not allowed.',400,'guild_invalid_name');return name;}
 function validTag(value){const tag=clean(value,GUILD_LIMITS.tagMax+1).toUpperCase();if(!TAG_RE.test(tag))fail('Guild tags are 2 to 4 letters or digits.',400,'guild_invalid_tag');if(!nameFilter(tag))fail('That guild tag is not allowed.',400,'guild_invalid_tag');return tag;}
 function assertUnique(name,tag,except=null){ // Case-insensitive across every guild, pending charters included (they hold the name while the fee settles).
  if(db.prepare('SELECT 1 FROM quest_guilds WHERE name_key=? AND id IS NOT ?').get(name.toLowerCase(),except))fail('A guild already uses that name.',409,'guild_name_taken');
  if(db.prepare('SELECT 1 FROM quest_guilds WHERE tag_key=? AND id IS NOT ?').get(tag.toLowerCase(),except))fail('A guild already uses that tag.',409,'guild_tag_taken');
 }
 function findByName(value){ // Invite by typed name (the applet has no peer list): prefer the character who is online right now; otherwise the name must be unambiguous.
  const name=clean(value,24).toLowerCase();if(!name)return null;
  const rows=db.prepare('SELECT c.*,p.seen FROM quest_characters c LEFT JOIN quest_presence p ON p.character_id=c.id WHERE lower(c.name)=? ORDER BY p.seen DESC').all(name);
  if(!rows.length)return null;if(rows.length===1||online(rows[0].seen))return rows[0];
  fail('Several characters share that name. Invite them in person from the game instead.',409,'guild_ambiguous_name');
 }
 function findGuild(input){ // Apply by id, by tag or by name.
  if(input.guild)return guildRow(input.guild);
  const key=clean(input.name??input.tag??input.text,GUILD_LIMITS.nameMax).toLowerCase();if(!key)return null;
  return db.prepare('SELECT * FROM quest_guilds WHERE name_key=? OR tag_key=?').get(key,key);
 }
 function destroy(id){ // Removes a guild and everything that hangs off it except the ledger, which stays as an audit trail.
  for(const table of ['quest_guild_members','quest_guild_invites','quest_guild_applications','quest_guild_weeks'])db.prepare(`DELETE FROM ${table} WHERE guild_id=?`).run(id);
  db.prepare('DELETE FROM quest_guilds WHERE id=?').run(id);revisionCounter++;
 }
 function join(g,characterId,restricted=[]){ // Shared by accepting an invitation and approving an application.
  if(membership(characterId))fail('Leave your current guild first.');
  if(g.status!=='active')fail('That guild is still being founded.');
  if(count(g.id)>=capOf(g))fail('That guild is full.',409,'guild_full');
  if(restricted.length&&roster(g.id).some(r=>restricted.includes(r.owner)))fail('Contact with this guild is unavailable.'); // A block placed after the invitation still applies.
  db.prepare('INSERT INTO quest_guild_members(character_id,guild_id,rank,joined) VALUES (?,?,?,?)').run(characterId,g.id,'member',now());
  db.prepare('DELETE FROM quest_guild_invites WHERE target=?').run(characterId);db.prepare('DELETE FROM quest_guild_applications WHERE character_id=?').run(characterId); // One guild per character: every other offer lapses.
  bump(g.id);
 }
 function goal(id){ // This week's shared goal for the snapshot; the row is created lazily by progress(), so a quiet week reads as 0 of the live target.
  const w=week(),row=db.prepare('SELECT * FROM quest_guild_weeks WHERE guild_id=? AND week=?').get(id,w.start),last=db.prepare('SELECT points,target,reward,paid FROM quest_guild_weeks WHERE guild_id=? AND week<? ORDER BY week DESC LIMIT 1').get(id,w.start);
  return {weekStart:w.start,endsAt:w.ends,points:row?.points??0,target:row?.target??whole('guild_goal_target'),reward:row?.reward??whole('guild_goal_reward'),dives:row?.dives??0,quests:row?.quests??0,accidents:row?.accidents??0,lastWeek:last?{points:last.points,target:last.target,reward:last.reward,met:last.points>=last.target,paid:last.paid===1}:null};
 }
 function view(g,m){ // What a member sees. Social status only: never another member's loadout, needs or account id.
  const members=roster(g.id).map(r=>({id:r.id,name:r.name,rank:r.rank,online:online(r.seen),zone:online(r.seen)?r.zone:null,joined:r.joined,donated:r.donated}));
  return {id:g.id,name:g.name,tag:g.tag,motd:g.motd,crest:g.crest,leader:g.leader,rank:m.rank,status:g.status,open:g.open===1,memberCap:capOf(g),members,
   treasury:{balance:g.balance,ledger:ledgerRows(g.id,GUILD_LIMITS.ledgerRows)},goal:goal(g.id),
   upgrades:{cap:g.cap_upgrades,motd:g.motd_upgrades,crest:g.crest_upgrade===1,prices:{cap:whole('guild_cap_upgrade_price'),motd:whole('guild_motd_upgrade_price'),crest:whole('guild_crest_upgrade_price')},capMax:GUILD_LIMITS.capUpgradesMax,motdMax:GUILD_LIMITS.motdUpgradesMax,motdLength:motdMax(g)},
   applications:atLeast(m,'officer')?db.prepare('SELECT a.id,a.character_id AS characterId,c.name,a.created FROM quest_guild_applications a JOIN quest_characters c ON c.id=a.character_id WHERE a.guild_id=? AND a.expires>? ORDER BY a.created').all(g.id,now()):[]}; // Only officers and the leader see who is knocking.
 }
 function rules(){return {fee:whole('guild_create_fee'),cap:whole('guild_member_cap'),nameMin:GUILD_LIMITS.nameMin,nameMax:GUILD_LIMITS.nameMax,tagMin:GUILD_LIMITS.tagMin,tagMax:GUILD_LIMITS.tagMax,motdMax:GUILD_LIMITS.motdBase,chatMax:GUILD_LIMITS.chat,donationPresets:[...GUILD_LIMITS.donationPresets],donationMax:Math.min(GUILD_LIMITS.donationMax,dailyCap())};} // For the create form and donate buttons; the server re-checks everything.

 function act(i,c,state,input,restricted=[]){ // Every `guild_*` zone action except guild_chat (zones.mjs speaks through its shared chat helper).
  const a=input.action,m=membership(c.id),g=m?guildRow(m.guild_id):null;
  const need=rank=>{if(!m||g?.status!=='active')fail(m?'Your guild charter is still settling.':'You are not in a guild.');if(!atLeast(m,rank))fail(rank==='leader'?'Only the guild leader can do that.':'Only guild officers and the leader can do that.',409,'guild_rank');};
  const other=()=>{const t=db.prepare('SELECT * FROM quest_guild_members WHERE character_id=? AND guild_id=?').get(input.member??'',g.id);if(!t||t.character_id===c.id)fail('Choose another guild member.');return t;};
  if(a==='guild_create'){
   if(m)fail(m.status==='pending'?'Your guild charter is still settling.':'Leave your current guild first.');
   if(state.run)fail('Finish combat first.');
   const name=validName(input.name),tag=validTag(input.tag);assertUnique(name,tag);
   const fee=whole('guild_create_fee'),id=randomUUID();
   db.prepare('INSERT INTO quest_guilds(id,name,name_key,tag,tag_key,leader,status,created) VALUES (?,?,?,?,?,?,?,?)').run(id,name,name.toLowerCase(),tag,tag.toLowerCase(),c.id,fee>0?'pending':'active',now()); // The name and tag are reserved now; the guild goes live when the fee settles.
   db.prepare('INSERT INTO quest_guild_members(character_id,guild_id,rank,joined) VALUES (?,?,?,?)').run(c.id,id,'leader',now());
   db.prepare('DELETE FROM quest_guild_invites WHERE target=?').run(c.id);db.prepare('DELETE FROM quest_guild_applications WHERE character_id=?').run(c.id);
   if(fee>0){const pid=createHash('sha256').update(c.id+':'+input.request_id).digest('hex');db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(pid,i.owner,c.id,JSON.stringify({guild_purchase:'create',guild:id,name:'Guild charter'}),fee);state.pendingPurchase=pid;notice(state,'Founding your guild…');} // The same durable debit path shops use; settle() finishes the charter.
   else{log(id,c.id,c.name,'create',0,'Founded (no charter fee)');notice(state,`Your guild ${name} [${tag}] is founded.`);}
   revisionCounter++;return;
  }
  if(a==='guild_decline'){db.prepare('DELETE FROM quest_guild_invites WHERE id=? AND target=?').run(input.invitation??'',c.id);return;}
  if(a==='guild_accept'){
   const invite=db.prepare('SELECT * FROM quest_guild_invites WHERE id=? AND target=? AND expires>?').get(input.invitation??'',c.id,now()),target=invite&&guildRow(invite.guild_id);
   if(!target)fail('This invitation has expired.');
   join(target,c.id,restricted);notice(state,`You joined ${target.name} [${target.tag}].`);return;
  }
  if(a==='guild_apply'){
   if(m)fail('Leave your current guild first.');
   const target=findGuild(input);if(!target||target.status!=='active')fail('No guild by that name or tag.',404,'guild_not_found');
   if(target.open!==1)fail(target.name+' is not taking applications right now.');
   if(roster(target.id).some(r=>restricted.includes(r.owner)))fail('Contact with this guild is unavailable.');
   if(count(target.id)>=capOf(target))fail('That guild is full.',409,'guild_full');
   if(db.prepare('SELECT COUNT(*) AS n FROM quest_guild_applications WHERE character_id=? AND expires>?').get(c.id,now()).n>=GUILD_LIMITS.applicationsPerCharacter)fail('Withdraw one of your other applications first.');
   db.prepare('INSERT INTO quest_guild_applications VALUES (?,?,?,?,?) ON CONFLICT(guild_id,character_id) DO UPDATE SET id=excluded.id,created=excluded.created,expires=excluded.expires').run(randomUUID(),target.id,c.id,now(),now()+GUILD_LIMITS.applicationTtl);
   notice(state,`Applied to ${target.name} [${target.tag}].`);return;
  }
  if(a==='guild_withdraw'){db.prepare('DELETE FROM quest_guild_applications WHERE id=? AND character_id=?').run(input.application??'',c.id);return;}
  if(a==='guild_invite'){need('officer');
   const target=input.member?character(input.member):findByName(input.name);
   if(!target||target.id===c.id)fail('Choose another player.');
   if(restricted.includes(target.owner))fail('Contact with this player is unavailable.');
   if(membership(target.id))fail(target.name+' already belongs to a guild.');
   if(count(g.id)>=capOf(g))fail('Your guild is full.',409,'guild_full');
   if(db.prepare('SELECT COUNT(*) AS n FROM quest_guild_invites WHERE guild_id=? AND expires>?').get(g.id,now()).n>=GUILD_LIMITS.invitesPerGuild)fail('Your guild has too many open invitations.');
   db.prepare('INSERT INTO quest_guild_invites VALUES (?,?,?,?,?) ON CONFLICT(guild_id,target) DO UPDATE SET id=excluded.id,sender=excluded.sender,expires=excluded.expires').run(randomUUID(),g.id,c.id,target.id,now()+GUILD_LIMITS.inviteTtl);
   notice(state,`Invited ${target.name} to ${g.name}.`);return;
  }
  if(a==='guild_approve'||a==='guild_reject'){need('officer');
   const app=db.prepare('SELECT * FROM quest_guild_applications WHERE id=? AND guild_id=?').get(input.application??'',g.id);if(!app)fail('That application is gone.');
   db.prepare('DELETE FROM quest_guild_applications WHERE id=?').run(app.id);
   if(a==='guild_approve'){join(g,app.character_id,restricted);notice(state,`${character(app.character_id)?.name??'A player'} joined ${g.name}.`);}
   return;
  }
  if(a==='guild_motd'){need('officer');const text=clean(input.text,motdMax(g));db.prepare('UPDATE quest_guilds SET motd=? WHERE id=?').run(text,g.id);bump(g.id);return;}
  if(a==='guild_settings'){need('leader');
   if(input.mode!==undefined){if(!['open','closed'].includes(input.mode))fail('Applications are either open or closed.',400,'guild_invalid_setting');db.prepare('UPDATE quest_guilds SET open=? WHERE id=?').run(input.mode==='open'?1:0,g.id);}
   bump(g.id);return;
  }
  if(a==='guild_crest'){need('leader');if(g.crest_upgrade!==1)fail('Buy the crest upgrade from the treasury first.');const crest=String(input.value??'').toLowerCase();if(!CREST_RE.test(crest))fail('Crest colours are #rrggbb.',400,'guild_invalid_crest');db.prepare('UPDATE quest_guilds SET crest=? WHERE id=?').run(crest,g.id);bump(g.id);return;}
  if(a==='guild_donate'){need('member');
   if(state.run)fail('Finish combat first.');
   const amount=input.amount,max=Math.min(GUILD_LIMITS.donationMax,dailyCap());
   if(!Number.isSafeInteger(amount)||amount<1||amount>max)fail(`Donate between 1 and ${max} LiDollCoins.`,400,'guild_invalid_amount');
   const pid=createHash('sha256').update(c.id+':'+input.request_id).digest('hex');
   db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(pid,i.owner,c.id,JSON.stringify({guild_purchase:'donation',guild:g.id,name:'Guild donation'}),amount);
   state.pendingPurchase=pid;notice(state,'Sending your donation…');return; // settle() credits the treasury once the wallet confirms the debit.
  }
  if(a==='guild_upgrade'){need('leader');
   const kind=input.kind,price=kind==='cap'?whole('guild_cap_upgrade_price'):kind==='motd'?whole('guild_motd_upgrade_price'):kind==='crest'?whole('guild_crest_upgrade_price'):null;
   if(price===null)fail('Choose the member cap, MOTD length or crest upgrade.',400,'guild_invalid_upgrade');
   if(kind==='cap'&&g.cap_upgrades>=GUILD_LIMITS.capUpgradesMax)fail('The member cap is already at its maximum.');
   if(kind==='motd'&&g.motd_upgrades>=GUILD_LIMITS.motdUpgradesMax)fail('The MOTD is already at its longest.');
   if(kind==='crest'&&g.crest_upgrade===1)fail('Your guild already has its crest.');
   if(g.balance<price)fail(`The treasury needs ${price} LiDollCoins for that (it holds ${g.balance}).`,409,'guild_treasury_short');
   db.prepare(`UPDATE quest_guilds SET balance=balance-?,${kind==='cap'?'cap_upgrades=cap_upgrades+1':kind==='motd'?'motd_upgrades=motd_upgrades+1':'crest_upgrade=1'} WHERE id=?`).run(price,g.id); // Treasury only: no wallet call, so this commits with the command.
   log(g.id,c.id,c.name,'upgrade_'+kind,-price,kind==='cap'?`Member cap +${GUILD_LIMITS.capStep}`:kind==='motd'?'Longer MOTD':'Guild crest');bump(g.id);
   notice(state,kind==='cap'?`Member cap raised to ${capOf(guildRow(g.id))}.`:kind==='motd'?'The MOTD can be longer now.':'Your guild has a crest. Choose its colour.');return;
  }
  need('member'); // Everything below needs an active membership.
  if(a==='guild_leave'){
   if(m.rank==='leader'){if(count(g.id)>1)fail('Transfer leadership or disband the guild first.');destroy(g.id);notice(state,`${g.name} is disbanded.`);return;} // The last member leaving closes the guild.
   db.prepare('DELETE FROM quest_guild_members WHERE character_id=?').run(c.id);bump(g.id);notice(state,`You left ${g.name}.`);return;
  }
  if(a==='guild_kick'){need('officer');const t=other();
   if(rankOf(t)>=rankOf(m))fail('You can only remove members below your rank.',409,'guild_rank'); // Officers remove members; only the leader removes officers.
   db.prepare('DELETE FROM quest_guild_members WHERE character_id=?').run(t.character_id);bump(g.id);return;
  }
  if(a==='guild_promote'){need('leader');const t=other();if(t.rank!=='member')fail('Only members can be promoted to officer.');db.prepare("UPDATE quest_guild_members SET rank='officer' WHERE character_id=?").run(t.character_id);bump(g.id);return;}
  if(a==='guild_demote'){need('leader');const t=other();if(t.rank!=='officer')fail('Only officers can be demoted.');db.prepare("UPDATE quest_guild_members SET rank='member' WHERE character_id=?").run(t.character_id);bump(g.id);return;}
  if(a==='guild_transfer'){need('leader');const t=other();
   db.prepare("UPDATE quest_guild_members SET rank='leader' WHERE character_id=?").run(t.character_id);db.prepare("UPDATE quest_guild_members SET rank='officer' WHERE character_id=?").run(c.id);
   db.prepare('UPDATE quest_guilds SET leader=? WHERE id=?').run(t.character_id,g.id);bump(g.id);notice(state,`${character(t.character_id)?.name??'Your successor'} now leads ${g.name}.`);return;
  }
  if(a==='guild_disband'){need('leader');destroy(g.id);notice(state,`${g.name} is disbanded.`);return;}
  fail('Unknown guild action.',400,'guild_unknown_action');
 }

 function settle(id,char,state,paid,amount,item){ // purchaseHooks.guild: the wallet answered for a charter fee or a donation. Runs inside hubs.mjs complete()'s transaction.
  const g=guildRow(item.guild);
  if(item.guild_purchase==='create'){
   if(!g){if(paid)adjust(char.owner,'coins',amount,'guild-refund-'+id,'Guild charter returned');state.hubNotice='That guild no longer exists; your charter fee was returned.';return;} // A gamemaster disbanded it before the wallet answered.
   if(paid){db.prepare("UPDATE quest_guilds SET status='active' WHERE id=?").run(g.id);log(g.id,char.id,char.name,'create',0,`Charter fee ${amount} LiDollCoins`);bump(g.id);state.hubNotice=`Your guild ${g.name} [${g.tag}] is founded.`;}
   else{destroy(g.id);state.hubNotice='Not enough LiDollCoins. No guild was founded.';}
   return;
  }
  if(item.guild_purchase==='donation'){
   if(!paid){state.hubNotice='Not enough LiDollCoins. Nothing was donated.';return;}
   if(!g||g.status!=='active'||!db.prepare('SELECT 1 FROM quest_guild_members WHERE character_id=? AND guild_id=?').get(char.id,g.id)){adjust(char.owner,'coins',amount,'guild-refund-'+id,'Guild donation returned');state.hubNotice='Your donation was returned: you are no longer in that guild.';return;}
   db.prepare('UPDATE quest_guilds SET balance=balance+? WHERE id=?').run(amount,g.id);db.prepare('UPDATE quest_guild_members SET donated=donated+? WHERE character_id=?').run(amount,char.id);
   log(g.id,char.id,char.name,'donation',amount);bump(g.id);state.hubNotice=`Donated ${amount} LiDollCoins to ${g.name}'s treasury.`;
  }
 }

 function progress(characterId,kind,n=1){ // A member did something that counts toward this week's goal. Silent for guildless characters and unknown kinds.
  if(!GOAL_KINDS.includes(kind)||!(n>0))return false;const m=membership(characterId);if(!m||m.status!=='active')return false;
  const w=week();
  db.prepare('INSERT INTO quest_guild_weeks(guild_id,week,points,dives,quests,accidents,target,reward) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,week) DO UPDATE SET points=points+excluded.points,dives=dives+excluded.dives,quests=quests+excluded.quests,accidents=accidents+excluded.accidents').run(m.guild_id,w.start,whole('guild_goal_points_'+kind)*n,kind==='dive'?n:0,kind==='quest'?n:0,kind==='accident'?n:0,whole('guild_goal_target'),whole('guild_goal_reward')); // Target and reward freeze when the week's row is born, so a mid-week retune never moves the goalposts.
  revisionCounter++;return true;
 }
 function repair(){ // Deleted characters and other surprises: drop orphans, hand leaderless guilds to the senior officer (else member), close empty ones.
  db.prepare('DELETE FROM quest_guild_members WHERE character_id NOT IN (SELECT id FROM quest_characters)').run();
  db.prepare('DELETE FROM quest_guild_invites WHERE target NOT IN (SELECT id FROM quest_characters) OR sender NOT IN (SELECT id FROM quest_characters)').run();
  db.prepare('DELETE FROM quest_guild_applications WHERE character_id NOT IN (SELECT id FROM quest_characters)').run();
  for(const g of db.prepare('SELECT g.* FROM quest_guilds g WHERE NOT EXISTS (SELECT 1 FROM quest_guild_members m WHERE m.guild_id=g.id AND m.character_id=g.leader)').all()){
   const next=db.prepare("SELECT character_id FROM quest_guild_members WHERE guild_id=? ORDER BY CASE rank WHEN 'officer' THEN 0 ELSE 1 END,joined,character_id LIMIT 1").get(g.id);
   if(!next){destroy(g.id);continue;}
   db.prepare('UPDATE quest_guilds SET leader=? WHERE id=?').run(next.character_id,g.id);db.prepare("UPDATE quest_guild_members SET rank='leader' WHERE character_id=?").run(next.character_id);bump(g.id);
  }
 }
 function payout(){ // Week rollover: every finished, unpaid week that met its target pays each member ACCOUNT once (alts in one guild share one payout), under the daily cap.
  const w=week(),day=Math.floor(now()/86400000),cap=dailyCap();
  for(const row of db.prepare('SELECT * FROM quest_guild_weeks WHERE paid=0 AND week<?').all(w.start)){
   const g=guildRow(row.guild_id);
   if(g&&row.points>=row.target&&row.reward>0){
    const owners=[...new Set(roster(g.id).map(r=>r.owner))];let paidAccounts=0;
    for(const owner of owners){
     const used=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(owner,day)?.coins??0,amount=Math.min(row.reward,Math.max(0,cap-used));if(!amount)continue;
     adjust(owner,'coins',amount,'guild-goal-'+g.id+'-'+row.week+'-'+owner.slice(0,16),'Guild goal: '+g.name);db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(owner,day,amount);paidAccounts++; // Idempotent outbox id: guild + week + account.
    }
    log(g.id,null,'Weekly goal','goal_reward',0,`Goal met (${row.points}/${row.target}): ${row.reward} LiDollCoins to ${paidAccounts} member account${paidAccounts===1?'':'s'}`);bump(g.id);
   }
   db.prepare('UPDATE quest_guild_weeks SET paid=1 WHERE guild_id=? AND week=?').run(row.guild_id,row.week); // Missed weeks close too, so they are never re-examined.
  }
 }
 function tick(force=false){ // From the 1 s world tick, but nothing here needs to run more than every 30 s.
  if(!force&&now()-lastTick<30000)return;lastTick=now();
  db.prepare('DELETE FROM quest_guild_invites WHERE expires<=?').run(now());db.prepare('DELETE FROM quest_guild_applications WHERE expires<=?').run(now());
  for(const g of db.prepare("SELECT * FROM quest_guilds WHERE status='pending' AND created<=?").all(now()-GUILD_LIMITS.pendingTtl))if(!db.prepare("SELECT 1 FROM hub_purchases WHERE character_id=? AND status='pending'").get(g.leader))destroy(g.id); // A charter whose fee never settled and is no longer pending frees its name.
  repair();payout();
 }
 function tagMap(){ // character id -> tag for active guilds; rebuilt only after a guild changed (peers rows are built for up to 64 players per request).
  if(tagCache.rev===revisionCounter)return tagCache.map;
  const map=new Map(db.prepare("SELECT m.character_id,g.tag FROM quest_guild_members m JOIN quest_guilds g ON g.id=m.guild_id WHERE g.status='active'").all().map(r=>[r.character_id,r.tag]));
  tagCache={rev:revisionCounter,map};return map;
 }
 function leaderboard(){ // Top guilds this week by points, then size, then age. Memoised for a minute or until any guild changes.
  if(boardCache.rev===revisionCounter&&now()-boardCache.at<60000)return boardCache.rows;
  const w=week(),rows=db.prepare("SELECT g.id,g.name,g.tag,g.crest,(SELECT COUNT(*) FROM quest_guild_members m WHERE m.guild_id=g.id) AS members,COALESCE(k.points,0) AS points,COALESCE(k.target,?) AS target FROM quest_guilds g LEFT JOIN quest_guild_weeks k ON k.guild_id=g.id AND k.week=? WHERE g.status='active' ORDER BY points DESC,members DESC,g.created LIMIT ?").all(whole('guild_goal_target'),w.start,GUILD_LIMITS.leaderboardRows);
  boardCache={rev:revisionCounter,at:now(),rows};return rows;
 }
 function snapshot(c,restricted=[]){ // Spread into both the full zone snapshot and the companion view; guildChat is added by zones.mjs, which owns the chat tables.
  const base={guildSupport:true,guildChatSupport:true,guildRules:rules(),guildLeaderboard:leaderboard()};
  if(!c)return {...base,guild:null,guildInvitations:[],guildApplications:[]};
  const m=membership(c.id),g=m?guildRow(m.guild_id):null;
  const invitations=db.prepare("SELECT i.id,i.expires,g.id AS guild,g.name,g.tag,s.name AS sender,s.owner AS senderOwner FROM quest_guild_invites i JOIN quest_guilds g ON g.id=i.guild_id JOIN quest_characters s ON s.id=i.sender WHERE i.target=? AND i.expires>? AND g.status='active' ORDER BY i.expires LIMIT 8").all(c.id,now()).filter(r=>!restricted.includes(r.senderOwner)).map(({senderOwner,...r})=>r); // Invitations from blocked accounts stay invisible.
  const applications=db.prepare('SELECT a.id,g.id AS guild,g.name,g.tag,a.created,a.expires FROM quest_guild_applications a JOIN quest_guilds g ON g.id=a.guild_id WHERE a.character_id=? AND a.expires>? ORDER BY a.created').all(c.id,now()); // The character's own outstanding applications.
  return {...base,guild:g?view(g,m):null,guildInvitations:invitations,guildApplications:applications};
 }
 const gm={ // Web panel and in-game GM tools. Callers audit; nothing here writes gm_audit itself.
  list(q=''){const like='%'+clean(q,40).toLowerCase()+'%';return db.prepare('SELECT g.*,(SELECT COUNT(*) FROM quest_guild_members m WHERE m.guild_id=g.id) AS members,(SELECT name FROM quest_characters WHERE id=g.leader) AS leaderName,COALESCE((SELECT points FROM quest_guild_weeks k WHERE k.guild_id=g.id AND k.week=?),0) AS points FROM quest_guilds g WHERE g.name_key LIKE ? OR g.tag_key LIKE ? ORDER BY g.created DESC LIMIT 100').all(week().start,like,like).map(g=>({id:g.id,name:g.name,tag:g.tag,status:g.status,leader:g.leader,leaderName:g.leaderName??'(deleted)',members:g.members,memberCap:capOf(g),balance:g.balance,points:g.points,motd:g.motd,created:g.created}));},
  detail(id){const g=guildRow(id);if(!g)fail('No such guild.',404,'guild_not_found');return {...view(g,{rank:'leader'}),treasury:{balance:g.balance,ledger:ledgerRows(g.id,100)},weeks:db.prepare('SELECT * FROM quest_guild_weeks WHERE guild_id=? ORDER BY week DESC LIMIT 12').all(g.id)};},
  rename(id,{name,tag}){const g=guildRow(id);if(!g)fail('No such guild.',404,'guild_not_found');const next={name:name===undefined||name===''?g.name:validName(name),tag:tag===undefined||tag===''?g.tag:validTag(tag)};assertUnique(next.name,next.tag,g.id);db.prepare('UPDATE quest_guilds SET name=?,name_key=?,tag=?,tag_key=? WHERE id=?').run(next.name,next.name.toLowerCase(),next.tag,next.tag.toLowerCase(),g.id);bump(g.id);return {id:g.id,from:{name:g.name,tag:g.tag},to:next};},
  motdClear(id){const g=guildRow(id);if(!g)fail('No such guild.',404,'guild_not_found');db.prepare("UPDATE quest_guilds SET motd='' WHERE id=?").run(g.id);bump(g.id);return {id:g.id,motd:g.motd};},
  transfer(id,characterId){const g=guildRow(id);if(!g)fail('No such guild.',404,'guild_not_found');const t=db.prepare('SELECT * FROM quest_guild_members WHERE character_id=? AND guild_id=?').get(characterId??'',g.id);if(!t)fail('That character is not in this guild.');if(t.character_id===g.leader)fail('They already lead this guild.');db.prepare("UPDATE quest_guild_members SET rank='officer' WHERE character_id=? AND rank='leader'").run(g.leader);db.prepare("UPDATE quest_guild_members SET rank='leader' WHERE character_id=?").run(t.character_id);db.prepare('UPDATE quest_guilds SET leader=? WHERE id=?').run(t.character_id,g.id);bump(g.id);return {id:g.id,from:g.leader,to:t.character_id};},
  disband(id){const g=guildRow(id);if(!g)fail('No such guild.',404,'guild_not_found');const summary={id:g.id,name:g.name,tag:g.tag,members:count(g.id),balance:g.balance};destroy(g.id);return summary;},
  adjust(id,amount,note){const g=guildRow(id);if(!g)fail('No such guild.',404,'guild_not_found');if(!Number.isSafeInteger(amount)||amount===0||g.balance+amount<0)fail('Choose a non-zero amount the treasury can absorb.',400,'guild_invalid_amount');db.prepare('UPDATE quest_guilds SET balance=balance+? WHERE id=?').run(amount,g.id);log(g.id,null,'Gamemaster','gm_adjust',amount,clean(note,120));bump(g.id);return {id:g.id,balance:g.balance+amount};},
  tuning:()=>Object.fromEntries(GUILD_TUNING_KEYS.map(k=>[k,knob(k)])),
 };
 return {act,settle,progress,tick,snapshot,tagMap,leaderboard,membership,rules,gm,setNameFilter(fn){nameFilter=typeof fn==='function'?fn:()=>true;},get revision(){return revisionCounter;}};
}
