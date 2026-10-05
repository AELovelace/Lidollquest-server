// Map Editor trap placements (world placement kind 'trap'): GM-placed floor traps in any online zone.
//
//  - A placement names one trap id from the live /gm trap registry (trap-store.mjs), or none,
//    meaning "draw from this zone's pool" (trapZoneKeys: 'any' plus the zone's own key).
//  - Stepping onto the tile springs it server-side, independent of quests, through the same
//    resolveTrap/trapEffects/applyDungeonEffects implementation as campaign floor traps.
//  - Once per character per placement per map edition (placed_trap_triggers). A persistent
//    placement re-arms when its zone gets a new edition (weekly Dive floor, monthly hub layout);
//    an avoided trap counts as sprung. A placement whose named trap is retired stays inert.
//  - The result is presented as state.trapScene, sent in every snapshot as `trapScene` and
//    answered with the trap_scene_choice command; the client shows it in the narrative box.
//    Pending scenes never block movement, and placements are walkable.
import {applyDungeonEffects,campaignChoice,pickWeighted,resolveTrap,trapEffects,presentScene,sceneView,advanceScene} from './full-dungeon-rules.mjs';
const DIRS={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]};

export function createPlacedTraps(db,{traps,placements,now=Date.now,roll,adjust=()=>{},origins=null,data={items:{},config:{inventory_capacity:99},enemies:{}},zoneKeys=()=>['any']}){
 db.exec('CREATE TABLE IF NOT EXISTS placed_trap_triggers(character_id TEXT NOT NULL,placement TEXT NOT NULL,edition TEXT NOT NULL,trap TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(character_id,placement,edition))');
 const context={db,data,now,roll,origins,adjust,floor:null}; // No dungeon floor: spawn_enemy traps never ambush here (trapEffects spawn:false).
 const any=zone=>placements.rows(zone).some(p=>p.kind==='trap'); // Cheap row check before realizing a map.
 function armed(c,zone){ // This zone's realized trap placements that this character has not sprung on the current edition.
  if(!zone||!any(zone))return {map:null,list:[]};
  const map=placements.view(zone),fired=new Set(db.prepare('SELECT placement FROM placed_trap_triggers WHERE character_id=? AND edition=?').all(c.id,map.edition).map(r=>r.placement));
  return {map,list:map.placements.filter(p=>p.kind==='trap'&&!fired.has(p.id))};
 }
 function cut(c,zone,start,steps){ // How many queued walk steps to keep so the walk stops on the first armed trap (like the NPC cut in zones.mjs).
  const {list}=armed(c,zone);if(!list.length)return steps.length;
  let x=start.x,y=start.y;for(let i=0;i<steps.length;i++){const [dx,dy]=DIRS[steps[i]]??[0,0];x+=dx;y+=dy;if(list.some(p=>p.x===x&&p.y===y))return i+1;}
  return steps.length;
 }
 function linger(c,s,steps){ // Lingering wet/tum from an earlier placed trap, one tick per committed step (the campaign floor rule).
  if(!s.trapLingering?.length)return;
  for(let n=0;n<steps;n++)for(const e of s.trapLingering){if(e.delay>0){e.delay--;continue;}if(e.turns-->0)applyDungeonEffects([{type:'wet',amount:e.wet},{type:'tum',amount:e.tum}],c,s,context);}
  s.trapLingering=s.trapLingering.filter(e=>e.turns>0);if(!s.trapLingering.length)delete s.trapLingering;
 }
 function spring(c,s,zone,edition,p){
  const raw=p.content?traps.registry()[p.content]:pickWeighted(traps.pool(zoneKeys(zone)),roll);if(!raw)return null; // Retired trap or empty pool: inert, and not marked, so a restore re-arms it.
  db.prepare('INSERT OR IGNORE INTO placed_trap_triggers VALUES (?,?,?,?,?)').run(c.id,p.id,edition,raw.trap_id??'',now());
  if(s.trapScenes?.length>=4)s.trapScenes.shift(); // Bounded backlog for a client that never answers.
  const {event,avoided}=resolveTrap(raw,s,roll,zone);
  if(avoided){presentScene(s,'trapScene',traps.narrative,event.name,'You avoid the '+event.name+' entirely.');return {trap:event.trap_id,avoided:true};}
  const lines=applyDungeonEffects(trapEffects(event,s,{spawn:false}),c,s,context);
  presentScene(s,'trapScene',traps.narrative,event.name,event.message||lines.join(' '),event.narrative_chunk??'');
  if(event.lingering_turns)(s.trapLingering??=[]).push({turns:event.lingering_turns,delay:event.lingering_delay??0,wet:event.lingering_wet??0,tum:event.lingering_tum??0});
  return {trap:event.trap_id,avoided:false,amount:event.amount};
 }
 function step(c,s,zone,path){ // path: every tile this command crossed, in order (a queued walk already stops on the first armed trap).
  linger(c,s,path.length);
  const {map,list}=armed(c,zone);if(!list.length)return null;
  for(const at of path){const p=list.find(t=>t.x===at.x&&t.y===at.y);if(p)return spring(c,s,zone,map.edition,p);}
  return null;
 }
 function choice(c,s,input){advanceScene(s,'trapScene',input,{apply:effects=>applyDungeonEffects(effects,c,s,context),choose:choice=>campaignChoice(choice,c,s,context)});} // Struggle/wait gates and page effects, exactly as on campaign floors.
 return {step,cut,choice,any,view:s=>sceneView(s?.trapScene)};
}
