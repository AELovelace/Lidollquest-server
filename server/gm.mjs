import {createEnchanter,describeItem} from './enchantment.mjs';
import {createLootRoller,describeLoot,DEFAULT_TUNING} from './loot.mjs';
import {BlockList,isIPv4,isIPv6} from 'node:net';
import {readFileSync} from 'node:fs';
import {hubCatalog,hubRooms,campaignDives} from './hubs.mjs';
import {createRoleplay} from './roleplay.mjs';
import {createRpp} from './rpp.mjs';
import {routeCategory,ZONE_CATEGORY} from './zone-categories.mjs';

const ONLINE_WINDOW=30000; // Matches the presence freshness window every other module already uses.
const HUB_SPAWN={x:10,y:9}; // hubDefinition() falls back to this same tile when a lobby declares no spawn of its own.
const KINDS=Object.freeze(['mute','suspend']); // The only two sanctions a gamemaster can place on an account.
const CONTROL=/[\x00-\x1f\x7f]/g; // Stripped from every stored string so no reason or announcement can smuggle in line breaks.
const SIGNIN_SCOPE='wallet:read'; // The panel needs identity alone: no balance changes, saves, social data or character access.
const panelPage=readFileSync(new URL('./gm-panel.html',import.meta.url),'utf8').replace('<!-- GM_GUIDE -->',()=>readFileSync(new URL('./gm-guide.html',import.meta.url),'utf8')).replace('/* GM_GUIDE_SCRIPT */',()=>readFileSync(new URL('./gm-guide.js',import.meta.url),'utf8')).replace('/* WORLD_PANEL */',()=>readFileSync(new URL('./gm-world-panel.js',import.meta.url),'utf8').replace('/* MONSTER_EDITOR */',()=>readFileSync(new URL('./gm-monster-editor.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('./gm-quest-editor.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('./gm-orb-editor.js',import.meta.url),'utf8'))); // Read once at boot so a moderation click never touches the disk.

export const gmZones=Object.freeze([
 {id:'global:ooc',name:'Global chat (OOC)',kind:'chat',category:null,warp:false}, // Staff can review and remove global messages through the existing chat tools.
 ...hubCatalog.map(h=>({id:h.id,name:h.name,kind:'lobby',category:ZONE_CATEGORY.SAFE,warp:true,spawn:h.spawn??HUB_SPAWN})), // Rose Court's garden declares its own plaza spawn.
 ...hubRooms.map(r=>({id:r.id,name:r.name,kind:r.kind,category:ZONE_CATEGORY.SAFE,warp:true,spawn:r.spawn})),
 {id:'dive-quarters',name:"Princess' Quarters",kind:'dive',category:ZONE_CATEGORY.DIVE,warp:false},
 {id:'overworld-desert',category:ZONE_CATEGORY.OVERWORLD,name:'Dustbreak Desert',kind:'dive',warp:false},
 {id:'overworld-taiga',category:ZONE_CATEGORY.OVERWORLD,name:'Frostveil Taiga',kind:'dive',warp:false},
 {id:'overworld-high-desert',category:ZONE_CATEGORY.OVERWORLD,name:'Dustbreak High Desert',kind:'dive',warp:false},
 {id:'overworld-haunted-woods',category:ZONE_CATEGORY.OVERWORLD,name:'Haunted Woods',kind:'dive',warp:false},
 {id:'overworld-autumnal-plains',category:ZONE_CATEGORY.OVERWORLD,name:'Autumnal Plains',kind:'dive',warp:false},
 {id:'overworld-farmstead',category:ZONE_CATEGORY.OVERWORLD,name:'Farmstead',kind:'dive',warp:false},
 {id:'overworld-seafoam-coast',category:ZONE_CATEGORY.OVERWORLD,name:'Seafoam Coast',kind:'dive',warp:false},
 {id:'overworld-emberfall-caldera',category:ZONE_CATEGORY.OVERWORLD,name:'Emberfall Caldera',kind:'dive',warp:false},
 {id:'overworld-obsidian-spa',category:ZONE_CATEGORY.OVERWORLD,name:'Obsidian Spa',kind:'dive',warp:false},
 {id:'overworld-spooky-mansion',category:ZONE_CATEGORY.OVERWORLD,name:'Spooky Mansion',kind:'dive',warp:false},
 {id:'overworld-tundra',category:ZONE_CATEGORY.OVERWORLD,name:'Frostveil Tundra',kind:'dive',warp:false},
 ...campaignDives.map(({config})=>({id:config.zone_id,name:config.name,kind:'dive',category:routeCategory(config),warp:false})),
].map(Object.freeze)); // Dives are shared weekly floors whose visits the Dive engine owns, so the web panel's `warp` never targets them (in-game GM warps use gmPlace()).

const zoneById=new Map(gmZones.map(z=>[z.id,z]));
const zoneName=id=>zoneById.get(id)?.name??id; // Unknown ids still read sensibly if a new route ships before this catalogue is updated.
const safeParse=text=>{try{return JSON.parse(text);}catch{return {};}}; // One unreadable row must never take the whole moderation surface down.
const scalars=value=>Object.fromEntries(Object.entries(value??{}).filter(([,v])=>v===null||['number','string','boolean'].includes(typeof v))); // Summarise a character without dumping its inventory into a staff console.
const clean=(value,max)=>String(value??'').replace(CONTROL,' ').trim().slice(0,max); // Every operator-supplied string passes through here before storage.

const bareAddress=ip=>{ // Node reports IPv4 callers as ::ffff:10.1.1.23 on a dual-stack bind; compare the real address.
 const value=String(ip??'').replace(/%.*$/,''); // Drop any zone index an IPv6 link-local caller carries.
 const mapped=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
 return mapped?mapped[1]:value;
};
const inList=(list,address)=>Boolean(list&&address&&(isIPv4(address)||isIPv6(address))&&list.check(address,isIPv4(address)?'ipv4':'ipv6'));
const forwarded=value=>String(value??'').split(',').map(part=>part.trim()).filter(Boolean); // X-Forwarded-* headers are comma-separated hop lists.
export function buildAllowList(text){ // Comma-separated addresses and CIDR blocks; empty means any host may reach the sign-in page.
 const entries=String(text??'').split(',').map(part=>part.trim()).filter(Boolean);
 if(!entries.length)return null;
 const list=new BlockList();
 for(const entry of entries){
  const [address,bits]=entry.split('/');
  const family=isIPv4(address)?'ipv4':isIPv6(address)?'ipv6':null;
  if(!family)throw Error('LIDOLLQUEST_GM_ALLOW entry is not an IP address or CIDR block: '+entry);
  if(bits===undefined){list.addAddress(address,family);continue;}
  const width=Number(bits),limit=family==='ipv4'?32:128;
  if(!Number.isSafeInteger(width)||width<0||width>limit)throw Error('LIDOLLQUEST_GM_ALLOW prefix must be 0-'+limit+' for '+entry);
  list.addSubnet(address,width,family);
 }
 return list;
} // Rejected loudly at construction so a typo cannot silently admit the whole network.

export function createGameMasterPanel(db,{tutor=null,walletClient,announcements=null,live=null,artJobs=null,world=()=>null,performanceSnapshot=()=>null,enchantments=null,enchantmentTable=null,loot=null,lootTable=null,alchemy=null,alchemyTable=null,lootItems=null,lootBases=null,allow='',trustProxy='',requireTls=false,enabled=true,now=Date.now,log=console.warn}={}){
 const announcementStore=()=>typeof announcements==='function'?announcements():announcements; // Passed lazily by service.mjs because the zones module is created after the panel.
 const rp=createRoleplay(db,{now}); // RP journals use the same live staff authorization as every moderation tool.
 const rpp=createRpp(db,{now}); // Staff-only RPP gifts and purchase history never touch premium currencies.
 db.exec(`CREATE TABLE IF NOT EXISTS gm_sanctions(owner TEXT NOT NULL,kind TEXT NOT NULL,until INTEGER NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(owner,kind));
 CREATE TABLE IF NOT EXISTS gm_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS gm_audit_target ON gm_audit(target,id);`);
 if(!db.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name=?').get('gm_audit','actor').n)
  db.exec("ALTER TABLE gm_audit ADD COLUMN actor TEXT NOT NULL DEFAULT ''"); // Entries written before identity sign-in keep an empty actor rather than being discarded.
 const allowList=buildAllowList(allow);
 const trustList=(()=>{try{return buildAllowList(trustProxy);}catch(error){throw Error('LIDOLLQUEST_GM_TRUST_PROXY '+error.message.replace(/^LIDOLLQUEST_GM_ALLOW /,''));}})(); // Same address grammar, rejected just as loudly.
 const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,code:code??'gm_request_failed'});}; // Mirrors the rejection shape the rest of the service already throws.
 // The curse/blessing table a gamemaster edits. `enchantments` is the same store
 // every dive route rolls through, so an edit here reaches the next chest without
 // a restart; `enchantmentTable` is the shipped baseline it layers over.
 const enchantStore=()=>enchantments??fail(503,'Enchantment tuning is not available on this deployment.','gm_enchantments_unavailable');
 const baseTable=()=>(typeof enchantmentTable==='function'?enchantmentTable():enchantmentTable)??{tuning:{},curses:[],blessings:[]};
 const enchantView=()=>{
  const store=enchantStore(),live=store.apply(baseTable());
  return {tuning:live.tuning,entries:store.list(baseTable()),revision:store.revision(),
   slots:store.slots,statKeys:store.statKeys,tuningKeys:store.tuningKeys,bounds:store.bounds,
   counts:{curses:live.curses.length,blessings:live.blessings.length}};
 };

 // The Adjective + Item + Rarity table a gamemaster edits: the same store every dive
 // route rolls through, layered over the shipped baseline exported into dive-data.json.
 const alchemyStore=()=>alchemy??fail(503,'Alchemy tuning is not available on this deployment.','gm_alchemy_unavailable');
 const alchemyBase=()=>(typeof alchemyTable==='function'?alchemyTable():alchemyTable)??fail(503,'This deployment shipped no alchemy tables (re-run export_online_dive.py).','gm_alchemy_unavailable');
 const alchemyView=()=>{ // Everything the /gm Alchemy tab shows: live and shipped sections, which keys are overridden, and the pickers' vocabularies.
  const base=alchemyBase(),store=alchemyStore(),liveTable=store.apply(base);
  const top=i=>{const p=i.alchemy?.pigments??{};return Object.keys(p).sort((a,b)=>p[b]-p[a])[0]??'';};
  return {revision:store.revision(),sections:store.sectionKeys,overridden:store.overriddenKeys(),
   live:{brewing:liveTable.brewing,chest_loot:liveTable.chest_loot},shipped:{brewing:base.brewing,chest_loot:base.chest_loot},
   colours:(base.colors??[]).map(c=>({id:c.id,name:c.name,family:c.family})),
   ingredients:Object.values(base.ingredients??{}).map(i=>({id:i.item_id,name:i.name,tier:i.alchemy?.tier??1,role:i.alchemy?.role??'herb',colour:top(i)})).sort((a,b)=>a.name.localeCompare(b.name))};
 };
 const lootStore=()=>loot??fail(503,'Loot tuning is not available on this deployment.','gm_loot_unavailable');
 const lootBase=()=>(typeof lootTable==='function'?lootTable():lootTable)??{tuning:{},affixes:[],legendary_titles:[]};
 const lootCatalog=()=>(typeof lootItems==='function'?lootItems():lootItems)??{};
 const lootBaseTable=()=>(typeof lootBases==='function'?lootBases():lootBases)??null;
 const lootView=()=>{
  const store=lootStore(),liveTable=store.apply(lootBase());
  return {tuning:{...DEFAULT_TUNING,...liveTable.tuning}, // Defaults fill scalars the shipped table predates (shop prices), so every panel input starts filled and a save is never refused for a blank.
   legendary_titles:liveTable.legendary_titles,affixes:store.list(lootBase()),revision:store.revision(),
   slots:store.slots,statKeys:store.statKeys,rarityOrder:store.rarityOrder,tuningKeys:store.tuningKeys,scalarBounds:store.scalarBounds,rarityBounds:store.rarityBounds,overcapStats:store.overcapStats,
   items:Object.keys(lootCatalog()).sort(),
   garments:store.listBases(lootBaseTable(),'garment'),styles:store.listBases(lootBaseTable(),'style'),generatedCategories:store.generatedCategories,garmentStatKeys:store.garmentStatKeys,garmentBounds:store.garmentBounds,
   counts:{affixes:liveTable.affixes.length,titles:liveTable.legendary_titles.length,garments:store.applyBases(lootBaseTable()).garments.length,styles:store.applyBases(lootBaseTable()).styles.length}};
 };

 function client(req){ // The address moderation decisions are made about.
  const direct=bareAddress(req.socket?.remoteAddress);
  if(!inList(trustList,direct))return direct; // Not behind a declared proxy: the socket itself is the caller.
  const chain=forwarded(req.headers['x-forwarded-for']).map(bareAddress);
  for(let i=chain.length-1;i>=0;i--)if(!inList(trustList,chain[i]))return chain[i]; // Walk right-to-left past our own proxies; the first outsider is the client.
  return direct; // Every declared hop was trusted, so nothing outside the proxy chain spoke.
 } // Only a trusted proxy's forwarding is believed, because any client can send these headers.

 function overTls(req){
  if(req.socket?.encrypted)return true; // TLS terminated by this process.
  if(!inList(trustList,bareAddress(req.socket?.remoteAddress)))return false; // An untrusted caller cannot assert its own scheme.
  return forwarded(req.headers['x-forwarded-proto'])[0]==='https';
 }

 const permitted=address=>{ // A caller with no readable address is refused rather than assumed local.
  if(!allowList)return true;
  if(!address)return false;
  return inList(allowList,address);
 };

 function sanction(owner,kind){
  const row=db.prepare('SELECT * FROM gm_sanctions WHERE owner=? AND kind=?').get(owner,kind); // One row per account per sanction kind.
  if(!row)return null;
  if(row.until&&row.until<=now()){db.prepare('DELETE FROM gm_sanctions WHERE owner=? AND kind=?').run(owner,kind);return null;} // Expired timers clear themselves on the next lookup instead of needing a sweeper.
  return row;
 }
 const muted=owner=>Boolean(sanction(owner,'mute'));        // Handed to the zone engine so a silenced account still walks and fights normally.
 const suspended=owner=>Boolean(sanction(owner,'suspend')); // Handed to the request gate so a blocked account cannot reach gameplay at all.
 const record=(actor,action,target,detail={})=>db.prepare('INSERT INTO gm_audit(action,target,detail,created,actor) VALUES (?,?,?,?,?)').run(action,target,JSON.stringify(detail),now(),actor??''); // Every state change names the gamemaster who made it.

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

 function place(kind,input,actor){
  const owner=clean(input.owner,64)||fail(400,'Choose an account.','gm_unknown_player');
  if(!db.prepare('SELECT 1 AS n FROM quest_characters WHERE owner=? LIMIT 1').get(owner))fail(404,'No such player.','gm_unknown_player');
  if(owner===actor)fail(409,'You cannot sanction your own account.','gm_self_target'); // A misclick must not lock the acting gamemaster out of their own game.
  const minutes=Number(input.minutes??0);
  if(!Number.isSafeInteger(minutes)||minutes<0||minutes>525600)fail(400,'Use 0 for indefinite, or up to one year in minutes.','gm_bad_duration');
  const until=minutes?now()+minutes*60000:0,reason=clean(input.reason,240); // Zero records an indefinite sanction that only a gamemaster can lift.
  db.prepare('INSERT INTO gm_sanctions VALUES (?,?,?,?,?) ON CONFLICT(owner,kind) DO UPDATE SET until=excluded.until,reason=excluded.reason,created=excluded.created').run(owner,kind,until,reason,now());
  if(kind==='suspend')db.prepare('DELETE FROM quest_presence WHERE owner=?').run(owner); // A suspension takes effect at once rather than at the end of the current session.
  record(actor,kind,owner,{until,minutes,reason});
  return {owner,kind,until,reason};
 }
 function lift(kind,input,actor){
  const owner=clean(input.owner,64)||fail(400,'Choose an account.','gm_unknown_player');
  if(!db.prepare('DELETE FROM gm_sanctions WHERE owner=? AND kind=?').run(owner,kind).changes)fail(404,'That account has no '+kind+' in place.','gm_no_sanction');
  record(actor,'un'+kind,owner,{reason:clean(input.reason,240)});
  return {owner,kind};
 }

 const actions={
  tutor_settings(input,actor){if(!tutor)fail(409,'The tutor NPC is not available on this server.');const saved=tutor.gmSet(input,actor);record(actor,'tutor_settings','tutor',{enabled:saved.enabled,name:saved.name,greeting:saved.greeting});return saved;}, // Pip on/off, name and greeting (tutor.mjs).
  rpp_gift(input,actor){const result=rpp.gift(input,actor);if(!result.replayed)record(actor,'rpp_gift',result.characterId,{...result,reason:input.reason});return result;},
  rp_award(input,actor){const result=rp.award(input,actor);record(actor,'rp_award',result.characterId,result);return result;},
  kick(input,actor){
   const p=online(clean(input.owner,64))??fail(409,'That account is not in a zone right now.','gm_not_online');
   db.prepare('DELETE FROM quest_presence WHERE owner=?').run(p.owner); // The client's next command fails its presence check and the player returns to character select.
   record(actor,'kick',p.owner,{zone:p.zone,character:p.character_id,reason:clean(input.reason,240)});
   return {owner:p.owner,zone:p.zone,zoneName:zoneName(p.zone)};
  },
  warp(input,actor){
   const target=zoneById.get(String(input.zone??''))??fail(400,'Choose a destination room.','gm_unknown_zone');
   if(!target.warp)fail(409,'Dives are instanced runs; move the player to a lobby instead.','gm_zone_not_warpable');
   const p=online(clean(input.owner,64))??fail(409,'That account is not in a zone right now.','gm_not_online');
   const state=safeParse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(p.character_id)?.state??'{}');
   if(state.run||state.dive)fail(409,'Finish, forfeit or settle their run before moving them.','gm_run_in_progress'); // Relocating mid-run would strand that run's own zone bookkeeping.
   const spawn=target.spawn??HUB_SPAWN;
   db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE owner=?').run(target.id,spawn.x,spawn.y,now(),p.owner);
   record(actor,'warp',p.owner,{from:p.zone,to:target.id,reason:clean(input.reason,240)});
   return {owner:p.owner,from:zoneName(p.zone),to:target.name};
  },
  mute:(input,actor)=>place('mute',input,actor),
  suspend:(input,actor)=>place('suspend',input,actor),
  unmute:(input,actor)=>lift('mute',input,actor),
  unsuspend:(input,actor)=>lift('suspend',input,actor),
  broadcast(input,actor){
   const zone=zoneById.get(String(input.zone??''))??fail(400,'Choose a room to announce in.','gm_unknown_zone');
   const message=clean(input.text,240)||fail(400,'Write an announcement first.','gm_empty_message');
   db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created) VALUES (?,?,?,?,?,?)').run(zone.id,'activity:gm','gm',clean(input.speaker,24)||'Gamemaster',message,now()); // The activity: prefix is the tag clients already render as an announcement rather than player speech.
   db.prepare('DELETE FROM quest_chat WHERE zone=? AND seq NOT IN (SELECT seq FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 100)').run(zone.id,zone.id); // Keep the hundred-message ceiling every other writer respects.
   record(actor,'broadcast',zone.id,{text:message});
   return {zone:zone.id,zoneName:zone.name,text:message};
  },
  announce(input,actor){ // Server-wide banner: every online player sees it until it expires or a gamemaster ends it.
   if(!announcementStore())fail(409,'Announcements are not available on this server.','gm_unknown_action');
   const posted=announcementStore().post({text:input.text,speaker:input.speaker,minutes:input.minutes},actor);
   record(actor,'announce','everyone',{text:posted.text,speaker:posted.speaker,minutes:posted.minutes});
   return posted;
  },
  announce_end(input,actor){
   if(!announcementStore())fail(409,'Announcements are not available on this server.','gm_unknown_action');
   const ended=announcementStore().end();
   if(ended)record(actor,'announce_end','everyone',{text:ended.text,reason:clean(input.reason,240)});
   return {ended};
  },
  enchant_tune(input,actor){
   const values=enchantStore().tune(input.tuning,actor);
   record(actor,'enchant_tune','enchantments',{values,reason:clean(input.reason,240)});
   return {tuning:enchantView().tuning,changed:values};
  },
  enchant_save(input,actor){
   const entry=enchantStore().save(input.entry,actor); // Rejects a malformed entry before it can reach the roller.
   record(actor,'enchant_save',entry.id,{alignment:entry.alignment,slots:entry.slots,name:entry.name,reason:clean(input.reason,240)});
   return {entry,revision:enchantStore().revision()};
  },
  enchant_delete(input,actor){
   const result=enchantStore().remove(input.id,baseTable(),actor); // Shipped entries are retired, not deleted: the next content push would bring them back.
   record(actor,'enchant_delete',result.id,{...result,reason:clean(input.reason,240)});
   return {...result,revision:enchantStore().revision()};
  },
  enchant_restore(input,actor){
   const result=enchantStore().restore(input.id,actor);
   record(actor,'enchant_restore',result.id,{reason:clean(input.reason,240)});
   return {...result,revision:enchantStore().revision()};
  },
  enchant_reset(input,actor){
   const scope=String(input.scope??'all');
   if(!['all','tuning','entries'].includes(scope))fail(400,'Reset tuning, entries or all.','gm_invalid_enchantment');
   const result=enchantStore().reset(scope);
   record(actor,'enchant_reset','enchantments',{...result,reason:clean(input.reason,240)});
   return {...result,revision:enchantStore().revision()};
  },
  alchemy_save(input,actor){
   const section=String(input.section??'');
   const saved=alchemyStore().save(section,input.patch,alchemyBase(),actor); // Refused unless the whole merged section stays valid.
   record(actor,'alchemy_save',section,{keys:Object.keys(saved),reason:clean(input.reason,240)});
   return {section,saved,revision:alchemyStore().revision()};
  },
  alchemy_reset(input,actor){
   const scope=String(input.scope??'all'),key=input.key?String(input.key):null;
   const result=alchemyStore().reset(scope,key);
   record(actor,'alchemy_reset',scope,{...result,reason:clean(input.reason,240)});
   return {...result,revision:alchemyStore().revision()};
  },
  loot_tune(input,actor){
   const values=lootStore().tune(input.tuning,actor);
   record(actor,'loot_tune','loot',{keys:Object.keys(values),reason:clean(input.reason,240)});
   return {tuning:lootView().tuning,changed:Object.keys(values)};
  },
  loot_save(input,actor){
   const affix=lootStore().save(input.affix,actor); // Rejects a malformed affix before it can reach the roller.
   record(actor,'loot_save',affix.id,{slots:affix.slots,adjective:affix.adjective,suffix_title:affix.suffix_title,reason:clean(input.reason,240)});
   return {affix,revision:lootStore().revision()};
  },
  loot_delete(input,actor){
   const result=lootStore().remove(input.id,lootBase(),actor); // Shipped affixes are retired, not deleted.
   record(actor,'loot_delete',result.id,{...result,reason:clean(input.reason,240)});
   return {...result,revision:lootStore().revision()};
  },
  loot_restore(input,actor){
   const result=lootStore().restore(input.id,actor);
   record(actor,'loot_restore',result.id,{reason:clean(input.reason,240)});
   return {...result,revision:lootStore().revision()};
  },
  loot_reset(input,actor){
   const scope=String(input.scope??'all');
   if(!['all','tuning','affixes','bases'].includes(scope))fail(400,'Reset tuning, affixes, bases or all.','gm_invalid_loot');
   const result=lootStore().reset(scope);
   record(actor,'loot_reset','loot',{...result,reason:clean(input.reason,240)});
   return {...result,revision:lootStore().revision()};
  },
  loot_garment_save(input,actor){
   const garment=lootStore().saveBase('garment',input.garment,lootBaseTable(),actor); // Refused before it can reach the generator.
   record(actor,'loot_garment_save',garment.id,{category:garment.category,name:garment.name,reason:clean(input.reason,240)});
   return {garment,revision:lootStore().revision()};
  },
  loot_garment_delete(input,actor){
   const result=lootStore().removeBase('garment',input.id,lootBaseTable(),actor);
   record(actor,'loot_garment_delete',result.id,{...result,reason:clean(input.reason,240)});
   return {...result,revision:lootStore().revision()};
  },
  loot_garment_restore(input,actor){
   const result=lootStore().restoreBase('garment',input.id,actor);
   record(actor,'loot_garment_restore',result.id,{reason:clean(input.reason,240)});
   return {...result,revision:lootStore().revision()};
  },
  loot_style_save(input,actor){
   const style=lootStore().saveBase('style',input.style,lootBaseTable(),actor); // Styles are words only; a stat is refused.
   record(actor,'loot_style_save',style.id,{name:style.name,garments:style.garments,reason:clean(input.reason,240)});
   return {style,revision:lootStore().revision()};
  },
  loot_style_delete(input,actor){
   const result=lootStore().removeBase('style',input.id,lootBaseTable(),actor);
   record(actor,'loot_style_delete',result.id,{...result,reason:clean(input.reason,240)});
   return {...result,revision:lootStore().revision()};
  },
  loot_style_restore(input,actor){
   const result=lootStore().restoreBase('style',input.id,actor);
   record(actor,'loot_style_restore',result.id,{reason:clean(input.reason,240)});
   return {...result,revision:lootStore().revision()};
  },
  loot_preview(input){ // Rolls one sample item with the live table; never touches chest receipts or the audit log.
   const catalog=lootCatalog(),id=clean(input.item_id,64);
   const base=catalog[id]??fail(400,'Pick an item from the dive catalog.','gm_unknown_item');
   const roller=createLootRoller(lootStore().apply(lootBase()),lootStore().applyBases(lootBaseTable()));
   const enchant=createEnchanter(enchantStore().apply(baseTable()));
   let item=structuredClone(base);
   if(item.atk_min!==undefined){item.atk=item.atk_min;if(typeof item.desc==='string')item.desc=item.desc.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
   const level=Number(input.level);
   const key='preview:'+clean(input.seed,64)||'preview:0';
   item=roller.roll(item,key,{level:Number.isFinite(level)?level:1,luck:clean(input.luck,24)||'chest'});
   enchant(item,key,roller.enchantMods(item));
   return {item,summary:describeLoot(item),enchantment:describeItem(item,enchantStore().apply(baseTable()))};
  },
  delete_chat(input,actor){
   const seq=Number(input.seq);
   if(!Number.isSafeInteger(seq)||seq<1)fail(400,'Choose a message to remove.','gm_unknown_message');
   const row=db.prepare('SELECT * FROM quest_chat WHERE seq=?').get(seq)??fail(404,'That message has already gone.','gm_unknown_message');
   db.prepare('DELETE FROM quest_chat WHERE seq=?').run(seq);
   record(actor,'delete_chat',row.owner.replace(/^activity:/,''),{zone:row.zone,name:row.name,text:row.text,reason:clean(input.reason,240)});
   return {seq,zone:row.zone,zoneName:zoneName(row.zone)};
  },
  clear_chat(input,actor){ // Every message in one area at once; the global stream and generated Dive floors count as areas too.
   const zone=clean(input.zone,200);
   if(!zone)fail(400,'Choose a room to clear.','gm_unknown_zone');
   if(!zoneById.has(zone)&&!db.prepare('SELECT 1 FROM quest_chat WHERE zone=? LIMIT 1').get(zone))fail(400,'That room has no chat to clear.','gm_unknown_zone'); // Dive floors use generated ids outside the catalogue, so any area that actually holds messages is accepted.
   const removed=Number(db.prepare('DELETE FROM quest_chat WHERE zone=?').run(zone).changes);
   record(actor,'clear_chat',zone,{removed,reason:clean(input.reason,240)});
   return {zone,zoneName:zoneName(zone),removed};
  }};

 async function body(req,limit=16*1024){
  if(!String(req.headers['content-type']??'').startsWith('application/json'))fail(415,'Send JSON.','gm_bad_content_type');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)fail(413,'Request too large.','gm_body_too_large');chunks.push(chunk);} // Moderation commands are tiny; this cap sits far below the gameplay gateway's.
  try{return JSON.parse(Buffer.concat(chunks));}catch{return fail(400,'Invalid JSON.','gm_bad_json');}
 }

 const starts=new Map(); // Sign-ins are proxied, so the tracker sees only this service; keep a per-caller ceiling of our own.
 function throttle(address){
  const key=address||'unknown',time=now();
  const window=starts.get(key)?.time>time-600000?starts.get(key):{time,count:0};
  window.count++;starts.set(key,window);
  for(const [id,value] of starts)if(value.time<=time-600000)starts.delete(id); // Forget stale counters rather than growing without bound.
  if(window.count>20)fail(429,'Too many sign-in attempts. Wait a few minutes.','gm_signin_throttled');
 }

 async function actor(req){ // Identity is revalidated against LiDollID on every staff request, so a revoked role loses access at once.
  const token=/^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization??'')?.[1];
  if(!token)fail(401,'Sign in with your LiDollID account.','gm_unauthenticated');
  let identity;
  try{identity=await walletClient.authenticate(token);}
  catch(error){fail(error.status===401?401:503,error.status===401?'Sign in again; this connection has expired.':'LiDollID is unavailable, so gamemaster access cannot be confirmed.',error.status===401?'gm_unauthenticated':'gm_identity_unavailable');}
  if(!identity.gamemaster)fail(403,'Your LiDollID account is not a gamemaster.','gm_not_gamemaster'); // Granted in Little Log user management, never here.
  return identity.owner;
 }

 async function route(req,res,url){
  if(url.pathname!=='/gm'&&!url.pathname.startsWith('/gm/'))return false;
  const send=(status,payload)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(payload));return true;};
  if(!enabled||!walletClient)return send(503,{error:'gm_panel_disabled'}); // An explicitly disabled deployment exposes no staff surface whatsoever.
  const caller=client(req);
  if(requireTls&&!overTls(req))return send(403,{error:'gm_insecure_transport',error_description:'The gamemaster panel requires HTTPS.'}); // A grant must never cross the network in cleartext.
  if(!permitted(caller))return send(403,{error:'gm_forbidden_address'}); // Refused before the page is served and before any identity is considered.
  if(url.pathname==='/gm'){
   if(req.method!=='GET')return send(405,{error:'gm_method_not_allowed'});
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'"});
   res.end(panelPage);return true; // The shell carries no player data: every figure on it arrives through an authenticated fetch below.
  }
  const origin=req.headers.origin;
  if(origin&&origin!=='http://'+req.headers.host&&origin!=='https://'+req.headers.host)return send(403,{error:'gm_bad_origin'}); // The panel's own writes are same-origin, and a forged page could not attach the bearer header anyway.
  try{
   if(url.pathname==='/gm/signin/start'&&req.method==='POST'){ // No credential yet: this is the beginning of a LiDollID device authorisation.
    throttle(caller);
    const started=await walletClient.device(SIGNIN_SCOPE);
    return send(200,{user_code:started.user_code,verification_uri:started.verification_uri??null,device_code:started.device_code,interval:started.interval??5,expires_in:started.expires_in??600});
   }
   if(url.pathname==='/gm/signin/poll'&&req.method==='POST'){
    const input=await body(req);
    if(typeof input?.device_code!=='string'||input.device_code.length>100)return send(400,{error:'gm_bad_device_code'});
    let granted;
    try{granted=await walletClient.deviceToken(input.device_code);}
    catch(error){return send(error.status??503,{error:error.code??'gm_signin_failed',error_description:error.message});} // authorization_pending and slow_down reach the page unchanged.
    const identity=await walletClient.authenticate(granted.access_token);
    if(!identity.gamemaster)return send(403,{error:'gm_not_gamemaster',error_description:'That LiDollID account is not a gamemaster.'}); // Refuse before the page ever holds a usable panel session.
    return send(200,{access_token:granted.access_token,expires_in:granted.expires_in??2592000,owner:identity.owner});
   }
   const who=await actor(req); // Every remaining route requires a live gamemaster identity.
   if(url.pathname==='/gm/whoami'&&req.method==='GET')return send(200,{owner:who,serverTime:now()});
   if(url.pathname==='/gm/overview'&&req.method==='GET')return send(200,{...overview(),actor:who});
   if(url.pathname==='/gm/performance'&&req.method==='GET')return send(200,performanceSnapshot()); // Reuses the live role, address, origin and TLS checks above; never exposed by /health.
   if(url.pathname==='/gm/content'&&req.method==='GET')return send(200,{...live.view(),worldZones:world().catalog(),onlineNpcs:world().npcCatalog?.()??[]});
   if(url.pathname==='/gm/map'&&req.method==='GET')return send(200,world().map(url.searchParams.get('zone')));
   if(url.pathname==='/gm/jobs'&&req.method==='GET')return send(200,{jobs:artJobs.list()});
   if(url.pathname==='/gm/asset'&&req.method==='GET')return send(200,live.asset(url.searchParams.get('id')));
   if(url.pathname==='/gm/enchantments'&&req.method==='GET')return send(200,enchantView()); // Content tuning, behind the same staff identity as every moderation tool.
   if(url.pathname==='/gm/loot'&&req.method==='GET')return send(200,lootView()); // Adjective + Item + Rarity tuning and affix authoring.
   if(url.pathname==='/gm/tutor'&&req.method==='GET')return send(200,tutor?tutor.gmView():{configured:false,settings:null,recent:[]}); // Pip's switch, npc-rag health and the latest questions/answers.
   if(url.pathname==='/gm/alchemy'&&req.method==='GET')return send(200,alchemyView()); // Chest odds and brewing rules (alchemy-store.mjs).
   if(url.pathname==='/gm/rp'&&req.method==='GET')return send(200,rp.journal(Object.fromEntries(url.searchParams)));
   if(url.pathname==='/gm/rpp'&&req.method==='GET')return send(200,rpp.journal(url.searchParams.get('character')??''));
   if(url.pathname==='/gm/chat'&&req.method==='GET'){
    const limit=Number(url.searchParams.get('limit')??'60');
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)return send(400,{error:'gm_invalid_page'});
    const zone=url.searchParams.get('zone');
    if(zone&&!zoneById.has(zone))return send(400,{error:'gm_unknown_zone'});
    return send(200,{...chat(zone||null,limit),announcement:announcementStore()?.active()??null}); // The chat tab also shows whichever server-wide banner is up.
   }
   if(url.pathname==='/gm/player'&&req.method==='GET')return send(200,player(url.searchParams.get('owner')||null,url.searchParams.get('character_id')||null));
   if(url.pathname==='/gm/action'&&req.method==='POST'){
    const input=await body(req,1300000);
    if(live&&/^(content_|world_|art_)/.test(input?.action??'')){
     db.exec('BEGIN IMMEDIATE');try{const result=live.once(input,who,()=>{let result;if(['content_save','content_publish','content_rollback'].includes(input.action))result=live.change(input,who);else if(input.action==='art_upload')result=live.putAsset(input);else if(['art_generate','art_retry','art_cancel','art_approve','art_assign'].includes(input.action))result=artJobs.act(input,who);else if(['world_place','world_remove','world_regenerate','world_cancel','world_place_content','world_remove_content','world_scatter_orbs','world_hub_lock','world_hub_regenerate'].includes(input.action))result=world().act(input);else fail(400,'Unknown world action.');record(who,input.action,input.id??input.zone??result.id,{reason:clean(input.reason,240),revision:result.revision??null});return result;});db.exec('COMMIT');return send(200,{ok:true,result});}catch(e){db.exec('ROLLBACK');live.invalidate();throw e;}
    }
    const handler=Object.hasOwn(actions,String(input?.action??''))?actions[input.action]:null; // Own-property lookup only, so no prototype key can be invoked as an action.
    if(!handler)return send(400,{error:'gm_unknown_action'});
    return send(200,{ok:true,action:input.action,serverTime:now(),result:handler(input,who)});
   }
   return send(404,{error:'gm_endpoint_not_found'});
  }catch(error){
   if(!error.status)log('gm_request_failed',url.pathname,error?.message??'unknown'); // Only the route name reaches the log; moderation reasons and player text never do.
   return send(error.status??500,{error:error.code??'gm_request_failed',error_description:error.status?error.message:'The gamemaster panel is temporarily unavailable.'});
  }
 }

 return {route,muted,suspended,sanction,overview,chat,player,record, // record: in-game GM tools write to the same audit log as the web panel.
  act:(action,payload={},who='')=>Object.hasOwn(actions,action)?actions[action](payload,who):fail(400,'Unknown action.','gm_unknown_action')};
} // Gamemaster rights live in Little Log's participant_access table; this service only reads the decision and records who acted.
