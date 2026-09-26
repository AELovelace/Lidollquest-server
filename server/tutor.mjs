// Tutorial NPC ("Pip"): players ask questions in the hub lobbies and npc-rag (the AI server, see C:/Scripts/npc-rag)
// answers them from the player wiki. The slow AI call never runs inside a player command:
//   1. tutor_ask (zones.mjs) validates and stores a 'pending' row inside the ordinary command transaction.
//   2. kick() (called by service.mjs after that command, and every few seconds) sends pending rows to npc-rag.
//   3. The answer is written back to the row; view() puts it in the next snapshot as `tutor`, which the client shows.
import {createHash} from 'node:crypto';
import {hubPortals,nearbyFixture} from './hubs.mjs';

export const TUTOR_LOBBIES=Object.freeze(['princess-rose','honeydew-lantern','littlebig-clockwork','utopia-arcanum','arcadia-foundry']); // Every starting hub gets a Pip.
export const TUTOR_FIXTURE_ID='tutor';
export const TUTOR_AVATAR='objNPCLibrarian'; // A guide who knows "the guidebook"; any avatars.json id works.
export const TUTOR_DEFAULTS=Object.freeze({
 enabled:true,
 name:'Pip',
 greeting:"Hi there! I'm Pip, and I help new arrivals find their feet. Ask me anything about how things work around here!",
});
const MAX_QUESTION=300;          // Characters; npc-rag accepts up to 500.
const VIEW_MS=10*60*1000;        // A reply stays in the snapshot this long after it was asked.
const STALE_MS=3*60*1000;        // A pending row older than this has been retried enough; it fails with a friendly line.
const RETRY_MS=15*1000;          // Wait before retrying a row whose npc-rag call failed.
const KEEP_MS=30*86400000;       // Q&A rows are kept 30 days for the GM log, then pruned.
const FALLBACK="Hmm, my thoughts are all tangled up right now. Could you ask me again in a little while?";

const fail=(status,message,code='tutor_unavailable')=>{throw Object.assign(Error(message),{status,code});};
const cleanText=v=>String(v??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim(); // One line, no control characters.

export function createTutor(db,{url=process.env.NPC_RAG_URL||'',key=process.env.NPC_RAG_KEY||'',now=Date.now,fetch=globalThis.fetch,log=console.warn,
 timeoutMs=Number(process.env.NPC_RAG_TIMEOUT_MS||45000),dailyLimit=Number(process.env.TUTOR_DAILY_LIMIT||100),cooldownMs=4000,concurrency=3}={}){
 const base=String(url).replace(/\/+$/,''); // Empty = not configured: Pip stays hidden whatever the GM switch says.
 db.exec(`CREATE TABLE IF NOT EXISTS quest_tutor(id TEXT PRIMARY KEY,owner TEXT NOT NULL,character_id TEXT NOT NULL,player_name TEXT NOT NULL,
  npc_name TEXT NOT NULL,zone TEXT NOT NULL,question TEXT NOT NULL,reply TEXT,sources TEXT,status TEXT NOT NULL,detail TEXT,attempts INTEGER NOT NULL DEFAULT 0,
  next_try INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,answered INTEGER);
 CREATE INDEX IF NOT EXISTS quest_tutor_character ON quest_tutor(character_id,created);
 CREATE INDEX IF NOT EXISTS quest_tutor_owner ON quest_tutor(owner,created);
 CREATE INDEX IF NOT EXISTS quest_tutor_status ON quest_tutor(status,next_try);
 CREATE TABLE IF NOT EXISTS quest_tutor_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');`);

 let cached=null; // Settings are read on every zone lookup, so keep them in memory until a GM changes them.
 function settings(){
  if(cached)return cached;
  const out={...TUTOR_DEFAULTS};
  for(const row of db.prepare('SELECT key,value FROM quest_tutor_settings').all())if(Object.hasOwn(TUTOR_DEFAULTS,row.key))out[row.key]=JSON.parse(row.value);
  return cached=out;
 }
 const active=()=>!!base&&settings().enabled; // Visible and answering only when configured AND switched on.

 // ── Placement ──────────────────────────────────────────────────────────────
 const spots=new Map(); // zone id + month edition -> chosen tile (or null), so monthly towns place Pip once per edition.
 function spot(z){
  const cacheKey=z.id+'|'+(z.district?.edition??'')+'|'+(z.width??0)+'x'+(z.height??0);
  if(spots.has(cacheKey))return spots.get(cacheKey);
  const walls=z.walls,w=z.width??walls?.[0]?.length??0,h=z.height??walls?.length??0,spawn=z.spawn??{x:10,y:9};
  const covers=(f,x,y)=>x>=f.x&&y>=f.y&&x<f.x+(f.span_w??1)&&y<f.y+(f.span_h??1);
  const open=(x,y)=>x>0&&y>0&&x<w-1&&y<h-1&&(!walls||walls[y]?.[x]===0)&&!(z.fixtures??[]).some(f=>covers(f,x,y)); // Floor with nothing on it.
  const doors=[...hubPortals(z),...(z.exit?[z.exit]:[])]; // Keep doorways and gates clear so Pip never crowds an entrance.
  const nearDoor=(x,y)=>doors.some(d=>x>=d.x-2&&y>=d.y-2&&x<d.x+(d.w??1)+2&&y<d.y+(d.h??1)+2);
  let chosen=null;
  for(let r=2;r<=8&&!chosen;r++){ // Rings of growing distance from the spawn tile, scanned in a fixed order so every server agrees.
   for(let dy=-r;dy<=r&&!chosen;dy++)for(const dx of [r-Math.abs(dy),-(r-Math.abs(dy))]){
    const x=spawn.x+dx,y=spawn.y+dy;
    if(!open(x,y)||nearDoor(x,y))continue;
    if(![[1,0],[-1,0],[0,1],[0,-1]].some(([ax,ay])=>open(x+ax,y+ay)))continue; // Someone must be able to stand beside Pip to talk.
    chosen={x,y};break;
   }
  }
  if(spots.size>200)spots.clear(); // Editions roll monthly; never let the cache grow without bound.
  spots.set(cacheKey,chosen);
  return chosen;
 }

 function decorate(z){ // Adds Pip to a lobby zone definition (zones.mjs wraps every zone lookup with this).
  if(!z||!TUTOR_LOBBIES.includes(z.id)||!active()||(z.fixtures??[]).some(f=>f.id===TUTOR_FIXTURE_ID))return z;
  const at=spot(z);if(!at)return z; // No free tile: skip this lobby rather than block anything.
  const s=settings();
  return {...z,fixtures:[...(z.fixtures??[]),{id:TUTOR_FIXTURE_ID,kind:'npc',service:'tutor',name:s.name,avatar:TUTOR_AVATAR,line:s.greeting,x:at.x,y:at.y,span_w:1,span_h:1,solid:false}]}; // Non-solid: Pip can never seal a path.
 }

 // ── Asking (runs inside the player's command transaction; synchronous only) ──
 function ask(i,c,state,z,p,input){
  if(!active())fail(409,settings().name+' is not taking questions right now.');
  const npc=nearbyFixture(z,p,input.fixture,'npc');
  if(npc.service!=='tutor')fail(409,'Only '+settings().name+' answers questions like that.','tutor_wrong_npc');
  if(state.run)fail(409,'Finish your fight first.');
  const question=cleanText(input.text).slice(0,MAX_QUESTION);
  if(!question)fail(400,'Type a question first.','tutor_empty');
  const t=now();
  const last=db.prepare('SELECT status,created,answered FROM quest_tutor WHERE character_id=? ORDER BY created DESC LIMIT 1').get(c.id);
  if(last?.status==='pending')fail(429,settings().name+' is still thinking about your last question.','tutor_busy');
  if(last&&t-(last.answered??last.created)<cooldownMs)fail(429,'Give '+settings().name+' a moment to catch their breath.','tutor_cooldown');
  const day=t-(t%86400000); // UTC midnight.
  if(db.prepare('SELECT COUNT(*) AS n FROM quest_tutor WHERE owner=? AND created>=?').get(i.owner,day).n>=dailyLimit)fail(429,settings().name+' has answered all the questions they can today. Try the player wiki!','tutor_daily_limit');
  const id='tutor-'+createHash('sha256').update(c.id+'\n'+String(input.request_id??t)).digest('hex').slice(0,24); // A replayed request id maps to the same row.
  db.prepare(`INSERT OR IGNORE INTO quest_tutor(id,owner,character_id,player_name,npc_name,zone,question,status,created) VALUES (?,?,?,?,?,?,?,'pending',?)`)
   .run(id,i.owner,c.id,cleanText(c.name).slice(0,32)||'traveller',settings().name,z.id,question,t);
  return id;
 }

 // ── Answering (async, outside every transaction) ─────────────────────────
 const inFlight=new Set();
 const health={ok:null,at:0,detail:''}; // Last npc-rag outcome, for the GM panel.
 async function answer(row){
  inFlight.add(row.id);
  try{
   const res=await fetch(base+'/v1/npc/chat',{method:'POST',headers:{'Content-Type':'application/json',...(key?{'X-Api-Key':key}:{})},
    body:JSON.stringify({message:row.question,player_id:row.character_id,player_name:row.player_name,npc_name:row.npc_name}),signal:AbortSignal.timeout(timeoutMs)});
   if(res.status===429){db.prepare('UPDATE quest_tutor SET next_try=? WHERE id=?').run(now()+3000,row.id);return;} // npc-rag is still busy with this player: try again shortly, no attempt used.
   if(!res.ok)throw Object.assign(Error('npc-rag answered '+res.status),{status:res.status});
   const body=await res.json(),reply=cleanText(body.reply).slice(0,600);
   if(!reply)throw Error('npc-rag sent an empty reply');
   const sources=(Array.isArray(body.sources)?body.sources:[]).slice(0,3).map(s=>({title:cleanText(s.title).slice(0,80),section:cleanText(s.section).slice(0,80),url:/^https:\/\//.test(s.url)?String(s.url).slice(0,300):''}));
   const detail=JSON.stringify({category:body.category??'',guard:body.guard??'',fallback:!!body.fallback,ms:body.timings_ms?.total??null});
   db.prepare("UPDATE quest_tutor SET status='answered',reply=?,sources=?,detail=?,answered=? WHERE id=? AND status='pending'").run(reply,JSON.stringify(sources),detail,now(),row.id);
   Object.assign(health,{ok:true,at:now(),detail:body.fallback?'answered with a fallback line (AI model busy or down)':'ok'});
  }catch(error){
   const detail=error?.name==='TimeoutError'?'timed out after '+timeoutMs+' ms':String(error?.message??error).slice(0,200);
   Object.assign(health,{ok:false,at:now(),detail});log('tutor_answer_failed',detail); // Never log the question or player names.
   const attempts=(row.attempts??0)+1;
   if(attempts>=2)db.prepare("UPDATE quest_tutor SET status='failed',reply=?,attempts=?,detail=?,answered=? WHERE id=? AND status='pending'").run(FALLBACK,attempts,JSON.stringify({error:detail}),now(),row.id);
   else db.prepare('UPDATE quest_tutor SET attempts=?,next_try=? WHERE id=?').run(attempts,now()+RETRY_MS,row.id);
  }finally{inFlight.delete(row.id);}
 }

 function kick(){ // Start npc-rag calls for due pending rows; returns a promise that settles when the calls started here finish.
  const t=now();
  db.prepare("UPDATE quest_tutor SET status='failed',reply=?,answered=? WHERE status='pending' AND created<?").run(FALLBACK,t,t-STALE_MS); // Give up on anything stuck.
  if(!base)return Promise.resolve();
  const free=concurrency-inFlight.size;if(free<=0)return Promise.resolve();
  const rows=db.prepare("SELECT * FROM quest_tutor WHERE status='pending' AND next_try<=? ORDER BY created LIMIT ?").all(t,free+inFlight.size).filter(r=>!inFlight.has(r.id)).slice(0,free);
  return Promise.all(rows.map(answer)).catch(error=>log('tutor_kick_failed',String(error?.message??error).slice(0,200))); // Never an unhandled rejection (e.g. the database closing on shutdown).
 }

 // ── Views ──────────────────────────────────────────────────────────────────
 function view(characterId){ // The player's latest exchange with Pip, for the snapshot.
  if(!characterId)return null;
  const row=db.prepare('SELECT * FROM quest_tutor WHERE character_id=? AND created>=? ORDER BY created DESC LIMIT 1').get(characterId,now()-VIEW_MS);
  if(!row)return null;
  return {id:row.id,status:row.status,name:row.npc_name,question:row.question,reply:row.reply??'',sources:row.sources?JSON.parse(row.sources):[],created:row.created,answered:row.answered??null};
 }

 function gmView({limit=60}={}){
  const recent=db.prepare(`SELECT t.id,t.owner,t.character_id,t.player_name,t.npc_name,t.zone,t.question,t.reply,t.status,t.detail,t.created,t.answered FROM quest_tutor t ORDER BY t.created DESC LIMIT ?`).all(Math.min(200,Math.max(1,limit)))
   .map(r=>({...r,detail:r.detail?JSON.parse(r.detail):null}));
  const day=now()-(now()%86400000);
  return {settings:settings(),configured:!!base,service:base?new URL(base).host:'',health:{...health},dailyLimit,
   today:db.prepare('SELECT COUNT(*) AS n FROM quest_tutor WHERE created>=?').get(day).n,pending:db.prepare("SELECT COUNT(*) AS n FROM quest_tutor WHERE status='pending'").get().n,recent};
 }

 function gmSet(input,actor=''){ // GM panel: switch Pip on/off, rename, change the greeting. Takes effect on the next snapshot.
  const next={};
  if(input.enabled!==undefined){if(typeof input.enabled!=='boolean')fail(400,'enabled must be true or false.','tutor_invalid');next.enabled=input.enabled;}
  if(input.name!==undefined){const name=cleanText(input.name);if(!/^[A-Za-z][A-Za-z '\-]{0,23}$/.test(name))fail(400,'Name: 1-24 letters, spaces, apostrophes or hyphens.','tutor_invalid');next.name=name;}
  if(input.greeting!==undefined){const greeting=cleanText(input.greeting);if(!greeting||greeting.length>300)fail(400,'Greeting: 1-300 characters.','tutor_invalid');next.greeting=greeting;}
  if(!Object.keys(next).length)fail(400,'Nothing to change.','tutor_invalid');
  const put=db.prepare('INSERT INTO quest_tutor_settings(key,value,updated,actor) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated,actor=excluded.actor');
  for(const [k,v] of Object.entries(next))put.run(k,JSON.stringify(v),now(),actor);
  cached=null;return settings();
 }

 function prune(){db.prepare('DELETE FROM quest_tutor WHERE created<?').run(now()-KEEP_MS);}

 return {decorate,ask,kick,view,gmView,gmSet,prune,settings,configured:()=>!!base,busy:()=>inFlight.size};
}
