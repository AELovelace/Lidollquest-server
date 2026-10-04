// Game-balance statistics: a second SQLite file (balance.sqlite beside quest.sqlite) that records what happens to players, so
// combat and needs numbers can be tuned from real play. It never feeds back into the game: nothing here is read by a formula.
//
// A second database cannot join the game's transaction, so events are buffered and written only after the game database
// commits (attachBalanceStats watches BEGIN/COMMIT/ROLLBACK on that handle). A rolled-back or replayed command logs nothing.
// Only a database with attached stats logs: isolated GM test worlds and read-only snapshot workers have none.
import {DatabaseSync} from 'node:sqlite';
import {cacheStatements} from './statement-cache.mjs';

const sinks=new WeakMap(); // game database handle -> its stats instance
const actors=new WeakMap(); // parsed character state -> {c, stats}; combat code only holds the state object
const finite=(value,fallback=null)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;
const NEEDS=['wet','tum','hunger','thirst','shame','shame_level','incontinence','excitement'];
const TURN_ACTIONS=new Set(['world_turn','walk','hub_rest','turn_ready']); // Commands that carry needs turns from the client.
const NEED_ACTIONS=new Set([...TURN_ACTIONS,'loadout','use_item','companion_use','craft_eat']); // Commands whose needs changes are play, not an import.
const CLIENT_KINDS=new Set(['hold','accident','leak','relief','eat','drink','starve']); // Roll details only the client knows (scrAccidentSystem, scrSurvivalSystem).
const INTERVALS={day:'%Y-%m-%d',week:'%Y-W%W',month:'%Y-%m'};

export function createBalanceStats({filename=':memory:',now=Date.now,log=console.warn}={}){
 const db=cacheStatements(new DatabaseSync(filename));db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
 db.exec(`CREATE TABLE IF NOT EXISTS balance_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,owner TEXT,character_id TEXT,name TEXT,staff INTEGER NOT NULL DEFAULT 0,
  level INTEGER,zone TEXT,route TEXT,depth INTEGER,hp REAL,hp_max REAL,wet REAL,tum REAL,hunger REAL,thirst REAL,dignity REAL,shame REAL,incontinence REAL,turn INTEGER,value REAL,data TEXT NOT NULL DEFAULT '{}');
 CREATE INDEX IF NOT EXISTS balance_events_at ON balance_events(at);
 CREATE INDEX IF NOT EXISTS balance_events_kind ON balance_events(kind,at);
 CREATE INDEX IF NOT EXISTS balance_events_character ON balance_events(character_id,at);
 CREATE TABLE IF NOT EXISTS balance_character(character_id TEXT PRIMARY KEY,turns_seen INTEGER NOT NULL DEFAULT 0,last TEXT NOT NULL DEFAULT '{}');`);
 const staff=new Set(); // Owners whose latest request carried the gamemaster role (memory only, like zones.mjs staffOwners).
 let buffer=[],mark=0;

 function record(kind,c,state,data={}){ // c: {owner,id?,name?}; state: the parsed character state or null for account-level events.
  const p=state?.loadout?.player_info??{},run=state?.run,{zone,value,...rest}=data;
  buffer.push({at:now(),kind,owner:c.owner??null,character_id:c.id??null,name:c.name??null,staff:staff.has(c.owner)?1:0,level:finite(p.level),
   zone:zone??state?.dive?.zone??run?.zone??state?.lastLocation?.zone??null,route:state?.dive?.route??null,depth:finite(state?.dive?.depth),
   hp:finite(run?.hp,finite(p.playerHealth)),hp_max:finite(run?.maxHp,finite(p.playerHealthMax)),wet:finite(p.wet),tum:finite(p.tum),hunger:finite(p.hunger),thirst:finite(p.thirst),
   dignity:finite(p.shame),shame:finite(p.shame_level),incontinence:finite(p.incontinence),value:finite(value),data:rest});
  if(buffer.length>20000){buffer=buffer.slice(-10000);mark=Math.min(mark,buffer.length);} // A transaction that never ends must not grow memory without bound.
 }
 function flush(){ // Called after the game database commits. Turn counters and "turns since" are settled here, so a rollback never advances them.
  if(!buffer.length)return;
  const rows=buffer;buffer=[];mark=0;
  try{
   db.exec('BEGIN IMMEDIATE');
   const insert=db.prepare('INSERT INTO balance_events(at,kind,owner,character_id,name,staff,level,zone,route,depth,hp,hp_max,wet,tum,hunger,thirst,dignity,shame,incontinence,turn,value,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
   const seen=new Map();
   for(const r of rows){
    let turn=null;
    if(r.character_id){
     let t=seen.get(r.character_id);
     if(!t){const row=db.prepare('SELECT turns_seen,last FROM balance_character WHERE character_id=?').get(r.character_id);t={turns:row?.turns_seen??0,last:row?JSON.parse(row.last):{}};seen.set(r.character_id,t);}
     if(r.kind==='turn')t.turns+=Math.max(0,r.value??0);
     const since=key=>{const gap=key in t.last?t.turns-t.last[key]:null;t.last[key]=t.turns;return gap;}; // null the first time: no earlier event to measure from.
     if(r.kind==='eat'||r.kind==='drink')r.data.turns_since=since(r.kind);
     if(r.kind==='accident'){r.data.turns_since=since('accident_'+r.data.type);r.data.turns_since_change='change' in t.last?t.turns-t.last.change:null;}
     if(r.kind==='change')r.data.turns_since=since('change');
     turn=t.turns;
    }
    insert.run(r.at,r.kind,r.owner,r.character_id,r.name,r.staff,r.level,r.zone,r.route,r.depth,r.hp,r.hp_max,r.wet,r.tum,r.hunger,r.thirst,r.dignity,r.shame,r.incontinence,turn,r.value,JSON.stringify(r.data));
   }
   for(const [id,t] of seen)db.prepare('INSERT INTO balance_character VALUES (?,?,?) ON CONFLICT(character_id) DO UPDATE SET turns_seen=excluded.turns_seen,last=excluded.last').run(id,t.turns,JSON.stringify(t.last));
   db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}log('balance_stats_write_failed',String(error?.message??error).slice(0,200));} // Statistics must never fail a game command.
 }

 function filter({from,to,kinds,character,staff:includeStaff,before}={}){ // Shared WHERE clause for the panel's filters.
  const where=['1=1'],args=[];
  if(Number.isFinite(from)){where.push('at>=?');args.push(from);}
  if(Number.isFinite(to)){where.push('at<?');args.push(to);}
  if(!includeStaff)where.push('staff=0');
  if(character){where.push('character_id=?');args.push(String(character));}
  if(Array.isArray(kinds)&&kinds.length){where.push('kind IN ('+kinds.map(()=>'?').join(',')+')');args.push(...kinds.map(String));}
  if(Number.isFinite(before)){where.push('id<?');args.push(before);}
  return {where:where.join(' AND '),args};
 }
 function query(options={}){
  const {where,args}=filter(options),limit=Math.max(1,Math.min(1000,Math.floor(options.limit)||100));
  const events=db.prepare('SELECT * FROM balance_events WHERE '+where+' ORDER BY id DESC LIMIT ?').all(...args,limit).map(row=>({...row,data:JSON.parse(row.data)}));
  return {events,nextBefore:events.length===limit?events.at(-1).id:null};
 }
 function summary(options={}){ // Every tile and chart of the panel, aggregated in SQL so the browser never downloads raw rows to draw them.
  const {where,args}=filter(options),bucket="strftime('"+(INTERVALS[options.interval]??INTERVALS.day)+"',at/1000,'unixepoch')";
  const all=(sql)=>db.prepare(sql).all(...args),j=key=>"json_extract(data,'$."+key+"')";
  const t=db.prepare(`SELECT COUNT(*) events,COUNT(DISTINCT character_id) players,COALESCE(SUM(CASE WHEN kind='turn' THEN value END),0) turns,
   SUM(kind='encounter_end') encounters,SUM(kind='encounter_end' AND ${j('outcome')}='win') wins,SUM(kind='encounter_end' AND ${j('outcome')} IN ('defeat','charm_backfire')) defeats,
   AVG(CASE WHEN kind='player_hit' AND value>0 THEN value END) dealt,AVG(CASE WHEN kind='enemy_hit' THEN value END) taken,
   SUM(kind='accident') accidents,SUM(kind='accident' AND ${j('type')}='mess') messes,AVG(CASE WHEN kind='eat' THEN ${j('turns_since')} END) meal_gap,
   SUM(CASE WHEN kind='turn' AND ${j('d_wet')}>0 THEN ${j('d_wet')} END) wet_gain,SUM(CASE WHEN kind='turn' AND ${j('d_tum')}>0 THEN ${j('d_tum')} END) tum_gain,SUM(kind='level_up') levelups
   FROM balance_events WHERE ${where}`).get(...args);
  const per=(n,d)=>d?n/d:null,round=(n,places=2)=>n===null||n===undefined?null:Math.round(n*10**places)/10**places;
  const tiles=[['Players',t.players],['Turns played',t.turns],['Encounters',t.encounters??0],['Win rate %',round(per((t.wins??0)*100,t.encounters),1)],['Defeats',t.defeats??0],
   ['Avg damage dealt',round(t.dealt,1)],['Avg damage taken',round(t.taken,1)],['Accidents',t.accidents??0],['Messes',t.messes??0],['Accidents / 100 turns',round(per((t.accidents??0)*100,t.turns))],
   ['Avg turns between meals',round(t.meal_gap,1)],['Bladder fill / turn',round(per(t.wet_gain??0,t.turns))],['Bowel fill / turn',round(per(t.tum_gain??0,t.turns))],['Level-ups',t.levelups??0]].map(([label,value])=>({label,value}));
  const chart=(id,tab,title,description,type,columns,sql,plot=columns.slice(1))=>({id,tab,title,description,type,columns,plot,rows:all(sql).map(row=>columns.map(c=>typeof row[c]==='number'?round(row[c]):row[c]))});
  const charts=[
   chart('activity','overview','Encounters and accidents over time','Encounters finished, accidents and active characters per period. Turns played are in the table.','line',['period','encounters','accidents','players','turns'],
    `SELECT ${bucket} period,SUM(kind='encounter_end') encounters,SUM(kind='accident') accidents,COUNT(DISTINCT character_id) players,COALESCE(SUM(CASE WHEN kind='turn' THEN value END),0) turns FROM balance_events WHERE ${where} GROUP BY period ORDER BY period`,['encounters','accidents','players']),
   chart('turns','overview','Turns played over time','Needs turns committed per period (steps, rests and combat turns).','line',['period','turns'],
    `SELECT ${bucket} period,COALESCE(SUM(value),0) turns FROM balance_events WHERE ${where} AND kind='turn' GROUP BY period ORDER BY period`),
   chart('win_gap','combat','Win rate by level gap','Enemy level minus player level at the end of each encounter. Positive means the enemy out-levelled the player.','bar',['level_gap','win_pct','fights'],
    `SELECT ${j('enemy_level')}-level level_gap,100.0*SUM(${j('outcome')}='win')/COUNT(*) win_pct,COUNT(*) fights FROM balance_events WHERE ${where} AND kind='encounter_end' AND ${j('enemy_level')} IS NOT NULL AND level IS NOT NULL GROUP BY level_gap ORDER BY level_gap`,['win_pct']),
   chart('damage_level','combat','Damage by player level','Average damage per player action that hit, and per enemy action, at each player level.','line',['level','avg_dealt','avg_taken'],
    `SELECT level,AVG(CASE WHEN kind='player_hit' AND value>0 THEN value END) avg_dealt,AVG(CASE WHEN kind='enemy_hit' THEN value END) avg_taken FROM balance_events WHERE ${where} AND kind IN ('player_hit','enemy_hit') AND level IS NOT NULL GROUP BY level ORDER BY level`),
   chart('stats_level','combat','Player and enemy health by player level','Player maximum HP against the HP of the enemies met, at encounter start. Enemy STR and level are in the table.','line',['level','player_hp_max','enemy_hp','enemy_str','enemy_level'],
    `SELECT level,AVG(hp_max) player_hp_max,AVG(${j('enemy_hp')}) enemy_hp,AVG(${j('enemy_str')}) enemy_str,AVG(${j('enemy_level')}) enemy_level FROM balance_events WHERE ${where} AND kind='encounter_start' AND level IS NOT NULL GROUP BY level ORDER BY level`,['player_hp_max','enemy_hp']),
   chart('enemies','combat','Enemies','Every enemy fought: how often, how often the player won, how long it took and how much health was left.','table',['enemy','enemy_level','fights','win_pct','avg_turns','avg_hp_left_pct'],
    `SELECT ${j('enemy')} enemy,${j('enemy_level')} enemy_level,COUNT(*) fights,100.0*SUM(${j('outcome')}='win')/COUNT(*) win_pct,AVG(${j('turns')}) avg_turns,AVG(100.0*${j('hp_left')}/NULLIF(hp_max,0)) avg_hp_left_pct FROM balance_events WHERE ${where} AND kind='encounter_end' GROUP BY enemy,enemy_level ORDER BY fights DESC LIMIT 200`),
   chart('accidents','needs','Accidents over time','Wettings and messes, split by whether a diaper absorbed them.','bar',['period','wet_diaper','wet_clothes','mess_diaper','mess_clothes'],
    `SELECT ${bucket} period,SUM(${j('type')}='wet' AND ${j('where')}='diaper') wet_diaper,SUM(${j('type')}='wet' AND ${j('where')}='clothes') wet_clothes,SUM(${j('type')}='mess' AND ${j('where')}='diaper') mess_diaper,SUM(${j('type')}='mess' AND ${j('where')}='clothes') mess_clothes FROM balance_events WHERE ${where} AND kind='accident' GROUP BY period ORDER BY period`),
   chart('fill_level','needs','Needs change per turn by level','Average bladder and bowel gain, and hunger and thirst loss, per turn. Resets after an accident or a meal are left out.','line',['level','wet_per_turn','tum_per_turn','hunger_loss_per_turn','thirst_loss_per_turn'],
    `SELECT level,SUM(MAX(${j('d_wet')},0))/SUM(value) wet_per_turn,SUM(MAX(${j('d_tum')},0))/SUM(value) tum_per_turn,SUM(MAX(-${j('d_hunger')},0))/SUM(value) hunger_loss_per_turn,SUM(MAX(-${j('d_thirst')},0))/SUM(value) thirst_loss_per_turn FROM balance_events WHERE ${where} AND kind='turn' AND value>0 AND level IS NOT NULL GROUP BY level ORDER BY level`),
   chart('meal_gap','needs','Turns between meals','How many turns passed since the previous meal, in bands of ten.','bar',['turns_since_meal','meals'],
    `SELECT CAST(${j('turns_since')}/10 AS INTEGER)*10 turns_since_meal,COUNT(*) meals FROM balance_events WHERE ${where} AND kind='eat' AND ${j('turns_since')} IS NOT NULL GROUP BY turns_since_meal ORDER BY turns_since_meal`),
   chart('accident_gap','needs','Turns between accidents','Turns since the previous accident of the same type, in bands of twenty-five.','bar',['turns_since_accident','wet','mess'],
    `SELECT CAST(${j('turns_since')}/25 AS INTEGER)*25 turns_since_accident,SUM(${j('type')}='wet') wet,SUM(${j('type')}='mess') mess FROM balance_events WHERE ${where} AND kind='accident' AND ${j('turns_since')} IS NOT NULL GROUP BY turns_since_accident ORDER BY turns_since_accident`),
   chart('holds','needs','Hold-it attempts','Reported by the game client: success rate at each consecutive hold attempt.','bar',['attempt','success_pct','tries'],
    `SELECT ${j('attempt')} attempt,100.0*SUM(${j('ok')}=1)/COUNT(*) success_pct,COUNT(*) tries FROM balance_events WHERE ${where} AND kind='client_hold' AND ${j('attempt')} IS NOT NULL GROUP BY attempt ORDER BY attempt`,['success_pct']),
   chart('coins','economy','Coins awarded by source','Server coin awards grouped by reason.','bar',['source','coins','awards'],
    `SELECT CASE WHEN instr(${j('reason')},':') THEN substr(${j('reason')},1,instr(${j('reason')},':')-1) ELSE ${j('reason')} END source,SUM(value) coins,COUNT(*) awards FROM balance_events WHERE ${where} AND kind='coins' GROUP BY source ORDER BY coins DESC LIMIT 40`,['coins']),
   chart('trade','economy','Shop and crafting activity','Purchases, sales and crafted items per period. Coins spent and earned are in the table.','line',['period','bought','sold','crafted','coins_spent','coins_earned'],
    `SELECT ${bucket} period,SUM(kind='shop_buy') bought,SUM(kind='shop_sell') sold,SUM(kind='craft') crafted,COALESCE(SUM(CASE WHEN kind='shop_buy' THEN value END),0) coins_spent,COALESCE(SUM(CASE WHEN kind='shop_sell' THEN value END),0) coins_earned FROM balance_events WHERE ${where} AND kind IN ('shop_buy','shop_sell','craft') GROUP BY period ORDER BY period`,['bought','sold','crafted']),
   chart('kinds','overview','Events by kind','How many rows of each kind are in this range.','table',['kind','events'],`SELECT kind,COUNT(*) events FROM balance_events WHERE ${where} GROUP BY kind ORDER BY events DESC`),
  ];
  return {generatedAt:now(),events:t.events,tiles,charts};
 }
 const characters=()=>db.prepare('SELECT character_id id,MAX(name) name,MAX(staff) staff,COUNT(*) events,MAX(at) last FROM balance_events WHERE character_id IS NOT NULL GROUP BY character_id ORDER BY last DESC LIMIT 500').all();
 const kinds=()=>db.prepare('SELECT DISTINCT kind FROM balance_events ORDER BY kind').all().map(row=>row.kind);
 return {db,record,flush,query,summary,characters,kinds,staff,
  begin(){mark=buffer.length;},rollback(){buffer.length=Math.min(buffer.length,mark);},
  close(){flush();db.close();}};
}

export function attachBalanceStats(db,stats){ // Follow the game database's transactions: commit writes the buffered events, rollback forgets the ones it made.
 sinks.set(db,stats);const run=db.exec.bind(db);
 db.exec=sql=>{const verb=/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(String(sql))?.[1].toUpperCase();
  if(verb==='BEGIN')stats.begin();
  try{const result=run(sql);if(verb==='COMMIT')stats.flush();else if(verb==='ROLLBACK')stats.rollback();return result;}
  catch(error){if(verb==='COMMIT')stats.rollback();throw error;}};
 return stats;
}
export const balanceStats=db=>sinks.get(db)??null;
export function markBalanceStaff(db,owner,flag){const stats=sinks.get(db);if(!stats)return;if(flag)stats.staff.add(owner);else stats.staff.delete(owner);}
export function bindBalance(db,state,c){const stats=sinks.get(db);if(stats&&state&&c?.owner)actors.set(state,{c,stats});return state;} // Lets combat.mjs log with only the state object in hand.
export function logBalance(kind,state,data={}){const actor=actors.get(state);if(actor)actor.stats.record(kind,actor.c,state,data);} // Unbound states (hired companions, test worlds) are skipped.
export function logOwnerBalance(db,kind,owner,data={}){sinks.get(db)?.record(kind,{owner},null,data);} // Account-level events such as coin awards.

const enemyFacts=enemy=>({enemy:enemy?.enemy_id??enemy?.id??enemy?.name??null,enemy_name:enemy?.name??null,enemy_level:finite(enemy?.level),enemy_tier:enemy?.tier??(enemy?.boss?'boss':null)});
export function logEncounterStart(state){const r=state.run;if(!r?.enemy)return;logBalance('encounter_start',state,{encounter:r.sharedEncounter??r.id??null,mode:r.kind??'arena',stage:finite(r.stage),...enemyFacts(r.enemy),enemy_hp:finite(r.enemy.hp),enemy_str:finite(r.enemy.str),enemy_def:finite(r.enemy.def),enemy_exp:finite(r.enemy.exp)});}
export function logEncounterEnd(state,run,outcome,extra={}){ // Call before the run is discarded and after defeat penalties, passing needsBefore to record what the loss cost.
 if(!run)return;const {needsBefore,...rest}=extra,p=state.loadout?.player_info??{};
 const penalty=needsBefore?Object.fromEntries(NEEDS.map(key=>[key,finite(p[key],0)-finite(needsBefore[key],0)]).filter(([,delta])=>delta)):undefined;
 logBalance('encounter_end',state,{outcome,encounter:run.sharedEncounter??run.id??null,mode:run.kind??'arena',stage:finite(run.stage),turns:finite(run.turn),hp_left:finite(run.hp),...enemyFacts(run.enemy),xp:outcome==='win'?finite(run.enemy?.exp):0,...(penalty&&Object.keys(penalty).length?{penalty}:{}),...rest});
}
export const balanceNeeds=state=>Object.fromEntries(NEEDS.map(key=>[key,finite(state?.loadout?.player_info?.[key],0)]));

export function clientBalanceEvents(input){ // Sanitize the client's optional roll details. Telemetry never rejects a command: anything malformed is dropped.
 if(!Array.isArray(input))return [];
 const events=[];
 for(const raw of input.slice(0,32)){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!CLIENT_KINDS.has(raw.kind))continue;
  const data={};
  for(const [key,value] of Object.entries(raw).slice(0,12)){
   if(key==='kind'||!/^[a-z_]{1,24}$/.test(key))continue;
   if(typeof value==='number'&&Number.isFinite(value))data[key]=Math.max(-1000000,Math.min(1000000,value));
   else if(typeof value==='boolean')data[key]=value?1:0;
   else if(typeof value==='string')data[key]=value.slice(0,48);
  }
  events.push({kind:'client_'+raw.kind,data});
 }
 return events;
}

export function logCommit(db,{c,before,state,action,walked=0,fired=[],zone=null,clientEvents=[]}){ // One call from the command commit: everything a before/after comparison of the character can tell.
 if(!sinks.has(db)||!state?.loadout?.player_info)return;
 bindBalance(db,state,c);
 const a=before?.loadout?.player_info,b=state.loadout.player_info,log=(kind,data={})=>logBalance(kind,state,{zone,...data});
 const delta=key=>finite(b[key],0)-finite(a?.[key],finite(b[key],0)),rose=key=>a&&Number.isFinite(a[key])&&Number.isFinite(b[key])&&b[key]>a[key]?b[key]-a[key]:0;
 const counted=key=>Math.max(0,finite(b[key],0)-finite(a?.[key],0)); // Counters a save never had start at zero.
 if(a&&NEED_ACTIONS.has(action)){
  const turns=action==='walk'?walked:TURN_ACTIONS.has(action)?1:0;
  if(turns>0)log('turn',{value:turns,action,in_combat:state.run?1:0,d_wet:delta('wet'),d_tum:delta('tum'),d_hunger:delta('hunger'),d_thirst:delta('thirst'),d_dignity:delta('shame'),d_hp:delta('playerHealth')});
  let typed=false;
  for(const [key,type,where] of [['diaper_wet_absorbed','wet','diaper'],['had_wet_accident','wet','clothes'],['diaper_tum_absorbed','mess','diaper'],['had_tum_accident','mess','clothes']])
   if(counted(key)){typed=true;log('accident',{value:counted(key),type,where,in_combat:state.run?1:0,meter_before:finite(a[type==='wet'?'wet':'tum'])});}
  if(!typed&&fired.includes('online_accident_seq'))log('accident',{value:1,type:delta('tum')<delta('wet')?'mess':'wet',where:'unknown',in_combat:state.run?1:0}); // The counter moved but no absorb/soil counter did: guess the type from the meter that emptied.
  if(fired.includes('online_hold_seq'))log('hold',{value:1,wet_before:finite(a.wet),tum_before:finite(a.tum)});
  if(fired.includes('online_change_seq'))log('change',{value:1,wet_absorbed:finite(a.diaper_wet_absorbed),tum_absorbed:finite(a.diaper_tum_absorbed)});
  if(fired.includes('online_excitement_seq'))log('excitement',{value:1});
  if(rose('hunger'))log('eat',{value:rose('hunger'),hunger_before:finite(a.hunger),action});
  if(rose('thirst'))log('drink',{value:rose('thirst'),thirst_before:finite(a.thirst),action});
  for(const event of clientEvents)log(event.kind,event.data);
 }
 if(a&&rose('level'))log('level_up',{value:rose('level'),from:a.level,to:b.level,hp_max:finite(b.playerHealthMax)});
 const was=before?.dive,is=state.dive;
 if((was?.route??null)!==(is?.route??null)||(was?.edition??null)!==(is?.edition??null)){
  if(was)logBalance('dive_exit',state,{zone:was.zone??null,route:was.route,edition:was.edition,after:action,outcome:state.lastResult?.outcome??null});
  if(is)log('dive_enter',{route:is.route,edition:is.edition,depth:finite(is.depth)});
 }
}
