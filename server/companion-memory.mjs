// Companion long-term memory: the game server owns it, in a secondary SQLite database (companion-memory.sqlite next to
// the main database). The AI nodes stay stateless: each companion chat sends the candidate memories with the request.
//   queue     quest_companion_events in the MAIN database. followers.remember() writes it inside the game command's
//             own transaction, so a rolled-back command never leaves a phantom memory.
//   drain()   after the commit (follower chat kick / service timer): render each event (companion-events.mjs), store it
//             in the memory database, raise the bond, then delete it from the queue. Memory ids come from the queue
//             ids, so a crash between the two databases can only repeat an INSERT OR IGNORE.
//   bonds     0-100 per companion and character, raised by shared experiences with an hourly cap; gates lore secrets.
// Only the main process opens this database: zone workers and snapshot paths never write here.
import {DatabaseSync} from 'node:sqlite';
import {render} from './companion-events.mjs';

export const MEMORY_DEFAULTS=Object.freeze({
 bond_hourly_cap:10,   // Most bond a pair can gain in one clock hour, so grinding fights can't max it in an afternoon.
 impression_min_words:4, // Shorter lines ("hi Elowen") never carry anything personal: skip the AI call.
 send_cap:60,          // Candidate memories sent with one chat (npc-rag ranks them by meaning).
 keep_per_pair:200,    // Above this, the oldest unimportant memories get folded into the relationship summary.
});
const WORD=/[a-z]{4,}/g;
const words=text=>new Set(String(text??'').toLowerCase().match(WORD)??[]); // Cheap keyword overlap for the pre-sort; meaning is ranked on the AI node.

export function createCompanionMemory(mainDb,{file=':memory:',now=Date.now,log=console.warn,tuning=()=>MEMORY_DEFAULTS}={}){
 const mem=new DatabaseSync(file);
 if(file!==':memory:')mem.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=2000;'); // Its own WAL: memory writes never wait on the game database.
 mem.exec(`CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,npc TEXT NOT NULL,character_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,gossip TEXT,
   importance INTEGER NOT NULL,embarrassing INTEGER NOT NULL DEFAULT 0,zone TEXT,created INTEGER NOT NULL,last_slip INTEGER);
  CREATE INDEX IF NOT EXISTS memories_pair ON memories(npc,character_id,created);
  CREATE INDEX IF NOT EXISTS memories_character ON memories(character_id);
  CREATE TABLE IF NOT EXISTS summaries(npc TEXT NOT NULL,character_id TEXT NOT NULL,text TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(npc,character_id));
  CREATE TABLE IF NOT EXISTS bonds(npc TEXT NOT NULL,character_id TEXT NOT NULL,bond REAL NOT NULL DEFAULT 0,hour INTEGER NOT NULL DEFAULT 0,hour_gain REAL NOT NULL DEFAULT 0,updated INTEGER NOT NULL,PRIMARY KEY(npc,character_id));
  CREATE TABLE IF NOT EXISTS impression_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,npc TEXT NOT NULL,character_id TEXT NOT NULL,player TEXT NOT NULL,npc_name TEXT NOT NULL,
   message TEXT NOT NULL,reply TEXT NOT NULL,created INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_try INTEGER NOT NULL DEFAULT 0);`);
 mainDb.exec('CREATE TABLE IF NOT EXISTS quest_companion_events(id INTEGER PRIMARY KEY AUTOINCREMENT,npc TEXT NOT NULL,character_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL)'); // followers.mjs creates it too; whichever runs first wins.
 const t=()=>({...MEMORY_DEFAULTS,...(tuning()??{})});

 function addBond(npc,characterId,amount){ // Raise the bond within this hour's cap; returns the new bond.
  const hour=Math.floor(now()/3600000),row=mem.prepare('SELECT * FROM bonds WHERE npc=? AND character_id=?').get(npc,characterId)??{bond:0,hour,hour_gain:0};
  const used=row.hour===hour?row.hour_gain:0,gain=Math.max(0,Math.min(amount,t().bond_hourly_cap-used)),bond=Math.min(100,row.bond+gain);
  mem.prepare('INSERT INTO bonds(npc,character_id,bond,hour,hour_gain,updated) VALUES (?,?,?,?,?,?) ON CONFLICT(npc,character_id) DO UPDATE SET bond=excluded.bond,hour=excluded.hour,hour_gain=excluded.hour_gain,updated=excluded.updated')
   .run(npc,characterId,bond,hour,used+gain,now());
  return bond;
 }

 function drain(limit=200){ // Move committed events from the game database into memories; returns how many were stored.
  const rows=mainDb.prepare('SELECT * FROM quest_companion_events ORDER BY id LIMIT ?').all(limit);if(!rows.length)return 0;
  let stored=0;mem.exec('BEGIN IMMEDIATE');
  try{
   for(const row of rows){
    let data={};try{data=JSON.parse(row.data);}catch{}
    const r=render(row.kind,data,data.player);if(!r)continue; // Unknown kinds from a newer build are dropped, not guessed at.
    if(row.kind==='zone'&&mem.prepare("SELECT 1 FROM memories WHERE npc=? AND character_id=? AND kind='zone' AND zone=?").get(row.npc,row.character_id,data.zone??''))continue; // Only the first visit together is memorable.
    const ins=mem.prepare('INSERT OR IGNORE INTO memories(id,npc,character_id,kind,text,gossip,importance,embarrassing,zone,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
     .run('e'+row.id,row.npc,row.character_id,row.kind,r.text,r.gossip,r.importance,r.embarrassing?1:0,data.zone??null,row.created);
    if(ins.changes){stored++;addBond(row.npc,row.character_id,r.bond);}
   }
   mem.exec('COMMIT');
  }catch(error){mem.exec('ROLLBACK');log('companion_memory_drain_failed',String(error?.message??error).slice(0,200));return 0;}
  mainDb.prepare('DELETE FROM quest_companion_events WHERE id<=?').run(rows.at(-1).id); // Only after the memories are safely committed.
  return stored;
 }

 const bondOf=(npc,characterId)=>Math.floor(mem.prepare('SELECT bond FROM bonds WHERE npc=? AND character_id=?').get(npc,characterId)?.bond??0);

 function candidates(npc,characterId,message,cap=t().send_cap){ // The memories sent with one chat: importance, freshness and shared words pre-sort them.
  const said=words(message),at=now();
  return mem.prepare('SELECT * FROM memories WHERE npc=? AND character_id=?').all(npc,characterId).map(m=>{
   const ageDays=Math.max(0,(at-m.created)/86400000),mine=words(m.text),overlap=[...said].filter(w=>mine.has(w)).length;
   return {m,score:.35*m.importance/5+.25*Math.exp(-ageDays/30)+.4*Math.min(1,overlap/2),ageDays}; // Shared words first: this only picks what gets sent, the AI node ranks by meaning.
  }).sort((a,b)=>b.score-a.score).slice(0,Math.max(0,cap)).map(({m,ageDays})=>({id:m.id,text:m.text,importance:m.importance,age_days:Math.round(ageDays*100)/100,embarrassing:!!m.embarrassing}));
 }

 const summary=(npc,characterId)=>mem.prepare('SELECT text FROM summaries WHERE npc=? AND character_id=?').get(npc,characterId)?.text??'';
 function forget(characterId){for(const table of ['memories','summaries','bonds','impression_jobs'])mem.prepare(`DELETE FROM ${table} WHERE character_id=?`).run(characterId);mainDb.prepare('DELETE FROM quest_companion_events WHERE character_id=?').run(characterId);} // Character deletion and the GM wipe.
 function view(characterId){ // GM panel: every companion's bond, summary and memories of one character.
  const bonds=mem.prepare('SELECT npc,bond,updated FROM bonds WHERE character_id=?').all(characterId);
  const memories=mem.prepare('SELECT id,npc,kind,text,importance,embarrassing,created,last_slip FROM memories WHERE character_id=? ORDER BY created DESC LIMIT 500').all(characterId);
  const summaries=mem.prepare('SELECT npc,text,updated FROM summaries WHERE character_id=?').all(characterId);
  return {bonds:bonds.map(b=>({...b,bond:Math.floor(b.bond)})),memories:memories.map(m=>({...m,embarrassing:!!m.embarrassing})),summaries,pending:mainDb.prepare('SELECT COUNT(*) n FROM quest_companion_events WHERE character_id=?').get(characterId).n};
 }
 function orphans(){ // Memories of characters that no longer exist (deleted outside forget()); returns how many were removed.
  const ids=mem.prepare('SELECT DISTINCT character_id FROM bonds UNION SELECT DISTINCT character_id FROM memories').all().map(r=>r.character_id);
  let removed=0;for(const id of ids)if(!mainDb.prepare('SELECT 1 FROM quest_characters WHERE id=?').get(id)){forget(id);removed++;}
  return removed;
 }
 // ── Phase 4: impressions (what the player said about themselves) and folding old memories into the summary ──
 function queueImpression({npc,characterId,player,npcName,message,reply}){ // After a companion reply: ask the AI later what the player revealed.
  if(String(message??'').trim().split(/\s+/).length<t().impression_min_words)return false;
  if(mem.prepare('SELECT COUNT(*) n FROM impression_jobs WHERE npc=? AND character_id=?').get(npc,characterId).n>=3)return false; // A chatty player can't flood the queue.
  mem.prepare('INSERT INTO impression_jobs(npc,character_id,player,npc_name,message,reply,created) VALUES (?,?,?,?,?,?,?)').run(npc,characterId,String(player).slice(0,64),String(npcName).slice(0,32),String(message).slice(0,500),String(reply??'').slice(0,600),now());
  return true;
 }
 function nextImpression(){mem.prepare('DELETE FROM impression_jobs WHERE created<?').run(now()-86400000);return mem.prepare('SELECT * FROM impression_jobs WHERE next_try<=? ORDER BY id LIMIT 1').get(now())??null;} // Day-old jobs are no longer worth an AI call.
 function storeImpressions(job,facts){ // Facts come back as "<player> said ..."; never gossiped, never embarrassing (they were said in public).
  mem.exec('BEGIN IMMEDIATE');try{
   facts.slice(0,3).forEach((f,n)=>mem.prepare("INSERT OR IGNORE INTO memories(id,npc,character_id,kind,text,gossip,importance,embarrassing,created) VALUES (?,?,?,'said',?,NULL,?,0,?)").run('i'+job.id+'-'+n,job.npc,job.character_id,String(f.text).slice(0,400),Math.max(1,Math.min(3,Number(f.importance)||1)),now()));
   mem.prepare('DELETE FROM impression_jobs WHERE id=?').run(job.id);mem.exec('COMMIT');
  }catch(error){mem.exec('ROLLBACK');throw error;}
 }
 function failImpression(job){if(job.attempts>=2)mem.prepare('DELETE FROM impression_jobs WHERE id=?').run(job.id);else mem.prepare('UPDATE impression_jobs SET attempts=attempts+1,next_try=? WHERE id=?').run(now()+60000,job.id);} // Three tries, a minute apart.
 function foldTarget(){ // One pair over keep_per_pair: its oldest small memories (importance <= 2 first) to fold into the summary.
  const keep=t().keep_per_pair,pair=mem.prepare('SELECT npc,character_id,COUNT(*) n FROM memories GROUP BY npc,character_id HAVING n>? ORDER BY n DESC LIMIT 1').get(keep);if(!pair)return null;
  const rows=mem.prepare('SELECT id,text FROM memories WHERE npc=? AND character_id=? ORDER BY (importance>2),created LIMIT ?').all(pair.npc,pair.character_id,Math.min(120,pair.n-keep+Math.ceil(keep/10))); // Fold 10% extra (20 at the default cap) so this does not run on every new memory.
  return {npc:pair.npc,characterId:pair.character_id,summary:summary(pair.npc,pair.character_id),ids:rows.map(r=>r.id),memories:rows.map(r=>r.text)};
 }
 function applyFold(target,text){
  mem.exec('BEGIN IMMEDIATE');try{
   mem.prepare('INSERT INTO summaries(npc,character_id,text,updated) VALUES (?,?,?,?) ON CONFLICT(npc,character_id) DO UPDATE SET text=excluded.text,updated=excluded.updated').run(target.npc,target.characterId,String(text).slice(0,1200),now());
   for(const id of target.ids)mem.prepare('DELETE FROM memories WHERE id=?').run(id);mem.exec('COMMIT');
  }catch(error){mem.exec('ROLLBACK');throw error;}
 } // The summary replaces what it absorbed in one transaction: nothing is lost if the AI call fails, nothing is kept twice.
 // ── Phase 5: slips (an embarrassing memory said in front of others) and anonymous gossip ──
 function slipCandidate(npc,characterId){ // The most recent embarrassing memory that hasn't slipped out in the last day.
  const m=mem.prepare('SELECT * FROM memories WHERE npc=? AND character_id=? AND embarrassing=1 AND (last_slip IS NULL OR last_slip<?) ORDER BY created DESC LIMIT 1').get(npc,characterId,now()-86400000);
  return m?{id:m.id,text:m.text,importance:m.importance,age_days:Math.round(Math.max(0,(now()-m.created)/86400000)*100)/100,embarrassing:true}:null;
 }
 const markSlip=id=>mem.prepare('UPDATE memories SET last_slip=? WHERE id=?').run(now(),id); // One slip per memory per day.
 function gossipLines(npc,characterId,limit=5){ // Other characters' experiences with this companion, already anonymous (templated gossip text; never things a player said).
  const seen=new Set(),out=[];
  for(const m of mem.prepare("SELECT id,gossip FROM memories WHERE npc=? AND character_id<>? AND gossip IS NOT NULL AND kind<>'said' ORDER BY created DESC LIMIT 100").all(npc,characterId)){
   if(seen.has(m.gossip))continue;seen.add(m.gossip);out.push({id:m.id,text:m.gossip});if(out.length>=limit)break;
  }return out;
 }
 return {drain,bondOf,addBond,candidates,summary,forget,view,orphans,queueImpression,nextImpression,storeImpressions,failImpression,foldTarget,applyFold,slipCandidate,markSlip,gossipLines,db:mem,close:()=>mem.close()};
}
