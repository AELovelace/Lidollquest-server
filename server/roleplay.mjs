import {inspectionProjection} from './inspection.mjs';
import {awardExperience} from './combat.mjs';
import {randomInt} from 'node:crypto';

export const RP_MAX_CHARACTERS=12000;
export const rpTarget=awards=>1000+500*awards; // Each admin-awarded RP level raises the next writing target.
const fail=(status,message)=>{throw Object.assign(Error(message),{status,code:'rp_request_failed'});};
const level=c=>Math.max(1,Number(JSON.parse(c.state).loadout?.player_info?.level)||1);
export function createRoleplay(db,{now=Date.now,roll=randomInt}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_rp_posts(id INTEGER PRIMARY KEY AUTOINCREMENT,author TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,area TEXT NOT NULL,text TEXT NOT NULL,appearance TEXT NOT NULL,words INTEGER NOT NULL,chars INTEGER NOT NULL,created INTEGER NOT NULL,chat_seq INTEGER);
 CREATE INDEX IF NOT EXISTS quest_rp_area ON quest_rp_posts(area,id);
 CREATE INDEX IF NOT EXISTS quest_rp_author ON quest_rp_posts(author,id);
 CREATE UNIQUE INDEX IF NOT EXISTS quest_rp_notice ON quest_rp_posts(chat_seq);
 CREATE TABLE IF NOT EXISTS quest_rp_partners(post_id INTEGER NOT NULL,character_id TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(post_id,character_id));
 CREATE INDEX IF NOT EXISTS quest_rp_partner ON quest_rp_partners(character_id,post_id);
 CREATE TABLE IF NOT EXISTS quest_rp_reads(character_id TEXT PRIMARY KEY,last_read_id INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS quest_rp_progress(character_id TEXT PRIMARY KEY,total_words INTEGER NOT NULL DEFAULT 0,total_chars INTEGER NOT NULL DEFAULT 0,level_words INTEGER NOT NULL DEFAULT 0,level_chars INTEGER NOT NULL DEFAULT 0,last_level INTEGER NOT NULL,awards INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS quest_rp_awards(id INTEGER PRIMARY KEY AUTOINCREMENT,character_id TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,from_level INTEGER NOT NULL,to_level INTEGER NOT NULL,words INTEGER NOT NULL,chars INTEGER NOT NULL,target INTEGER NOT NULL,reason TEXT NOT NULL);`);
 function progress(c){
  const current=level(c);
  let r=db.prepare('SELECT * FROM quest_rp_progress WHERE character_id=?').get(c.id);
  if(!r)r={character_id:c.id,total_words:0,total_chars:0,level_words:0,level_chars:0,last_level:current,awards:0};
  else if(r.last_level!==current){db.prepare('UPDATE quest_rp_progress SET level_words=0,level_chars=0,last_level=? WHERE character_id=?').run(current,c.id);r={...r,level_words:0,level_chars:0,last_level:current};} // Combat and admin level changes both start a new writing window; ordinary polls do not write.
  return {...r,target:rpTarget(r.awards),eligible:r.level_words>=rpTarget(r.awards)};
 }
 const partners=id=>db.prepare('SELECT character_id AS id,name FROM quest_rp_partners WHERE post_id=? ORDER BY name').all(id);
 const summary=r=>({id:r.id,author:r.author,name:r.name,area:r.area,words:r.words,chars:r.chars,created:r.created,partners:partners(r.id)});
 function read(c,id,area,restricted=[]){
  const r=db.prepare('SELECT * FROM quest_rp_posts WHERE id=?').get(Number.isSafeInteger(id)?id:-1);
  if(!r||restricted.includes(r.owner)||(r.author!==c.id&&r.area!==area&&!partners(r.id).some(p=>p.id===c.id)))fail(404,'This RP post is not available here.');
  db.prepare('INSERT INTO quest_rp_reads(character_id,last_read_id) VALUES (?,?) ON CONFLICT(character_id) DO UPDATE SET last_read_id=MAX(last_read_id,excluded.last_read_id)').run(c.id,r.id); // Persist the existing newest-seen cursor only after access checks; reopening older history never moves it backwards.
  return {...summary(r),text:r.text,appearance:JSON.parse(r.appearance)}; // Only the public paperdoll projection is retained, never inventory or account details.
 }
 function snapshot(c,area,restricted=[]){
  if(!c)return {supported:true,maxCharacters:RP_MAX_CHARACTERS,seen:0,posts:[]};
  const rows=db.prepare('SELECT id,author,owner,name,area,words,chars,created FROM quest_rp_posts WHERE author=? OR id IN (SELECT post_id FROM quest_rp_partners WHERE character_id=?) ORDER BY id DESC LIMIT 40').all(c.id,c.id);
  const seen=db.prepare('SELECT last_read_id FROM quest_rp_reads WHERE character_id=?').get(c.id)?.last_read_id??0;
  return {supported:true,maxCharacters:RP_MAX_CHARACTERS,seen,progress:progress(c),posts:rows.filter(r=>!restricted.includes(r.owner)).map(summary)};
 }
 function post(c,input,area,candidates,at={x:null,y:null}){ // at: the author's tile, so the notice travels the same radius as speech.
  if(typeof input.text!=='string'||Array.from(input.text).length>RP_MAX_CHARACTERS)fail(400,'RP posts must be at most 12,000 characters.');
  const text=input.text.normalize('NFC').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069#]/g,' ').trim();
  const words=(text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)??[]).length,chars=Array.from(text).length;
  if(!words)fail(400,'Write a narrative before posting.');
  if(!Array.isArray(input.partners)||!input.partners.length||input.partners.length>8||new Set(input.partners).size!==input.partners.length)fail(400,'Choose between one and eight RP partners.');
  const chosen=input.partners.map(id=>candidates.find(p=>p.id===id));
  if(chosen.some(p=>!p||p.owner===c.owner))fail(409,'Choose players in this area-chat room; refresh if someone has moved.');
  if(db.prepare('SELECT 1 FROM quest_rp_posts WHERE owner=? AND created>?').get(c.owner,now()-10000))fail(429,'Wait ten seconds between RP posts.');
  db.prepare('INSERT OR IGNORE INTO quest_rp_progress(character_id,last_level) VALUES (?,?)').run(c.id,level(c));progress(c);
  const appearance=inspectionProjection(c);delete appearance.account_id;
  const id=Number(db.prepare('INSERT INTO quest_rp_posts(author,owner,name,area,text,appearance,words,chars,created) VALUES (?,?,?,?,?,?,?,?,?)').run(c.id,c.owner,c.name,area,text,JSON.stringify(appearance),words,chars,now()).lastInsertRowid);
  for(const p of chosen)db.prepare('INSERT INTO quest_rp_partners VALUES (?,?,?)').run(id,p.id,p.name);
  const seq=Number(db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created,x,y) VALUES (?,?,?,?,?,?,?,?)').run(area,c.owner,c.id,c.name,c.name+' posted an rp',now(),at?.x??null,at?.y??null).lastInsertRowid);
  db.prepare('UPDATE quest_rp_posts SET chat_seq=? WHERE id=?').run(seq,id);
  db.prepare('DELETE FROM quest_chat WHERE zone=? AND seq NOT IN (SELECT seq FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 100)').run(area,area);
  db.prepare('UPDATE quest_rp_progress SET total_words=total_words+?,total_chars=total_chars+?,level_words=level_words+?,level_chars=level_chars+? WHERE character_id=?').run(words,chars,words,chars,c.id);
  return id; // Only authors earn writing credit; selecting someone never gives that partner passive XP.
 }
 function journal(query={}){
  const page=Math.max(0,Math.min(100000,Number(query.page)||0)),search=String(query.search??'').trim().slice(0,100),character=String(query.character??'');
  const where='(?=\'\' OR author=? OR id IN (SELECT post_id FROM quest_rp_partners WHERE character_id=?)) AND (?=\'\' OR instr(lower(name||char(10)||text||char(10)||area),lower(?))>0 OR id IN (SELECT post_id FROM quest_rp_partners WHERE instr(lower(name),lower(?))>0))';
  const args=[character,character,character,search,search,search];
  const rows=db.prepare('SELECT * FROM quest_rp_posts WHERE '+where+' ORDER BY id DESC LIMIT 25 OFFSET ?').all(...args,Math.floor(page)*25);
  const roster=db.prepare('SELECT c.* FROM quest_characters c JOIN quest_rp_progress p ON p.character_id=c.id ORDER BY c.name').all().map(c=>({id:c.id,name:c.name,level:level(c),...progress(c)}));
  return {page:Math.floor(page),total:db.prepare('SELECT count(*) n FROM quest_rp_posts WHERE '+where).get(...args).n,characters:roster,posts:rows.map(r=>({...summary(r),text:r.text})),awards:db.prepare('SELECT * FROM quest_rp_awards WHERE ?=\'\' OR character_id=? ORDER BY id DESC LIMIT 50').all(character,character)};
 }
 function award(input,actor){
  db.exec('BEGIN IMMEDIATE');
  try{
   const c=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(String(input.character_id??''));
   if(!c)fail(404,'Choose an existing character.');
   const s=JSON.parse(c.state),p=s.loadout?.player_info,r=progress(c);
   if(!p||s.run||s.pendingDefeat||s.worldTurnDue||s.pendingPurchase||db.prepare("SELECT 1 FROM quest_management WHERE character_id=? AND status='pending'").get(c.id))fail(409,'This character must finish their current action before a level can be awarded.');
   if(input.expected_awards!==r.awards||input.expected_level!==p.level)fail(409,'Progress changed. Refresh the RP journal before awarding.');
   if(!r.eligible)fail(409,'This character has not reached the current word target.');
   const reason=String(input.reason??'').trim().slice(0,240);if(!reason)fail(400,'Add a short review note for this award.');
   const from=p.level;s.run={enemy:{exp:50*p.level},hp:p.playerHealth,maxHp:p.playerHealthMax,log:[]};
   awardExperience(s,roll);const messages=s.run.log;s.run=null;s.loadoutRevision=c.revision+1;
   db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(s),c.id);
   db.prepare('UPDATE quest_rp_progress SET awards=awards+1,level_words=0,level_chars=0,last_level=? WHERE character_id=?').run(p.level,c.id);
   db.prepare('INSERT INTO quest_rp_awards(character_id,actor,created,from_level,to_level,words,chars,target,reason) VALUES (?,?,?,?,?,?,?,?,?)').run(c.id,actor,now(),from,p.level,r.level_words,r.level_chars,r.target,reason);
   db.exec('COMMIT');return {characterId:c.id,name:c.name,fromLevel:from,level:p.level,words:r.level_words,chars:r.level_chars,target:r.target,messages};
  }catch(error){db.exec('ROLLBACK');throw error;}
 } // Revision and award-count checks make double clicks and concurrent staff reviews safe.
 return {snapshot,post,read,journal,award,progress};
}
