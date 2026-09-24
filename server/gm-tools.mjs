// In-game gamemaster tools. The game's GM panel sends these as ordinary `gm_*`
// zone actions through the existing player gateway, so they reuse the durable
// command journal, controller lease and revision checks every other command uses.
// Access is the same LiDollID `gamemaster` role the /gm web panel reads; it is
// decided by the tracker on every request and never by anything the client sends.
import {gmZones} from './gm.mjs';
import {hubDefinition,hubGaps,inHubGap,hubCatalog,hubRooms,routePortals,routeHome,wildernessGates} from './hubs.mjs';
import {currentTuning} from './combat.mjs';

const ONLINE_WINDOW=30000; // Matches the presence freshness window every other module uses.
const HUB_SPAWN={x:10,y:9}; // hubDefinition() falls back to this tile when a room declares no spawn.
const zoneInfo=new Map(gmZones.map(z=>[z.id,z])); // One shared catalogue with the web panel: names, kinds and which rooms may be warped into.
const fail=(status,message,code='gm_tool_rejected')=>{throw Object.assign(Error(message),{status,code});}; // Never 401/403: the client treats those as a lost sign-in.
export const GM_ACTIONS=Object.freeze(['gm_catalog','gm_warp_zone','gm_warp_player','gm_summon','gm_zone_reload','gm_quest_start','gm_quest_advance','gm_quest_complete','gm_quest_reset','gm_chat_delete','gm_chat_clear','gm_combat_tune','gm_announce','gm_announce_end']);
export const COMBAT_KEYS=Object.freeze(['row_swap_costs_turn','row_back_damage_taken','row_back_melee_dealt','row_front_target_weight','reach_damage_mult','move_delay_ms','crawl_move_delay_ms']); // What the in-game Combat page may retune; bounds come from loot-store.mjs. // Every command the in-game panel can send.

export function createGmTools(db,{now=Date.now,zone,blocked,isDungeon,dives=new Map(),quests=null,live=null,audit=()=>{},loot=null,announcements=null}={}){
 const requireGm=i=>{if(i?.gamemaster!==true)fail(409,'GM tools need the gamemaster role on your LiDollID account.','gm_not_gamemaster');}; // 409 keeps an ordinary player's session alive if a stale client ever shows the panel.
 const zoneName=id=>zoneInfo.get(id)?.name??id; // Unknown ids still read sensibly if a new room ships before the catalogue is updated.
 const fresh=characterId=>db.prepare('SELECT p.*,c.name,c.owner AS char_owner,c.state,c.revision FROM quest_presence p JOIN quest_characters c ON c.id=p.character_id WHERE p.character_id=? AND p.seen>?').get(characterId,now()-ONLINE_WINDOW); // A live presence row plus its character.

 function movable(state,who,fromDive=false){ // Relocating mid-fight would strand that fight's own bookkeeping.
  if(state.run)fail(409,who+' must finish or forfeit the current fight first.');
  if(state.dive&&!fromDive)fail(409,who+' is inside a Dive; they must leave it before being summoned.'); // Only the GM's own warps may lift someone out of a Dive.
  if(state.pendingDefeat)fail(409,who+' must finish the defeat dialogue first.');
  if(state.pendingPurchase)fail(409,who+' has a purchase still settling.');
 }

 function landing(z,x,y){ // Nearest open tile to (x,y) that is not an exit, portal or wall opening, so arrival never triggers another transfer.
  const def=hubDefinition(z,now()),exit=def.exit,portals=def.portals??[];
  const unsafe=(tx,ty)=>blocked(z,tx,ty)||(tx===exit.x&&ty===exit.y)||portals.some(p=>p.x===tx&&p.y===ty)||hubGaps(z).some(g=>inHubGap(g,tx,ty));
  for(let r=0;r<=6;r++)for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){ // Grow outward ring by ring, nearest first.
   if(Math.abs(dx)+Math.abs(dy)!==r)continue; // Only this ring's tiles; inner rings were already checked.
   if(!unsafe(x+dx,y+dy))return {x:x+dx,y:y+dy};
  }
  return {...(def.spawn??HUB_SPAWN)}; // A walled-in target still lands the GM on the room's declared spawn.
 }

 function place(characterId,owner,state,z,spot){ // Commit one presence move and the matching annex bookkeeping.
  if(z.parent)state.hubVisit=z.id;else delete state.hubVisit; // Same rule as walking through a door: annexes remember their visit, lobbies clear it.
  db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=?,seen=? WHERE character_id=? AND owner=?').run(z.id,spot.x,spot.y,now(),now(),characterId,owner);
 }

 const diveOpen=id=>dives.has(id)&&dives.get(id).available(); // A Dive is a destination once this week's shared floor exists.
 function warpable(id){ // Hub lobbies, their annex rooms and any Dive with a floor ready this week.
  const info=zoneInfo.get(String(id??''));
  if(!info)fail(400,'Choose a destination room.','gm_unknown_zone');
  if(dives.has(info.id)){if(!diveOpen(info.id))fail(409,info.name+' has no floor ready right now.','gm_zone_not_warpable');return null;} // null means "a Dive": its engine places the GM.
  if(!info.warp)fail(409,'That area is not a place you can stand in.','gm_zone_not_warpable'); // Global chat is listed for moderation only.
  return zone(info.id); // Resolve monthly district layouts so the spawn matches what visitors actually see.
 }
 function homeHub(state,p){ // The campaign hub the GM is visiting from: used as a Dive's origin and its way back.
  if(state.dive?.hubOrigin??state.dive?.origin)return state.dive.hubOrigin??state.dive.origin;
  if(hubCatalog.some(h=>h.id===p.zone))return p.zone;
  return hubRooms.find(r=>r.id===p.zone)?.parent??null;
 }
 function diveVisit(id,prefer){ // Build the origin/return fields a portal entry would have produced for this Dive.
  const hubs=hubCatalog.filter(h=>routePortals(h).some(v=>v.target===id)).map(h=>h.id); // Every hub with a portal or garden gate to this route.
  const hub=hubs.includes(prefer)?prefer:hubs[0];
  if(hub)return {origin:hub,hubOrigin:hub,returnZone:routeHome(hub,id),gate:wildernessGates(hub).some(g=>g.target===id)}; // Leaving returns beside the opening in that hub's dive hall, or in Rose Court's garden for the Tundra.
  const parent=dives.get(id)?.parentZone; // Branch regions (Taiga, High Desert) are reached by trail from another Dive.
  if(!parent)fail(409,'No hub leads to that Dive.','gm_zone_not_warpable');
  const above=diveVisit(parent,prefer);
  return {origin:parent,hubOrigin:above.hubOrigin,returnZone:above.returnZone,hubEntryZone:parent}; // Arrive on the trail from the parent, exactly as walking in would.
 }
 function leaveDive(state){ // Same end state as walking out: personal loot claims and fog stay saved per edition.
  if(!state.dive)return;
  state.dive=null;state.diveReturned=null;delete state.diveReturnedPosition;
 }

 function catalog(i,c){ // Everything the panel lists, built fresh on request instead of riding along in every snapshot.
  const players=db.prepare('SELECT p.character_id,p.zone,p.x,p.y,c.name,c.state FROM quest_presence p JOIN quest_characters c ON c.id=p.character_id WHERE p.seen>? ORDER BY c.name,p.character_id LIMIT 200').all(now()-ONLINE_WINDOW)
   .map(r=>{const s=JSON.parse(r.state);return {id:r.character_id,name:r.name,zone:r.zone,zoneName:zoneName(r.zone),x:r.x,y:r.y,self:r.character_id===c.id,dive:isDungeon(r.zone),fighting:Boolean(s.run)};}); // Only names and positions: no account ids, inventory or credentials.
  const zones=gmZones.filter(z=>z.warp||diveOpen(z.id)).map(z=>({id:z.id,name:z.name,kind:z.kind})); // Warpable rooms and live Dives, in the web panel's order.
  const here=fresh(c.id),area=here?chatAreaOf(c,here):null; // The GM's own area, resolved from their committed presence rather than anything the client sent.
  const chat=area?db.prepare("SELECT seq,name,text,owner LIKE 'activity:%' AS activity FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 24").all(area).reverse().map(r=>({seq:r.seq,name:r.name,text:r.text,activity:r.activity===1})):[]; // Every recent line in the area, ignoring the radius, so moderation sees what any player here could have seen.
  const tuning=currentTuning(),combat=Object.fromEntries(COMBAT_KEYS.map(key=>[key,tuning[key]])); // Current live values for the Combat page.
  return {serverTime:now(),players,zones,quests:quests?quests.gmCatalog(c):[],chat,chatArea:area,combat};
 }

 function chatAreaOf(c,p){return isDungeon(p.zone)&&dives.has(p.zone)?dives.get(p.zone).chatArea(c,p)?.id??null:p.zone;} // Same stream id the snapshot builder uses: hub room, or route+edition+floor inside a Dive.
 function act(i,c,state,input,p){ // Runs inside the caller's transaction; the caller bumps the GM's revision and writes the receipt.
  requireGm(i);
  const action=input.action;
  if(action==='gm_chat_delete'){ // One line by sequence number, from any area.
   const seq=Number(input.seq);
   if(!Number.isSafeInteger(seq)||seq<1)fail(400,'Choose a message to remove.','gm_unknown_message');
   const row=db.prepare('SELECT * FROM quest_chat WHERE seq=?').get(seq)??fail(404,'That message has already gone.','gm_unknown_message');
   db.prepare('DELETE FROM quest_chat WHERE seq=?').run(seq);
   audit(i.owner,'delete_chat',row.owner.replace(/^activity:/,''),{zone:row.zone,name:row.name,text:row.text,reason:'in-game'}); // Same audit action as the web panel, so one report covers both.
   state.hubNotice='[GM] Removed a line by '+row.name+'.';state.hubNoticeAt=now();
   return;
  }
  if(action==='gm_combat_tune'){ // One live combat value from the in-game Combat page; the same store the /gm Loot tab writes, so both agree.
   const key=String(input.key??'');if(!COMBAT_KEYS.includes(key))fail(400,'Choose a combat setting.','gm_unknown_setting');
   if(!loot)fail(409,'Live tuning is not available on this server.','gm_unknown_setting');
   let values;try{values=loot.tune({[key]:input.value},i.owner);}catch(e){fail(400,e.message,'gm_unknown_setting');}
   audit(i.owner,'loot_tune','combat',{keys:[key],value:values[key],reason:'in-game'});
   state.hubNotice='[GM] '+key.replace(/_/g,' ')+' is now '+values[key]+'.';state.hubNoticeAt=now();
   return;
  }
  if(action==='gm_announce'){ // "/announce text" from chat or the GM tools: a banner in front of every online player, signed with this GM's character name.
   if(!announcements)fail(409,'Announcements are not available on this server.','gm_unknown_action');
   const posted=announcements.post({text:input.text,speaker:c.name,minutes:input.minutes},i.owner);
   audit(i.owner,'announce','everyone',{text:posted.text,speaker:posted.speaker,minutes:posted.minutes,reason:'in-game'}); // Same audit action as the web panel.
   state.hubNotice='[GM] Announced to everyone for '+posted.minutes+(posted.minutes===1?' minute.':' minutes.');state.hubNoticeAt=now();
   return;
  }
  if(action==='gm_announce_end'){ // Take the current banner down early.
   if(!announcements)fail(409,'Announcements are not available on this server.','gm_unknown_action');
   const ended=announcements.end();
   if(ended)audit(i.owner,'announce_end','everyone',{text:ended.text,reason:'in-game'});
   state.hubNotice=ended?'[GM] Announcement ended.':'[GM] No announcement is up right now.';state.hubNoticeAt=now();
   return;
  }
  if(action==='gm_chat_clear'){ // Every line in the GM's current area.
   const area=chatAreaOf(c,p);
   if(!area)fail(409,'Re-enter the area before clearing its chat.','gm_unknown_zone');
   const removed=Number(db.prepare('DELETE FROM quest_chat WHERE zone=?').run(area).changes);
   audit(i.owner,'clear_chat',area,{removed,reason:'in-game'});
   state.hubNotice='[GM] Cleared '+removed+(removed===1?' message':' messages')+' from this area.';state.hubNoticeAt=now();
   return;
  }
  if(action==='gm_warp_zone'){
   movable(state,'You',true);
   const z=warpable(input.zone),to=z?z.id:String(input.zone);
   if(z){leaveDive(state);place(c.id,i.owner,state,z,landing(z,(z.spawn??HUB_SPAWN).x,(z.spawn??HUB_SPAWN).y));}
   else {const visit=diveVisit(to,homeHub(state,p));leaveDive(state);dives.get(to).gmPlace(c,state,visit);} // Enter the shared weekly floor at its normal arrival point.
   audit(i.owner,'gm_warp_zone',c.id,{from:p.zone,to}); // Staff moves are recorded in the same audit log as the web panel.
   state.hubNotice='[GM] Warped to '+zoneName(to)+'.';state.hubNoticeAt=now(); // Shown once in the action log by the ordinary notice path.
   return;
  }
  if(action==='gm_warp_player'||action==='gm_summon'){
   if(typeof input.target!=='string'||input.target===c.id)fail(400,'Choose another online player.','gm_unknown_player');
   const t=fresh(input.target)??fail(409,'That player is not online right now.','gm_not_online');
   if(action==='gm_warp_player'){
    movable(state,'You',true);
    if(isDungeon(t.zone)){ // Join them on the same shared floor and edition, beside their tile.
     const theirs=JSON.parse(t.state).dive;
     if(!theirs||!dives.has(t.zone))fail(409,t.name+' is between Dive floors; try again in a moment.','gm_not_online');
     const visit={edition:theirs.edition,origin:theirs.origin,hubOrigin:theirs.hubOrigin??theirs.origin,returnZone:theirs.returnZone,hubEntryZone:theirs.hubEntryZone,near:{x:t.x,y:t.y}}; // Share their way back too.
     leaveDive(state);dives.get(t.zone).gmPlace(c,state,visit);
    }else{leaveDive(state);const z=zone(t.zone);place(c.id,i.owner,state,z,landing(z,t.x,t.y));}
    audit(i.owner,'gm_warp_player',t.char_owner,{character:t.character_id,zone:t.zone});
    state.hubNotice='[GM] Warped to '+t.name+' in '+zoneName(t.zone)+'.';state.hubNoticeAt=now();
    return;
   }
   if(isDungeon(p.zone))fail(409,'Warp to a hub room before summoning; pulling someone into a Dive would skip its entry checks.','gm_zone_not_warpable');
   const other=JSON.parse(t.state);movable(other,t.name);
   const z=zone(p.zone),spot=landing(z,p.x,p.y);
   place(t.character_id,t.char_owner,other,z,spot);
   other.hubNotice='A gamemaster brought you to '+zoneName(z.id)+'.';other.hubNoticeAt=now(); // The summoned player sees why their room changed.
   db.prepare('UPDATE quest_characters SET revision=revision+1,state=? WHERE id=?').run(JSON.stringify(other),t.character_id); // Their next command refreshes first instead of acting on the old room.
   audit(i.owner,'gm_summon',t.char_owner,{character:t.character_id,from:t.zone,to:z.id});
   state.hubNotice='[GM] Summoned '+t.name+'.';state.hubNoticeAt=now();
   return;
  }
  if(action==='gm_zone_reload'){
   live?.invalidate(); // Drop the cached published content so the next snapshot re-reads NPCs, quests and placements.
   audit(i.owner,'gm_zone_reload',p.zone,{});
   state.hubNotice='[GM] Reloaded '+zoneName(p.zone)+'.';state.hubNoticeAt=now();
   return;
  }
  if(action.startsWith('gm_quest_')){
   if(!quests)fail(409,'Online quests are not enabled on this server.','gm_quests_unavailable');
   if(typeof input.quest!=='string'||!input.quest)fail(400,'Choose a quest.','gm_unknown_quest');
   const name=quests.gm(c,state,action.slice(3),input.quest); // quest_start, quest_advance, quest_complete or quest_reset.
   audit(i.owner,action,c.id,{quest:input.quest});
   state.hubNotice='[GM] '+{gm_quest_start:'Started',gm_quest_advance:'Advanced',gm_quest_complete:'Completed',gm_quest_reset:'Reset'}[action]+' quest: '+name+'.';state.hubNoticeAt=now();
   return;
  }
  fail(400,'Unknown GM action.','gm_unknown_action');
 }

 return {requireGm,catalog,act};
}
