import {createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {hubCatalog,hubRooms,campaignDives} from './hubs.mjs';

const ONLINE_WINDOW=30000; // Matches the presence freshness window every other module already uses.
const HUB_SPAWN={x:10,y:9}; // hubDefinition() falls back to this same tile when a lobby declares no spawn of its own.
const KINDS=Object.freeze(['mute','suspend']); // The only two sanctions a gamemaster can place on an account.
const CONTROL=/[\x00-\x1f\x7f]/g; // Stripped from every stored string so no reason or announcement can smuggle in line breaks.
const panelPage=readFileSync(new URL('./gm-panel.html',import.meta.url),'utf8'); // Read once at boot so a moderation click never touches the disk.

export const gmZones=Object.freeze([
 ...hubCatalog.map(h=>({id:h.id,name:h.name,kind:'lobby',warp:true,spawn:HUB_SPAWN})),
 ...hubRooms.map(r=>({id:r.id,name:r.name,kind:r.kind,warp:true,spawn:r.spawn})),
 {id:'dive-quarters',name:"Princess' Quarters",kind:'dive',warp:false},
 {id:'dive-desert',name:'Dustbreak Desert',kind:'dive',warp:false},
 {id:'dive-tundra',name:'Frostveil Tundra',kind:'dive',warp:false},
 ...campaignDives.map(({config})=>({id:config.zone_id,name:config.name,kind:'dive',warp:false})),
].map(Object.freeze)); // Dives are edition-scoped instances, so they are listed for observation but never offered as warp destinations.

const zoneById=new Map(gmZones.map(z=>[z.id,z]));
const zoneName=id=>zoneById.get(id)?.name??id; // Unknown ids still read sensibly if a new route ships before this catalogue is updated.
const safeParse=text=>{try{return JSON.parse(text);}catch{return {};}}; // One unreadable row must never take the whole moderation surface down.
const scalars=value=>Object.fromEntries(Object.entries(value??{}).filter(([,v])=>v===null||['number','string','boolean'].includes(typeof v))); // Summarise a character without dumping its inventory into a staff console.
const clean=(value,max)=>String(value??'').replace(CONTROL,' ').trim().slice(0,max); // Every operator-supplied string passes through here before storage.

export function createGameMasterPanel(db,{token='',now=Date.now,log=console.warn}={}){
 if(token&&!/^[A-Za-z0-9_-]{32,128}$/.test(token))throw Error('LIDOLLQUEST_GM_TOKEN must be 32-128 URL-safe secret characters.');
 db.exec(`CREATE TABLE IF NOT EXISTS gm_sanctions(owner TEXT NOT NULL,kind TEXT NOT NULL,until INTEGER NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(owner,kind));
 CREATE TABLE IF NOT EXISTS gm_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS gm_audit_target ON gm_audit(target,id);`);
 const hash=value=>createHash('sha256').update(value).digest(); // Fixed-width digests keep the comparison below constant time for any header length.
 const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,code:code??'gm_request_failed'});}; // Mirrors the rejection shape the rest of the service already throws.

 function sanction(owner,kind){
  const row=db.prepare('SELECT * FROM gm_sanctions WHERE owner=? AND kind=?').get(owner,kind); // One row per account per sanction kind.
  if(!row)return null;
  if(row.until&&row.until<=now()){db.prepare('DELETE FROM gm_sanctions WHERE owner=? AND kind=?').run(owner,kind);return null;} // Expired timers clear themselves on the next lookup instead of needing a sweeper.
  return row;
 }
 const muted=owner=>Boolean(sanction(owner,'mute'));        // Handed to the zone engine so a silenced account still walks and fights normally.
 const suspended=owner=>Boolean(sanction(owner,'suspend')); // Handed to the request gate so a blocked account cannot reach gameplay at all.
 const record=(action,target,detail={})=>db.prepare('INSERT INTO gm_audit(action,target,detail,created) VALUES (?,?,?,?)').run(action,target,JSON.stringify(detail),now()); // Every state change leaves a reviewable trail.

 function roster(){
  return db.prepare(`SELECT p.owner,p.character_id,p.zone,p.x,p.y,p.seen,p.controller,c.name,c.revision,c.state
   FROM quest_presence p JOIN quest_characters c ON c.id=p.character_id WHERE p.seen>? ORDER BY p.zone,c.name`).all(now()-ONLINE_WINDOW)
   .map(row=>{
    const state=safeParse(row.state);
    return {owner:row.owner,characterId:row.character_id,name:row.name,revision:row.revision,
     zone:row.zone,zoneName:zoneName(row.zone),x:row.x,y:row.y,controller:row.controller,
     idleMs:now()-row.seen,avatar:state.avatar??'player',
     stage:state.run?.stage??0,fighting:state.run?.phase==='fight',
     dive:state.dive?{zone:state.dive.zone??null,edition:state.dive.edition??null}:null,
     muted:muted(row.owner),suspended:suspended(row.owner)};
   }); // Presence is the authoritative "who is playing right now" view; stale rows are already excluded by the query.
 }

 function overview(){
  const players=roster(),counts=new Map();
  for(const p of players)counts.set(p.zone,(counts.get(p.zone)??0)+1); // Count from the same list the panel renders so the two can never disagree.
  return {serverTime:now(),
   zones:gmZones.map(z=>({...z,players:counts.get(z.id)??0})),
   players,
   sanctions:db.prepare('SELECT * FROM gm_sanctions ORDER BY created DESC').all().filter(row=>!row.until||row.until>now()),
   audit:db.prepare('SELECT * FROM gm_audit ORDER BY id DESC LIMIT 50').all().map(row=>({...row,detail:safeParse(row.detail)})),
   totals:{online:players.length,
    characters:db.prepare('SELECT COUNT(*) AS n FROM quest_characters').get().n,
    accounts:db.prepare('SELECT COUNT(DISTINCT owner) AS n FROM quest_characters').get().n}};
 }

 function chat(zone,limit){
  const rows=zone
   ?db.prepare('SELECT seq,zone,owner,character_id,name,text,created FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT ?').all(zone,limit)
   :db.prepare('SELECT seq,zone,owner,character_id,name,text,created FROM quest_chat ORDER BY seq DESC LIMIT ?').all(limit); // Omitting the zone reads the whole server's recent traffic.
  return {serverTime:now(),zone:zone??null,messages:rows.reverse().map(row=>({
   seq:row.seq,zone:row.zone,zoneName:zoneName(row.zone),characterId:row.character_id,name:row.name,text:row.text,created:row.created,
   owner:row.owner.replace(/^activity:/,''),activity:row.owner.startsWith('activity:')}))}; // Automatic care announcements are tagged rather than hidden, so a gamemaster can tell them from typed speech.
 }

 function player(owner,characterId){
  if(!owner&&characterId)owner=db.prepare('SELECT owner FROM quest_characters WHERE id=?').get(characterId)?.owner; // Look an account up from whichever handle the panel happens to be holding.
  if(!owner)fail(404,'No such player.','gm_unknown_player');
  const characters=db.prepare('SELECT id,name,revision,created,state FROM quest_characters WHERE owner=? ORDER BY created,id').all(owner).map(row=>{
   const state=safeParse(row.state);
   return {id:row.id,name:row.name,revision:row.revision,created:row.created,avatar:state.avatar??'player',
    hubVisit:state.hubVisit??null,
    run:state.run?{zone:state.run.zone,stage:state.run.stage,phase:state.run.phase,hp:state.run.hp}:null,
    dive:state.dive?{zone:state.dive.zone??null,edition:state.dive.edition??null}:null,
    playerInfo:scalars(state.loadout?.player_info)}; // Only flat values travel: no inventory, no equipment, no credentials.
  });
  if(!characters.length)fail(404,'No such player.','gm_unknown_player');
  return {serverTime:now(),owner,characters,
   presence:roster().find(p=>p.owner===owner)??null,
   sanctions:KINDS.map(kind=>sanction(owner,kind)).filter(Boolean),
   chat:db.prepare('SELECT seq,zone,name,text,created FROM quest_chat WHERE owner=? OR owner=? ORDER BY seq DESC LIMIT 40').all(owner,'activity:'+owner).reverse().map(row=>({...row,zoneName:zoneName(row.zone)})),
   audit:db.prepare('SELECT * FROM gm_audit WHERE target=? ORDER BY id DESC LIMIT 25').all(owner).map(row=>({...row,detail:safeParse(row.detail)}))};
 }

 const online=owner=>db.prepare('SELECT * FROM quest_presence WHERE owner=? AND seen>?').get(owner,now()-ONLINE_WINDOW); // Shared by the actions that only make sense against a live session.

 function place(kind,input){
  const owner=clean(input.owner,64)||fail(400,'Choose an account.','gm_unknown_player');
  if(!db.prepare('SELECT 1 AS n FROM quest_characters WHERE owner=? LIMIT 1').get(owner))fail(404,'No such player.','gm_unknown_player');
  const minutes=Number(input.minutes??0);
  if(!Number.isSafeInteger(minutes)||minutes<0||minutes>525600)fail(400,'Use 0 for indefinite, or up to one year in minutes.','gm_bad_duration');
  const until=minutes?now()+minutes*60000:0,reason=clean(input.reason,240); // Zero records an indefinite sanction that only a gamemaster can lift.
  db.prepare('INSERT INTO gm_sanctions VALUES (?,?,?,?,?) ON CONFLICT(owner,kind) DO UPDATE SET until=excluded.until,reason=excluded.reason,created=excluded.created').run(owner,kind,until,reason,now());
  if(kind==='suspend')db.prepare('DELETE FROM quest_presence WHERE owner=?').run(owner); // A suspension takes effect at once rather than at the end of the current session.
  record(kind,owner,{until,minutes,reason});
  return {owner,kind,until,reason};
 }
 function lift(kind,input){
  const owner=clean(input.owner,64)||fail(400,'Choose an account.','gm_unknown_player');
  if(!db.prepare('DELETE FROM gm_sanctions WHERE owner=? AND kind=?').run(owner,kind).changes)fail(404,'That account has no '+kind+' in place.','gm_no_sanction');
  record('un'+kind,owner,{reason:clean(input.reason,240)});
  return {owner,kind};
 }

 const actions={
  kick(input){
   const p=online(clean(input.owner,64))??fail(409,'That account is not in a zone right now.','gm_not_online');
   db.prepare('DELETE FROM quest_presence WHERE owner=?').run(p.owner); // The client's next command fails its presence check and the player returns to character select.
   record('kick',p.owner,{zone:p.zone,character:p.character_id,reason:clean(input.reason,240)});
   return {owner:p.owner,zone:p.zone,zoneName:zoneName(p.zone)};
  },
  warp(input){
   const target=zoneById.get(String(input.zone??''))??fail(400,'Choose a destination room.','gm_unknown_zone');
   if(!target.warp)fail(409,'Dives are instanced runs; move the player to a lobby instead.','gm_zone_not_warpable');
   const p=online(clean(input.owner,64))??fail(409,'That account is not in a zone right now.','gm_not_online');
   const state=safeParse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(p.character_id)?.state??'{}');
   if(state.run||state.dive)fail(409,'Finish, forfeit or settle their run before moving them.','gm_run_in_progress'); // Relocating mid-run would strand that run's own zone bookkeeping.
   const spawn=target.spawn??HUB_SPAWN;
   db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE owner=?').run(target.id,spawn.x,spawn.y,now(),p.owner);
   record('warp',p.owner,{from:p.zone,to:target.id,reason:clean(input.reason,240)});
   return {owner:p.owner,from:zoneName(p.zone),to:target.name};
  },
  mute:input=>place('mute',input),
  suspend:input=>place('suspend',input),
  unmute:input=>lift('mute',input),
  unsuspend:input=>lift('suspend',input),
  broadcast(input){
   const zone=zoneById.get(String(input.zone??''))??fail(400,'Choose a room to announce in.','gm_unknown_zone');
   const message=clean(input.text,240)||fail(400,'Write an announcement first.','gm_empty_message');
   db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created) VALUES (?,?,?,?,?,?)').run(zone.id,'activity:gm','gm',clean(input.speaker,24)||'Gamemaster',message,now()); // The activity: prefix is the tag clients already render as an announcement rather than player speech.
   db.prepare('DELETE FROM quest_chat WHERE zone=? AND seq NOT IN (SELECT seq FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 100)').run(zone.id,zone.id); // Keep the hundred-message ceiling every other writer respects.
   record('broadcast',zone.id,{text:message});
   return {zone:zone.id,zoneName:zone.name,text:message};
  },
  delete_chat(input){
   const seq=Number(input.seq);
   if(!Number.isSafeInteger(seq)||seq<1)fail(400,'Choose a message to remove.','gm_unknown_message');
   const row=db.prepare('SELECT * FROM quest_chat WHERE seq=?').get(seq)??fail(404,'That message has already gone.','gm_unknown_message');
   db.prepare('DELETE FROM quest_chat WHERE seq=?').run(seq);
   record('delete_chat',row.owner.replace(/^activity:/,''),{zone:row.zone,name:row.name,text:row.text,reason:clean(input.reason,240)});
   return {seq,zone:row.zone,zoneName:zoneName(row.zone)};
  }};

 async function body(req){
  if(!String(req.headers['content-type']??'').startsWith('application/json'))fail(415,'Send JSON.','gm_bad_content_type');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>16*1024)fail(413,'Request too large.','gm_body_too_large');chunks.push(chunk);} // Moderation commands are tiny; this cap sits far below the gameplay gateway's.
  try{return JSON.parse(Buffer.concat(chunks));}catch{return fail(400,'Invalid JSON.','gm_bad_json');}
 }

 async function route(req,res,url){
  if(url.pathname!=='/gm'&&!url.pathname.startsWith('/gm/'))return false;
  const send=(status,payload)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(payload));return true;};
  if(!token)return send(503,{error:'gm_panel_disabled'}); // A deployment without the secret exposes no staff surface whatsoever.
  if(url.pathname==='/gm'){
   if(req.method!=='GET')return send(405,{error:'gm_method_not_allowed'});
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'"});
   res.end(panelPage);return true; // The shell carries no player data: every figure on it arrives through an authorised fetch below.
  }
  const origin=req.headers.origin;
  if(origin&&origin!=='http://'+req.headers.host&&origin!=='https://'+req.headers.host)return send(403,{error:'gm_bad_origin'}); // The panel's own writes are same-origin, and a forged page could not attach the bearer header anyway.
  if(!timingSafeEqual(hash(String(req.headers.authorization||'')),hash('Bearer '+token)))return send(401,{error:'gm_unauthorized'});
  try{
   if(url.pathname==='/gm/overview'&&req.method==='GET')return send(200,overview());
   if(url.pathname==='/gm/chat'&&req.method==='GET'){
    const limit=Number(url.searchParams.get('limit')??'60');
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)return send(400,{error:'gm_invalid_page'});
    const zone=url.searchParams.get('zone');
    if(zone&&!zoneById.has(zone))return send(400,{error:'gm_unknown_zone'});
    return send(200,chat(zone||null,limit));
   }
   if(url.pathname==='/gm/player'&&req.method==='GET')return send(200,player(url.searchParams.get('owner')||null,url.searchParams.get('character_id')||null));
   if(url.pathname==='/gm/action'&&req.method==='POST'){
    const input=await body(req),handler=Object.hasOwn(actions,String(input?.action??''))?actions[input.action]:null; // Own-property lookup only, so no prototype key can be invoked as an action.
    if(!handler)return send(400,{error:'gm_unknown_action'});
    return send(200,{ok:true,action:input.action,serverTime:now(),result:handler(input)});
   }
   return send(404,{error:'gm_endpoint_not_found'});
  }catch(error){
   if(!error.status)log('gm_action_failed',url.pathname,error?.message??'unknown'); // Only the route name reaches the log; moderation reasons and player text never do.
   return send(error.status??500,{error:error.code??'gm_request_failed',error_description:error.status?error.message:'The gamemaster panel is temporarily unavailable.'});
  }
 }

 return {route,muted,suspended,sanction,overview,chat,player,act:(action,payload={})=>Object.hasOwn(actions,action)?actions[action](payload):fail(400,'Unknown action.','gm_unknown_action')};
} // The shared staff secret owns this surface entirely; it never reads wallet credentials and never writes character inventories.
