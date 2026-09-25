import {movementDelay} from './crawl.mjs';
import {createDiveControls} from './world-dive.mjs';
import {createDiveEncounters} from './dive-encounters.mjs';
import {generatorName} from './compute-tasks.mjs'; // Maps a generator function to the name the worker pool understands.
import {addPinkMist,mistAt} from './dive-mist.mjs';
import {createDiveLootRoller} from './dive-loot.mjs';
import {createEnchantmentStore} from './enchantment-store.mjs';
import {createLootStore} from './loot-store.mjs';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {applyDefeatEquipment} from './defeat-equipment.mjs';
import {applyDefeatDignity} from './defeat-dignity.mjs';
import {applyDefeatAftermath} from './defeat-aftermath.mjs';
import {weatherAt,drinkFromWell} from './plains-features.mjs';
import {restInHay} from './farmstead-generation.mjs';
import {tideAt} from './coast-features.mjs';
import {eruptionAt,soakInSpring} from './caldera-features.mjs';
import {coolInBath} from './spa-generation.mjs';
import {generateFloor,dressFloor,addFood,weeklyWindow,seeded,pathTo,walkable,inside,enemyRoams} from './dive-generation.mjs';
import {beginRound,clearEffects,readyTurn,combatAction,awardExperience,defeatPresentation,MAX_STAT,currentTuning} from './combat.mjs';
import {levelEnemy,encounterLevel,routeLevelFor,defHpDelta,dexStaminaDelta} from './scaling.mjs';
import {stackable,slotsUsed,addToInventory,setStackTokens} from './loadout.mjs';
import {importLoadout,syncRunHealth,applyRunLoadout} from './loadout.mjs';
import {manaCapacity} from './magic-balance.mjs';
import {hubArrival,routePortals,routeHome,returnSource,wildernessGates,hubRooms,hubCatalog,inHubGap,dailyCoinCap} from './hubs.mjs';
import {routeCategory} from './zone-categories.mjs';
import {inExit,nearExit} from './wilderness-links.mjs';
import {createDungeonRules,recordDungeonVictories} from './full-dungeon-rules.mjs';
import {findShop,shopOffers,shopperLevel} from './hubs.mjs';

export const diveData=JSON.parse(readFileSync(new URL('./dive-data.json',import.meta.url),'utf8'));
export const DIVE_ZONE='dive-quarters';
const fail=(message,code='dive_conflict')=>{throw Object.assign(Error(message),{status:409,code});};
const clone=structuredClone;
const seconds=1000,minutes=60000;

export function createDive(db,{now,roll,adjust,origins,data=diveData,generate=generateFloor,log=console.warn,parties,measure=(_name,work)=>work(),upgradeFloor=()=>false,travel=()=>false,enchantments=null,loot=null,alchemyStore=null,compute=null,live=null,resolveHub=z=>z,purchases=null}){
 const baseline=structuredClone(data);if(live){live.register(baseline);data=live.resolve(baseline);} // Each engine keeps mutable configuration isolated from shipped exports.
 const config=data.config,route=config.route,zoneId=config.zone_id??DIVE_ZONE,theme=config.theme??'princess_quarters',name=config.name??"Princess' Quarters - Dungeon Dive",bossId=(config.boss_id??'iris')||'world_boss';
 const category=routeCategory(config); // 'dive' for instanced boss routes, 'overworld' for open wilderness; fails fast on bad authored data.
 // Only dive-data.json carries the curse/blessing table; Desert, Tundra, Taiga and
 // the campaign weeklies share that one table rather than each shipping a copy.
 const rollLoot=createDiveLootRoller(data,{table:data.enchantments??diveData.enchantments,enchantments:enchantments??createEnchantmentStore(db,{now}),lootTable:data.loot??diveData.loot??null,lootBases:data.bases??diveData.bases??null,loot:loot??createLootStore(db,{now}),alchemy:data.alchemy??diveData.alchemy??null,alchemyStore,alchemyZone:zoneId}); // One policy covers every online route and its personal floor progress; gamemaster retunes reach all of them.
 const owns=visit=>visit?.route===route; // Each route maintains only its own visits and encounter locks.
 const safe=(floor,x,y)=>(floor.safeRooms??[floor.rooms[0]]).some(r=>inside(r,x,y));
 const entry=(floor,origin)=>floor.entries?.[origin]??floor.entrance;
 db.exec(`CREATE TABLE IF NOT EXISTS dive_editions(route TEXT NOT NULL,edition TEXT NOT NULL,depth INTEGER NOT NULL,starts INTEGER NOT NULL,ends INTEGER NOT NULL,content TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(route,edition,depth));
 CREATE TABLE IF NOT EXISTS dive_progress(character_id TEXT NOT NULL,route TEXT NOT NULL,edition TEXT NOT NULL,depth INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(character_id,route,edition,depth));`);
 const dungeonRules=config.full_dungeon_version?createDungeonRules({db,data,now,roll,origins,adjust,progress,saveProgress,saveFloor}):null;
 const encounters=createDiveEncounters(db,{live,now,roll,data,parties,saveFloor,progress,saveProgress,pay,back,entry,saveCharacter,relocate});
 let lastTick=-Infinity,nextSweep=-Infinity,retryAt=0,dressingRetryAt=0,generationPending=null,roamingPending=null,closed=false,settledKey=null; // settledKey: edition|content revision of the last full maintain pass (idle fast path).
 const presentQuery=db.prepare('SELECT 1 FROM quest_presence WHERE zone=? AND seen>? LIMIT 1'); // Cheap "is anybody here?" check; same 30 s window as roamingPlayers().
 const floorQuery=db.prepare('SELECT * FROM dive_editions WHERE route=? AND edition=? AND depth=1');
 const existsQuery=db.prepare('SELECT 1 FROM dive_editions WHERE route=? AND edition=? AND depth=1');
 const enabledQuery=db.prepare('SELECT 1 FROM dive_editions WHERE route=? AND depth=1 LIMIT 1');
 const getFloor=edition=>{const row=measure('floor.read',()=>floorQuery.get(route,edition??null));if(!row)return null;const floor=measure('floor.decode',()=>JSON.parse(row.content));if(live)for(const foe of floor.enemies)foe.definition??=clone(baseline.enemies[foe.type]??data.enemies[foe.type]);floor.managedOccupancy=live?.placementPositions?.(zoneId,row.edition)??[];return {...row,floor};}; // Keep decoded mutable floors local to their operation so rollback cannot leak cached mutations.
 const latest=()=>{
  const newest=db.prepare('SELECT edition FROM dive_editions WHERE route=? ORDER BY starts DESC,updated DESC LIMIT 1').get(route)?.edition; // Most recently installed floor, whatever week it came from.
  const week=config.static&&newest?newest.slice(0,10):weeklyWindow(now()).edition; // Static routes stay pinned to their newest floor's week instead of the calendar week.
  return controls&&db.prepare('SELECT edition FROM world_routes WHERE route=? AND week=?').get(route,week)?.edition||newest; // A gamemaster regeneration for that week wins over the automatic floor.
 };
 const controls=live?createDiveControls(db,{now,data,live,current,getFloor,saveFloor,saveCharacter,entry,generate,compute,generator:generatorName(generate)??'rooms',upgradeFloor:floor=>{upgradeFloor(floor);addPinkMist(floor);}}):null;
 function saveFloor(record){const content=measure('floor.encode',()=>JSON.stringify(record.floor));measure('floor.write',()=>db.prepare('UPDATE dive_editions SET content=?,updated=? WHERE route=? AND edition=? AND depth=1').run(content,record.updated,route,record.edition));}
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
  return {id:JSON.stringify([zoneId,route,record.edition,record.depth]),name:name+' floor '+record.depth};
 } // One stream per route, edition and floor; who hears a line is decided by distance from the speaker's tile (chatReach in zones.mjs), not by room walls.
 function ensure(){
  if(closed||!config.enabled)return;
  if(config.static&&enabledQuery.get(route))return; // Static routes keep their existing floor forever; only a brand-new route generates once.
  const window=weeklyWindow(now());if(existsQuery.get(route,window.edition)||now()<retryAt)return;
  if(generationPending)return generationPending;
  const generationData=clone(data),generationRevision=data.contentRevision;
  const install=floor=>{if(live&&live.published().revision!==generationRevision)return;if(live)for(const foe of floor.enemies)foe.definition=clone(generationData.enemies[foe.type]);if(closed||weeklyWindow(now()).edition!==window.edition)return;upgradeFloor(floor);addPinkMist(floor);live?.mapReady?.(zoneId,window.edition,floor);db.prepare('INSERT OR IGNORE INTO dive_editions VALUES (?,?,1,?,?,?,?)').run(route,window.edition,window.start,window.ends,JSON.stringify(floor),now());log('dive_generation_ready',route,window.edition);};
  const failed=error=>{if(closed)return;retryAt=now()+minutes;log('dive_generation_failed',route,String(error));};
  if(compute&&generatorName(generate)){ // Named generators (rooms, desert, forest) run on the worker pool.
   generationPending=compute.submit('generate',{generator:generatorName(generate),data:generationData,edition:window.edition}).then(install).catch(failed).finally(()=>{generationPending=null;});return generationPending;
  }
  try{install(measure('generate.'+zoneId,()=>generate(generationData,window.edition)));}catch(error){failed(error);}
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
  const origin=destination?routeHome(destination,zoneId,{returnZone:state.dive?.returnZone??'',gate:state.dive?.gate===true}):(state.dive?.returnZone??state.dive?.origin??'honeydew-lantern'); // Crossing to another hub lands in whichever of its rooms hosts this route's opening (Rose: the garden itself; Lantern: its Dive Hall); legacy lobby pad entries still return to lobbies.
  const destinationRoom=resolveHub([...hubRooms,...hubCatalog].find(z=>z.id===origin)); // Full dungeon entrances live in the resolved monthly map.
  const arrival=hubArrival(destinationRoom,returnSource(origin,state.dive?.hubEntryZone??zoneId)); // A retired branch returns beside its original Tundra opening; legacy lobby entries stand beside the Dive Hall doorway.
  db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE character_id=?').run(origin,arrival.x,arrival.y,now(),c.id);
  if(origin.endsWith('-dives'))state.hubVisit=origin;else delete state.hubVisit; // Reconnect after a warp restores the destination hall rather than the previous hub.
  state.dive=null;state.diveReturned=origin;state.diveReturnedPosition=arrival;
 }
 function finish(c,state,record,outcome){
  const run=state.run;if(!run||run.kind!=='dive')return;
  const foe=record?.floor.enemies.find(e=>e.id===run.encounter);
  clearEffects(state);
  if(outcome==='win'){
   recordDungeonVictories(data,c,state,record,[run.encounter],progress,saveProgress);
   awardExperience(state,roll);state.wins++;
   if(foe){foe.dead=true;foe.diedAt=now();foe.engaged=null;foe.respawnAt=now()+(foe.id===bossId?config.boss_respawn_seconds:config.enemy_respawn_seconds)*seconds;foe.x=foe.spawn.x;foe.y=foe.spawn.y;}
   if(run.encounter===bossId){const p=progress(c,run.edition);p.completed=true;saveProgress(c,run.edition,p);}
  }else{
   if(foe){foe.engaged=null;foe.respawnAt=0;foe.x=foe.spawn.x;foe.y=foe.spawn.y;}
   if(['defeat','charm_backfire'].includes(outcome))run.hp=Math.max(1,Math.ceil(run.maxHp/4));
   if(record)relocate(c,state,entry(record.floor,state.dive.origin),defeatPresentation(run,outcome).defeatScene);
  }
  const equipment=applyDefeatEquipment(state,run,outcome);
  applyDefeatDignity(state,run,outcome); // Lost fights drain dignity like the campaign (-64, -96 in a childish outfit, scaled by Shame); lines land in run.log.
  applyDefeatAftermath(state,run,outcome); // The loss blurb's own effects (bladder/tummy fill, Dignity, needs) settle once; its accident beats play on the client.
  syncRunHealth(state,run);state.lastResult={outcome,coins:0,rounds:1,zone:zoneId,log:run.log,...defeatPresentation(run,outcome),...(equipment?{defeatEquipment:equipment}:{})};state.run=null;
  if(state.dive)state.dive.safeUntil=now()+10*seconds;
  if(record)saveFloor(record);
 } // Combat settlement is independent of arena rounds, pots and handicaps.
 function pay(c,state,record,grace=false){
  if(!record||now()>=record.ends+(grace?10*minutes:0)&&record.edition!==latest())return 0;
  const p=progress(c,record.edition);if(!p.completed||p.coinsPaid>=config.boss_coins)return 0;
  const day=Math.floor(now()/86400000),used=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(c.owner,day)?.coins??0;
  const amount=Math.min(config.boss_coins-p.coinsPaid,Math.max(0,dailyCoinCap()-used));
  if(amount){adjust(c.owner,'coins',amount,randomUUID(),'Dungeon Dive: '+record.edition);db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(c.owner,day,amount);p.coinsPaid+=amount;saveProgress(c,record.edition,p);}
  return amount;
 }
 function start(c,state,record,foe){
  if(controls?.draining())fail('This Dive is being regenerated. Finish existing battles first.');
  if(live?.published().enabled&&state.contentVersion!==1)fail('Update the game to join this encounter.','client_update_required');
  if(foe?.dead&&(!config.spawning||foe.manual&&!foe.respawning)&&live?.published().enabled)fail('This monster is not available.');
  if(state.pendingDefeat||state.run||state.loadout?.player_info.playerHealth<=0||!foe||foe.engaged||foe.respawnAt>now())fail('That encounter is not available.'); // Saved stat points remain spendable after future encounters.
  if(!state.loadout)fail('Import your character before entering.');
  if(state.diveCombatVersion===3){encounters.start(c,state,record,foe);return;} // New clients share an encounter; unfinished legacy fights keep their original path.
  foe.engaged=c.id;const enemy=clone(foe.definition??data.enemies[foe.type]);enemy.maxHp=enemy.hp;enemy.turn=0;
  {const t=currentTuning();levelEnemy(t,enemy,encounterLevel(t,routeLevelFor(t,route,record.depth),[state.loadout.player_info.level]),{boss:foe.type===config.boss_id||enemy.tier==='boss'||enemy.boss===true});} // Route band by floor, raised toward this player's level; HP by turns-to-kill.
  state.lastResult=null;state.run={kind:'dive',id:randomUUID(),zone:zoneId,edition:record.edition,encounter:foe.id,stage:1,phase:'fight',hp:state.loadout.player_info.playerHealth,maxHp:state.loadout.player_info.playerHealthMax,heals:0,pot:0,handicaps:[],enemy,acted:now(),log:[enemy.name+' approaches.']};
  beginRound(state,{theme,attack:0},roll,enemy); // Keep authored encounter stats rather than the arena's progressive template.
  saveFloor(record);
 }
 function sweepDue(){return now()>=nextSweep;} // The sweep schedules itself from the soonest real deadline it saw, so recovery still lands on its exact second.
 function maintain(){
  if(live&&data.contentRevision!==live.published().revision){const fresh=live.resolve(baseline);Object.assign(config,fresh.config);data.enemies=fresh.enemies;data.enemy_types=fresh.enemy_types;data.contentRevision=fresh.contentRevision;}
  controls?.tick();
  ensure();
  const edition=latest(),idleKey=edition+'|'+(live?.published().revision??'');
  if(idleKey===settledKey&&!sweepDue()&&!presentQuery.get(zoneId,now()-30000))return; // Idle fast path: an empty route whose floor already passed reconcile/upgrades for this edition and content skips reading and decoding the whole floor every second. Its own sweep deadline (at most 15 s) and any arriving player bring back the full pass.
  settledKey=null;let active=getFloor(edition);if(!active)return; // Same floor current() returns; only marked settled once the pass below finishes.
  controls?.reconcile(active);
  if(upgradeFloor(active.floor))saveFloor(active); // Add a trail to an existing edition without rerolling rooms or claimed treasure.
  if(addPinkMist(active.floor))saveFloor(active); // Install a layer on existing editions once, preserving every room, enemy lock and personal claim.
  if(zoneId===DIVE_ZONE&&((active.floor.dressingVersion??0)<(data.dressing_version??2)||(active.floor.foodVersion??0)<(data.food_version??0))&&now()>=dressingRetryAt){
   try{
    const visitors=db.prepare('SELECT state FROM quest_characters WHERE state LIKE ?').all('%"dive":{%').map(c=>JSON.parse(c.state).dive).filter(d=>owns(d)&&d.edition===active.edition).map(d=>d.position);
    const upgraded=clone(active);dressFloor(data,upgraded.floor,visitors);addFood(data,upgraded.floor,visitors);saveFloor(upgraded);active=upgraded;log('dive_dressing_upgraded',active.edition);
   }catch(error){dressingRetryAt=now()+minutes;log('dive_dressing_failed',String(error));}
  } // Existing weekly chest claims and ongoing fights survive the additive scenery/pickup upgrade.
  const occupied=roamingPlayers().length>0;
  if(occupied||sweepDue()){
  let soonest=Infinity;const due=at=>{if(Number.isFinite(at)&&at<soonest)soonest=at;};
  for(const c of db.prepare('SELECT * FROM quest_characters WHERE state LIKE ?').all('%"dive":{%')){
   const state=JSON.parse(c.state);if(!owns(state.dive))continue;
   const old=state.dive.edition!==active.edition,record=getFloor(state.dive.edition),run=state.run,p=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);
   if(state.pendingDefeat&&record&&recover(c,state,record)){saveCharacter(c,state);continue;} // Tick the durable wall-clock timer even when no gameplay command is submitted.
   if(run?.kind==='dive'&&!run.sharedEncounter&&((!p||p.seen<now()-2*minutes)||run.acted<now()-5*minutes||old&&now()>=record.ends+10*minutes)){
    finish(c,state,record,'abandoned');log('dive_encounter_abandoned',c.id,run.encounter);saveCharacter(c,state);
   }
   if(old&&!state.run&&!state.pendingDefeat){back(c,state);saveCharacter(c,state);}
   if(state.pendingDefeat)due(state.pendingDefeat.readyAt); // Every branch above is driven by one of these wall clocks, so waking for the earliest cannot miss one.
   if(state.run?.kind==='dive'&&!state.run.sharedEncounter){due(state.run.acted+5*minutes);due((p?.seen??now())+2*minutes);}
   if(old&&record)due(record.ends+10*minutes);
  }
  encounters.tick(getFloor);
  // Expired editions are retained for audit and receipt replay, but cannot accept new exploration.
  active=current(); // Settlement above may have released locks; never overwrite it with the earlier floor copy.
  nextSweep=Math.max(soonest===Infinity?now()+15*seconds:soonest,now()+seconds); // Idle routes back right off; a route holding a live deadline never sweeps faster than the old one-second cadence.
  } // An empty route still sweeps to its own deadline, so a disconnected fight settles and a rolled-over edition returns its player without anybody present.
  settledKey=idleKey; // Reconcile, upgrades and the sweep are done for this edition; empty ticks may now skip until something changes.
  if(controls?.draining())return;
  if(config.roaming===false)return; // World panel "enemies roam" switch for this map: while it is off nobody walks or chases; flipping it back on resumes on the next tick.
  if(now()-active.updated<seconds)return;
  const players=roamingPlayers();
  if(!players.length)return; // Nothing to pursue: skip the random walk and, more importantly, the unconditional whole-floor write below.
  if(compute&&players.length&&active.floor.enemies.some(e=>!e.engaged&&e.respawnAt<=now()&&enemyRoams(data,e))){scheduleRoaming(active,players);return;}
  roam(active,players);
 }
 function roamingPlayers(){return db.prepare('SELECT p.*,c.revision,c.state FROM quest_presence p JOIN quest_characters c ON c.id=p.character_id WHERE p.zone=? AND p.seen>? ORDER BY p.character_id').all(zoneId,now()-30000);}
 function scheduleRoaming(active,players){
  if(roamingPending||closed)return;
  const f=active.floor,starts=f.enemies.filter(e=>!e.engaged&&enemyRoams(data,e)).map(e=>({id:e.id,x:e.x,y:e.y})); // Include imminent respawns so time passing during calculation cannot leave a roaming enemy without a plan.
  const positions=rows=>JSON.stringify(rows.map(p=>[p.character_id,p.x,p.y]));
  const expectedPositions=positions(players),scheduledAt=now();
  roamingPending=compute.submit('paths',{floor:{width:f.width,height:f.height,walls:f.walls,props:f.props},starts,targets:players.map(p=>({x:p.x,y:p.y})),limit:config.pursuit_steps}).then(paths=>{
   if(closed)return;
   measure('simulation.apply.'+zoneId,()=>{
    db.exec('BEGIN IMMEDIATE');try{
     const row=floorQuery.get(route,active.edition),currentPlayers=roamingPlayers();
     if(controls?.draining()||latest()!==active.edition||!config.static&&!active.edition.startsWith(weeklyWindow(now()).edition)||!row||row.content!==active.content||row.updated!==active.updated||positions(currentPlayers)!==expectedPositions||now()-scheduledAt>seconds){measure('worker.stale.paths',()=>{});db.exec('COMMIT');return;}
     const plans=new Map(starts.map((start,index)=>[start.id,new Map(currentPlayers.map((p,target)=>[p.character_id,paths[index][target]]))]));
     roam({...row,floor:JSON.parse(row.content)},currentPlayers,plans,scheduledAt);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
   });
  }).catch(error=>{if(!closed)log('dive_pathfinding_failed',zoneId,String(error));}).finally(()=>{roamingPending=null;});
 } // Revalidate geometry, enemy locks, edition and positions; fresh character/party state controls eligibility and settlement.
 function roam(active,players,plans=null,tickAt=now()){
  const f=active.floor;
  const occupied=new Set(f.enemies.filter(e=>e.respawnAt<=now()).map(e=>e.x+','+e.y));
  const rnd=seeded(active.edition+':'+Math.floor(tickAt/seconds));
  for(const foe of f.enemies){
   if(foe.engaged||foe.respawnAt>now()||!enemyRoams(data,foe))continue;
   const targets=players.filter(p=>{const s=JSON.parse(p.state);const ready=(parties?.members(p.character_id)??[]).every(c=>{const v=JSON.parse(c.state);return v.pendingDefeat||v.dive?.route!==route||v.dive?.edition!==active.edition||(!v.run&&!v.dungeonScene&&!v.worldTurnDue&&!v.pendingPurchase&&v.loadout?.player_info.playerHealth>0);});return ready&&(!live?.published().enabled||s.contentVersion===1)&&!s.pendingDefeat&&s.dive?.edition===active.edition&&!s.run&&!s.dungeonScene&&!s.worldTurnDue&&s.dive.safeUntil<=now()&&!safe(f,p.x,p.y);}); // Storing points cannot grant immunity from roaming enemies or block party encounters.
   let target=null,best=null;
   for(const p of targets){const path=plans?plans.get(foe.id)?.get(p.character_id):measure('pathfinding.'+zoneId,()=>pathTo(f,foe,p,config.pursuit_steps));if(path&&(!best||path.length<best.length)){target=p;best=path;}} // Worker paths are consumed only against revalidated coordinates; combat remains on the coordinator.
   if(best?.length===0||best?.length===1){const c={id:target.character_id,owner:target.owner,revision:target.revision},s=JSON.parse(target.state);if(s.loadout?.player_info.playerHealth>0){start(c,s,active,foe);saveCharacter(c,s);target.state=c.state;target.revision=c.revision;}continue;}
   let step=best?.[0];if(!step){const [dx,dy]=[[1,0],[-1,0],[0,1],[0,-1]][rnd(4)];step={x:foe.x+dx,y:foe.y+dy};}
   if(walkable(f,step.x,step.y)&&!safe(f,step.x,step.y)&&!occupied.has(step.x+','+step.y)&&!players.some(p=>p.x===step.x&&p.y===step.y)){
    occupied.delete(foe.x+','+foe.y);foe.x=step.x;foe.y=step.y;occupied.add(foe.x+','+foe.y);
   }
  }
  active.updated=tickAt;saveFloor(active); // Preserve the scheduled tick boundary; worker delivery latency must not halve the one-second movement cadence.
 }
 function tick(){if(closed||now()-lastTick<seconds)return;lastTick=now();measure('simulation.'+zoneId,()=>{db.exec('BEGIN IMMEDIATE');try{maintain();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');lastTick=-Infinity;settledKey=null;log('dive_tick_failed',error.stack??String(error));}});} // Never await workers while holding a transaction or request identity.
 function snapshot(c,p){
  const state=c?JSON.parse(c.state):null,record=owns(state?.dive)?getFloor(state.dive.edition):current(),personal=c&&record?progress(c,record.edition):null;
  const summary={enabled:config.enabled&&!!record,version:1,route,zone:zoneId,category,name,boss:bossId,edition:record?.edition??'',static:!!config.static,resetsAt:config.static?0:record?.ends??weeklyWindow(now()).ends,completed:personal?.completed??false,claimed:record?.floor.chests.filter(ch=>personal?.claimed.includes(ch.id)).length??0,total:record?.floor.chests.length??0,pickupsClaimed:(record?.floor.pickups??[]).filter(ch=>personal?.claimed.includes(ch.id)).length,pickupsTotal:record?.floor.pickups?.length??0,claimableCoins:personal?.completed?Math.max(0,config.boss_coins-personal.coinsPaid):0};
  if(!record||p?.zone!==zoneId||!owns(state?.dive))return {dive:summary};
  const f=record.floor;
  return {dive:{...summary,depth:1,origin:state.dive.origin,explored:personal.explored,...(dungeonRules?{scene:dungeonRules.scene(state),mechanismRevision:f.mechanismRevision,puzzles:f.puzzles}:{}),...(config.features?.rain?{weather:weatherAt(route,config.features.rain,now())}:{}),...(config.features?.tide?{tide:{...tideAt(route,config.features.tide,now()),reach:config.features.tide.reach??3,wade_wet:config.features.tide.wade_wet??2}}:{}),...(config.features?.eruption?{eruption:{...eruptionAt(route,config.features.eruption,now()),radius:config.features.eruption.radius??3,startle_wet:config.features.eruption.startle_wet??35}}:{}),enemies:f.enemies.filter(e=>!(e.manual&&!e.respawning&&e.dead)).map(e=>({...e,definition:undefined,name:(e.definition??data.enemies[e.type]).name,sprite:(e.definition??data.enemies[e.type]).sprite})),chests:f.chests.map(ch=>({...ch,claimed:personal.claimed.includes(ch.id)})),pickups:(f.pickups??[]).map(ch=>({...ch,claimed:personal.claimed.includes(ch.id)}))},definition:{id:zoneId,name,kind:"dungeon",category,exits:f.exits??[],theme,...(dungeonRules?{fullDungeonVersion:1,fixtures:f.fixtures.map(v=>v.kind==='shop'?{...v,offers:shopOffers(zoneId,findShop(v.id),now(),shopperLevel(state))}:v),puzzles:f.puzzles,mechanismRevision:f.mechanismRevision}:{}),mist:f.mist,walls:f.walls,props:f.props,geometryVersion:f.geometryVersion??0,dressingVersion:f.dressingVersion??0,width:f.width,height:f.height,rooms:f.rooms,entrance:f.entrance,decorations:f.decorations,...(f.cover?{cover:f.cover,exposed:!!f.exposed}:{}),...(f.shore?{shore:f.shore}:{}),...(f.crater?{crater:f.crater}:{}),...(f.heat?{heat:{...f.heat,thirst_per_step:config.features?.heat?.thirst_per_step??3,sweat_percent:config.features?.heat?.sweat_percent??50}}:{})}}; // crater/heat: Emberfall Caldera's lava lake and the overheated ring round it. // shore: the Seafoam Coast's shoreline column per row (sea to its east, tide flats just west of it). // cover/exposed: the Autumnal Plains' tall grass and open fields (plains-features.mjs).
 } // Snapshots expose claim status but never another character's inventory or chest rolls.
 function claim(c,state,record,chest,automatic=false){
  if(chest.puzzle&&!record.floor.puzzles.find(p=>p.id===chest.puzzle)?.solved)fail('Push the blocks to open this chest first.');
  const personal=progress(c,record.edition);if(chest.requires_encounter&&!personal.defeated?.includes(chest.requires_encounter)){if(automatic)return;fail('Defeat the guarding boss before claiming this treasure.');}if(personal.claimed.includes(chest.id)){if(automatic)return;fail('You already claimed this treasure this week.');}
  if(!stackable(personal.rolls[chest.id])&&slotsUsed(state.loadout.inventory)>=config.inventory_capacity){if(automatic){state.dive.lootNotice='Inventory full. Treasure remains here.';state.dive.lootNoticeAt=now();return;}fail('Inventory full. This treasure remains unclaimed.');}
  if(!personal.rolls[chest.id])personal.rolls[chest.id]=rollLoot(record.edition,c.id,chest,personal.rolls); // Capacity was checked first; only successful claims consume the allowance.
  const item=clone(personal.rolls[chest.id]);if(origins)origins.mint(c.id,item);addToInventory(state.loadout.inventory,item);personal.claimed.push(chest.id);saveProgress(c,record.edition,personal);
  const bundle=!chest.kind&&record.floor.chests.some(ch=>ch.id===chest.id)?rollLoot.ingredient(record.edition,c.id,chest):null; // room chests may also hold ingredients; loose treasure, food and potion pickups never do. Seeded, so replays find the same bundle.
  if(bundle){ // Ingredients stack and never use a slot, so a full bag cannot block them.
   if(origins){const tokens=[],prices=new Map();for(let n=0;n<bundle.quantity;n++){const unit=clone(bundle);delete unit.quantity;origins.mint(c.id,unit);if(unit.online_item){tokens.push(unit.online_item);prices.set(unit.online_item,unit.online_sell_price);}}setStackTokens(bundle,tokens,prices);} // one resale right per unit, like bought stacks
   addToInventory(state.loadout.inventory,bundle);
  }
  if(chest.trapped)dungeonRules?.trap(c,state,record,chest.id); // A personal trap shares the committed chest receipt.
  state.dive.lootNotice='Found '+(item.name??item.item_id)+(bundle?' and '+bundle.name+(bundle.quantity>1?' x'+bundle.quantity:''):'')+'.';state.dive.lootNoticeAt=now();
 } // Inventory, deterministic item roll and personal claim commit together inside the zone transaction.
 function handles(input,p){return input.action==='dive_enter'&&(input.zone??DIVE_ZONE)===zoneId||input.action==='enter'&&input.zone===zoneId||p?.zone===zoneId;}
 function act(i,c,state,input,p){
  const action=input.action;
  if(action==='dive_enter'||action==='enter'){
   if(config.full_dungeon_version&&(state.fullDungeonVersion!==1||state.questVersion!==1))fail('Update the game to enter full campaign dungeons.','client_update_required');
   if(controls?.draining()&&!state.dive)fail('This Dive is being regenerated.');
   if(state.dive&&input.zone&&input.zone!==zoneId)fail('Leave your current dungeon before changing routes.'); // Re-entry cannot change a live visit's route or imported inventory.
   if(!config.enabled)fail('Dungeon Dive is not enabled.');
   const existing=db.prepare('SELECT * FROM quest_presence WHERE owner=?').get(i.owner);
   if(existing&&existing.seen>now()-30000&&(existing.controller!==input.controller||existing.character_id!==c.id||existing.grant_id!==i.id)&&input.takeover!==true)fail('This account is active in another window.','zone_controller_conflict'); // Explicit re-entry can recover this character without discarding its dungeon fight or items.
   if(action==='enter'&&!state.dive&&state.diveReturned){
    const arrival=state.diveReturnedPosition??hubArrival([...hubRooms,...hubCatalog].find(z=>z.id===state.diveReturned),returnSource(state.diveReturned,zoneId));
    db.prepare('INSERT INTO quest_presence(owner,character_id,zone,grant_id,controller,x,y,seen,moved) VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET character_id=excluded.character_id,zone=excluded.zone,grant_id=excluded.grant_id,controller=excluded.controller,x=excluded.x,y=excluded.y,seen=excluded.seen,moved=0').run(i.owner,c.id,state.diveReturned,i.id,input.controller,arrival.x,arrival.y,now());return;
   } // A browser suspended across reset resumes in its lobby instead of retrying a retired floor forever.
   if(state.run&&state.run.kind!=='dive')fail('Finish your arena run before diving.');
   if(state.dive&&!owns(state.dive))fail('Leave your current dungeon before entering another route.');
   if(!state.dive){const hall=hubRooms.find(r=>r.id===p?.zone&&(r.kind==='dives'||config.full_dungeon_version)),host=hall??hubCatalog.find(h=>h.id===p?.zone);if(!p||!host||p.seen<=now()-30000||p.controller!==input.controller||p.grant_id!==i.id)fail('Enter from an online dungeon entrance.');
    const portal=routePortals(resolveHub(host)).find(v=>v.target===zoneId); // The Castle is an annex; towns have their own full dungeon doorsteps.
    const beside=portal?.style==='gap'?inHubGap({x:portal.x-1,y:portal.y-1,w:(portal.w??1)+2,h:(portal.h??1)+2},p.x,p.y):portal&&Math.abs(p.x-portal.x)+Math.abs(p.y-portal.y)<=1; // Wall openings span two tiles; pads are one.
    if(!portal||(hall||config.full_dungeon_version)&&!beside)fail(portal?.style==='gap'?'Walk through the wall opening.':config.full_dungeon_version?'Stand on or beside that dungeon entrance portal.':'Stand on or beside that glowing portal.');
    if(input.loadout)state.loadout=importLoadout(input.loadout);if(!state.loadout)fail('Import your character first.');
    const record=current(),origin=config.full_dungeon_version?p.zone:(hall?.parent??p.zone);if(!record)fail('The weekly floor is not ready.');state.dive={route,zone:zoneId,edition:record.edition,depth:1,origin,returnZone:p.zone,gate:!hall&&input.gate===true&&wildernessGates(p.zone).some(g=>g.target===zoneId),position:{...entry(record.floor,origin)},safeUntil:now()+10*seconds};state.diveReturned=null;delete state.diveReturnedPosition;delete state.hubVisit; // `gate`: entered by walking through a lobby's own wall opening (Rose garden -> Tundra).
   }
   const record=getFloor(state.dive.edition),position=state.dive.position;
   if(!record)fail('The weekly floor is unavailable.');
   const count=db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>? AND owner<>?').get(zoneId,now()-30000,c.owner).n;if(count>=64)fail('The dive is full.');
   db.prepare('INSERT INTO quest_presence(owner,character_id,zone,grant_id,controller,x,y,seen,moved) VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET character_id=excluded.character_id,zone=excluded.zone,grant_id=excluded.grant_id,controller=excluded.controller,x=excluded.x,y=excluded.y,seen=excluded.seen,moved=0').run(i.owner,c.id,zoneId,i.id,input.controller,position.x,position.y,now());
   reveal(c,state,record.floor,position.x,position.y);return;
  }
  if(state.run?.sharedEncounter&&!['enter','chat'].includes(action)){encounters.act(c,state,input,getFloor(state.dive.edition));return;}
  if(!owns(state.dive))fail('Re-enter the dungeon from its lobby.');
  const record=getFloor(state.dive.edition),f=record.floor;
  if(input.edition!==record.edition)fail('The dungeon edition changed. Refresh before acting.');
  if(dungeonRules&&record.edition!==latest()&&!['dive_exit','leave','defeat_complete','appearance','allocate'].includes(action))fail('This weekly dungeon has ended.'); // Old floors retain receipts but reject new fixture and mechanism mutations.
  if(dungeonRules?.act(c,state,record,input,p))return;
  if(dungeonRules&&action==='shop_buy'){purchases.prepare(i,c,state,{id:zoneId,fixtures:f.fixtures},p,input);return;}
  if(action==='defeat_complete'){
   const pending=state.pendingDefeat;
   if(!pending||input.scene!==pending.id)fail('That defeat scene is no longer pending.');
   pending.sceneComplete=true;recover(c,state,record); // Acknowledgement records reading once; an unfinished timer continues without repeated client commands.
   return;
  }
  if(action==='dive_exit'||action==='leave'){if(state.run)fail('Finish or flee from the current fight first.');
   if(input.zone){const exit=f.exits?.find(e=>e.zone===input.zone);if(!exit||!nearExit(exit,p.x,p.y))fail('Stand beside that hub exit.');}
   back(c,state,input.zone??(state.dive?.gate===true?undefined:config.parent_zone));return;} // Branch regions retreat to their parent, unless you walked in through a hub's own gate (Utopia's south wall onto the Taiga): then escape takes you home to that gate. Crossings retain their original hub return.
  // Chat is handled by the zone gateway before dungeon dispatch, sharing mute, block and rate-limit rules with every other area.
  if(action==='appearance'){state.avatar=input.avatar;return;} // The zone adapter validates the cosmetic allowlist before dispatch.
  if(action==='allocate'){if(state.run||!['str','def','dex','int','cha'].includes(input.stat)||!(state.loadout.player_info.stat_points>0))fail('Choose an available stat point outside combat.');if(state.loadout.player_info[input.stat]>=MAX_STAT)fail('That stat is already at its maximum of '+MAX_STAT+'.');state.loadout.player_info[input.stat]++;state.loadout.player_info.stat_points--;if(input.stat==='int')state.loadout.player_mp_max=manaCapacity(state.loadout);if(input.stat==='def'){const p=state.loadout.player_info,gain=defHpDelta(currentTuning(),p.level,p.def-1,p.def);p.playerHealthMax+=gain;p.playerHealth=Math.min(p.playerHealthMax,p.playerHealth+gain);}if(input.stat==='dex'){const p=state.loadout.player_info,gain=dexStaminaDelta(currentTuning(),p.level,p.dex-1,p.dex);p.stamina_max=(Number(p.stamina_max)||100)+gain;p.stamina=Math.min(p.stamina_max,(Number(p.stamina)||0)+gain);}return;} // DEF carries a share of max HP (hp_def_share); DEX a share of max stamina.
  if(record.edition!==latest()&&!state.run)fail('This weekly dungeon has ended.');
  if(action==='dive_claim_reward'){if(state.run)fail('Finish the current fight first.');const amount=pay(c,state,record);state.lastResult={outcome:'reward_claimed',coins:amount,zone:zoneId,log:[]};return;}
  if(action==='dive_well'){ // Drink from a Plains well: thirst and stamina up, and it goes straight to the bladder. One drink per well per cooldown.
   if(state.run)fail('Finish the current fight first.');
   const lines=drinkFromWell(f,p,state.loadout,config.features,now(),state.dive.wellDrinks??={});
   state.dive.lootNotice=lines.join(' ');state.dive.lootNoticeAt=now();return;
  }
  if(action==='dive_rest'){ // Nap on a Farmstead hay bed: stamina back, and you wake needing the outhouse. One nap per bed per cooldown.
   if(state.run)fail('Finish the current fight first.');
   const lines=restInHay(f,p,state.loadout,config.features,now(),state.dive.hayNaps??={});
   state.dive.lootNotice=lines.join(' ');state.dive.lootNoticeAt=now();return;
  }
  if(action==='dive_soak'||action==='dive_cool'){ // Caldera hot springs (full stamina, then everything loosens for a while) and Obsidian Spa cooling baths.
   if(state.run)fail('Finish the current fight first.');
   const lines=action==='dive_soak'?soakInSpring(f,p,state.loadout,config.features,now(),state.dive.springSoaks??={}):coolInBath(f,p,state.loadout,config.features,now(),state.dive.bathDips??={});
   state.dive.lootNotice=lines.join(' ');state.dive.lootNoticeAt=now();return;
  }
  if(action==='dive_claim'){
   if(state.run)fail('Finish the current fight first.');const chest=[...f.chests,...(f.pickups??[])].find(ch=>ch.id===input.chest);if(!chest||Math.abs(chest.x-p.x)+Math.abs(chest.y-p.y)>1)fail('Stand next to that treasure.');
   claim(c,state,record,chest);return;
  }
  if(action==='move'||action==='dive_engage'){
   if(state.run)fail('Finish combat first.'); // Exploration stays available while stat points are banked.
   if(action==='dive_engage'){const foe=f.enemies.find(e=>e.id===input.encounter);if(!foe||Math.abs(foe.x-p.x)+Math.abs(foe.y-p.y)>1)fail('Approach that enemy first.');start(c,state,record,foe);return;}
   if(now()-p.moved<movementDelay(state.loadout,currentTuning()))fail('Movement is too fast.'); /* Same live move_delay_ms / crawl_move_delay_ms as the hubs. */ const d={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]}[input.direction];if(!d)fail('Choose a direction.');
   const x=p.x+d[0],y=p.y+d[1];if(!walkable(f,x,y))fail('That tile is blocked.');const foe=f.enemies.find(e=>e.x===x&&e.y===y&&e.respawnAt<=now());
   if(foe){start(c,state,record,foe);return;}
   const exit=f.exits?.find(e=>inExit(e,x,y)); // Pads are one tile; overworld wall gaps span two.
   const entranceReturn=!(f.exits?.length)&&x===f.entrance.x&&y===f.entrance.y;
   if(exit||entranceReturn){back(c,state,exit?.zone);return;} // Stepping onto any return portal commits the transfer; spawning/reconnecting on it never triggers a bounce.
   db.prepare('UPDATE quest_presence SET x=?,y=?,moved=? WHERE character_id=?').run(x,y,now(),c.id);reveal(c,state,f,x,y);
   dungeonRules?.step(c,state,record,x,y); // Room timers and traps count committed moves only.
   if(input.world_step===true)state.worldTurnDue={id:randomUUID(),mist:mistAt(f,x,y),lullaby:!!state.dungeonLullaby}; // Loot commits first; the needs tick resumes from that inventory rather than overwriting the grant.
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
  if(controls?.draining())fail('This Dive is being regenerated.');
  const record=current(),position=record?.floor.entries?.[source];
  if(!config.enabled||!position)fail('That connecting trail is unavailable.');
  if(db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>? AND owner<>?').get(zoneId,now()-30000,c.owner).n>=64)fail('The dive is full.');
  const previous=state.dive;
  state.dive={route,zone:zoneId,edition:record.edition,depth:1,origin:source,hubOrigin:previous.hubOrigin??previous.origin,hubEntryZone:previous.hubEntryZone??source,returnZone:previous.returnZone,position:{...position},safeUntil:now()+10*seconds};
  state.diveReturned=null;delete state.diveReturnedPosition;
  db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE character_id=?').run(zoneId,position.x,position.y,now(),c.id);
  reveal(c,state,record.floor,position.x,position.y); // Revisit this route's own claims and fog; never re-import stale campaign equipment.
 }
 function gmPlace(c,state,visit){ // Gamemaster warp into this route's shared weekly floor, building the same visit record a portal or trail would.
  if(controls?.draining())fail('This Dive is being regenerated.');
  const record=(visit.edition&&getFloor(visit.edition))||current(); // Join a player still finishing last week's floor, otherwise the current week.
  if(!config.enabled||!record)fail('This Dive has no floor ready this week.');
  if(db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>? AND owner<>?').get(zoneId,now()-30000,c.owner).n>=64)fail('The dive is full.');
  const f=record.floor,goal=visit.near??entry(f,visit.origin); // Beside a player, or at the arrival point for where the visit came from.
  const exits=[...(f.exits??[]),f.entrance]; // Standing still on these is harmless, but avoid them so the first step never bounces the GM out.
  const open=(x,y)=>walkable(f,x,y)&&!f.enemies.some(e=>e.x===x&&e.y===y)&&!exits.some(e=>e.x===x&&e.y===y);
  let position=null;
  for(let r=visit.near?1:0;r<=8&&!position;r++)for(let dy=-r;dy<=r&&!position;dy++)for(let dx=-r;dx<=r;dx++){ // Nearest ring first; a player's own tile is skipped.
   if(Math.abs(dx)+Math.abs(dy)!==r||!open(goal.x+dx,goal.y+dy))continue;
   position={x:goal.x+dx,y:goal.y+dy};break;
  }
  position??={...entry(f,visit.origin)}; // A boxed-in target still lands the GM on the floor's own arrival tile.
  state.dive={route,zone:zoneId,edition:record.edition,depth:1,origin:visit.origin,hubOrigin:visit.hubOrigin,...(visit.hubEntryZone?{hubEntryZone:visit.hubEntryZone}:{}),returnZone:visit.returnZone,gate:visit.gate===true,position:{...position},safeUntil:now()+10*seconds};
  state.diveReturned=null;delete state.diveReturnedPosition;delete state.hubVisit; // Same bookkeeping as dive_enter.
  db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE character_id=?').run(zoneId,position.x,position.y,now(),c.id);
  reveal(c,state,f,position.x,position.y); // Personal fog and claims for this edition are reused, never reset.
 }
 return {category,tick,snapshot,handles,act,chatArea,arrive,gmPlace,parentZone:config.parent_zone??null,controls,floor:()=>current()?.floor??null,prepare:ensure,close(){closed=true;controls?.close();},available:()=>Boolean(config.enabled&&enabledQuery.get(route)),encounterSnapshot:state=>encounters.snapshot(state)};
} // All mutations run inside the zone command transaction; scheduled simulation owns its own transaction.
