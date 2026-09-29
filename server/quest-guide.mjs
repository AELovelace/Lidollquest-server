// Quest guide (2026-09-29): where the ONE tracked online quest wants the player to go next.
// The minimap draws the answer: a gold marker on the exit to take when the objective is in another
// zone, or a blue marker on the objective itself once the player is in the right zone.
// The client only ever knows its own zone, so the zone graph (every gate, door, pad and trail)
// lives here and ships as one small `questGuide` object in the snapshot.

export const GUIDE_REFRESH_MS=30000; // Monthly districts, weekly editions and GM enable switches are the only things that move doors.
const OPEN=['active','choice','ready']; // Quest statuses that still have somewhere to go.

export function firstOpenObjective(q){ // Decision 2026-09-29: always the first unfinished objective in authored order, even for mode:any stages (predictable beats clever).
 return (q?.objectives??[]).find(o=>(o.progress??0)<(o.count??1))??null; // null when every objective in the stage is done (the stage is about to advance).
}

export function buildGuideGraph(list){ // list: [{id,exits:[{to,x,y,w,h,style,side,name}]}]. to:null means "back out the way you came" (a Dive with no authored exits).
 const graph=new Map(list.map(z=>[z.id,[]])); // zone id -> outgoing exits; only zones in the list are nodes.
 for(const z of list)for(const e of z.exits??[]){ // Copy every exit whose destination is a known, enabled zone.
  if(e.to===null||e.to===undefined||!graph.has(e.to)||e.to===z.id)continue; // Unknown or disabled destinations never become a route.
  graph.get(z.id).push(exitView(e)); // Keep only what the client needs to draw it.
 }
 for(const z of list)for(const e of z.exits??[]){ // Return-to-origin exits: one edge back to every room that has a way in.
  if(e.to!==null)continue; // Only the "way out" entrances of exit-less Dives.
  for(const [from,exits] of graph)if(from!==z.id&&exits.some(x=>x.to===z.id))graph.get(z.id).push(exitView({...e,to:from})); // Campaign Dives return to whichever hall's pad sent you in.
 }
 return graph;
}

function exitView(e){ // The drawable part of an exit: position, footprint, wall side and label.
 return {to:e.to,x:e.x,y:e.y,w:e.w??1,h:e.h??1,style:e.style??'stairs',side:e.side??'',name:e.name??''}; // Wall gaps span w x h tiles; pads, doors and stairs are one tile.
}

const distance=(e,x,y)=>Math.abs(e.x+(e.w-1)/2-x)+Math.abs(e.y+(e.h-1)/2-y); // Manhattan distance from the player to the middle of an exit.

export function guideRoutes(graph,from,x=0,y=0){ // Breadth-first search: zone id -> {hops, exit} where exit is the door to take in `from`.
 const routes=new Map([[from,{hops:0,exit:null}]]),queue=[]; // The start zone needs no door.
 const first=new Map(); // neighbour zone -> the closest exit in `from` that leads there.
 for(const e of graph.get(from)??[])if(!first.has(e.to)||distance(e,x,y)<distance(first.get(e.to),x,y))first.set(e.to,e); // Several gates can lead to the same zone: take the nearest.
 for(const [to,e] of first)if(!routes.has(to)){routes.set(to,{hops:1,exit:e});queue.push(to);} // Every neighbour is one hop away through its own door.
 while(queue.length){ // Standard BFS; each zone inherits the first door of the zone that reached it.
  const at=queue.shift(),here=routes.get(at); // The next zone to expand.
  for(const e of graph.get(at)??[])if(!routes.has(e.to)){routes.set(e.to,{hops:here.hops+1,exit:here.exit});queue.push(e.to);} // First visit is the shortest route.
 }
 return routes;
}

export function guideGoal(q,{isZone,contentZones}){ // What the tracked quest wants next, before looking at any map: which zone(s) and what to point at there.
 if(q.status==='choice')return {objective:'',note:'choice'}; // A branch is waiting in the journal; there is nowhere to walk.
 if(q.status==='ready')return q.turn_in?.mode==='npc'?{...npcGoal(q.turn_in.npc,{isZone,contentZones}),objective:'turn_in'}:{objective:'turn_in',note:'journal'}; // Walk back to the turn-in NPC, or claim from the journal.
 const o=firstOpenObjective(q);if(!o)return {objective:'',note:'done'}; // Every objective is finished; the stage changes on the next evaluation.
 const zoned=o.zone&&isZone(o.zone)?[o.zone]:null; // An authored zone restriction always wins.
 const goal=(()=>{switch(o.type){ // Where each objective type lives.
  case 'talk':return npcGoal(o.target,{isZone,contentZones}); // A resident fixture ("zone:fixture") or a published NPC placement.
  case 'deliver':return npcGoal(o.npc??q.turn_in?.npc,{isZone,contentZones}); // Carry the item to the delivery NPC.
  case 'visit':
   if(isZone(o.target))return {zones:[o.target],area:true}; // "Go to this zone": arriving completes it.
   if(String(o.target).startsWith('full-room:'))return {zones:zoned??[],room:String(o.target).slice(10)}; // A room of a full dungeon floor (campaign explore quests).
   return {zones:zoned??contentZones(o.target),content:o.target}; // A GM "location" placement.
  case 'interact':return {zones:zoned??contentZones(o.target),content:o.target}; // An interact placement or a story orb.
  case 'collect':return o.token?{zones:zoned??contentZones(o.target),content:o.target}:zoned?{zones:zoned,area:true}:{note:'anywhere'}; // Tokens are placed; ordinary items can come from anywhere.
  case 'kill':return {zones:zoned??[],enemy:o.target,anyZone:!zoned}; // Monsters of that kind; without a zone only the current zone is searched.
  default:return zoned?{zones:zoned,area:true}:{note:'anywhere'}; // state, equipment, timer: only a zone restriction gives them a place.
 }})();
 return {...goal,objective:o.id}; // Tag the answer with the objective it points at.
}

function npcGoal(key,{isZone,contentZones}){ // "<zone>:<fixture>" resident keys carry their zone; published NPCs are found through their placements.
 const text=String(key??''),split=text.indexOf(':'); // Published NPC ids never contain a colon.
 if(split>0&&isZone(text.slice(0,split)))return {zones:[text.slice(0,split)],fixture:text.slice(split+1),npc:text}; // A built-in resident of that zone.
 return text?{zones:contentZones(text),content:text,npc:text}:{note:'unknown'}; // A published NPC wherever a GM placed it.
}

export function locateGoal(goal,{x=0,y=0,fixtures=[],placements=[],enemies=[],rooms=[],time=0}={}){ // The tile to mark inside the current zone, or null for "somewhere in this zone".
 if(goal.fixture){const f=fixtures.find(f=>f.id===goal.fixture);if(f)return {x:f.x,y:f.y};} // Resident NPCs stand on their fixture.
 if(goal.content){const n=placements.find(n=>n.content===goal.content&&(!goal.npc||n.kind==='npc'))??fixtures.find(f=>f.kind==='token'&&f.content===goal.content);if(n)return {x:n.x,y:n.y};} // Placed NPCs, locations, tokens, interacts and orbs; full-dungeon quest tokens are floor fixtures.
 if(goal.enemy){ // The nearest living monster of that kind.
  const alive=enemies.filter(e=>(e.type===goal.enemy||e.enemy_id===goal.enemy||e.definition?.enemy_id===goal.enemy)&&!(e.respawnAt>time)); // Defeated monsters waiting to respawn do not count.
  alive.sort((a,b)=>Math.abs(a.x-x)+Math.abs(a.y-y)-(Math.abs(b.x-x)+Math.abs(b.y-y))); // Closest first.
  if(alive.length)return {x:alive[0].x,y:alive[0].y};
 }
 if(goal.room){const r=rooms.find(r=>r.type===goal.room);if(r)return {x:r.x+Math.floor((r.w??1)/2),y:r.y+Math.floor((r.h??1)/2)};} // The middle of that dungeon room.
 return null; // No exact tile: the minimap brackets the whole zone instead.
}

export function createQuestGuide({now=Date.now,zones,contentZones=()=>[]}){ // zones(): the live exit list (zones.mjs builds it); contentZones(content): zones holding a placement.
 let graph=null,built=-Infinity; // Rebuilt at most every GUIDE_REFRESH_MS.
 const contentMemo=new Map(); // content key -> zone ids, cleared with the graph.
 function current(){ // The cached zone graph.
  if(!graph||now()-built>=GUIDE_REFRESH_MS){graph=buildGuideGraph(zones());built=now();contentMemo.clear();} // A stale graph costs at most one missed month/week door move for 30 s.
  return graph;
 }
 function placedIn(content){ // Placement zones, remembered for the same 30 s window as the graph.
  if(!contentMemo.has(content))contentMemo.set(content,[...new Set(contentZones(content))]); // One small SQLite read per content key.
  return contentMemo.get(content);
 }
 function guide(q,{zone,x=0,y=0,locate=()=>null}){ // q: the publicQuest view of the tracked instance. Returns the snapshot's questGuide.
  if(!q||!OPEN.includes(q.status))return null; // Nothing tracked, or the tracked quest has ended.
  const g=current(),goal=guideGoal(q,{isZone:id=>g.has(id),contentZones:placedIn}); // Where the quest wants us.
  const base={quest:q.id,objective:goal.objective,from:zone,zone:null,here:false,target:null,exit:null,note:goal.note??null}; // Every field is always present so the client can read it plainly; from: the zone this answer was worked out in (the client skips a stale one mid-transfer).
  if(goal.note)return base; // choice / journal / anywhere / done / unknown: HUD text only.
  const inHere=goal.zones.includes(zone)||(goal.anyZone&&!goal.zones.length); // Unzoned kill objectives only look at the current zone.
  if(inHere){const target=locate(goal);if(goal.anyZone&&!goal.zones.length&&!target)return {...base,note:'anywhere'};return {...base,zone,here:true,target};} // In the right zone: point at the tile (or the whole zone).
  const routes=guideRoutes(g,zone,x,y); // Doors out of the current zone, nearest first.
  const best=goal.zones.filter(id=>routes.has(id)).sort((a,b)=>routes.get(a).hops-routes.get(b).hops)[0]; // The closest zone that holds the objective.
  if(!best)return {...base,zone:goal.zones[0]??null,note:goal.zones.length?'no_route':'unknown'}; // Locked, disabled or not placed anywhere yet.
  return {...base,zone:best,exit:{...routes.get(best).exit},hops:routes.get(best).hops}; // The door to take right now.
 }
 return {guide,graph:current,invalidate(){graph=null;}}; // invalidate(): GM tools that move doors can force the next snapshot to rebuild.
}
