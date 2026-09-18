import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';

export function createOnlineFeed(db,{token='',now=Date.now}={}){
 if(token&&!/^[A-Za-z0-9_-]{32,128}$/.test(token))throw Error('MOMMYBOT_ONLINE_TOKEN must be 32-128 URL-safe secret characters.');
 db.exec(`CREATE TABLE IF NOT EXISTS mommybot_online_meta(id INTEGER PRIMARY KEY CHECK(id=1),stream TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mommybot_online_seen(owner TEXT PRIMARY KEY,seen INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS mommybot_online_events(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,name TEXT NOT NULL,joined_at INTEGER NOT NULL);`);
 db.prepare('INSERT OR IGNORE INTO mommybot_online_meta VALUES (1,?)').run(randomUUID());
 const hash=value=>createHash('sha256').update(value).digest();
 return {
  record(character,presence){
   if(!token||!presence||presence.seen<=now()-30000)return;
   const previous=db.prepare('SELECT seen FROM mommybot_online_seen WHERE owner=?').get(character.owner);
   if(!previous||presence.seen-previous.seen>120000)db.prepare('INSERT INTO mommybot_online_events(owner,name,joined_at) VALUES (?,?,?)').run(character.owner,character.name,now());
   db.prepare('INSERT INTO mommybot_online_seen VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET seen=MAX(seen,excluded.seen)').run(character.owner,presence.seen);
  }, // Called inside the authenticated gameplay transaction; heartbeats, portals and brief reconnects share one arrival.
  route(req,res,url){
   if(url.pathname!=='/integrations/mommybot/joins')return false;
   const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));return true;};
   if(!token)return send(503,{error:'online_feed_disabled'});
   if(req.headers.origin||!timingSafeEqual(hash(String(req.headers.authorization||'')),hash('Bearer '+token)))return send(401,{error:'online_feed_unauthorized'});
   if(req.method!=='GET')return send(405,{error:'method_not_allowed'});
   const after=Number(url.searchParams.get('after')||0),limit=Number(url.searchParams.get('limit')||20);
   if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)return send(400,{error:'invalid_page'});
   const latest=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('mommybot_online_events')?.seq??0;
   const events=db.prepare(`SELECT e.id,e.name,e.joined_at,EXISTS(SELECT 1 FROM quest_presence p WHERE p.owner=e.owner AND p.seen>?) AS online
    FROM mommybot_online_events e WHERE e.id>? ORDER BY e.id LIMIT ?`).all(now()-30000,after,limit);
   const next=events.at(-1)?.id??Math.max(after,latest); // Pruned history can leave a gap; advance it without returning an empty endless page.
   return send(200,{stream:db.prepare('SELECT stream FROM mommybot_online_meta WHERE id=1').get().stream,events,latest_cursor:latest,next_cursor:next,has_more:next<latest});
  }, // The server-only credential reveals character names and join times, never account IDs, grants, inventory or care activity.
  prune(){db.prepare('DELETE FROM mommybot_online_events WHERE joined_at<?').run(now()-7*86400000);},
 };
}
