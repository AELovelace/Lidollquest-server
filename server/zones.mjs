import {createHubDistricts} from './hub-districts.mjs';
import {randomUUID,randomInt,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {importLoadout,applyRunLoadout,syncRunHealth} from './loadout.mjs';
import {beginRound,clearEffects,readyTurn,combatAction,awardExperience} from './combat.mjs';
import {hubRooms,hubPortals,hubBlocked,hubDefinition,nearbyFixture,hubData,createHubPurchases,hubGaps,inHubGap,hubCatalog,campaignDives,DAILY_COIN_CAP} from './hubs.mjs';
import {createDive,DIVE_ZONE} from './dive.mjs';
import {generateDesert} from './desert-generation.mjs';
export const DESERT_ZONE='dive-desert';
export const desertData=JSON.parse(readFileSync(new URL('./desert-data.json',import.meta.url),'utf8'));
export const TUNDRA_ZONE='dive-tundra';
export const tundraData=JSON.parse(readFileSync(new URL('./tundra-data.json',import.meta.url),'utf8'));
import {createBank} from './bank.mjs';
import {createItemOrigins} from './item-origins.mjs';
import {inspectionProjection} from './inspection.mjs';
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

export function createQuestZones(db,{grant,wallet,adjust,enabled=()=>true,now=Date.now,roll=randomInt,diveOptions={},desertOptions={},tundraOptions={}}={}) {
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
 const districts=createHubDistricts(db,{now});
 const zone=id=>districts.resolve(baseZone(id));
 const origins=createItemOrigins(db);
 const purchases=createHubPurchases(db,{now,origins});
 const bank=createBank(db);
 const quarters=createDive(db,{now,roll,adjust,origins,...diveOptions});
 const desert=createDive(db,{now,roll,adjust,origins,data:desertData,generate:generateDesert,...desertOptions});
 const tundra=createDive(db,{now,roll,adjust,origins,data:tundraData,generate:generateDesert,...tundraOptions});
 const engines=new Map([[DIVE_ZONE,quarters],[DESERT_ZONE,desert],[TUNDRA_ZONE,tundra]]);
 for(const data of campaignDives)engines.set(data.config.zone_id,createDive(db,{now,roll,adjust,origins,data})); // Each destination keeps its own editions, loot receipts and encounter locks.
 const isDungeon=id=>engines.has(id);
 const engine=id=>engines.get(id)??quarters; // No active visit still exposes the legacy Quarters summary.
 const dive={tick(){for(const route of engines.values())route.tick();},
  snapshot(c,p){return engine(p?.zone??(c?JSON.parse(c.state).dive?.zone:null)).snapshot(c,p);},
  chatArea(c,p){return engine(p.zone).chatArea(c,p);},
  handles(input,p){return [...engines.values()].some(route=>route.handles(input,p));},
  act(i,c,state,input,p){const id=state.dive?.zone??(state.dive?DIVE_ZONE:input.zone??p?.zone);return engine(id).act(i,c,state,input,p);}}; // Share settlement and leases, while keeping weekly maps and claims route-scoped.
 function identity(secret){const i=grant(secret,'wallet:read');if(i.client!=='lidollquest')fail(403,'These zones are for LiDollQuest.');return i;} // A registered app ID alone is not a player identity.
 function atomic(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
 function limit(owner){const time=now();db.prepare('DELETE FROM quest_request_limits WHERE started<=?').run(time-60000);const r=db.prepare('INSERT INTO quest_request_limits VALUES (?,?,1) ON CONFLICT(owner) DO UPDATE SET count=count+1 RETURNING count').get(owner,time);if(r.count>600)fail(429,'Please slow down.');}
 function character(owner,id){if(!identifier(id))fail(400,'Choose an online character.');const c=db.prepare('SELECT * FROM quest_characters WHERE owner=? AND id=?').get(owner,id);if(!c)fail(404,'Online character not found for this account.');return c;}
 function publicCharacter(c){return {avatar:'player',id:c.id,name:c.name,revision:c.revision,...JSON.parse(c.state)};} // Existing characters keep their default appearance without a database migration.
 function presence(i,c,controller){const p=db.prepare('SELECT * FROM quest_presence WHERE owner=? AND character_id=? AND grant_id=? AND controller=? AND seen>?').get(i.owner,c.id,i.id,controller,now()-30000);if(!p)fail(409,'Enter the zone again; this connection no longer controls the character.');return p;}
 function visitHub(i,state,source,destination){
  if(state.run)fail(409,'Finish or forfeit your arena run before visiting another room.');
  if(db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>?').get(destination.id,now()-30000).n>=64)fail(429,'This room is full.');
  if(destination.parent)state.hubVisit=destination.id;else delete state.hubVisit;
  let spawn=destination.spawn??{x:10,y:9};
  if(source.parent===destination.id&&['garden','beds'].includes(source.kind))spawn={x:source.kind==='garden'?1:18,y:6};
  db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE owner=?').run(destination.id,spawn.x,spawn.y,now(),i.owner);
 } // Enter just inside the matching wall opening, facing into the destination; a held movement key cannot immediately bounce back.
 function snapshot(i,c=null,view={}){
  const p=c?db.prepare('SELECT * FROM quest_presence WHERE owner=? AND character_id=? AND seen>?').get(i.owner,c.id,now()-30000):null;
  const peers=p?db.prepare('SELECT p.*,c.name,c.state FROM quest_presence p JOIN quest_characters c ON c.id=p.character_id WHERE p.zone=? AND p.seen>? ORDER BY p.character_id LIMIT 64').all(p.zone,now()-30000).filter(r=>enabled(r.owner)).map(r=>({id:r.character_id,name:r.name,avatar:JSON.parse(r.state).avatar??'player',x:r.x,y:r.y,stage:JSON.parse(r.state).run?.stage??0,fighting:JSON.parse(r.state).run?.phase==='fight'})):[];
  const chatArea=isDungeon(p?.zone)?dive.chatArea(c,p):p?{id:p.zone,name:zone(p.zone).name}:null;
  const chat=chatArea?db.prepare('SELECT seq,name,text,character_id AS characterId FROM quest_chat WHERE zone=? AND created>? ORDER BY seq DESC LIMIT 40').all(chatArea.id,now()-86400000).reverse():[];
  const spent=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(i.owner,Math.floor(now()/86400000))?.coins??0;
  const dungeon=dive.snapshot(c,p),definitions=[...questZones,...hubRooms].map(base=>{
   const z=zone(base.id),definition=hubDefinition(z,now());
   if(z.district&&p?.zone!==z.id){const {floors,rooms,...summary}=definition;return {...summary,fixtures:[],walls:[]};} // Only the visited district sends its full monthly map.
   return {...definition,walls:z.walls??Array.from({length:z.height??12},(_,y)=>Array.from({length:z.width??20},(_,x)=>blocked({...z,fixtures:[]},x,y)?1:0))};
  });
  if(dungeon.definition)definitions.push(dungeon.definition);
  const edition=c?JSON.parse(c.state).dive?.edition:null;
  const visiblePeers=isDungeon(p?.zone)?peers.filter(peer=>JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(peer.id).state).dive?.edition===edition):peers;
  return {dungeons:[...engines].map(([id,route])=>({id,enabled:route.snapshot(null,null).dive.enabled})),serverTime:now(),loadoutSupport:true,combatVersion:2,controllerTakeover:true,dive:dungeon.dive,desert:desert.snapshot(c,null).dive,tundra:tundra.snapshot(c,null).dive,avatars:questAvatars,zones:definitions,characters:db.prepare('SELECT * FROM quest_characters WHERE owner=? ORDER BY created,id').all(i.owner).map(row=>{const {loadout,...summary}=publicCharacter(row);return summary;}),character:c?publicCharacter(c):null,zone:p?.zone??null,position:p?{x:p.x,y:p.y}:null,peers:visiblePeers,chat,chatArea,bank:bank.snapshot(c,p,p&&!isDungeon(p.zone)?zone(p.zone):null,view),...(view.companion&&c?{sheet:inspectionProjection(c)}:{}),coins:wallet(i.owner).coins,dailyRemaining:Math.max(0,DAILY_COIN_CAP-spent),dailyCap:DAILY_COIN_CAP};
 } // Snapshots expose only zone avatars and chat, never wallet credentials or account IDs.
 function read(secret,id,view={}){const i=identity(secret);limit(i.owner);districts.refresh();dive.tick();return snapshot(i,id?character(i.owner,id):null,view);} // Only this read honours the companion view; every in-play snapshot keeps the beside-a-bank rule.
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
   state.lastResult={outcome:result,coins:0,rounds:r.stage-1,zone:z.id,log:r.log};state.run=null;
  }
 }
 function act(secret,input){
  const i=identity(secret);limit(i.owner);
  grant(secret,'wallet:write');
  districts.refresh(); // Materialize monthly maps before the command transaction, keeping rollback and cached geometry consistent.
  dive.tick(); // Scheduled resets and enemy decisions precede command revision checks.
  if(!input||!identifier(input.request_id)||!identifier(input.controller))fail(400,'Supply a stable request ID and controller.');
   if(Object.keys(input).some(k=>!['action','request_id','controller','character_id','revision','name','zone','direction','text','avatar','loadout','combat_version','spell','forfeit','stat','edition','encounter','chest','takeover','fixture','offer','slot','bank_item','page','world_step','world_turn_id','item_instance','creation','online_revision'].includes(k)))fail(400,'Unsupported zone input.');
  if(input.takeover!==undefined&&(input.action!=='enter'||typeof input.takeover!=='boolean'))fail(400,'Control can only be transferred by an explicit entry request.'); // Never let movement or a background heartbeat steal control.
  return atomic(()=>{
   identity(secret);
   if(input.action==='create'){
    if(db.prepare('SELECT 1 FROM quest_deleted_characters WHERE owner=? AND creation_id=?').get(i.owner,input.request_id))fail(410,'This character was deleted. Start a new character.');
    const name=clean(input.name,24),appearance=avatar(input.avatar===undefined?'player':input.avatar);if(!name)fail(400,'Give your online character a name.');
    let c=db.prepare('SELECT * FROM quest_characters WHERE owner=? AND creation_id=?').get(i.owner,input.request_id);
    if(c&&(JSON.parse(c.state).creationName??c.name)!==name)fail(409,'This creation request already has another name.');
    if(c&&(JSON.parse(c.state).creationAvatar??'player')!==appearance)fail(409,'This creation request already has another appearance.');
    const creation=input.creation??null;if(creation!==null&&(typeof creation!=='object'||Array.isArray(creation)||Buffer.byteLength(JSON.stringify(creation))>8192))fail(400,'Invalid creation choices.');
    if(c&&JSON.stringify(JSON.parse(c.state).creation??null)!==JSON.stringify(creation))fail(409,'This creation request already has different choices.');
    if(!c){if(db.prepare('SELECT COUNT(*) AS n FROM quest_characters WHERE owner=?').get(i.owner).n>=5)fail(409,'This account already has five online characters.');const id=randomUUID();db.prepare('INSERT INTO quest_characters VALUES (?,?,?,?,0,?,?)').run(id,i.owner,name,now(),JSON.stringify({avatar:appearance,creationAvatar:appearance,creationName:name,creation,wins:0,run:null,lastStart:0,lastResult:null}),input.request_id);c=character(i.owner,id);}
    return snapshot(i,c);
   }
   const c=character(i.owner,input.character_id),fingerprint=createHash('sha256').update(JSON.stringify(Object.keys(input).sort().map(k=>[k,canonical(input[k])]))).digest('hex'); // Preserve legacy flat command fingerprints while stabilizing nested loadout data.
   if(db.prepare("SELECT 1 FROM quest_management WHERE character_id=? AND status='pending'").get(c.id))fail(409,'Your character change is still settling.','character_change_pending');
   const old=db.prepare('SELECT * FROM quest_commands WHERE character_id=? AND request_id=?').get(c.id,input.request_id);
   if(old){if(old.fingerprint!==fingerprint)fail(409,'This request ID already describes another action.');return {...snapshot(i,c),receipt:JSON.parse(old.result)};}
   if(input.action==='heartbeat'){
    presence(i,c,input.controller);db.prepare('UPDATE quest_presence SET seen=? WHERE owner=?').run(now(),i.owner);return snapshot(i,c);
   }
   if(!Number.isSafeInteger(input.revision)||input.revision!==c.revision)fail(409,'Character changed; refresh before choosing another action.');
   const state=JSON.parse(c.state);let p;
   if(input.action==='enter'&&input.online_revision!==undefined){
    if(!Number.isSafeInteger(input.online_revision)||input.online_revision<0||input.online_revision>c.revision)fail(409,'Refresh the saved character revision.');
    if(state.loadout&&input.online_revision<(state.loadoutRevision??c.revision))input={...input,loadout:state.loadout}; // Older cloud/local campaigns cannot roll back committed online items and needs.
   }
   if(state.pendingPurchase&&!['enter','chat'].includes(input.action))fail(409,'Your purchase is still settling. Reconnect to finish it.','purchase_pending');
   if(state.worldTurnDue&&!['world_turn','enter','chat'].includes(input.action))fail(409,'Finish your pending exploration turn first.');
   const divePresence=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);
   if(input.action==='bank_sell'){ // Companion sale: account storage needs no zone presence, controller lease or shop fixture, but keeps every economy rule.
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
   }else if(dive.handles(input,divePresence)){
    if(!['enter','dive_enter'].includes(input.action))presence(i,c,input.controller);
    if(input.action==='appearance')avatar(input.avatar);
    dive.act(i,c,state,input,divePresence);
    db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(now(),c.id);
   }else if(input.action==='enter'){
    const z=zone(state.hubVisit??input.zone),active=db.prepare('SELECT * FROM quest_presence WHERE owner=? AND seen>?').get(i.owner,now()-30000);
    if(active&&(active.controller!==input.controller||active.character_id!==c.id||active.grant_id!==i.id)&&input.takeover!==true)fail(409,'This account is active in another game window.','zone_controller_conflict'); // The owner may explicitly replace the single lease; ordinary retries never do.
    if(state.run&&state.run.zone!==z.id)fail(409,'Finish or forfeit the current arena run before changing zones.');
    if(input.loadout!==undefined&&!state.run&&!state.hubVisit&&!state.pendingPurchase&&!state.worldTurnDue&&!(input.takeover===true&&state.loadout))state.loadout=importLoadout(input.loadout); // Resume committed turns before importing another campaign inventory.
    if(z.parent)state.hubVisit=z.id; // Explicit annex entry also resumes committed inventory after reconnect.
    if(input.combat_version===2&&state.run&&state.run.combatVersion!==2&&state.loadout)beginRound(state,z,roll); // Preserve the old opponent, HP and pot while upgrading an unfinished run.
    if(db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>? AND owner<>?').get(z.id,now()-30000,i.owner).n>=64)fail(429,'This zone is full. Try again shortly.');
    const spawn=z.spawn??{x:10,y:9};db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET character_id=excluded.character_id,zone=excluded.zone,grant_id=excluded.grant_id,controller=excluded.controller,x=excluded.x,y=excluded.y,seen=excluded.seen,moved=0').run(i.owner,c.id,z.id,i.id,input.controller,spawn.x,spawn.y,now());
   }else{
    p=presence(i,c,input.controller);const z=zone(p.zone);
    if(input.action==='hub_visit'){
     if(state.run)fail(409,'Finish or forfeit your arena run before visiting another room.');
     const destination=zone(input.zone);
     if(z.parent){if(destination.id!==z.parent)fail(409,'Return to your originating lobby.');} // The normal Return action works from anywhere outside combat.
     else {const portal=hubPortals(z.id).find(portal=>portal.target===destination.id);if(!portal||Math.abs(p.x-portal.x)+Math.abs(p.y-portal.y)>1)fail(409,'Stand next to the room entrance.');if(portal.style==='gap'&&!inHubGap(portal,p.x,p.y))fail(409,'Walk through the wall opening.');}
     visitHub(i,state,z,destination);
    }else if(input.action==='hub_talk'){
     if(!z.district)fail(409,'There is nobody to talk to here.');
     const npc=nearbyFixture(z,p,input.fixture,'npc');state.hubNotice=npc.name+': '+npc.line;state.hubNoticeAt=now();
    }else if(input.action==='shop_buy'){purchases.prepare(i,c,state,z,p,input);}
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
    }else if(input.action==='appearance'){state.avatar=avatar(input.avatar);} // Cosmetic changes use the same ownership, presence, revision and replay checks as other arena commands.
    else if(input.action==='allocate'){
     if(!state.loadout||state.run?.phase==='fight'||!['str','def','dex','int','cha'].includes(input.stat)||!(state.loadout.player_info.stat_points>0))fail(409,'Choose an available level-up stat point between rounds.');
     state.loadout.player_info[input.stat]++;state.loadout.player_info.stat_points--;
     if(input.stat==='int'){state.loadout.player_mp_max=Math.max(0,10+state.loadout.player_info.int*5);state.loadout.player_mp=Math.min(state.loadout.player_mp,state.loadout.player_mp_max);}
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
      syncRunHealth(state,r);if(!r.hp){state.lastResult={outcome:'defeat',coins:0,rounds:r.stage-1,zone:z.id};state.run=null;}
     }
    }
    else if(input.action==='leave'){delete state.hubVisit;if(state.run)fail(409,'Bank your completed rounds or forfeit before leaving.');db.prepare('DELETE FROM quest_presence WHERE owner=?').run(i.owner);}
    else if(input.action==='move'){
     if(state.run?.phase==='fight')fail(409,'Finish this round before moving.');
     if(now()-p.moved<200)fail(429,'Movement is too fast.');
     const directions={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]},d=Object.hasOwn(directions,input.direction)?directions[input.direction]:null;if(!d)fail(400,'Choose a movement direction.');
     const x=p.x+d[0],y=p.y+d[1];if(blocked(z,x,y))fail(409,'That tile is blocked.');
     const gap=hubGaps(z).find(g=>inHubGap(g,x,y));
     if(gap)visitHub(i,state,z,zone(gap.target)); // The server commits wall contact and room transfer in one receipt, including click-path movement.
     else {db.prepare('UPDATE quest_presence SET x=?,y=?,moved=? WHERE owner=?').run(x,y,now(),i.owner);if(input.world_step===true&&state.loadout)state.worldTurnDue={id:randomUUID()};} // Ordinary walking still reserves one recoverable needs turn.
    }else if(input.action==='chat'){
     const text=clean(input.text,240);if(!text)fail(400,'Write a message first.');
     if(db.prepare('SELECT COUNT(*) AS n FROM quest_chat WHERE owner=? AND created>?').get(i.owner,now()-10000).n>=5)fail(429,'Wait a moment before sending another message.');
     db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created) VALUES (?,?,?,?,?,?)').run(z.id,i.owner,c.id,c.name,text,now());
     db.prepare('DELETE FROM quest_chat WHERE zone=? AND seq NOT IN (SELECT seq FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 100)').run(z.id,z.id);
    }else if(input.action==='start'){
     if(z.parent)fail(409,'Return to the arena lobby to start a run.');if(state.run)fail(409,'An arena run is already in progress.');if(state.lastStart&&now()-state.lastStart<60000)fail(429,'Wait one minute between arena entries.');
     if(input.loadout!==undefined)state.loadout=importLoadout(input.loadout);
     if(state.loadout&&state.loadout.player_info.playerHealth<=0)fail(409,'Recover HP with an item before starting another run.');
     state.lastStart=now();state.lastResult=null;state.run={id:randomUUID(),zone:z.id,stage:1,phase:'fight',hp:70,maxHp:70,heals:3,pot:0,attack:11,handicaps:[],enemy:enemy(z,1),acted:0,log:['Round 1 begins.']};
     if(state.loadout){applyRunLoadout(state.run,state.loadout);state.run.heals=0;} // Imported characters heal with their own consumables.
     if(input.combat_version===2){if(!state.loadout)fail(400,'Import a campaign character first.');beginRound(state,z,roll);}
    }else if(input.action==='flee'||input.action==='submit'){
     if(!state.run)fail(409,'No active run.');if(state.run.combatVersion===2)clearEffects(state);syncRunHealth(state,state.run);state.lastResult={outcome:input.action==='submit'?'submitted':'forfeit',coins:0,rounds:state.run.stage-1,zone:z.id};state.run=null;
    }else{
     const r=state.run;if(!r||r.zone!==z.id)fail(409,'Start an arena run first.');
     if(input.action==='cashout'){if(r.phase!=='interval')fail(409,'Finish the round before banking.');settle(i,c,state,r);}
     else if(input.action==='continue'){
      if(r.phase!=='interval')fail(409,'Finish the current round first.');
      const handicap=roll(3);r.handicaps.push(['Weakened strikes','Reduced vitality',state.loadout?'Reduced armor':'Healing charge lost'][handicap]);
      if(handicap===0)r.attack=Math.max(state.loadout?1:5,r.attack-1);else if(handicap===1){r.maxHp=Math.max(state.loadout?1:25,r.maxHp-5);r.hp=Math.min(r.hp,r.maxHp);}else if(state.loadout)r.defense--;else r.heals=Math.max(0,r.heals-1);
      r.stage++;r.enemy=enemy(z,r.stage);r.phase='fight';r.log=['Round '+r.stage+'. '+r.handicaps.at(-1)+'.'];
      if(r.combatVersion===2){syncRunHealth(state,r);beginRound(state,z,roll);}
     }else if(r.combatVersion===2&&['attack','cast','charm','allure'].includes(input.action)){
      if(now()-r.acted<300)fail(429,'Wait for the current turn.');r.acted=now();combatResult(i,c,state,z,combatAction(state,input,z,roll));
     }else if(r.combatVersion!==2&&['attack','guard','heal'].includes(input.action)){
      if(r.phase!=='fight')fail(409,'Choose bank or continue.');if(now()-r.acted<300)fail(429,'Wait for the current turn.');r.acted=now();
      let guarded=input.action==='guard',damage=0;r.log=[];
      if(input.action==='heal'){if(r.heals<1)fail(409,'No healing charges remain.');r.heals--;r.hp=Math.min(r.maxHp,r.hp+24);r.log.push('Recovered 24 HP.');}
      else{damage=guarded?4:r.attack+roll(4);r.enemy.hp=Math.max(0,r.enemy.hp-damage);r.log.push('You dealt '+damage+' damage.');}
      if(r.enemy.hp===0){r.pot+=r.stage*5;r.phase='interval';r.hp=Math.min(r.maxHp,r.hp+z.recovery);r.log.push('Round cleared. Bank '+r.pot+' coins or continue with a handicap.');if(r.stage===8)settle(i,c,state,r);}
      else{r.enemy.turn++;let hit=z.attack+r.stage+roll(3);if(z.theme==='clockwork'&&r.enemy.turn%3===0)hit+=5;if(z.theme==='mirror')hit+=r.enemy.turn%2===0?5:-2;hit=Math.max(1,hit-(r.defense??0));if(guarded)hit=Math.max(1,Math.floor(hit/3));if(z.theme==='bramble'&&input.action==='attack')hit+=2;r.hp=Math.max(0,r.hp-hit);r.log.push(r.enemy.name+' dealt '+hit+' damage.');
       syncRunHealth(state,r);
       if(!r.hp){state.lastResult={outcome:'defeat',coins:0,rounds:r.stage-1,zone:z.id};state.run=null;}
      }
     }else fail(400,'Unknown zone action.');
    }
    if(input.action!=='leave')db.prepare('UPDATE quest_presence SET seen=? WHERE owner=?').run(now(),i.owner);
   }
   if(state.run)syncRunHealth(state,state.run);
   origins.reconcile(c,state,JSON.parse(c.state)); // Strip forged/duplicate item markers on every imported loadout and persist equipment/bank transitions.
   if(input.loadout&&state.loadout?.player_info?.name&&!state.nameLocked){const name=clean(state.loadout.player_info.name,24);if(name){c.name=name;state.nameLocked=true;db.prepare('UPDATE quest_characters SET name=? WHERE id=?').run(name,c.id);}} // Reconcile legacy campaign names once; subsequent renames use the paid management action.
   if(state.loadout?.player_info){
    if(!state.profileAppearance){const initial={gender:'Female',hair_style:1,hair_color:'Brown',has_breasts:false,nipple_style:0,penis_style:0,pubes_style:0};for(const key of appearanceFields)if(state.loadout.player_info[key]!==undefined)initial[key]=state.loadout.player_info[key];state.profileAppearance=initial;}
    Object.assign(state.loadout.player_info,{name:c.name},state.profileAppearance);
   } // Preserve the first imported paperdoll; subsequent changes require the paid makeover, including legacy-client imports.
   if(JSON.stringify(state.loadout)!==JSON.stringify(JSON.parse(c.state).loadout))state.loadoutRevision=c.revision+1;
   c.revision++;c.state=JSON.stringify(state);db.prepare('UPDATE quest_characters SET revision=?,state=? WHERE id=?').run(c.revision,c.state,c.id);
   const receipt={request_id:input.request_id,revision:c.revision,action:input.action,result:state.lastResult};
   db.prepare('INSERT INTO quest_commands VALUES (?,?,?,?,?)').run(c.id,input.request_id,c.revision,fingerprint,JSON.stringify(receipt));
   db.prepare('DELETE FROM quest_commands WHERE character_id=? AND revision<?').run(c.id,c.revision-128);
   return {...snapshot(i,c),receipt};
  });
 }
 function inspect(secret,id,target,controller){
  const i=identity(secret);limit(i.owner);const c=character(i.owner,id),p=presence(i,c,controller);
  const other=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(target),op=db.prepare('SELECT * FROM quest_presence WHERE character_id=? AND seen>?').get(target,now()-30000);
  if(!other||!op||!enabled(other.owner)||op.zone!==p.zone)fail(404,'That player is no longer in this area.');
  if(isDungeon(p.zone)){const a=JSON.parse(c.state).dive,b=JSON.parse(other.state).dive,area=dive.chatArea(c,p)?.id;if(!a||!b||!area||a.edition!==b.edition||area!==dive.chatArea(other,op)?.id)fail(404,'That player is no longer in this area.');}
  return inspectionProjection(other);
 }
 return {read,act,inspect,tick:dive.tick,completePurchase:purchases.complete};
} // Campaign stats and inventory are client-trusted; arena outcomes and shared-currency awards still belong to this simulation.
