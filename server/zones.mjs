import {createOnlineQuests} from './online-quests.mjs';
import {createHubEncounters} from './world-hubs.mjs';
import {publicCombatState} from './defeat-scenes.mjs';
import {movementDelay} from './crawl.mjs';
import {createParties} from './parties.mjs';
import {publishPlayerActivity} from './player-activity.mjs';
import {createHubDistricts} from './hub-districts.mjs';
import {randomUUID,randomInt,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {importLoadout,applyRunLoadout,syncRunHealth} from './loadout.mjs';
import {beginRound,clearEffects,readyTurn,combatAction,awardExperience,defeatPresentation} from './combat.mjs';
import {hubArrival,hubRooms,hubPortals,hubBlocked,hubDefinition,nearbyFixture,hubData,createHubPurchases,hubGaps,inHubGap,hubCatalog,campaignDives,DAILY_COIN_CAP} from './hubs.mjs';
import {createDive,DIVE_ZONE} from './dive.mjs';
import {createEnchantmentStore} from './enchantment-store.mjs';
import {generateDesert} from './desert-generation.mjs';
import {addTaigaTrail} from './wilderness-links.mjs';
export const DESERT_ZONE='dive-desert';
export const desertData=JSON.parse(readFileSync(new URL('./desert-data.json',import.meta.url),'utf8'));
export const TUNDRA_ZONE='dive-tundra';
export const tundraData=JSON.parse(readFileSync(new URL('./tundra-data.json',import.meta.url),'utf8'));
export const TAIGA_ZONE='dive-taiga';
export const taigaData=JSON.parse(readFileSync(new URL('./taiga-data.json',import.meta.url),'utf8'));
import {createBank} from './bank.mjs';
import {createItemOrigins} from './item-origins.mjs';
import {inspectionProjection} from './inspection.mjs';
import {createRoleplay} from './roleplay.mjs';
import {createRpp} from './rpp.mjs';
import {manaCapacity} from './magic-balance.mjs';
import {companionEquipment} from './companion-equipment.mjs';
import {companionSheet} from './companion.mjs';
import {managementSchema,appearanceFields} from './character-management.mjs';

export const questAvatars=Object.freeze(JSON.parse(readFileSync(new URL('./avatars.json',import.meta.url),'utf8')).map(Object.freeze)); // Generated from the game's NPC registry and authored object sprites.
const avatarIds=new Set(questAvatars.map(a=>a.id));

export const questZones=Object.freeze(hubCatalog.map(h=>({...h,...(h.theme==='clockwork'
 ?{rule:'Every third enemy turn hits harder',enemies:['Tin Sentry','Gear Hound','Clockwork Monarch'],attack:5,health:24,recovery:3}
 :{rule:'Recovery between rounds',enemies:h.theme==='rose'?['Rose Sprite','Ribbon Knight','Crown Warden']:['Moss Sprite','Lantern Knight','Moonlit Warden'],attack:5,health:22,recovery:6})}))); // Rose Court uses Lantern balance and the same account-wide reward cap.
const fail=(status,message,code='zone_request_failed')=>{throw Object.assign(Error(message),{status,code});};
const avatar=value=>typeof value==='string'&&avatarIds.has(value)?value:fail(400,'Choose an NPC from the appearance list.'); // Never accept arbitrary asset paths or gameplay stats.
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
const clean=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069#]/g,' ').trim().slice(0,max):'';
const baseZone=id=>[...questZones,...hubRooms].find(z=>z.id===id)??fail(400,'Choose an online zone.');
const blocked=(z,x,y)=>x<0||y<0||x>=(z.width??20)||y>=(z.height??12)||(!hubGaps(z).some(g=>inHubGap(g,x,y))&&(x<1||y<1||x>(z.width??20)-2||y>(z.height??12)-2))||Boolean(z.walls?.[y]?.[x])||hubBlocked(z,x,y)||(!z.parent&&z.theme==='clockwork'&&y===5&&x>5&&x<14&&x!==10);
function canonical(value,depth=0){ // Nested loadout property order may change when GameMaker reloads its request journal.
 if(depth>20)fail(400,'Request data is too complex.');
 if(Array.isArray(value))return value.map(v=>canonical(v,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k],depth+1)]));
 return value;
}

export function createQuestZones(db,{grant,wallet,adjust,enabled=()=>true,muted=()=>false,now=Date.now,roll=randomInt,measure=(_name,work)=>work(),diveOptions={},desertOptions={},tundraOptions={},taigaOptions={},onPresence=()=>{},compute=null,live=null}={}) {
 let privateSprites=null;
 const chooseAvatar=(value,owner,cid='')=>typeof value==='string'&&value.startsWith('private-')?(privateSprites?.authorize(owner,cid,value)??fail(403,'Private sprites are unavailable.')):avatar(value);
 db.exec(`CREATE TABLE IF NOT EXISTS quest_characters(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,creation_id TEXT NOT NULL,UNIQUE(owner,creation_id));
 CREATE INDEX IF NOT EXISTS quest_character_owner ON quest_characters(owner);
 CREATE TABLE IF NOT EXISTS quest_presence(owner TEXT PRIMARY KEY,character_id TEXT NOT NULL UNIQUE,zone TEXT NOT NULL,grant_id TEXT NOT NULL,controller TEXT NOT NULL,x INTEGER NOT NULL,y INTEGER NOT NULL,seen INTEGER NOT NULL,moved INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS quest_zone_presence ON quest_presence(zone,seen);
 CREATE TABLE IF NOT EXISTS quest_commands(character_id TEXT NOT NULL,request_id TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(character_id,request_id));
 CREATE TABLE IF NOT EXISTS quest_chat(seq INTEGER PRIMARY KEY AUTOINCREMENT,zone TEXT NOT NULL,owner TEXT NOT NULL,character_id TEXT NOT NULL,name TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS quest_chat_zone ON quest_chat(zone,seq);
 CREATE TABLE IF NOT EXISTS quest_reward_days(owner TEXT NOT NULL,day INTEGER NOT NULL,coins INTEGER NOT NULL,PRIMARY KEY(owner,day));
 CREATE TABLE IF NOT EXISTS quest_request_limits(owner TEXT PRIMARY KEY,started INTEGER NOT NULL,count INTEGER NOT NULL);`);
 managementSchema(db);
 const rp=createRoleplay(db,{now,roll});
 const rpp=createRpp(db,{now});
 const parties=createParties(db,{now});
 const districts=createHubDistricts(db,{now,beforeActivate:(zone,floor)=>{const busy=db.prepare('SELECT c.state FROM quest_characters c JOIN quest_presence p ON p.character_id=c.id WHERE p.zone=?').all(zone).some(r=>{const s=JSON.parse(r.state);return s.run||s.pendingDefeat;});if(busy)throw Error('Finish existing encounters before changing this district.');live?.mapReady?.(zone,'hub-'+zone+':'+floor.district.layoutKey,{...floor,entrance:floor.spawn});}});
 const zone=id=>districts.resolve(baseZone(id));
 const origins=createItemOrigins(db);
 const purchases=createHubPurchases(db,{now,origins});
 const bank=createBank(db);
 const enchantments=createEnchantmentStore(db,{now}); // One live curse/blessing table behind every route and the /gm panel.
 const quarters=createDive(db,{now,roll,adjust,origins,parties,measure,compute,live,enchantments,...diveOptions});
 const desert=createDive(db,{now,roll,adjust,origins,parties,measure,compute,live,data:desertData,generate:generateDesert,enchantments,...desertOptions});
 const trail=floor=>addTaigaTrail(floor,(taigaOptions.data??taigaData).config);
 const tundra=createDive(db,{now,roll,adjust,origins,parties,measure,compute,live,data:tundraData,generate:generateDesert,upgradeFloor:trail,travel,enchantments,...tundraOptions});
 const taiga=createDive(db,{now,roll,adjust,origins,parties,measure,compute,live,data:taigaData,generate:generateDesert,travel,enchantments,...taigaOptions});
 const engines=new Map([[DIVE_ZONE,quarters],[DESERT_ZONE,desert],[TUNDRA_ZONE,tundra],[TAIGA_ZONE,taiga]]);
 function travel(c,state,source,destination){
  if(!((source===TUNDRA_ZONE&&destination===TAIGA_ZONE)||(source===TAIGA_ZONE&&destination===TUNDRA_ZONE)))return false;
  engines.get(destination).arrive(c,state,source);return true; // Only this authored reciprocal trail connects dungeons; hub portals cannot enter the branch.
 }
 for(const data of campaignDives)engines.set(data.config.zone_id,createDive(db,{now,roll,adjust,origins,parties,measure,compute,live,data,enchantments})); // Each destination keeps its own editions, loot receipts and encounter locks.
 const hubEvents=live?createHubEncounters(db,{now,roll,parties,live,ids:[...hubCatalog,...hubRooms].map(z=>z.id),definition:id=>{const z=zone(id),d=hubDefinition(z,now());return {...d,width:z.width??20,height:z.height??12,walls:Array.from({length:z.height??12},(_,y)=>Array.from({length:z.width??20},(_,x)=>blocked(z,x,y)?1:0))};}}):null;
 const baseWorld=live?{catalog:()=>[...[...engines].map(([id])=>({id,name:live.entry('zone',id).draft.id,kind:'dive'})),...[...hubCatalog,...hubRooms].map(z=>({id:z.id,name:z.name,kind:'hub'}))],map:id=>engines.has(id)?engines.get(id).controls.view():hubEvents.engine(id).view(),act:input=>{const controls=engines.has(input.zone)?engines.get(input.zone).controls:hubEvents.engine(input.zone);if(input.action==='world_regenerate'){if(!controls.regenerate)fail(400,'Only whole Dives can be regenerated.');return controls.regenerate(input);}if(input.action==='world_cancel')return controls.cancel(input);return controls.place(input);}}:null;
 const quests=live?createOnlineQuests(db,{live,now,world:baseWorld,origins,adjust,roll,parties}):null;
 const world=quests?{npcCatalog:()=>[...hubCatalog,...hubRooms].flatMap(base=>(hubDefinition(zone(base.id),now()).fixtures??[]).filter(f=>f.kind==='npc').map(f=>({id:base.id+':'+f.id,name:f.name,zone:base.id}))),catalog:baseWorld.catalog,map:quests.placements.view,act:quests.placements.act}:baseWorld;
 if(live){live.mapReady=(zone,edition,floor,options)=>quests.placements.realize(zone,edition,floor,options);live.questEvent=quests.event;live.placementPositions=quests.placements.positions;}
 const isDungeon=id=>engines.has(id);
 const engine=id=>engines.get(id)??quarters; // No active visit still exposes the legacy Quarters summary.
 const dive={tick(){atomic(()=>parties.tick());for(const route of engines.values())route.tick();},
  snapshot(c,p){return engine(p?.zone??(c?JSON.parse(c.state).dive?.zone:null)).snapshot(c,p);},
  chatArea(c,p){return engine(p.zone).chatArea(c,p);},
  handles(input,p){return [...engines.values()].some(route=>route.handles(input,p));},
  act(i,c,state,input,p){const id=state.dive?.zone??(state.dive?DIVE_ZONE:input.zone??p?.zone);return engine(id).act(i,c,state,input,p);}}; // Share settlement and leases, while keeping weekly maps and claims route-scoped.
 function identity(secret){const i=grant(secret,'wallet:read');if(i.client!=='lidollquest')fail(403,'These zones are for LiDollQuest.');return i;} // A registered app ID alone is not a player identity.
 function atomic(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
 function limit(owner){const time=now();db.prepare('DELETE FROM quest_request_limits WHERE started<=?').run(time-60000);const r=db.prepare('INSERT INTO quest_request_limits VALUES (?,?,1) ON CONFLICT(owner) DO UPDATE SET count=count+1 RETURNING count').get(owner,time);if(r.count>600)fail(429,'Please slow down.');}
 function character(owner,id){if(!identifier(id))fail(400,'Choose an online character.');const c=db.prepare('SELECT * FROM quest_characters WHERE owner=? AND id=?').get(owner,id);if(!c)fail(404,'Online character not found for this account.');return c;}
 function publicCharacter(c){return {avatar:'player',id:c.id,name:c.name,revision:c.revision,...publicCombatState(JSON.parse(c.state))};} // Existing characters keep their default appearance without a database migration.
 function presence(i,c,controller){const p=db.prepare('SELECT * FROM quest_presence WHERE owner=? AND character_id=? AND grant_id=? AND controller=? AND seen>?').get(i.owner,c.id,i.id,controller,now()-30000);if(!p)fail(409,'Enter the zone again; this connection no longer controls the character.');return p;}
 function visitHub(i,state,source,destination){
  if(state.run)fail(409,'Finish or forfeit your arena run before visiting another room.');
  if(db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>?').get(destination.id,now()-30000).n>=64)fail(429,'This room is full.');
  if(destination.parent)state.hubVisit=destination.id;else delete state.hubVisit;
  const spawn=hubArrival(destination,source.id);
  db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE owner=?').run(destination.id,spawn.x,spawn.y,now(),i.owner);
 } // Enter just inside the matching wall opening, facing into the destination; a held movement key cannot immediately bounce back.
 function snapshot(i,c=null,view={}){return measure('snapshot.build',()=>snapshotData(i,c,view));} // Includes floor decoding and database reads, but excludes network waits and response encoding.
 function snapshotData(i,c=null,view={}){
  const state=c?JSON.parse(c.state):null,peerStates=new Map(); // Decode each character once for this response, with no mutable cache surviving a transaction.
  const restricted=i.blockedAccounts??[]; // Account restrictions apply across every character and room.
  const p=c?db.prepare('SELECT * FROM quest_presence WHERE owner=? AND character_id=? AND seen>?').get(i.owner,c.id,now()-30000):null;
  const peers=p?db.prepare('SELECT p.*,c.name,c.state FROM quest_presence p JOIN quest_characters c ON c.id=p.character_id WHERE p.zone=? AND p.seen>? ORDER BY p.character_id LIMIT 64').all(p.zone,now()-30000).filter(r=>enabled(r.owner)).map(r=>{const peer=JSON.parse(r.state);peerStates.set(r.character_id,peer);return {id:r.character_id,name:r.name,restricted:restricted.includes(r.owner),avatar:peer.avatar??'player',x:r.x,y:r.y,stage:peer.run?.stage??0,fighting:peer.run?.phase==='fight'};}):[];
  const chatArea=isDungeon(p?.zone)?dive.chatArea(c,p):p?{id:p.zone,name:zone(p.zone).name}:null;
  const chatRows=(area,channel)=>db.prepare('SELECT seq,name,text,character_id AS characterId,owner,owner LIKE \'activity:%\' AS activity,(SELECT id FROM quest_rp_posts WHERE chat_seq=seq) AS rpId FROM quest_chat WHERE zone=? AND created>? ORDER BY seq DESC LIMIT 100').all(area,now()-86400000).filter(row=>!restricted.includes(row.owner.replace(/^activity:/,''))).slice(0,40).reverse().map(({owner,...row})=>({...row,channel})); // RP links come from committed posts, never from player text.
  const chat=chatArea?chatRows(chatArea.id,'area'):[],globalChat=p?chatRows('global:ooc','global'):[]; // The reserved global stream is independent of hub, dungeon room and weekly edition.
  const spent=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(i.owner,Math.floor(now()/86400000))?.coins??0;
  if(view.companion)return {serverTime:now(),characters:db.prepare('SELECT id,name,revision FROM quest_characters WHERE owner=? ORDER BY created,id').all(i.owner),
   character:c?{id:c.id,name:c.name,revision:c.revision}:null,sheet:c?companionSheet(db,c,p):null,
   bank:bank.snapshot(c,p,p&&!isDungeon(p.zone)?zone(p.zone):null,view),coins:wallet(i.owner).coins,
   dailyRemaining:Math.max(0,DAILY_COIN_CAP-spent),dailyCap:DAILY_COIN_CAP}; // The private companion needs no dungeon geometry, peer records or duplicate raw loadout.
  const dungeon=dive.snapshot(c,p),definitions=[...questZones,...hubRooms].map(base=>{
   const z=zone(base.id),definition=hubDefinition(z,now());
   if(state?.diveCombatVersion===3&&p?.zone!==z.id){const {id,name,kind,parent,theme,width,height,spawn,exit,portals}=definition;return {id,name,kind,parent,theme,width,height,spawn,exit,portals,fixtures:[],walls:[]};} // New clients load full room geometry only after arrival, leaving room for large inventories and six-actor encounters.
   if(z.district&&p?.zone!==z.id){const {floors,wallTiles,rooms,blocks,axes,...summary}=definition;return {...summary,fixtures:[],walls:[]};} // Only the visited district sends its full monthly map.
   return {...definition,walls:z.walls??Array.from({length:z.height??12},(_,y)=>Array.from({length:z.width??20},(_,x)=>blocked({...z,fixtures:[]},x,y)?1:0))};
  });
  if(dungeon.definition)definitions.push(dungeon.definition);
  const questMap=p&&quests&&(Object.keys(live.published().npcs).length||Object.keys(live.published().quests).length)?quests.placements.view(p.zone):null;
  const edition=state?.dive?.edition;
  const visiblePeers=isDungeon(p?.zone)?peers.filter(peer=>peerStates.get(peer.id).dive?.edition===edition):peers;
  return {questNpcLinks:live?Object.values(live.published().quests).flatMap(q=>[...q.givers,q.turn_in.npc]):[],onlineQuests:quests?quests.snapshot(c,state):null,questVersion:1,worldInstance:questMap?.edition,worldPlacements:questMap?questMap.placements.map(n=>({...n,instance:questMap.edition,...(n.kind==='npc'?{name:live.published().npcs[n.content]?.name??n.name,sprite:live.published().npcs[n.content]?.sprite??n.sprite}:{})})):[],rpp:c?rpp.snapshot(c,state):null,rp:{...rp.snapshot(c,chatArea?.id,restricted),candidates:c&&p?rpCandidates(i,c,p).map(({id,name})=>({id,name})):[]},dungeons:[...engines].map(([id,route])=>({id,enabled:route.available()})),serverTime:now(),loadoutSupport:true,combatVersion:2,diveCombatVersion:3,partySupport:true,globalChatSupport:true,...parties.snapshot(c,restricted),contentRevision:live?.published().revision??0,contentVersion:1,worldMonsters:p&&!isDungeon(p.zone)&&hubEvents?hubEvents.engine(p.zone).monsters():[],encounter:c?(state?.run?.kind==='hub_event'?hubEvents.engine(p.zone).snapshot(state):engine(p?.zone).encounterSnapshot(state)):null,controllerTakeover:true,dive:dungeon.dive,desert:desert.snapshot(c,null).dive,tundra:tundra.snapshot(c,null).dive,avatars:questAvatars,zones:definitions,characters:db.prepare('SELECT * FROM quest_characters WHERE owner=? ORDER BY created,id').all(i.owner).map(row=>{const {loadout,...summary}=publicCharacter(row);if(summary.lastResult?.defeatScene){const {content,...scene}=summary.lastResult.defeatScene;summary.lastResult={...summary.lastResult,defeatScene:scene};}return summary;}),character:c?{avatar:'player',id:c.id,name:c.name,revision:c.revision,...publicCombatState(state)}:null,zone:p?.zone??null,position:p?{x:p.x,y:p.y}:null,peers:visiblePeers,chat,chatArea,globalChat,bank:bank.snapshot(c,p,p&&!isDungeon(p.zone)?zone(p.zone):null,view),coins:wallet(i.owner).coins,dailyRemaining:Math.max(0,DAILY_COIN_CAP-spent),dailyCap:DAILY_COIN_CAP};
 } // Snapshots expose only zone avatars and chat, never wallet credentials or account IDs.
 function read(secret,id,view={}){const i=identity(secret);limit(i.owner);districts.refresh();dive.tick();if(view.companion&&!id)id=db.prepare('SELECT character_id FROM quest_presence WHERE owner=? ORDER BY seen DESC LIMIT 1').get(i.owner)?.character_id??db.prepare('SELECT id FROM quest_characters WHERE owner=? ORDER BY created DESC,id LIMIT 1').get(i.owner)?.id;
  return snapshot(i,id?character(i.owner,id):null,view);} // Only this read honours the companion view; every in-play snapshot keeps the beside-a-bank rule.
 function enemy(z,stage){return {name:z.enemies[Math.min(2,Math.floor((stage-1)/3))],hp:z.health+(stage-1)*5,maxHp:z.health+(stage-1)*5,turn:0};}
 function settle(i,c,state,run){
  const day=Math.floor(now()/86400000),used=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(i.owner,day)?.coins??0;
  const paid=Math.min(run.pot,Math.max(0,DAILY_COIN_CAP-used));
  if(paid){adjust(i.owner,'coins',paid,randomUUID(),'LiDollQuest arena: '+run.zone);db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(i.owner,day,paid);}
  syncRunHealth(state,run);state.lastResult={outcome:'banked',coins:paid,rounds:run.stage,zone:run.zone};state.wins+=run.stage;state.run=null;
 } // Reward amount comes only from committed combat state; the ledger and result commit in the same database transaction.
 function combatResult(i,c,state,z,result){ // All class actions funnel through the same reward and loss rules.
  const r=state.run;
  if(result==='win'){
   clearEffects(state);awardExperience(state,roll);r.pot+=r.stage*5;r.phase='interval';r.hp=Math.min(r.maxHp,r.hp+z.recovery);
   r.log.push('Round cleared. Bank '+r.pot+' coins or continue with a handicap.');if(r.stage===8)settle(i,c,state,r);
  }else if(['defeat','charm_backfire'].includes(result)){
   clearEffects(state);r.hp=Math.max(1,Math.ceil(r.maxHp*0.25));syncRunHealth(state,r);
   state.lastResult={outcome:result,coins:0,rounds:r.stage-1,zone:z.id,log:r.log,...defeatPresentation(r,result)};state.run=null;
  }
 }
 const rpArea=(c,p)=>isDungeon(p.zone)?dive.chatArea(c,p)?.id:p.zone;
 function rpCandidates(i,c,p){
  const area=rpArea(c,p);
  return db.prepare('SELECT c.*,p.zone,p.x,p.y FROM quest_presence p JOIN quest_characters c ON c.id=p.character_id WHERE p.zone=? AND p.seen>? AND c.owner<>? ORDER BY c.name,c.id').all(p.zone,now()-30000,c.owner).filter(other=>enabled(other.owner)&&!(i.blockedAccounts??[]).includes(other.owner)&&rpArea(other,other)===area); // Partner selection follows area chat, including dungeon room and edition boundaries.
 }
 function act(secret,input,{buildSnapshot=true}={}){
  const response=(i,c)=>buildSnapshot?snapshot(i,c):{character:{id:c.id}}; // HTTP needs only the committed character ID until purchases settle; direct callers retain full snapshots.
  const i=identity(secret);limit(i.owner);
  grant(secret,'wallet:write');
  districts.refresh(); // Materialize monthly maps before the command transaction, keeping rollback and cached geometry consistent.
  dive.tick(); // Scheduled resets and enemy decisions precede command revision checks.
  if(!input||!identifier(input.request_id)||!identifier(input.controller))fail(400,'Supply a stable request ID and controller.');
   if(Object.keys(input).some(k=>!['quest_version','quest','quest_revision','conversation','placement','choice','branch','objective','content_version','rpp_cost','partners','rp_id','defeat_version','scene','equipment_version','action','request_id','controller','character_id','revision','name','zone','direction','text','channel','avatar','loadout','combat_version','spell','forfeit','stat','edition','encounter','chest','takeover','fixture','offer','slot','bank_item','page','world_step','world_turn_id','item_instance','item_id','creation','online_revision','member','invitation','battle','target','cycle','patch'].includes(k)))fail(400,'Unsupported zone input.');
  if(input.channel!==undefined&&(input.action!=='chat'||!['area','global'].includes(input.channel)))fail(400,'Choose Area or OOC for this message.'); // A client cannot supply an arbitrary destination or broadcast to both channels.
  if(input.takeover!==undefined&&(input.action!=='enter'||typeof input.takeover!=='boolean'))fail(400,'Control can only be transferred by an explicit entry request.'); // Never let movement or a background heartbeat steal control.
  return atomic(()=>{
   identity(secret);
   let arrival=null; // Set only by an explicit entry, so heartbeats and movement never look like an arrival.
   if(input.action==='create'){
    if(db.prepare('SELECT 1 FROM quest_deleted_characters WHERE owner=? AND creation_id=?').get(i.owner,input.request_id))fail(410,'This character was deleted. Start a new character.');
    const name=clean(input.name,24);if(!name)fail(400,'Give your online character a name.');
    let c=db.prepare('SELECT * FROM quest_characters WHERE owner=? AND creation_id=?').get(i.owner,input.request_id);
    const appearance=c?(input.avatar??'player'):chooseAvatar(input.avatar===undefined?'player':input.avatar,i.owner,''); // Creation retries retain their original receipt even if that sprite was later deleted.
    if(c&&(JSON.parse(c.state).creationName??c.name)!==name)fail(409,'This creation request already has another name.');
    if(c&&(JSON.parse(c.state).creationAvatar??'player')!==appearance)fail(409,'This creation request already has another appearance.');
    const creation=input.creation??null;if(creation!==null&&(typeof creation!=='object'||Array.isArray(creation)||Buffer.byteLength(JSON.stringify(creation))>8192))fail(400,'Invalid creation choices.');
    if(c&&JSON.stringify(JSON.parse(c.state).creation??null)!==JSON.stringify(creation))fail(409,'This creation request already has different choices.');
    if(!c){if(db.prepare('SELECT COUNT(*) AS n FROM quest_characters WHERE owner=?').get(i.owner).n>=5)fail(409,'This account already has five online characters.');const id=randomUUID();db.prepare('INSERT INTO quest_characters VALUES (?,?,?,?,0,?,?)').run(id,i.owner,name,now(),JSON.stringify({avatar:appearance,creationAvatar:appearance,creationName:name,creation,wins:0,run:null,lastStart:0,lastResult:null}),input.request_id);c=character(i.owner,id);privateSprites?.claimDraft(i.owner,c.id);}
    return response(i,c);
   }
   const c=character(i.owner,input.character_id),fingerprint=createHash('sha256').update(JSON.stringify(Object.keys(input).sort().map(k=>[k,canonical(input[k])]))).digest('hex'); // Preserve legacy flat command fingerprints while stabilizing nested loadout data.
   if(db.prepare("SELECT 1 FROM quest_management WHERE character_id=? AND status='pending'").get(c.id))fail(409,'Your character change is still settling.','character_change_pending');
   const old=db.prepare('SELECT * FROM quest_commands WHERE character_id=? AND request_id=?').get(c.id,input.request_id);
   if(input.action==='rp_read'){const p=presence(i,c,input.controller),rpPost=rp.read(c,input.rp_id,rpArea(c,p),i.blockedAccounts??[]);return {...response(i,c),receipt:{action:'rp_read',request_id:input.request_id,rpPost}};} // Include the persisted read cursor immediately; character revision, writing credit and the command journal stay unchanged.
   if(old){if(old.fingerprint!==fingerprint)fail(409,'This request ID already describes another action.');return {...response(i,c),receipt:JSON.parse(old.result)};}
   if(input.action==='heartbeat'){
    presence(i,c,input.controller);db.prepare('UPDATE quest_presence SET seen=? WHERE owner=?').run(now(),i.owner);return response(i,c);
   }
   if((!JSON.parse(c.state).run?.sharedEncounter||!['turn_ready','attack','cast','charm','allure','use_item','flee','submit','stand'].includes(input.action))&&(!Number.isSafeInteger(input.revision)||input.revision!==c.revision))fail(409,'Character changed; refresh before choosing another action.');
   const state=JSON.parse(c.state);let p,rpId;
   if(input.action==='enter'){state.contentVersion=input.content_version===1?1:0;state.questVersion=input.quest_version===1?1:0;}
   if(quests&&(Object.keys(live.published().quests).length||Object.keys(live.published().npcs).length)&&state.questVersion!==1)fail(409,'Update the game for online NPCs and quests.','client_update_required');
   if(live?.published().enabled&&state.contentVersion!==1&&['enter','dive_enter','dive_engage','hub_encounter'].includes(input.action))fail(409,'Update the game to use published world content.','client_update_required');
   if(state.loadout)rpp.attach(c,state.loadout);if(input.loadout)input={...input,loadout:rpp.attach(c,structuredClone(input.loadout))}; // Bind imported abilities and purchased spells to committed entitlements before any combat action.
   if(state.pendingDefeat&&!['enter','chat','defeat_complete'].includes(input.action))fail(409,'Finish the defeat dialogue before continuing.');
   if(input.action==='enter'){
    if(state.pendingDefeat&&input.defeat_version!==1)fail(409,'Update the game to finish this defeat dialogue.');
    state.deferDefeatReturn=input.defeat_version===1; // Older clients retain their existing settlement protocol.
    if(state.pendingDefeat&&state.dive)input={...input,zone:state.dive.zone??DIVE_ZONE};
    if(state.pendingDefeat?.hub)input={...input,zone:state.pendingDefeat.hub}; // Reconnect cannot strand a hub defeat scene in another room.
   }
   if(input.action==='enter'&&input.combat_version!==3){if(state.run?.sharedEncounter||parties.party(c.id))fail(409,'Update the game before controlling this party or shared battle.');state.diveCombatVersion=2;}
   if(input.action==='enter'&&input.combat_version===3)state.diveCombatVersion=3; // Explicit capability negotiation keeps old clients on the legacy encounter protocol.
   if(input.action==='enter'&&state.diveCombatVersion===3&&state.dive)input={...input,zone:state.dive.zone??DIVE_ZONE}; // A group transfer can overtake the disconnected client's cached destination.
   if(input.action==='enter'&&input.online_revision!==undefined){
    if(!Number.isSafeInteger(input.online_revision)||input.online_revision<0||input.online_revision>c.revision)fail(409,'Refresh the saved character revision.');
    if(state.loadout&&input.online_revision<(state.loadoutRevision??c.revision))input={...input,loadout:state.loadout}; // Older cloud/local campaigns cannot roll back committed online items and needs.
   }
   if(state.pendingPurchase&&!['enter','chat'].includes(input.action))fail(409,'Your purchase is still settling. Reconnect to finish it.','purchase_pending');
   if(state.worldTurnDue&&!['world_turn','enter','chat'].includes(input.action))fail(409,'Finish your pending exploration turn first.');
   const divePresence=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);
   if(quests&&input.action==='move'&&divePresence){const step={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]}[input.direction];if(step&&quests.placements.rows(divePresence.zone).length&&quests.placements.view(divePresence.zone).placements.some(p=>p.kind==='npc'&&p.x===divePresence.x+step[0]&&p.y===divePresence.y+step[1]))fail(409,'An NPC is standing there. Speak to them or walk around.');}
   if(quests&&/^(npc_|quest_)/.test(input.action)){presence(i,c,input.controller);quests.act(c,state,input);}
   else if(input.action.startsWith('party_')){presence(i,c,input.controller);parties.act(c,input,i.blockedAccounts??[]);}
   else if(['companion_equip','companion_unequip'].includes(input.action)){
    companionEquipment(db,c,state,divePresence?.seen>now()-30000?divePresence:null,input,hubData.equipment,hubData.config.inventory_capacity,now());
   }
   else if(input.action==='bank_sell'){ // Companion sale: account storage needs no zone presence, controller lease or shop fixture, but keeps every economy rule.
    if(state.run)fail(409,'Leave combat before selling.');
    const {stored,index,item}=bank.locate(c,input.bank_item),row=origins.sale(c,item);
    if(!row||row.id!==input.item_instance)fail(409,'Only tracked online loot and purchases can be sold.');
    const day=Math.floor(now()/86400000),used=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(i.owner,day)?.coins??0;
    if(row.price>Math.max(0,DAILY_COIN_CAP-used))fail(409,'Daily coin limit reached. Keep this item and sell it after the UTC reset.');
    stored.splice(index,1);bank.commit(c,stored);
    db.prepare("UPDATE quest_item_origins SET status='sold' WHERE id=?").run(row.id);
    adjust(i.owner,'coins',row.price,'sale-'+row.id,'LiDollQuest bank sale'); // Storage removal, one payout entitlement and its receipt commit atomically.
    db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(i.owner,day,row.price);
    state.hubNotice='Sold '+(JSON.parse(row.item).name??item.item_id)+' from your bank for '+row.price+' LiDollCoins.';state.hubNoticeAt=now();
   }else if(input.action==='world_turn'){
    presence(i,c,input.controller);
    if(!state.worldTurnDue||state.worldTurnDue.id!==input.world_turn_id||state.run)fail(409,'That exploration turn is no longer pending.');
    const next=importLoadout(input.loadout);next.player_info.companions=state.loadout?.player_info.companions??{};
    state.loadout=next;delete state.worldTurnDue;
    db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(now(),c.id);
   }else if(input.action==='rpp_buy'||input.action==='mage_pick'){
    presence(i,c,input.controller);rpp.buy(c,state,input);
   }else if(input.action==='rp_post'){
    p=presence(i,c,input.controller);
    if(muted(i.owner))fail(403,'A gamemaster has muted this account; you can still play normally.','rp_muted');
    if(state.run)fail(409,'Finish combat before posting RP.');
    if(isDungeon(p.zone)&&input.edition!==state.dive?.edition)fail(409,'The dungeon edition changed. Refresh before acting.');
    rpId=rp.post(c,input,rpArea(c,p),rpCandidates(i,c,p));
    db.prepare('UPDATE quest_presence SET seen=? WHERE owner=?').run(now(),i.owner);
   }else if(input.action==='chat'){
    p=presence(i,c,input.controller);
    const text=clean(input.text,240);if(!text)fail(400,'Write a message first.');
    if(muted(i.owner))fail(403,'A gamemaster has muted this account; you can still play normally.');
    if(db.prepare('SELECT COUNT(*) AS n FROM quest_chat WHERE owner=? AND created>?').get(i.owner,now()-10000).n>=5)fail(429,'Wait a moment before sending another message.'); // One account quota spans both channels and every zone.
    if(isDungeon(p.zone)&&input.edition!==state.dive?.edition)fail(409,'The dungeon edition changed. Refresh before acting.');
    const area=input.channel==='global'?'global:ooc':isDungeon(p.zone)?dive.chatArea(c,p)?.id:p.zone;
    if(!area)fail(409,'Re-enter the area before chatting.');
    db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created) VALUES (?,?,?,?,?,?)').run(area,i.owner,c.id,c.name,text,now());
    db.prepare('DELETE FROM quest_chat WHERE zone=? AND seq NOT IN (SELECT seq FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 100)').run(area,area);
    db.prepare('UPDATE quest_presence SET seen=? WHERE owner=?').run(now(),i.owner);
   }else if(hubEvents&&divePresence&&!isDungeon(divePresence.zone)&&(state.run?.kind==='hub_event'&&!['enter','chat'].includes(input.action)||input.action==='hub_encounter'||input.action==='defeat_complete'&&state.pendingDefeat?.hub)){
    p=presence(i,c,input.controller);hubEvents.engine(p.zone).act(c,state,input,p);
   }else if(dive.handles(input,divePresence)){
    if(!['enter','dive_enter'].includes(input.action))presence(i,c,input.controller);
    if(input.action==='appearance')chooseAvatar(input.avatar,i.owner,c.id);
    dive.act(i,c,state,input,divePresence);
    db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(now(),c.id);
   }else if(input.action==='enter'){
    const z=zone(state.hubVisit??input.zone),active=db.prepare('SELECT * FROM quest_presence WHERE owner=? AND seen>?').get(i.owner,now()-30000);
    const prior=db.prepare('SELECT grant_id,seen FROM quest_presence WHERE owner=?').get(i.owner);
    arrival=!prior||prior.grant_id!==i.id?'join':prior.seen<=now()-30000?'return':null;
    // Leaving deletes the row and a fresh sign-in issues a new grant, so either is a real arrival; the same grant
    // coming back to a row it never removed is the same session resuming after its heartbeats lapsed.
    if(active&&(active.controller!==input.controller||active.character_id!==c.id||active.grant_id!==i.id)&&input.takeover!==true)fail(409,'This account is active in another game window.','zone_controller_conflict'); // The owner may explicitly replace the single lease; ordinary retries never do.
    if(state.run&&state.run.zone!==z.id)fail(409,'Finish or forfeit the current arena run before changing zones.');
    if(input.loadout!==undefined&&!state.run&&!state.hubVisit&&!state.pendingPurchase&&!state.worldTurnDue&&!(input.takeover===true&&state.loadout))state.loadout=importLoadout(input.loadout); // Resume committed turns before importing another campaign inventory.
    if(z.parent)state.hubVisit=z.id; // Explicit annex entry also resumes committed inventory after reconnect.
    if(input.combat_version>=2&&state.run&&state.run.combatVersion!==2&&!state.run.sharedEncounter&&state.loadout)beginRound(state,z,roll); // Preserve the old opponent, HP and pot while upgrading an unfinished run.
    if(db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>? AND owner<>?').get(z.id,now()-30000,i.owner).n>=64)fail(429,'This zone is full. Try again shortly.');
    const spawn=divePresence?.zone===z.id?{x:divePresence.x,y:divePresence.y}:(z.spawn??{x:10,y:9});db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET character_id=excluded.character_id,zone=excluded.zone,grant_id=excluded.grant_id,controller=excluded.controller,x=excluded.x,y=excluded.y,seen=excluded.seen,moved=0').run(i.owner,c.id,z.id,i.id,input.controller,spawn.x,spawn.y,now());
   }else{
    p=presence(i,c,input.controller);const z=zone(p.zone);
    if(input.action==='hub_visit'){
     if(state.run)fail(409,'Finish or forfeit your arena run before visiting another room.');
     const destination=zone(input.zone);
     if(z.parent){if(destination.id!==z.parent)fail(409,'Return to your originating lobby.');} // The normal Return action works from anywhere outside combat.
     else {const portal=hubPortals(z.id).find(portal=>portal.target===destination.id);if(!portal||Math.abs(p.x-portal.x)+Math.abs(p.y-portal.y)>1)fail(409,'Stand next to the room entrance.');if(portal.style==='gap'&&!inHubGap(portal,p.x,p.y))fail(409,'Walk through the wall opening.');}
     visitHub(i,state,z,destination);
    }else if(input.action==='hub_talk'){
     if(!z.district&&z.kind!=='shops')fail(409,'There is nobody to talk to here.');
     const npc=nearbyFixture(z,p,input.fixture,'npc');state.hubNotice=npc.name+': '+npc.line;state.hubNoticeAt=now();
    }else if(input.action==='curse_remove'){purchases.prepareCurse(i,c,state,z,p,input);}
    else if(input.action==='shop_buy'){purchases.prepare(i,c,state,z,p,input);}
    else if(input.action==='item_discard'){ // Carried items only: commit removal and retire provenance inside the durable command transaction.
     if(state.run||!state.loadout)fail(409,'Leave combat before discarding items.');
     nearbyFixture(z,p,input.fixture,'dumpster');
     const inventory=state.loadout.inventory,item=Number.isInteger(input.slot)?inventory[input.slot]:null;
     if(!item||item.item_id!==input.item_id||(item.online_item??'')!==input.item_instance)fail(409,'That item changed. Choose it again.');
     if(item.category==='quest_item'||item.quest_item)fail(409,'Quest items cannot be thrown away.');
     inventory.splice(input.slot,1); // Equipment and bank storage are never disposal sources; reconciliation marks missing sale rights spent.
     state.hubNotice='Threw away '+(item.name??item.item_id)+'.';state.hubNoticeAt=now();
    }
    else if(input.action==='shop_sell'){
     if(state.run||!state.loadout)fail(409,'Leave combat before selling.');
     nearbyFixture(z,p,input.fixture,'shop');
     const inventory=state.loadout.inventory,item=Number.isInteger(input.slot)?inventory[input.slot]:null,row=origins.sale(c,item);
     if(!row||row.id!==input.item_instance)fail(409,'Only tracked online loot and purchases can be sold.');
     const day=Math.floor(now()/86400000),used=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(i.owner,day)?.coins??0;
     if(row.price>Math.max(0,DAILY_COIN_CAP-used))fail(409,'Daily coin limit reached. Keep this item and sell it after the UTC reset.');
     inventory.splice(input.slot,1);db.prepare("UPDATE quest_item_origins SET status='sold' WHERE id=?").run(row.id);
     adjust(i.owner,'coins',row.price,'sale-'+row.id,'LiDollQuest item sale'); // Item removal, one payout entitlement and its receipt commit atomically.
     db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(i.owner,day,row.price);
     state.hubNotice='Sold '+(JSON.parse(row.item).name??item.item_id)+' for '+row.price+' LiDollCoins.';state.hubNoticeAt=now();
    }
    else if(['bank_deposit','bank_withdraw','bank_page'].includes(input.action)){bank.transfer(c,state,z,p,input);}
    else if(input.action==='hub_rest'){
     if(state.run)fail(409,'Finish combat before resting.');nearbyFixture(z,p,input.fixture,'bed');
     if(state.restedAt&&now()-state.restedAt<hubData.config.rest_tick_ms)fail(429,'Wait for the next rest turn.');
     const next=importLoadout(input.loadout);next.player_info.companions=state.loadout?.player_info.companions??{};state.loadout=next;state.restedAt=now();
    }else if(input.action==='appearance'){state.avatar=chooseAvatar(input.avatar,i.owner,c.id);} // Private sprites require this character's ownership as well as ordinary replay/presence checks.
    else if(input.action==='allocate'){
     if(!state.loadout||state.run?.phase==='fight'||!['str','def','dex','int','cha'].includes(input.stat)||!(state.loadout.player_info.stat_points>0))fail(409,'Choose an available level-up stat point between rounds.');
     state.loadout.player_info[input.stat]++;state.loadout.player_info.stat_points--;
     if(input.stat==='int'){state.loadout.player_mp_max=manaCapacity(state.loadout);state.loadout.player_mp=Math.min(state.loadout.player_mp,state.loadout.player_mp_max);}
     if(state.run){applyRunLoadout(state.run,state.loadout);state.run.log.push('+1 '+input.stat.toUpperCase()+'.');}
    }
    else if(input.action==='turn_ready'){
     if(state.run?.combatVersion!==2||state.run.phase!=='fight'||state.run.turnReady)fail(409,'No unprepared combat turn.');
     if(typeof input.forfeit!=='boolean')fail(400,'Supply the turn status.');
     const next=importLoadout(input.loadout);next.player_info.companions=state.loadout.player_info.companions??{};state.loadout=next;
     combatResult(i,c,state,z,readyTurn(state,input.forfeit,z,roll));
    }
    else if(input.action==='loadout'||input.action==='use_item'){
     if(input.action==='loadout'&&state.run)fail(409,'Use Items during a run to change equipment or consume an item.');
     if(state.run?.combatVersion===2&&state.run.phase==='fight'&&!state.run.turnReady)fail(409,'Wait for the next player turn.');
     const next=importLoadout(input.loadout);state.loadout=next;
     if(state.run){
      const r=state.run;if(now()-r.acted<300)fail(429,'Wait for the current turn.');r.acted=now();applyRunLoadout(r,next);
      r.log=['Used campaign inventory.'];
      if(r.combatVersion===2){if(r.phase==='fight')combatResult(i,c,state,z,combatAction(state,input,z,roll));}
      else if(r.phase==='fight'){r.enemy.turn++;let hit=z.attack+r.stage+roll(3);if(z.theme==='clockwork'&&r.enemy.turn%3===0)hit+=5;hit=Math.max(1,hit-(r.defense??0));r.hp=Math.max(0,r.hp-hit);r.log.push(r.enemy.name+' dealt '+hit+' damage.');}
      syncRunHealth(state,r);if(!r.hp){state.lastResult={outcome:'defeat',coins:0,rounds:r.stage-1,zone:z.id,...defeatPresentation(r,'defeat')};state.run=null;}
     }
    }
    else if(input.action==='leave'){delete state.hubVisit;if(state.run)fail(409,'Bank your completed rounds or forfeit before leaving.');db.prepare('DELETE FROM quest_presence WHERE owner=?').run(i.owner);}
    else if(input.action==='move'){
     if(state.run?.phase==='fight')fail(409,'Finish this round before moving.');
     if(now()-p.moved<movementDelay(state.loadout))fail(429,'Movement is too fast.');
     const directions={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]},d=Object.hasOwn(directions,input.direction)?directions[input.direction]:null;if(!d)fail(400,'Choose a movement direction.');
     const x=p.x+d[0],y=p.y+d[1];if(blocked(z,x,y))fail(409,'That tile is blocked.');
     const gap=hubGaps(z).find(g=>inHubGap(g,x,y));
     if(gap)visitHub(i,state,z,zone(gap.target)); // The server commits wall contact and room transfer in one receipt, including click-path movement.
     else {db.prepare('UPDATE quest_presence SET x=?,y=?,moved=? WHERE owner=?').run(x,y,now(),i.owner);if(input.world_step===true&&state.loadout)state.worldTurnDue={id:randomUUID()};} // Ordinary walking still reserves one recoverable needs turn.
    }else if(input.action==='start'){
     if(z.parent)fail(409,'Return to the arena lobby to start a run.');if(state.run)fail(409,'An arena run is already in progress.');if(state.lastStart&&now()-state.lastStart<60000)fail(429,'Wait one minute between arena entries.');
     if(input.loadout!==undefined)state.loadout=importLoadout(input.loadout);
     if(state.loadout&&state.loadout.player_info.playerHealth<=0)fail(409,'Recover HP with an item before starting another run.');
     state.lastStart=now();state.lastResult=null;state.run={id:randomUUID(),zone:z.id,stage:1,phase:'fight',hp:70,maxHp:70,heals:3,pot:0,attack:11,handicaps:[],enemy:enemy(z,1),acted:0,log:['Round 1 begins.']};
     if(state.loadout){applyRunLoadout(state.run,state.loadout);state.run.heals=0;} // Imported characters heal with their own consumables.
     if(input.combat_version>=2){if(!state.loadout)fail(400,'Import a campaign character first.');beginRound(state,z,roll);}
    }else if(input.action==='flee'||input.action==='submit'){
     if(!state.run)fail(409,'No active run.');if(state.run.combatVersion===2)clearEffects(state);syncRunHealth(state,state.run);state.lastResult={outcome:input.action==='submit'?'submitted':'forfeit',coins:0,rounds:state.run.stage-1,zone:z.id,...defeatPresentation(state.run,input.action)};state.run=null;
    }else{
     const r=state.run;if(!r||r.zone!==z.id)fail(409,'Start an arena run first.');
     if(input.action==='cashout'){if(r.phase!=='interval')fail(409,'Finish the round before banking.');settle(i,c,state,r);}
     else if(input.action==='continue'){
      if(r.phase!=='interval')fail(409,'Finish the current round first.');
      const handicap=roll(3);r.handicaps.push(['Weakened strikes','Reduced vitality',state.loadout?'Reduced armor':'Healing charge lost'][handicap]);
      if(handicap===0)r.attack=Math.max(state.loadout?1:5,r.attack-1);else if(handicap===1){r.maxHp=Math.max(state.loadout?1:25,r.maxHp-5);r.hp=Math.min(r.hp,r.maxHp);}else if(state.loadout)r.defense--;else r.heals=Math.max(0,r.heals-1);
      r.stage++;r.enemy=enemy(z,r.stage);r.phase='fight';r.log=['Round '+r.stage+'. '+r.handicaps.at(-1)+'.'];
      if(r.combatVersion===2){syncRunHealth(state,r);beginRound(state,z,roll);}
     }else if(r.combatVersion===2&&['attack','cast','charm','allure','stand'].includes(input.action)){
      if(now()-r.acted<300)fail(429,'Wait for the current turn.');r.acted=now();combatResult(i,c,state,z,combatAction(state,input,z,roll));
     }else if(r.combatVersion!==2&&['attack','guard','heal'].includes(input.action)){
      if(r.phase!=='fight')fail(409,'Choose bank or continue.');if(now()-r.acted<300)fail(429,'Wait for the current turn.');r.acted=now();
      let guarded=input.action==='guard',damage=0;r.log=[];
      if(input.action==='heal'){if(r.heals<1)fail(409,'No healing charges remain.');r.heals--;r.hp=Math.min(r.maxHp,r.hp+24);r.log.push('Recovered 24 HP.');}
      else{damage=guarded?4:r.attack+roll(4);r.enemy.hp=Math.max(0,r.enemy.hp-damage);r.log.push('You dealt '+damage+' damage.');}
      if(r.enemy.hp===0){r.pot+=r.stage*5;r.phase='interval';r.hp=Math.min(r.maxHp,r.hp+z.recovery);r.log.push('Round cleared. Bank '+r.pot+' coins or continue with a handicap.');if(r.stage===8)settle(i,c,state,r);}
      else{r.enemy.turn++;let hit=z.attack+r.stage+roll(3);if(z.theme==='clockwork'&&r.enemy.turn%3===0)hit+=5;if(z.theme==='mirror')hit+=r.enemy.turn%2===0?5:-2;hit=Math.max(1,hit-(r.defense??0));if(guarded)hit=Math.max(1,Math.floor(hit/3));if(z.theme==='bramble'&&input.action==='attack')hit+=2;r.hp=Math.max(0,r.hp-hit);r.log.push(r.enemy.name+' dealt '+hit+' damage.');
       syncRunHealth(state,r);
       if(!r.hp){state.lastResult={outcome:'defeat',coins:0,rounds:r.stage-1,zone:z.id,...defeatPresentation(r,'defeat')};state.run=null;}
      }
     }else fail(400,'Unknown zone action.');
    }
    if(input.action!=='leave')db.prepare('UPDATE quest_presence SET seen=? WHERE owner=?').run(now(),i.owner);
   }
   const afterPresence=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);
   if(input.action!=='defeat_complete')parties.transfer(c,state,divePresence,afterPresence); // Portal transfers remain grouped; defeat acknowledgement returns only its reader.
   if(input.action==='leave'&&!afterPresence)parties.remove(c.id); // Campaign return leaves only this member.
   if(quests)quests.after(c,state,input);
   if(state.run)syncRunHealth(state,state.run);
   origins.reconcile(c,state,JSON.parse(c.state)); // Strip forged/duplicate item markers on every imported loadout and persist equipment/bank transitions.
   if(input.loadout&&state.loadout?.player_info?.name&&!state.nameLocked){const name=clean(state.loadout.player_info.name,24);if(name){c.name=name;state.nameLocked=true;db.prepare('UPDATE quest_characters SET name=? WHERE id=?').run(name,c.id);}} // Reconcile legacy campaign names once; subsequent renames use the paid management action.
   if(state.loadout?.player_info){
    if(!state.profileAppearance){const initial={gender:'Female',hair_style:1,hair_color:'Brown',has_breasts:false,nipple_style:0,penis_style:0,pubes_style:0};for(const key of appearanceFields)if(state.loadout.player_info[key]!==undefined)initial[key]=state.loadout.player_info[key];state.profileAppearance=initial;}
    Object.assign(state.loadout.player_info,{name:c.name},state.profileAppearance);
   } // Preserve the first imported paperdoll; subsequent changes require the paid makeover, including legacy-client imports.
   publishPlayerActivity(db,{previous:JSON.parse(c.state),state,action:input.action,character:c,owner:i.owner,now,area:()=>{
    const p=db.prepare('SELECT * FROM quest_presence WHERE character_id=? AND seen>?').get(c.id,now()-30000);
    return p?(isDungeon(p.zone)?dive.chatArea({...c,state:JSON.stringify(state)},p)?.id:p.zone):null;
   }}); // Emit shared notices in this same transaction, using the committed route/room rather than a client-supplied destination.
   if(JSON.stringify(state.loadout)!==JSON.stringify(JSON.parse(c.state).loadout))state.loadoutRevision=c.revision+1;
   c.revision++;c.state=JSON.stringify(state);db.prepare('UPDATE quest_characters SET revision=?,state=? WHERE id=?').run(c.revision,c.state,c.id);
   const receipt={request_id:input.request_id,revision:c.revision,action:input.action,result:state.lastResult,...(rpId?{rpId}: {})};
   db.prepare('INSERT INTO quest_commands VALUES (?,?,?,?,?)').run(c.id,input.request_id,c.revision,fingerprint,JSON.stringify(receipt));
   db.prepare('DELETE FROM quest_commands WHERE character_id=? AND revision<?').run(c.id,c.revision-128);
   onPresence(c,afterPresence,arrival); // Publish only committed, authenticated presence; a failed command rolls its event back too.
   return {...response(i,c),receipt};
  });
 }
 function inspect(secret,id,target,controller){
  const i=identity(secret);limit(i.owner);const c=character(i.owner,id),p=presence(i,c,controller);
  const other=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(target),op=db.prepare('SELECT * FROM quest_presence WHERE character_id=? AND seen>?').get(target,now()-30000);
  if(!other||!op||!enabled(other.owner)||op.zone!==p.zone)fail(404,'That player is no longer in this area.');
  if(isDungeon(p.zone)){const a=JSON.parse(c.state).dive,b=JSON.parse(other.state).dive;if(!a||!b||a.route!==b.route||a.depth!==b.depth||a.edition!==b.edition)fail(404,'That player is no longer in this area.');} // Inspection follows displayed peers on the same weekly floor; chat room boundaries never make a visible player unclickable.
  return inspectionProjection(other);
 }
 return {read,act,inspect,enchantments,world,quests,questRead(secret,id,quest){const i=identity(secret),c=character(i.owner,id);return quests.detail(c,JSON.parse(c.state),quest);},setPrivateSprites(value){privateSprites=value;},tick(){districts.tick();dive.tick();if(hubEvents)atomic(()=>hubEvents.tick());if(quests)atomic(()=>quests.tick());},prepare:()=>Promise.all([...engines.values()].map(route=>route.prepare())),close(){for(const route of engines.values())route.close();},completePurchase:purchases.complete}; // One coordinator owns simulation and commits; workers only calculate candidate results.
} // Campaign stats and inventory are client-trusted; arena outcomes and shared-currency awards still belong to this simulation.
