import {movementDelay} from './crawl.mjs';
import {createDiveEncounters} from './dive-encounters.mjs';
import {addPinkMist,mistAt} from './dive-mist.mjs';
import {createDiveLootRoller} from './dive-loot.mjs';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {applyDefeatEquipment} from './defeat-equipment.mjs';
import {generateFloor,dressFloor,addFood,weeklyWindow,seeded,pathTo,walkable,inside,enemyRoams} from './dive-generation.mjs';
import {beginRound,clearEffects,readyTurn,combatAction,awardExperience,defeatPresentation} from './combat.mjs';
import {importLoadout,syncRunHealth,applyRunLoadout} from './loadout.mjs';
import {hubArrival,dungeonPortals,hubRooms,hubCatalog,DAILY_COIN_CAP} from './hubs.mjs';

export const diveData=JSON.parse(readFileSync(new URL('./dive-data.json',import.meta.url),'utf8'));
export const DIVE_ZONE='dive-quarters';
const fail=(message,code='dive_conflict')=>{throw Object.assign(Error(message),{status:409,code});};
const clone=structuredClone;
const seconds=1000,minutes=60000;

export function createDive(db,{now,roll,adjust,origins,data=diveData,generate=generateFloor,log=console.warn,parties,measure=(_name,work)=>work(),upgradeFloor=()=>false,travel=()=>false}){
 const config=data.config,route=config.route,zoneId=config.zone_id??DIVE_ZONE,theme=config.theme??'princess_quarters',name=config.name??"Princess' Quarters - Dungeon Dive",bossId=config.boss_id??'iris';
 const rollLoot=createDiveLootRoller(data); // One policy covers every online route and its personal floor progress.
 const owns=visit=>visit?.route===route; // Each route maintains only its own visits and encounter locks.
 const safe=(floor,x,y)=>(floor.safeRooms??[floor.rooms[0]]).some(r=>inside(r,x,y));
 const entry=(floor,origin)=>floor.entries?.[origin]??floor.entrance;
 db.exec(`CREATE TABLE IF NOT EXISTS dive_editions(route TEXT NOT NULL,edition TEXT NOT NULL,depth INTEGER NOT NULL,starts INTEGER NOT NULL,ends INTEGER NOT NULL,content TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(route,edition,depth));
 CREATE TABLE IF NOT EXISTS dive_progress(character_id TEXT NOT NULL,route TEXT NOT NULL,edition TEXT NOT NULL,depth INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(character_id,route,edition,depth));`);
 const encounters=createDiveEncounters(db,{now,roll,data,parties,saveFloor,progress,saveProgress,pay,back,entry,saveCharacter,relocate});
 let lastTick=-Infinity,retryAt=0,dressingRetryAt=0;
 const getFloor=edition=>{const row=db.prepare('SELECT * FROM dive_editions WHERE route=? AND edition=? AND depth=1').get(route,edition??null);return row?{...row,floor:JSON.parse(row.content)}:null;}; // Disabled or not-yet-generated branches have no edition to bind.
 const latest=()=>db.prepare('SELECT edition FROM dive_editions WHERE route=? ORDER BY starts DESC LIMIT 1').get(route)?.edition;
 function saveFloor(record){db.prepare('UPDATE dive_editions SET content=?,updated=? WHERE route=? AND edition=? AND depth=1').run(JSON.stringify(record.floor),record.updated,route,record.edition);}
 function progress(c,edition){const row=db.prepare('SELECT state FROM dive_progress WHERE character_id=? AND route=? AND edition=? AND depth=1').get(c.id,route,edition);return row?JSON.parse(row.state):{claimed:[],rolls:{},explored:[],completed:false,coinsPaid:0};}
 function saveProgress(c,edition,p){db.prepare('INSERT INTO dive_progress VALUES (?,?,?,1,?) ON CONFLICT(character_id,route,edition,depth) DO UPDATE SET state=excluded.state').run(c.id,route,edition,JSON.stringify(p));}
 function saveCharacter(c,state){
  const previous=JSON.parse(c.state??db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state); // Roaming engagement supplies a compact identity without a state field.
  if(JSON.stringify(state.loadout)!==JSON.stringify(previous.loadout))state.loadoutRevision=c.revision+1;
  c.revision++;c.state=JSON.stringify(state);db.prepare('UPDATE quest_characters SET revision=?,state=? WHERE id=?').run(c.revision,c.state,c.id);
 } // Tick/party settlements protect changed outfits from stale campaign imports too.
 function reveal(c,state,f,x,y){
  const p=progress(c,f.edition),seen=new Set(p.explored);
  function visible(tx,ty){let px=x,py=y,dx=Math.abs(tx-x),dy=Math.abs(ty-y),err=dx-dy;for(let n=0;n<dx+dy+2;n++){if(px===tx&&py===ty)return true;const e=err*2;if(e>-dy){err-=dy;px+=Math.sign(tx-x);}if(e<dx){err+=dx;py+=Math.sign(ty-y);}if(px===tx&&py===ty)return true;if(f.walls[py]?.[px]!==0)return false;}return false;} // Furniture shares the campaign's transparent CELL_PROP sight rules.
  for(let yy=Math.max(0,y-6);yy<=Math.min(f.height-1,y+6);yy++)for(let xx=Math.max(0,x-6);xx<=Math.min(f.width-1,x+6);xx++)if((xx-x)**2+(yy-y)**2<=36&&visible(xx,yy))seen.add(yy*f.width+xx);
  p.explored=[...seen];saveProgress(c,f.edition,p);state.dive.position={x,y};
 } // Match the campaign's six-cell circular reveal and structural-wall line of sight.
 function current(){return getFloor(latest());}
 function chatArea(c,p){
  const state=JSON.parse(c.state),visit=state.dive,record=owns(visit)?getFloor(visit.edition):null;
  if(!record)return null;
  const index=record.floor.rooms.findIndex(room=>inside(room,p.x,p.y));
  return {id:JSON.stringify([zoneId,route,record.edition,record.depth,index]),name:index<0?name+' corridors':index===0?name+' entrance':name+' room '+(index+1)};
 } // Scope by committed position, route, edition and floor; clients cannot choose another room's chat.
 function ensure(){
  if(!config.enabled)return;
  const window=weeklyWindow(now());if(getFloor(window.edition)||now()<retryAt)return;
  try{const floor=measure('generate.'+zoneId,()=>generate(data,window.edition));upgradeFloor(floor);addPinkMist(floor);db.prepare('INSERT OR IGNORE INTO dive_editions VALUES (?,?,1,?,?,?,?)').run(route,window.edition,window.start,window.ends,JSON.stringify(floor),now());log('dive_generation_ready',route,window.edition);}
  catch(error){retryAt=now()+minutes;log('dive_generation_failed',route,String(error));}
 } // Never replace a valid edition until its successor is fully generated and validated.
 function relocate(c,state,position,scene,downedAt=now()){ // Recovery needs both the completed scene and one real minute since defeat.
  if(state.deferDefeatReturn&&scene){state.pendingDefeat={id:scene.id,position:{...position},readyAt:downedAt+60000,sceneComplete:false};return;}
  state.dive.position={...position};state.dive.safeUntil=now()+10000;
  db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(position.x,position.y,c.id);
 }
 function recover(c,state,record){
  const pending=state.pendingDefeat;
  if(!pending?.sceneComplete||now()<(pending.readyAt??0))return false;
  delete state.pendingDefeat; // Only this character recovers; party members may already be in another encounter or room.
  if(pending.returnToHub||record.edition!==latest())back(c,state);
  else relocate(c,state,pending.position);
  return true;
 }
 function back(c,state,destination){
  if(state.pendingDefeat){state.pendingDefeat.returnToHub=true;return;} // Weekly reset may retire the floor, but never interrupts its unread defeat scene.
  if(destination&&travel(c,state,zoneId,destination))return; // Linked wilderness travel preserves the loadout and personal progress inside the same transaction.
  const origin=destination?(state.dive?.returnZone?.endsWith('-dives')?destination+'-dives':destination):(state.dive?.returnZone??state.dive?.origin??'honeydew-lantern');
  const destinationRoom=[...hubRooms,...hubCatalog].find(z=>z.id===origin);
  const arrival=hubArrival(destinationRoom,origin.endsWith('-dives')?(state.dive?.hubEntryZone??zoneId):origin+'-dives'); // A retired branch returns beside its original Tundra hall pad.
  db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE character_id=?').run(origin,arrival.x,arrival.y,now(),c.id);
  if(origin.endsWith('-dives'))state.hubVisit=origin;else delete state.hubVisit; // Reconnect after a warp restores the destination hall rather than the previous hub.
  state.dive=null;state.diveReturned=origin;state.diveReturnedPosition=arrival;
 }
 function finish(c,state,record,outcome){
  const run=state.run;if(!run||run.kind!=='dive')return;
  const foe=record?.floor.enemies.find(e=>e.id===run.encounter);
  clearEffects(state);
  if(outcome==='win'){
   awardExperience(state,roll);state.wins++;
   if(foe){foe.engaged=null;foe.respawnAt=now()+(foe.id===bossId?config.boss_respawn_seconds:config.enemy_respawn_seconds)*seconds;foe.x=foe.spawn.x;foe.y=foe.spawn.y;}
   if(run.encounter===bossId){const p=progress(c,run.edition);p.completed=true;saveProgress(c,run.edition,p);}
  }else{
   if(foe){foe.engaged=null;foe.respawnAt=0;foe.x=foe.spawn.x;foe.y=foe.spawn.y;}
   if(['defeat','charm_backfire'].includes(outcome))run.hp=Math.max(1,Math.ceil(run.maxHp/4));
   if(record)relocate(c,state,entry(record.floor,state.dive.origin),defeatPresentation(run,outcome).defeatScene);
  }
  const equipment=applyDefeatEquipment(state,run,outcome);
  syncRunHealth(state,run);state.lastResult={outcome,coins:0,rounds:1,zone:zoneId,log:run.log,...defeatPresentation(run,outcome),...(equipment?{defeatEquipment:equipment}:{})};state.run=null;
  if(state.dive)state.dive.safeUntil=now()+10*seconds;
  if(record)saveFloor(record);
 } // Combat settlement is independent of arena rounds, pots and handicaps.
 function pay(c,state,record,grace=false){
  if(!record||now()>=record.ends+(grace?10*minutes:0)&&record.edition!==latest())return 0;
  const p=progress(c,record.edition);if(!p.completed||p.coinsPaid>=config.boss_coins)return 0;
  const day=Math.floor(now()/86400000),used=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(c.owner,day)?.coins??0;
  const amount=Math.min(config.boss_coins-p.coinsPaid,Math.max(0,DAILY_COIN_CAP-used));
  if(amount){adjust(c.owner,'coins',amount,randomUUID(),'Dungeon Dive: '+record.edition);db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(c.owner,day,amount);p.coinsPaid+=amount;saveProgress(c,record.edition,p);}
  return amount;
 }
 function start(c,state,record,foe){
  if(state.pendingDefeat||state.run||state.loadout?.player_info.stat_points>0||state.loadout?.player_info.playerHealth<=0||!foe||foe.engaged||foe.respawnAt>now())fail('That encounter is not available.');
  if(!state.loadout)fail('Import your character before entering.');
  if(state.diveCombatVersion===3){encounters.start(c,state,record,foe);return;} // New clients share an encounter; unfinished legacy fights keep their original path.
  foe.engaged=c.id;const enemy=clone(data.enemies[foe.type]);enemy.maxHp=enemy.hp;enemy.turn=0;
  state.lastResult=null;state.run={kind:'dive',id:randomUUID(),zone:zoneId,edition:record.edition,encounter:foe.id,stage:1,phase:'fight',hp:state.loadout.player_info.playerHealth,maxHp:state.loadout.player_info.playerHealthMax,heals:0,pot:0,handicaps:[],enemy,acted:now(),log:[enemy.name+' approaches.']};
  beginRound(state,{theme,attack:0},roll,enemy); // Keep authored encounter stats rather than the arena's progressive template.
  saveFloor(record);
 }
 function maintain(){
  ensure();let active=current();if(!active)return;
  if(upgradeFloor(active.floor))saveFloor(active); // Add a trail to an existing edition without rerolling rooms or claimed treasure.
  if(addPinkMist(active.floor))saveFloor(active); // Install a layer on existing editions once, preserving every room, enemy lock and personal claim.
  if(zoneId===DIVE_ZONE&&((active.floor.dressingVersion??0)<(data.dressing_version??2)||(active.floor.foodVersion??0)<(data.food_version??0))&&now()>=dressingRetryAt){
   try{
    const visitors=db.prepare('SELECT state FROM quest_characters WHERE state LIKE ?').all('%"dive":{%').map(c=>JSON.parse(c.state).dive).filter(d=>owns(d)&&d.edition===active.edition).map(d=>d.position);
    const upgraded=clone(active);dressFloor(data,upgraded.floor,visitors);addFood(data,upgraded.floor,visitors);saveFloor(upgraded);active=upgraded;log('dive_dressing_upgraded',active.edition);
   }catch(error){dressingRetryAt=now()+minutes;log('dive_dressing_failed',String(error));}
  } // Existing weekly chest claims and ongoing fights survive the additive scenery/pickup upgrade.
  for(const c of db.prepare('SELECT * FROM quest_characters WHERE state LIKE ?').all('%"dive":{%')){
   const state=JSON.parse(c.state);if(!owns(state.dive))continue;
   const old=state.dive.edition!==active.edition,record=getFloor(state.dive.edition),run=state.run,p=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);
   if(state.pendingDefeat&&record&&recover(c,state,record)){saveCharacter(c,state);continue;} // Tick the durable wall-clock timer even when no gameplay command is submitted.
   if(run?.kind==='dive'&&!run.sharedEncounter&&((!p||p.seen<now()-2*minutes)||run.acted<now()-5*minutes||old&&now()>=record.ends+10*minutes)){
    finish(c,state,record,'abandoned');log('dive_encounter_abandoned',c.id,run.encounter);saveCharacter(c,state);
   }
   if(old&&!state.run&&!state.pendingDefeat){back(c,state);saveCharacter(c,state);}
  }
  encounters.tick(getFloor);
  // Expired editions are retained for audit and receipt replay, but cannot accept new exploration.
  active=current(); // Settlement above may have released locks; never overwrite it with the earlier floor copy.
  if(now()-active.updated<seconds)return;
  const f=active.floor,players=db.prepare('SELECT p.*,c.revision,c.state FROM quest_presence p JOIN quest_characters c ON c.id=p.character_id WHERE p.zone=? AND p.seen>?').all(zoneId,now()-30000);
  const occupied=new Set(f.enemies.filter(e=>e.respawnAt<=now()).map(e=>e.x+','+e.y));
  const rnd=seeded(active.edition+':'+Math.floor(now()/seconds));
  for(const foe of f.enemies){
   if(foe.engaged||foe.respawnAt>now()||!enemyRoams(data,foe))continue;
   const targets=players.filter(p=>{const s=JSON.parse(p.state);const ready=(parties?.members(p.character_id)??[]).every(c=>{const v=JSON.parse(c.state);return v.pendingDefeat||v.dive?.route!==route||v.dive?.edition!==active.edition||(!v.run&&!v.worldTurnDue&&!v.pendingPurchase&&v.loadout?.player_info.playerHealth>0&&!v.loadout?.player_info.stat_points);});return ready&&!s.pendingDefeat&&s.dive?.edition===active.edition&&!s.run&&!s.worldTurnDue&&!(s.loadout?.player_info.stat_points>0)&&s.dive.safeUntil<=now()&&!safe(f,p.x,p.y);}); // Roaming enemies can engage survivors without enrolling downed party members.
   let target=null,best=null;
   for(const p of targets){const path=measure('pathfinding.'+zoneId,()=>pathTo(f,foe,p,config.pursuit_steps));if(path&&(!best||path.length<best.length)){target=p;best=path;}} // Aggregate by authored zone, never by a player or enemy identifier.
   if(best?.length===0||best?.length===1){const c={id:target.character_id,owner:target.owner,revision:target.revision},s=JSON.parse(target.state);if(s.loadout?.player_info.playerHealth>0){start(c,s,active,foe);saveCharacter(c,s);target.state=c.state;target.revision=c.revision;}continue;}
   let step=best?.[0];if(!step){const [dx,dy]=[[1,0],[-1,0],[0,1],[0,-1]][rnd(4)];step={x:foe.x+dx,y:foe.y+dy};}
   if(walkable(f,step.x,step.y)&&!safe(f,step.x,step.y)&&!occupied.has(step.x+','+step.y)&&!players.some(p=>p.x===step.x&&p.y===step.y)){
    occupied.delete(foe.x+','+foe.y);foe.x=step.x;foe.y=step.y;occupied.add(foe.x+','+foe.y);
   }
  }
  active.updated=now();saveFloor(active);
 }
 function tick(){if(now()-lastTick<seconds)return;lastTick=now();measure('simulation.'+zoneId,()=>{db.exec('BEGIN IMMEDIATE');try{maintain();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');lastTick=-Infinity;log('dive_tick_failed',String(error));}});} // Time actual ticks, not the early returns when a request arrives inside the same second.
 function snapshot(c,p){
  const state=c?JSON.parse(c.state):null,record=owns(state?.dive)?getFloor(state.dive.edition):current(),personal=c&&record?progress(c,record.edition):null;
  const summary={enabled:config.enabled&&!!record,version:1,route,zone:zoneId,name,boss:bossId,edition:record?.edition??'',resetsAt:record?.ends??weeklyWindow(now()).ends,completed:personal?.completed??false,claimed:record?.floor.chests.filter(ch=>personal?.claimed.includes(ch.id)).length??0,total:record?.floor.chests.length??0,pickupsClaimed:(record?.floor.pickups??[]).filter(ch=>personal?.claimed.includes(ch.id)).length,pickupsTotal:record?.floor.pickups?.length??0,claimableCoins:personal?.completed?Math.max(0,config.boss_coins-personal.coinsPaid):0};
  if(!record||p?.zone!==zoneId||!owns(state?.dive))return {dive:summary};
  const f=record.floor;
  return {dive:{...summary,depth:1,origin:state.dive.origin,explored:personal.explored,enemies:f.enemies.map(e=>({...e,name:data.enemies[e.type].name,sprite:data.enemies[e.type].sprite})),chests:f.chests.map(ch=>({...ch,claimed:personal.claimed.includes(ch.id)})),pickups:(f.pickups??[]).map(ch=>({...ch,claimed:personal.claimed.includes(ch.id)}))},definition:{id:zoneId,name,kind:"dungeon",exits:f.exits??[],theme,mist:f.mist,walls:f.walls,props:f.props,geometryVersion:f.geometryVersion??0,dressingVersion:f.dressingVersion??0,width:f.width,height:f.height,rooms:f.rooms,entrance:f.entrance,decorations:f.decorations}};
 } // Snapshots expose claim status but never another character's inventory or chest rolls.
 function claim(c,state,record,chest,automatic=false){
  const personal=progress(c,record.edition);if(personal.claimed.includes(chest.id)){if(automatic)return;fail('You already claimed this treasure this week.');}
  if(state.loadout.inventory.length>=config.inventory_capacity){if(automatic){state.dive.lootNotice='Inventory full. Treasure remains here.';state.dive.lootNoticeAt=now();return;}fail('Inventory full. This treasure remains unclaimed.');}
  if(!personal.rolls[chest.id])personal.rolls[chest.id]=rollLoot(record.edition,c.id,chest,personal.rolls); // Capacity was checked first; only successful claims consume the allowance.
  const item=clone(personal.rolls[chest.id]);if(origins)origins.mint(c.id,item);state.loadout.inventory.push(item);personal.claimed.push(chest.id);saveProgress(c,record.edition,personal);
  state.dive.lootNotice='Found '+(item.name??item.item_id)+'.';state.dive.lootNoticeAt=now();
 } // Inventory, deterministic item roll and personal claim commit together inside the zone transaction.
 function handles(input,p){return input.action==='dive_enter'&&(input.zone??DIVE_ZONE)===zoneId||input.action==='enter'&&input.zone===zoneId||p?.zone===zoneId;}
 function act(i,c,state,input,p){
  const action=input.action;
  if(action==='dive_enter'||action==='enter'){
   if(state.dive&&input.zone&&input.zone!==zoneId)fail('Leave your current dungeon before changing routes.'); // Re-entry cannot change a live visit's route or imported inventory.
   if(!config.enabled)fail('Dungeon Dive is not enabled.');
   const existing=db.prepare('SELECT * FROM quest_presence WHERE owner=?').get(i.owner);
   if(existing&&existing.seen>now()-30000&&(existing.controller!==input.controller||existing.character_id!==c.id||existing.grant_id!==i.id)&&input.takeover!==true)fail('This account is active in another window.','zone_controller_conflict'); // Explicit re-entry can recover this character without discarding its dungeon fight or items.
   if(action==='enter'&&!state.dive&&state.diveReturned){
    const arrival=state.diveReturnedPosition??hubArrival([...hubRooms,...hubCatalog].find(z=>z.id===state.diveReturned),state.diveReturned.endsWith('-dives')?zoneId:state.diveReturned+'-dives');
    db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET character_id=excluded.character_id,zone=excluded.zone,grant_id=excluded.grant_id,controller=excluded.controller,x=excluded.x,y=excluded.y,seen=excluded.seen,moved=0').run(i.owner,c.id,state.diveReturned,i.id,input.controller,arrival.x,arrival.y,now());return;
   } // A browser suspended across reset resumes in its lobby instead of retrying a retired floor forever.
   if(state.run&&state.run.kind!=='dive')fail('Finish your arena run before diving.');
   if(state.dive&&!owns(state.dive))fail('Leave your current dungeon before entering another route.');
   if(!state.dive){const hall=hubRooms.find(r=>r.id===p?.zone&&r.kind==='dives');if(!p||!hall&&!hubCatalog.some(h=>h.id===p.zone)||p.seen<=now()-30000||p.controller!==input.controller||p.grant_id!==i.id)fail('Enter from an online dive hall.');
    const portal=dungeonPortals(hall?.parent??p.zone).find(v=>v.target===zoneId);
    if(!portal||hall&&Math.abs(p.x-portal.x)+Math.abs(p.y-portal.y)>1)fail('Stand on or beside that glowing portal.'); // Legacy lobby entry remains accepted only for routes connected to that hub.
    if(input.loadout)state.loadout=importLoadout(input.loadout);if(!state.loadout)fail('Import your character first.');
    const record=current(),origin=hall?.parent??p.zone;if(!record)fail('The weekly floor is not ready.');state.dive={route,zone:zoneId,edition:record.edition,depth:1,origin,returnZone:p.zone,position:{...entry(record.floor,origin)},safeUntil:now()+10*seconds};state.diveReturned=null;delete state.diveReturnedPosition;delete state.hubVisit;
   }
   const record=getFloor(state.dive.edition),position=state.dive.position;
   if(!record)fail('The weekly floor is unavailable.');
   const count=db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>? AND owner<>?').get(zoneId,now()-30000,c.owner).n;if(count>=64)fail('The dive is full.');
   db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET character_id=excluded.character_id,zone=excluded.zone,grant_id=excluded.grant_id,controller=excluded.controller,x=excluded.x,y=excluded.y,seen=excluded.seen,moved=0').run(i.owner,c.id,zoneId,i.id,input.controller,position.x,position.y,now());
   reveal(c,state,record.floor,position.x,position.y);return;
  }
  if(state.run?.sharedEncounter&&!['enter','chat'].includes(action)){encounters.act(c,state,input,getFloor(state.dive.edition));return;}
  if(!owns(state.dive))fail('Re-enter the dungeon from its lobby.');
  const record=getFloor(state.dive.edition),f=record.floor;
  if(input.edition!==record.edition)fail('The dungeon edition changed. Refresh before acting.');
  if(action==='defeat_complete'){
   const pending=state.pendingDefeat;
   if(!pending||input.scene!==pending.id)fail('That defeat scene is no longer pending.');
   pending.sceneComplete=true;recover(c,state,record); // Acknowledgement records reading once; an unfinished timer continues without repeated client commands.
   return;
  }
  if(action==='dive_exit'||action==='leave'){if(state.run)fail('Finish or flee from the current fight first.');
   if(input.zone){const exit=f.exits?.find(e=>e.zone===input.zone);if(!exit||Math.abs(exit.x-p.x)+Math.abs(exit.y-p.y)>1)fail('Stand beside that hub exit.');}
   back(c,state,input.zone??config.parent_zone);return;} // Branch regions retreat to their parent; crossings retain their original hub return.
  if(action==='chat'){
   const text=String(input.text??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069#]/g,' ').trim().slice(0,240);if(!text)fail('Write a message first.');
   if(db.prepare('SELECT COUNT(*) AS n FROM quest_chat WHERE owner=? AND created>?').get(i.owner,now()-10000).n>=5)fail('Wait before sending another message.');
   const area=chatArea(c,p);
   db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created) VALUES (?,?,?,?,?,?)').run(area.id,i.owner,c.id,c.name,text,now());
   db.prepare('DELETE FROM quest_chat WHERE zone=? AND seq NOT IN (SELECT seq FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 100)').run(area.id,area.id);return;
  }
  if(action==='appearance'){state.avatar=input.avatar;return;} // The zone adapter validates the cosmetic allowlist before dispatch.
  if(action==='allocate'){if(state.run||!['str','def','dex','int','cha'].includes(input.stat)||!(state.loadout.player_info.stat_points>0))fail('Choose an available stat point outside combat.');state.loadout.player_info[input.stat]++;state.loadout.player_info.stat_points--;if(input.stat==='int')state.loadout.player_mp_max=Math.max(0,10+state.loadout.player_info.int*5);return;}
  if(record.edition!==latest()&&!state.run)fail('This weekly dungeon has ended.');
  if(action==='dive_claim_reward'){if(state.run)fail('Finish the current fight first.');const amount=pay(c,state,record);state.lastResult={outcome:'reward_claimed',coins:amount,zone:zoneId,log:[]};return;}
  if(action==='dive_claim'){
   if(state.run)fail('Finish the current fight first.');const chest=[...f.chests,...(f.pickups??[])].find(ch=>ch.id===input.chest);if(!chest||Math.abs(chest.x-p.x)+Math.abs(chest.y-p.y)>1)fail('Stand next to that treasure.');
   claim(c,state,record,chest);return;
  }
  if(action==='move'||action==='dive_engage'){
   if(state.run||state.loadout.player_info.stat_points>0)fail('Finish combat and spend level-up points first.');
   if(action==='dive_engage'){const foe=f.enemies.find(e=>e.id===input.encounter);if(!foe||Math.abs(foe.x-p.x)+Math.abs(foe.y-p.y)>1)fail('Approach that enemy first.');start(c,state,record,foe);return;}
   if(now()-p.moved<movementDelay(state.loadout))fail('Movement is too fast.');const d={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]}[input.direction];if(!d)fail('Choose a direction.');
   const x=p.x+d[0],y=p.y+d[1];if(!walkable(f,x,y))fail('That tile is blocked.');const foe=f.enemies.find(e=>e.x===x&&e.y===y&&e.respawnAt<=now());
   if(foe){start(c,state,record,foe);return;}
   const exit=f.exits?.find(e=>e.x===x&&e.y===y);
   const entranceReturn=!(f.exits?.length)&&x===f.entrance.x&&y===f.entrance.y;
   if(exit||entranceReturn){back(c,state,exit?.zone);return;} // Stepping onto any return portal commits the transfer; spawning/reconnecting on it never triggers a bounce.
   db.prepare('UPDATE quest_presence SET x=?,y=?,moved=? WHERE character_id=?').run(x,y,now(),c.id);reveal(c,state,f,x,y);
   if(input.world_step===true)state.worldTurnDue={id:randomUUID(),mist:mistAt(f,x,y)}; // Loot commits first; the needs tick resumes from that inventory rather than overwriting the grant.
   const pickup=[...f.chests,...(f.pickups??[])].find(ch=>ch.x===x&&ch.y===y);if(pickup)claim(c,state,record,pickup,true);return; // Walking onto either a room chest or a loose pickup commits the same personal claim as Interact.
  }
  const z={id:zoneId,theme,recovery:0};let result;
  if(action==='loadout'||action==='use_item'){
   if(action==='loadout'&&state.run)fail('Use Items during combat.');
   if(state.run&&!state.run.turnReady)fail('Wait for your turn.');
   state.loadout=importLoadout(input.loadout);if(state.run){if(now()-state.run.acted<300)fail('Wait for the current turn.');state.run.acted=now();applyRunLoadout(state.run,state.loadout);result=combatAction(state,input,z,roll);}else return;
  }else{
   if(state.run?.kind!=='dive')fail('No active dungeon fight.');
   if(['flee','submit'].includes(action)){finish(c,state,record,action);return;}
   if(action==='turn_ready'){
    if(typeof input.forfeit!=='boolean'||state.run.turnReady)fail('No unprepared turn.');state.loadout=importLoadout(input.loadout);state.run.acted=now();result=readyTurn(state,input.forfeit,z,roll); // An acknowledged accident/forfeit turn is combat activity, unlike a heartbeat.
   }else if(['attack','cast','charm','allure','stand'].includes(action)){if(now()-state.run.acted<300)fail('Wait for the current turn.');state.run.acted=now();result=combatAction(state,input,z,roll);}
   else fail('Unknown dungeon action.');
  }
  if(['win','defeat','charm_backfire'].includes(result)){
   const grace=state.run?.kind==='dive'&&now()<record.ends+10*minutes;
   finish(c,state,record,result);
   if(result==='win'){ // A fight already underway at reset may settle its first boss entitlement during grace.
    if(record.edition===latest())state.lastResult.coins=pay(c,state,record);
    else if(grace)state.lastResult.coins=pay(c,state,record,true);
   }
   if(record.edition!==latest())back(c,state);
  }
 }
 function arrive(c,state,source){
  const record=current(),position=record?.floor.entries?.[source];
  if(!config.enabled||!position)fail('That connecting trail is unavailable.');
  if(db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>? AND owner<>?').get(zoneId,now()-30000,c.owner).n>=64)fail('The dive is full.');
  const previous=state.dive;
  state.dive={route,zone:zoneId,edition:record.edition,depth:1,origin:source,hubOrigin:previous.hubOrigin??previous.origin,hubEntryZone:previous.hubEntryZone??source,returnZone:previous.returnZone,position:{...position},safeUntil:now()+10*seconds};
  state.diveReturned=null;delete state.diveReturnedPosition;
  db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE character_id=?').run(zoneId,position.x,position.y,now(),c.id);
  reveal(c,state,record.floor,position.x,position.y); // Revisit this route's own claims and fog; never re-import stale campaign equipment.
 }
 return {tick,snapshot,handles,act,chatArea,arrive,encounterSnapshot:state=>encounters.snapshot(state)};
} // All mutations run inside the zone command transaction; scheduled simulation owns its own transaction.
