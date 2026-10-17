// The game database queues committed encounters; resident-memory.sqlite owns recall and its inspection/audit records.
import {DatabaseSync} from 'node:sqlite';
const clean=(value,max=300)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,max);
const terms=value=>new Set((clean(value,1000).toLowerCase().match(/[a-z]{4,}/g)??[]).filter(w=>!['that','this','have','with','what','your','said','just','from','about','would','could','there','they','them','were','been'].includes(w)));
const sensitive=/\b(?:secret\w*|private|confidential|between us|don['’]?t tell|do not tell|keep (?:it|this) to yourself|accident\w*|wet\w*|soak\w*|leak\w*|mess\w*|diaper\w*|napp\w*|padding|potty|toilet|pee\w*|poop\w*|pants|embarrass\w*|humiliat\w*|smell\w*|stink\w*|medical|diagnos\w*|address|password|phone|email)\b/i;
export const RESIDENT_MEMORY_LIMITS=Object.freeze({perPair:32,peersPerResident:128,recall:4,gossip:2,audit:10000});
export const gossipEligible=text=>!sensitive.test(String(text))&&!/[?@]|https?:\/\/|\d{4,}/i.test(String(text))&&/\b(?:I|my|we|our)\b/i.test(String(text))&&String(text).trim().split(/\s+/).length>=4; // Share first-person statements, not questions, guessed needs or private details.

export function createResidentMemory(mainDb,{file=':memory:',now=Date.now,log=console.warn}={}){
 const db=new DatabaseSync(file);let closed=false;
 if(file!==':memory:')db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;'); // A dedicated SQLite file can be inspected without opening the game or companion databases.
 db.exec(`CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL UNIQUE,resident TEXT NOT NULL,peer_kind TEXT NOT NULL,peer TEXT NOT NULL,
  conversation TEXT NOT NULL,source_seq INTEGER NOT NULL,speaker TEXT NOT NULL,speaker_kind TEXT NOT NULL,
  text TEXT NOT NULL,gossip INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS memory_pair ON memories(resident,peer_kind,peer,id);
  CREATE TABLE IF NOT EXISTS uses(id INTEGER PRIMARY KEY AUTOINCREMENT,memory_id INTEGER NOT NULL,resident TEXT NOT NULL,
   peer_kind TEXT NOT NULL,peer TEXT NOT NULL,conversation TEXT NOT NULL,request_id TEXT NOT NULL,purpose TEXT NOT NULL,
   source_seq INTEGER NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,offered INTEGER NOT NULL,
   target_kind TEXT NOT NULL,target_peer TEXT NOT NULL,target_name TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS uses_request ON uses(request_id);
  CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  INSERT OR IGNORE INTO metadata VALUES ('schema_version','1');
  INSERT OR IGNORE INTO metadata VALUES ('last_event','0');`);
 mainDb.exec(`CREATE TABLE IF NOT EXISTS quest_resident_memory_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,
  peer_kind TEXT NOT NULL,peer TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL);`);
 const hasCharacters=!!mainDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quest_characters'").get();
 const existingPlayer=id=>!hasCharacters||!!mainDb.prepare('SELECT 1 FROM quest_characters WHERE id=?').get(id); // Hide deleted players immediately, even while an outbox backlog is draining.
 if(hasCharacters)mainDb.exec(`CREATE TRIGGER IF NOT EXISTS resident_memory_character_deleted AFTER DELETE ON quest_characters BEGIN
  INSERT INTO quest_resident_memory_outbox(kind,peer_kind,peer,body,created) VALUES ('forget','player',OLD.id,'{}',0); END;`); // Deletion is durable even if the memory database is temporarily unavailable.

 function remember({resident,peerKind,peer,conversation,sourceSeq,speaker,speakerKind,text}){
  const shareable=peerKind==='player'&&speakerKind==='player'&&gossipEligible(text); // Check the full utterance before truncation, including privacy requests at the end.
  text=clean(text);if(!text||!resident||!peer)return;
  const body={resident,peerKind,peer,conversation,sourceSeq,speaker:clean(speaker,64),speakerKind,text,gossip:shareable?1:0};
  mainDb.prepare("INSERT INTO quest_resident_memory_outbox(kind,peer_kind,peer,body,created) VALUES ('remember',?,?,?,?)").run(peerKind,peer,JSON.stringify(body),now());
 } // Queue inside the chat transaction: a rollback cannot leave a phantom resident memory.

 function store(event){
  if(event.kind==='forget'){
   db.prepare("DELETE FROM memories WHERE peer_kind='player' AND peer=?").run(event.peer);
   db.prepare("DELETE FROM uses WHERE peer_kind='player' AND peer=?").run(event.peer);return;
  }
  const m=JSON.parse(event.body);
  db.prepare('INSERT OR IGNORE INTO memories(event_id,resident,peer_kind,peer,conversation,source_seq,speaker,speaker_kind,text,gossip,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
   .run(event.id,m.resident,m.peerKind,m.peer,m.conversation,m.sourceSeq,m.speaker,m.speakerKind,m.text,m.gossip,event.created);
  db.prepare('DELETE FROM memories WHERE resident=? AND peer_kind=? AND peer=? AND id NOT IN (SELECT id FROM memories WHERE resident=? AND peer_kind=? AND peer=? ORDER BY id DESC LIMIT ?)')
   .run(m.resident,m.peerKind,m.peer,m.resident,m.peerKind,m.peer,RESIDENT_MEMORY_LIMITS.perPair);
  db.prepare('DELETE FROM memories WHERE resident=? AND (peer_kind,peer) NOT IN (SELECT peer_kind,peer FROM memories WHERE resident=? GROUP BY peer_kind,peer ORDER BY MAX(id) DESC LIMIT ?)')
   .run(m.resident,m.resident,RESIDENT_MEMORY_LIMITS.peersPerResident); // Bound both lengthy friendships and the number of visitors retained.
 }
 function drain(){
  if(closed||mainDb.isTransaction)return 0;
  try{
   const done=Number(db.prepare("SELECT value FROM metadata WHERE key='last_event'").get().value);
   mainDb.prepare('DELETE FROM quest_resident_memory_outbox WHERE id<=?').run(done); // A crash after the sidecar commit but before acknowledgement cannot replay old memories.
   const events=mainDb.prepare('SELECT * FROM quest_resident_memory_outbox ORDER BY id LIMIT 200').all();if(!events.length)return 0;
   db.exec('BEGIN IMMEDIATE');try{
    for(const event of events)store(event);
    db.prepare("UPDATE metadata SET value=? WHERE key='last_event'").run(String(events.at(-1).id));db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   mainDb.prepare('DELETE FROM quest_resident_memory_outbox WHERE id<=?').run(events.at(-1).id);return events.length;
  }catch(error){log('resident_memory_drain_failed',String(error?.message??error).slice(0,200));return 0;} // Keep the outbox for a later tick/restart; a storage outage never loses committed chat.
 }
 function offered(rows,purpose,{conversation='',requestId='',targetKind='',targetPeer='',targetName=''}={}){
  if(requestId)for(const row of rows)db.prepare('INSERT INTO uses(memory_id,resident,peer_kind,peer,conversation,request_id,purpose,source_seq,speaker,text,offered,target_kind,target_peer,target_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(row.id,row.resident,row.peer_kind,row.peer,conversation,requestId,purpose,row.source_seq,row.speaker,row.text,now(),targetKind,targetPeer,clean(targetName,64));
  if(requestId)db.prepare('DELETE FROM uses WHERE id NOT IN (SELECT id FROM uses ORDER BY id DESC LIMIT ?)').run(RESIDENT_MEMORY_LIMITS.audit);
  return rows.map(row=>`${row.speaker} said: ${row.text}`);
 } // Snapshot offered evidence, not a claim that the model actually used it; source text survives normal recall eviction.
 function recall(resident,peerKind,peer,options={}){
  drain();const {conversation='',message=''}=options;
  if(peerKind==='player'&&!existingPlayer(peer))return [];
  const rows=db.prepare('SELECT * FROM memories WHERE resident=? AND peer_kind=? AND peer=? AND conversation<>? ORDER BY id DESC LIMIT ?')
   .all(resident,peerKind,peer,conversation,RESIDENT_MEMORY_LIMITS.perPair),query=terms(message);
  const ranked=rows.map((row,i)=>({row,score:[...terms(row.text)].filter(w=>query.has(w)).length+1/(i+1)})).sort((a,b)=>b.score-a.score);
  const chosen=new Map(rows.slice(0,2).map(row=>[row.id,row])); // Retain newest corrections alongside relevant older statements.
  for(const {row} of ranked){if(chosen.size>=RESIDENT_MEMORY_LIMITS.recall)break;chosen.set(row.id,row);}
  return offered([...chosen.values()].sort((a,b)=>a.id-b.id),'recall',options);
 }
 function gossip(resident,options={}){
  drain();const {conversation='',message=''}=options,query=terms(message);
  const rows=db.prepare("SELECT * FROM memories WHERE resident=? AND peer_kind='player' AND speaker_kind='player' AND conversation<>? ORDER BY id DESC LIMIT 128").all(resident,conversation);
  const latest=new Map();for(const row of rows)if(!latest.has(row.peer))latest.set(row.peer,row); // Newer refusals/private statements supersede an older shareable remark.
  const chosen=[...latest.values()].filter(row=>row.gossip&&existingPlayer(row.peer)).map(row=>({row,score:[...terms(row.text)].filter(w=>query.has(w)).length}))
   .sort((a,b)=>b.score-a.score||b.row.id-a.row.id).slice(0,RESIDENT_MEMORY_LIMITS.gossip).map(({row})=>row);
  return offered(chosen,'gossip',options);
 }
 function forgetPlayer(id){mainDb.prepare("INSERT INTO quest_resident_memory_outbox(kind,peer_kind,peer,body,created) VALUES ('forget','player',?,'{}',?)").run(id,now());drain();} // Clear the player's recall and audit snapshots through the same durable queue.
 function view(){drain();return {file,entries:db.prepare('SELECT COUNT(*) n FROM memories').get().n,pairs:db.prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM memories GROUP BY resident,peer_kind,peer)').get().n,
  offered:db.prepare('SELECT COUNT(*) n FROM uses').get().n,pending:mainDb.prepare('SELECT COUNT(*) n FROM quest_resident_memory_outbox').get().n};}
 return {remember,recall,gossip,forgetPlayer,view,drain,close(){if(closed)return;drain();closed=true;db.close();}}; // No extra model calls, invented summaries, relationship scores or lore unlocks.
}
