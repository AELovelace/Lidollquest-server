// Server-wide gamemaster announcements. One announcement is active at a time; every online snapshot carries it
// (`announcement`) so each client shows a banner and logs it once, whatever room, Dive or fight the player is in.
// Both the web panel (gm.mjs `announce` / `announce_end`) and the in-game GM tools (gm-tools.mjs `gm_announce` /
// `gm_announce_end`) post through here, so the rules and the audit trail are identical.
const CONTROL=/[\x00-\x1f\x7f]/g; // Line breaks and control characters never reach a stored announcement.
const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,code});};
export const ANNOUNCEMENT_MAX=240;   // Characters of text, the same ceiling as room announcements and chat lines.
export const ANNOUNCEMENT_MINUTES={default:10,min:1,max:1440}; // How long the banner stays up; a day at most.
export function createAnnouncements(db,{now}){
 db.exec('CREATE TABLE IF NOT EXISTS quest_announcements(id INTEGER PRIMARY KEY AUTOINCREMENT,text TEXT NOT NULL,speaker TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,actor TEXT NOT NULL,ended INTEGER)');
 const clean=(value,max)=>typeof value==='string'?value.replace(CONTROL,' ').trim().slice(0,max):'';
 const shape=row=>row?{id:row.id,text:row.text,speaker:row.speaker,created:row.created,expires:row.expires}:null; // What clients and the panel see; the actor stays in the audit log.
 function active(){return shape(db.prepare('SELECT * FROM quest_announcements WHERE ended IS NULL AND expires>? ORDER BY id DESC LIMIT 1').get(now()));} // Newest unexpired, unended announcement, or null.
 function post({text,speaker,minutes},actor){ // Replaces any active announcement; returns the stored row.
  const message=clean(text,ANNOUNCEMENT_MAX);if(!message)fail(400,'Write an announcement first.','gm_empty_message');
  const name=clean(speaker,24)||'Gamemaster';
  const length=minutes===undefined||minutes===null||minutes===''?ANNOUNCEMENT_MINUTES.default:Number(minutes);
  if(!Number.isInteger(length)||length<ANNOUNCEMENT_MINUTES.min||length>ANNOUNCEMENT_MINUTES.max)fail(400,'Announcements last 1 to 1440 minutes.','gm_invalid_minutes');
  const at=now();
  db.prepare('UPDATE quest_announcements SET ended=? WHERE ended IS NULL AND expires>?').run(at,at); // Only one banner at a time; the newer one wins.
  const id=db.prepare('INSERT INTO quest_announcements(text,speaker,created,expires,actor) VALUES (?,?,?,?,?)').run(message,name,at,at+length*60000,actor??'').lastInsertRowid;
  return {...shape(db.prepare('SELECT * FROM quest_announcements WHERE id=?').get(id)),minutes:length};
 }
 function end(){ // Takes the current banner down early; returns what was ended, or null when nothing was up.
  const current=active();if(!current)return null;
  db.prepare('UPDATE quest_announcements SET ended=? WHERE id=?').run(now(),current.id);return current;
 }
 const history=(limit=20)=>db.prepare('SELECT * FROM quest_announcements ORDER BY id DESC LIMIT ?').all(Math.max(1,Math.min(200,Number(limit)||20))).map(row=>({...shape(row),actor:row.actor,ended:row.ended})); // For staff review; never sent to players.
 return {active,post,end,history};
}
