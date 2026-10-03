import {envFlag} from './env-flag.mjs'; // TRUE/true/1/yes all switch recruitment on.
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {importLoadout} from './loadout.mjs';

export const followerData=JSON.parse(readFileSync(new URL('./followers-data.json',import.meta.url),'utf8')).companions;
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'follower_conflict'});};
export const HIRE_MS=3600000;
export const BATTLE_GRACE_MS=15*60000; // How long a finished contract waits for its battle to settle before the companion goes home anyway.

export function followerStats(def,level){
 const p=def.stat_profile,l=Math.max(1,Math.min(p.level_cap,level)),stat=k=>p[k+'_base']+Math.floor((l-1)/p[k+'_step']);
 const values={level:l,str:stat('str'),def:stat('def'),dex:stat('dex'),int:stat('int')};
 return {...values,hp:p.hp_base+(l-1)*p.hp_per_level+values.def*p.hp_def_scale,mp:p.mp_base+values.int*p.mp_int_scale};
} // The authored companion profiles remain the source of level, stat and mana scaling.

export function createFollowers(db,{now=Date.now,enabled=envFlag('QUEST_FOLLOWERS_ENABLED',true),catalog=followerData,live=null,readOnly=false}={}){
 if(live){const source=catalog;catalog={};for(const [id,def] of Object.entries(source)){live.registerSheet('follower',def.online.home_zone,id,{name:def.name,aliases:def.online.aliases??[],persona:def.online.persona,hire_text:def.online.hire_text,fallback:def.online.fallback,talk_lines:def.dialogue.talk_lines??[]},{name:def.name,source:'followers-data.json'});Object.defineProperty(catalog,id,{enumerable:true,get(){const story=live.sheet('follower',def.online.home_zone,id);return {...def,name:story.name,online:{...def.online,...story},dialogue:{...def.dialogue,talk_lines:story.talk_lines}};}});}} // Companions are an explicit exception to the blank-world cleanup; recruitment still has an operator off switch.
 db.exec(`CREATE TABLE IF NOT EXISTS quest_followers(id TEXT PRIMARY KEY,level INTEGER NOT NULL DEFAULT 1,xp INTEGER NOT NULL DEFAULT 0,hp REAL NOT NULL,mp REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS quest_follower_hires(id TEXT PRIMARY KEY,npc TEXT NOT NULL,character_id TEXT NOT NULL,owner TEXT NOT NULL,request_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER,zone TEXT,x INTEGER,y INTEGER,edition TEXT,area TEXT,battle TEXT,UNIQUE(character_id,request_id));
 CREATE UNIQUE INDEX IF NOT EXISTS quest_follower_exclusive ON quest_follower_hires(npc) WHERE status IN ('pending','active');
 CREATE UNIQUE INDEX IF NOT EXISTS quest_follower_one_per_character ON quest_follower_hires(character_id) WHERE status IN ('pending','active');
 CREATE UNIQUE INDEX IF NOT EXISTS quest_follower_one_per_player ON quest_follower_hires(owner) WHERE status IN ('pending','active');
 CREATE TABLE IF NOT EXISTS quest_follower_awards(battle TEXT NOT NULL,npc TEXT NOT NULL,PRIMARY KEY(battle,npc));
 CREATE TABLE IF NOT EXISTS quest_follower_extensions(id TEXT PRIMARY KEY,rental TEXT NOT NULL,character_id TEXT NOT NULL,owner TEXT NOT NULL,request_id TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER,payment_uncertain INTEGER NOT NULL DEFAULT 0,payment_receipt TEXT,UNIQUE(character_id,request_id));
 CREATE UNIQUE INDEX IF NOT EXISTS quest_follower_one_extension ON quest_follower_extensions(rental) WHERE status='pending';
 CREATE INDEX IF NOT EXISTS quest_follower_extension_owner ON quest_follower_extensions(owner) WHERE status='pending';`);
 const columns=new Set(db.prepare('PRAGMA table_info(quest_follower_hires)').all().map(c=>c.name));
 if(!columns.has('payment_uncertain'))db.exec('ALTER TABLE quest_follower_hires ADD COLUMN payment_uncertain INTEGER NOT NULL DEFAULT 0');
 if(!columns.has('payment_receipt'))db.exec('ALTER TABLE quest_follower_hires ADD COLUMN payment_receipt TEXT'); // Additive receipt metadata also supports servers upgraded from the initial disabled rollout.
 for(const [id,def] of Object.entries(catalog)){const s=followerStats(def,1);db.prepare('INSERT OR IGNORE INTO quest_followers(id,hp,mp) VALUES (?,?,?)').run(id,s.hp,s.mp);}
 const get=id=>db.prepare("SELECT * FROM quest_follower_hires WHERE character_id=? AND status IN ('pending','active')").get(id);
 const occupied=id=>db.prepare("SELECT * FROM quest_follower_hires WHERE npc=? AND status IN ('pending','active')").get(id);
 const progression=id=>db.prepare('SELECT * FROM quest_followers WHERE id=?').get(id);
 const extending=id=>db.prepare("SELECT 1 FROM quest_follower_extensions WHERE rental=? AND status='pending'").get(id);
 const slots=ids=>ids.length+ids.filter(id=>get(id)).length;
 function assertSlots(ids){const unique=[...new Set(ids)];if(unique.filter(id=>get(id)).length>1)fail('A party may hire only one companion. Dismiss a follower first.');if(slots(unique)>3)fail('Players and companions share three party slots. Dismiss a follower first.');}
 function tick(){ // Contracts that are up send the companion home: the hire ends and view() shows them back at their recruiting spot (placement) in their home zone.
  const t=now(),ended=db.prepare("SELECT id,npc,character_id FROM quest_follower_hires WHERE status='active' AND expires<=? AND (battle IS NULL OR expires<=?)").all(t,t-BATTLE_GRACE_MS); // A battle lock only holds them until that fight settles; one still set 15 minutes after the contract is from a fight that never settled (retired floor, restart) and is ignored.
  for(const row of ended){
   if(extending(row.id))continue; // Keep the exclusive reservation until an in-flight diamond debit is resolved, including after restart.
   db.prepare("UPDATE quest_follower_hires SET status='expired',battle=NULL WHERE id=?").run(row.id);
   const character=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(row.character_id);if(!character)continue;
   const state=JSON.parse(character.state);if(state.pendingDefeat||state.lastResult?.defeatScene||state.run)continue; // Never overwrite an unread defeat scene or a fight in progress; the companion still goes home.
   state.lastResult={log:[catalog[row.npc].name+"'s contract is up. They head back to where you found them."]};db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),row.character_id);
  }
 } // Battle locks grant only the current encounter a departure grace period.
 function placement(id,zone,geometry){
  const def=catalog[id];if(!def||def.online.home_zone!==zone||!geometry)return null;
  const origin=geometry.entrance??geometry.spawn;if(!origin)return null;
  const walls=geometry.walls??[],fixtures=geometry.fixtures??[],reserved=[origin,geometry.exit,...(geometry.exits??[]),...(geometry.portals??[]),...Object.values(geometry.entries??{})].filter(Boolean);
  const queue=[{...origin,steps:0}],seen=new Set([origin.x+','+origin.y]);
  let slot=Object.keys(catalog).filter(key=>catalog[key].online.home_zone===zone).sort().indexOf(id); // Shared homes get separate, stable spots even when another recruiter is hired.
  for(let index=0;index<queue.length;index++){
   const p=queue[index];
   if(p.steps>0&&!reserved.some(r=>r.x===p.x&&r.y===p.y)&&!(geometry.traps??[]).some(t=>t.x===p.x&&t.y===p.y)&&slot--===0)return {x:p.x,y:p.y};
   if(p.steps>=8)continue;
   for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]){
    const x=p.x+dx,y=p.y+dy,key=x+','+y;
    if(seen.has(key)||x<1||y<1||x>=(geometry.width??20)-1||y>=(geometry.height??12)-1||walls[y]?.[x]||geometry.props?.[y]?.[x]||(geometry.managedOccupancy??[]).some(o=>o.x===x&&o.y===y)||fixtures.some(f=>f.solid!==false&&x>=f.x&&y>=f.y&&x<f.x+(f.span_w??1)&&y<f.y+(f.span_h??1)))continue;
    seen.add(key);queue.push({x,y,steps:p.steps+1});
   }
  }return null;
 } // Search outward along walkable tiles from the inside entrance, avoiding furniture, hazards and arrival/exit pads.
 function reserve(c,state,input,p,geometry,memberIds){
  tick();if(!enabled)fail('Companion recruitment is not enabled.');if(state.followerVersion!==1)fail('Update the game to recruit companions.');
  if(state.run||state.pendingDefeat||state.pendingPurchase||state.worldTurnDue)fail('Finish your current action before hiring.');
  if(db.prepare("SELECT 1 FROM quest_follower_hires WHERE owner=? AND status IN ('pending','active')").get(c.owner))fail('You already have a companion or a payment pending on this account.');
  const id=input.npc,def=catalog[id];if(!def)fail('Choose an available companion.');if(occupied(id))fail('That companion is already travelling with someone.');
  const at=placement(id,p.zone,geometry);if(!at||Math.abs(p.x-at.x)+Math.abs(p.y-at.y)>2)fail('Stand beside the companion to hire them.');
  assertSlots(memberIds);if(memberIds.some(id=>get(id)))fail('Your party already has a companion or a payment pending.');if(slots(memberIds)>=3)fail('Your party has no free companion slot.');
  const rental=randomUUID();db.prepare("INSERT INTO quest_follower_hires(id,npc,character_id,owner,request_id,status,created,zone,x,y,edition) VALUES (?,?,?,?,?,'pending',?,?,?,?,?)").run(rental,id,c.id,c.owner,input.request_id,now(),p.zone,at.x,at.y,state.dive?.edition??null);
  return rental;
 } // Reserving the NPC and party slot happens in the same transaction as the game command.
 function complete(id,paid,receipt=null){
  const row=db.prepare('SELECT * FROM quest_follower_hires WHERE id=?').get(id);if(!row||row.status!=='pending')return;
  const character=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(row.character_id);
  if(character){const state=JSON.parse(character.state);state.lastResult={log:[paid?catalog[row.npc].name+' joins you for 60 minutes. Mention their name in Area chat.':'The companion payment was declined. Check your diamonds and spending permission.']};db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),row.character_id);}
  if(!paid){db.prepare("UPDATE quest_follower_hires SET status='declined' WHERE id=?").run(id);return;}
  const stats=followerStats(catalog[row.npc],progression(row.npc).level);
  db.prepare('UPDATE quest_followers SET hp=?,mp=? WHERE id=?').run(stats.hp,stats.mp,row.npc);
  db.prepare("UPDATE quest_follower_hires SET status='active',expires=?,payment_receipt=? WHERE id=?").run(now()+HIRE_MS,JSON.stringify(receipt??{request_id:'follower-'+id}),id);
 } // A confirmed, idempotent wallet receipt starts the hour and restores the new rental's resources.
 function extend(c,state,input){
  tick();const row=get(c.id);
  if(!row||row.owner!==c.owner||row.status!=='active'||row.id!==input.rental||row.expires<=now())fail('Choose your current, unexpired companion contract.');
  if(state.followerVersion!==1)fail('Update the game to extend companion time.');
  if(extending(row.id))fail('Your companion extension payment is still pending.');
  if(row.battle||state.run||state.pendingDefeat||state.pendingPurchase||state.worldTurnDue)fail('Finish your current action before extending companion time.');
  const id=randomUUID();db.prepare("INSERT INTO quest_follower_extensions(id,rental,character_id,owner,request_id,status,created) VALUES (?,?,?,?,?,'pending',?)").run(id,row.id,c.id,c.owner,input.request_id,now());return id;
 } // The command transaction binds one explicit purchase to the hirer's current contract; recruitment may remain disabled.
 function completeExtension(id,paid,receipt=null){
  const extension=db.prepare('SELECT * FROM quest_follower_extensions WHERE id=?').get(id);if(!extension||extension.status!=='pending')return;
  const hire=db.prepare('SELECT * FROM quest_follower_hires WHERE id=?').get(extension.rental);if(!hire||hire.status!=='active')fail('The reserved companion contract is unavailable.');
  const expires=paid?Math.max(hire.expires,now())+HIRE_MS:hire.expires;
  if(paid)db.prepare('UPDATE quest_follower_hires SET expires=? WHERE id=?').run(expires,hire.id);
  db.prepare('UPDATE quest_follower_extensions SET status=?,expires=?,payment_receipt=? WHERE id=?').run(paid?'paid':'declined',expires,paid?JSON.stringify(receipt??{request_id:'follower-extension-'+id}):null,id);
  const character=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(hire.character_id);
  if(character){const state=JSON.parse(character.state);if(!state.run&&!state.pendingDefeat&&!state.lastResult?.defeatScene){state.lastResult={log:[paid?catalog[hire.npc].name+' will stay for another 60 minutes.':'The extension payment was declined. Your existing companion time is unchanged.']};db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),hire.character_id);}}
 } // Apply a confirmed receipt once, preserving remaining time and NPC resources; delayed confirmation still delivers a full extra hour.
 function dismiss(c){const row=get(c.id);if(!row)fail('You do not have a companion.');if(row.status==='pending'||row.battle||extending(row.id))fail('Finish the payment or battle before dismissing your companion.');db.prepare("UPDATE quest_follower_hires SET status='dismissed' WHERE id=?").run(row.id);}
 function cancelSpeech(row){if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quest_follower_chat_jobs'").get())db.prepare("UPDATE quest_follower_chat_jobs SET status='discarded' WHERE rental=? AND status='pending'").run(row.id);} // Cancel travel/disconnect replies even when their HTTP request is already in flight.
 let chatSchemaReady=false;
 function move(c,state,before,after,area){
  if(chatSchemaReady||(chatSchemaReady=!!db.prepare("SELECT 1 FROM pragma_table_info('quest_follower_chat_jobs') WHERE name='speaker'").get())){
   if(!after)db.prepare("UPDATE quest_follower_chat_jobs SET status='discarded' WHERE speaker=? AND status='pending'").run(c.id);
   else db.prepare("UPDATE quest_follower_chat_jobs SET status='discarded' WHERE speaker=? AND status='pending' AND (zone<>? OR edition IS NOT ?)").run(c.id,after.zone,state.dive?.edition??null);
  } // Any speaker's departure cancels their queued replies, including speakers who have no hired companion.
  const row=get(c.id);if(!row||row.status!=='active')return;if(!after){cancelSpeech(row);return;}
  const edition=state.dive?.edition??null,same=before?.zone===after.zone&&row.zone===after.zone&&row.edition===edition;
  const stepped=same&&Math.abs(before.x-after.x)+Math.abs(before.y-after.y)===1;
  const relocated=!same||Math.abs(before.x-after.x)+Math.abs(before.y-after.y)>1;
  const x=stepped?before.x:(relocated?after.x:row.x),y=stepped?before.y:(relocated?after.y:row.y);
  if(!same||row.area!==(area??null))cancelSpeech(row); // Travel invalidates even a reply that returns after the player has come back.
  db.prepare('UPDATE quest_follower_hires SET zone=?,x=?,y=?,edition=?,area=? WHERE id=?').run(after.zone,x,y,edition,area??null,row.id);
 } // Walk one validated tile behind the hirer; portal arrivals move the pair together.
 function view(c,p,geometry,state){
  if(!readOnly)tick();const own=c?get(c.id):null,entities=[]; // Snapshot workers consume the coordinator's committed expiry decisions.
  if(p){
   if(enabled)for(const [id,def] of Object.entries(catalog)){const at=placement(id,p.zone,geometry);if(at&&!occupied(id))entities.push({id:'follower:'+id,npc:id,name:def.name,sprite:def.overworld_sprite,...at,available:true,hireText:def.online.hire_text});}
   for(const row of db.prepare("SELECT h.* FROM quest_follower_hires h JOIN quest_presence p ON p.character_id=h.character_id WHERE h.status='active' AND h.zone=? AND p.zone=h.zone AND p.seen>?").all(p.zone,now()-30000)){
    if(row.edition!==(state?.dive?.edition??null))continue;const def=catalog[row.npc];entities.push({id:'follower:'+row.npc,npc:row.npc,name:def.name,sprite:def.overworld_sprite,x:row.x,y:row.y,hirer:row.character_id,available:false});
   }
  }
  return {enabled,entities,active:own?{...progression(own.npc),id:own.id,npc:own.npc,name:catalog[own.npc].name,status:own.status,expires:own.expires,extensionPending:!!extending(own.id),canExtend:own.status==='active'&&own.expires>now()&&!extending(own.id)&&!own.battle&&!state?.run&&!state?.pendingDefeat&&!state?.pendingPurchase&&!state?.worldTurnDue}:null};
 } // A compact entity list is independent of player accounts, inventories and appearance grants.
 function chatTargets(c,{area,geometry=null,within=(a,b)=>Math.abs(a.x-b.x)<=15&&Math.abs(a.y-b.y)<=10}={}){
  const p=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);if(!p||p.seen<=now()-30000)return [];
  const state=JSON.parse(c.state),targets=[];
  for(const entity of view(c,p,geometry,state).entities){
   if(!within(p,entity))continue;
   const hire=occupied(entity.npc);if(hire&&(hire.status!=='active'||hire.expires<=now()||hire.area!==null&&hire.area!==area))continue;
   if(hire?.area===null)db.prepare('UPDATE quest_follower_hires SET area=? WHERE id=?').run(area,hire.id);
   const last=hire??db.prepare('SELECT id,status FROM quest_follower_hires WHERE npc=? ORDER BY created DESC,rowid DESC LIMIT 1').get(entity.npc);
   targets.push({npc:entity.npc,rental:hire?.id??JSON.stringify(['idle',entity.npc,area,last?.id??'',last?.status??'']),zone:p.zone,edition:state.dive?.edition??null,x:entity.x,y:entity.y});
  }
  return targets;
 } // Resolve only companions actually visible within the area's hearing rectangle; idle and hired contexts keep histories separate.
 function actors(people,battle){
  tick();assertSlots(people.map(c=>c.id));const active=[];
  for(const c of people){const h=get(c.id);if(!h||h.status!=='active'||h.expires<=now())continue;
   if(people.some(other=>JSON.parse(other.state).followerVersion!==1))fail('Every player needs the companion-capable game.');
   if(h.battle&&h.battle!==battle)fail('Your companion is still in another battle.');
   const def=catalog[h.npc],saved=progression(h.npc),stats=followerStats(def,saved.level);
   const loadout=importLoadout({player_info:{name:def.name,class_id:'fighter',...stats,playerHealth:saved.hp,playerHealthMax:stats.hp,stamina:100,stamina_max:100,shame:1024},inventory:[],player_mp:saved.mp,player_mp_max:stats.mp,player_spells:(def.combat.spell_unlocks??[]).filter(s=>s.level<=stats.level).map(s=>s.spell_id)});
   loadout.player_mp=saved.mp;loadout.player_mp_max=stats.mp;
   db.prepare('UPDATE quest_follower_hires SET battle=? WHERE id=?').run(battle,h.id);
   active.push({id:'follower:'+h.npc,npc:h.npc,hirer:c.id,rental:h.id,name:def.name,state:{loadout}});
  }return active;
 } // NPC actors get a server-built loadout; imported character companion metadata is never authoritative.
 function settle(actor,battle,xp){
  if(db.prepare('INSERT OR IGNORE INTO quest_follower_awards VALUES (?,?)').run(battle,actor.npc).changes===0)return;
  const def=catalog[actor.npc],saved=progression(actor.npc);let level=saved.level,total=saved.xp+Math.max(0,xp);
  while(level<def.stat_profile.level_cap&&total>=50*level){total-=50*level;level++;}
  if(level>=def.stat_profile.level_cap)total=Math.min(total,50*level-1);
  const stats=followerStats(def,level),previous=followerStats(def,saved.level),hp=actor.run.hp<=0?Math.ceil(stats.hp/4):Math.min(stats.hp,actor.run.hp+stats.hp-previous.hp);
  db.prepare('UPDATE quest_followers SET level=?,xp=?,hp=?,mp=? WHERE id=?').run(level,total,hp,Math.min(stats.mp,actor.state.loadout.player_mp),actor.npc);
  db.prepare('UPDATE quest_follower_hires SET battle=NULL WHERE id=? AND battle=?').run(actor.rental,battle);tick();
 } // The settlement receipt guards persistent NPC XP and HP independently from player rewards.
 function rest(c){const h=get(c.id);if(!h||h.status!=='active'||h.battle)return;const s=followerStats(catalog[h.npc],progression(h.npc).level);db.prepare('UPDATE quest_followers SET hp=MIN(?,hp+?),mp=MIN(?,mp+?) WHERE id=?').run(s.hp,Math.max(1,Math.ceil(s.hp*.1)),s.mp,Math.max(1,Math.ceil(s.mp*.1)),h.npc);}
 return {enabled,catalog,get,occupied,progression,slots,assertSlots,tick,placement,reserve,complete,extend,completeExtension,dismiss,move,view,chatTargets,actors,settle,rest};
}
