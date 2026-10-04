import {caveReach} from './caverns-generation.mjs';
import {randomUUID,createHash} from 'node:crypto';
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'quest_placement_conflict'});};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function npcPlacementFacing(npc,placement={}){return (npc?.wander_radius||placement.routes?.length?placement.facing:undefined)??npc?.facing??npc?.look?.facing??0;} // Moving NPCs retain their last step; stationary ones immediately use the published default.
export function createQuestPlacements(db,{live,now,base,affected=()=>[],failQuests=()=>{},readOnly=false}){ // readOnly: zone snapshot workers (zone-snapshot-runtime.mjs) hold a read-only database and must never commit a placement map.
 db.exec(`CREATE TABLE IF NOT EXISTS world_placements(id TEXT PRIMARY KEY,zone TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS world_placement_exclusions(zone TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(zone,id));
 CREATE TABLE IF NOT EXISTS world_placement_maps(zone TEXT NOT NULL,edition TEXT NOT NULL,signature TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(zone,edition));`);
 const rows=zone=>db.prepare('SELECT body FROM world_placements WHERE zone=? ORDER BY id').all(zone).map(r=>JSON.parse(r.body));
 function geometry(f){return hash([f.width,f.height,f.walls,f.props,f.entrance,f.entries,f.exits,(f.fixtures??[]).filter(p=>p.kind!=='npc'),f.portals]);}
 function tiles(f){ // Flood from every required entrance, excluding solid terrain; relocated objectives stay reachable.
  const fixtures=(f.fixtures??[]).filter(p=>p.solid!==false);const walk=(x,y)=>Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<f.width&&y<f.height&&!f.walls?.[y]?.[x]&&!f.props?.[y]?.[x]&&!fixtures.some(p=>x>=p.x&&x<p.x+(p.span_w??1)&&y>=p.y&&y<p.y+(p.span_h??1));
  const queue=[f.entrance,...Object.values(f.entries??{})].filter(p=>p&&walk(p.x,p.y)),seen=new Set(queue.map(p=>p.x+','+p.y));
  for(let i=0;i<queue.length;i++){const p=queue[i];for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]){const x=p.x+dx,y=p.y+dy,key=x+','+y;if(walk(x,y)&&!seen.has(key)){seen.add(key);queue.push({x,y});}}}return queue;
 }
 const obstacles=f=>[f.entrance,...Object.values(f.entries??{}),...(f.exits??[]),...(f.portals??[]),...(f.fixtures??[]),...(f.chests??[]),...(f.pickups??[]),...(f.enemies??[]).filter(e=>!e.dead)].filter(Boolean);
 // ----- NPC routes: GM-authored patrols and schedules on an NPC placement (the Map Editor's NPC routes tool) -----
 // routes: up to four {id,name,mode:'loop'|'pingpong'|'once',when,points:[{x,y,wait}]}. when: {type:'always'}, {type:'daily',from,to} (UTC minutes of the day) or
 // {type:'every',minutes} (one lap at each period start). The first route whose schedule matches is walked; with none, the NPC walks home.
 const tileKey=p=>p.x+','+p.y,ROUTE_MODES=['loop','pingpong','once'];
 const standing=f=>[f.entrance,...Object.values(f.entries??{}),...(f.exits??[]),...(f.portals??[]),...(f.fixtures??[]),...(f.chests??[]),...(f.pickups??[])].filter(Boolean); // obstacles() without the monsters, which move.
 function normalizeRoutes(list,f){ // Shape and reachability of incoming routes; every waypoint sits on the flood-filled floor, so any two of them connect.
  if(!Array.isArray(list)||list.length>4)fail('Use up to four routes per NPC.');
  const reach=new Set(tiles(f).map(tileKey)),taken=new Set(standing(f).map(tileKey)),ids=new Set();
  return list.map(r=>{
   if(!r||typeof r!=='object')fail('Malformed route.');
   const points=Array.isArray(r.points)?r.points:[];if(!points.length||points.length>16)fail('A route needs 1 to 16 waypoints.');
   const w=r.when??{};let when={type:'always'};
   if(w.type==='daily'){const from=Number(w.from),to=Number(w.to);if(![from,to].every(n=>Number.isInteger(n)&&n>=0&&n<1440)||from===to)fail('A daily route needs different start and end times.');when={type:'daily',from,to};}
   else if(w.type==='every'){const minutes=Number(w.minutes);if(!Number.isInteger(minutes)||minutes<1||minutes>1440)fail('Repeat a route every 1 to 1440 minutes.');when={type:'every',minutes};}
   else if(w.type!==undefined&&w.type!=='always')fail('Unknown route schedule.');
   const id=typeof r.id==='string'&&/^[A-Za-z0-9_-]{4,64}$/.test(r.id)&&!ids.has(r.id)?r.id:'route-'+randomUUID();ids.add(id);
   return {id,name:String(r.name??'').slice(0,60),mode:ROUTE_MODES.includes(r.mode)?r.mode:'loop',when,points:points.map(p=>{const x=Number(p?.x),y=Number(p?.y),wait=Math.floor(Number(p?.wait??0));if(!reach.has(x+','+y)||taken.has(x+','+y))fail('Waypoint '+x+','+y+' must be a reachable tile clear of entrances, exits and fixtures.');if(!(wait>=0&&wait<=600))fail('Waypoint waits run from 0 to 600 seconds.');return {x,y,wait};})};
  });
 }
 function snapRoutes(routes,free,f){ // A regenerated or patched map may wall a waypoint in: move it to the nearest usable tile within three steps, or drop it.
  const taken=new Set(standing(f).map(tileKey)),usable=free.filter(t=>!taken.has(tileKey(t))),reach=new Set(usable.map(tileKey));let dropped=0;
  const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
  const out=routes.map(r=>({...r,points:r.points.flatMap(p=>{if(reach.has(tileKey(p)))return [p];const near=usable.filter(t=>distance(t,p)<=3).sort((a,b)=>distance(a,p)-distance(b,p)||a.y-b.y||a.x-b.x)[0];if(near)return [{...p,x:near.x,y:near.y}];dropped++;return [];})})).filter(r=>r.points.length);
  return {routes:out,dropped};
 }
 function activeRoute(p,t){ // The first route whose schedule matches now; an 'every' route stays active until this period's lap is finished.
  const minute=Math.floor(t/60000)%1440;
  for(const r of p.routes){const w=r.when;
   if(w.type==='daily'){if(w.from<w.to?minute>=w.from&&minute<w.to:minute>=w.from||minute<w.to)return r;}
   else if(w.type==='every'){if(p.laps?.[r.id]!==Math.floor(t/(w.minutes*60000)))return r;}
   else return r;
  }
  return null;
 }
 function stepToward(free,blocked,from,to){ // First tile of the shortest walk from -> to over free tiles, or null when there is no way through right now.
  if(blocked.has(tileKey(to))||!free.has(tileKey(to)))return null;
  const prev=new Map([[tileKey(from),null]]),queue=[from];
  for(let i=0;i<queue.length;i++){const p=queue[i];
   if(p.x===to.x&&p.y===to.y){let at=p;for(let parent=prev.get(tileKey(at));parent!==from;parent=prev.get(tileKey(at)))at=parent;return at;}
   for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]){const q={x:p.x+dx,y:p.y+dy},k=tileKey(q);if(free.has(k)&&!blocked.has(k)&&!prev.has(k)){prev.set(k,p);queue.push(q);}}
  }
  return null;
 }
 function routeStep(p,t,free,blocked,snap){ // One 2 s slot for an NPC with routes. walking: on the way somewhere, so players (and other walkers) pass through it.
  let r=activeRoute(p,t);if((p.walk?.route??null)!==(r?.id??null))p.walk=r?{route:r.id,leg:0}:null;
  if(snap){const rest=r?(r.mode==='once'?r.points.length-1:0):0,spot=r?r.points[rest]:p.home;if(!blocked.has(tileKey(spot))){p.x=spot.x;p.y=spot.y;if(r)p.walk={route:r.id,leg:rest};}} // Nobody watched the walk there: start where the schedule says.
  if(r&&p.x===r.points[p.walk.leg].x&&p.y===r.points[p.walk.leg].y){ // Standing on the current waypoint: wait, then choose the next one.
   const w=p.walk,n=r.points.length,last=w.leg===n-1;w.until??=t+r.points[w.leg].wait*1000;
   if(t<w.until){p.walking=false;return;}
   const lap=r.mode==='pingpong'?n===1||(w.leg===0&&!!w.back):last;
   if(lap&&r.when.type==='every'){p.laps={...p.laps,[r.id]:Math.floor(t/(r.when.minutes*60000))};p.walk=null;r=null;} // This period's lap is done: head home until the next one.
   else if(n===1||(last&&r.mode==='once')){p.walking=false;return;} // A post to stand at.
   else {if(r.mode==='pingpong'){if(last)w.back=true;else if(w.leg===0)w.back=false;w.leg+=w.back?-1:1;}else w.leg=(w.leg+1)%n;delete w.until;}
  }
  const target=r?r.points[p.walk.leg]:p.home;
  if(p.x===target.x&&p.y===target.y){p.walking=false;return;} // Home with nothing scheduled.
  p.walking=true;const next=stepToward(free,blocked,p,target);if(!next)return; // Boxed in for now: try again next slot.
  p.facing=next.x!==p.x?(next.x>p.x?2:3):(next.y>p.y?0:1);p.x=next.x;p.y=next.y;
 }
 function realize(zone,edition,f,{commit=true,players=[]}={}){
  const logical=[...(f.authoredPlacements??[]).filter(p=>!db.prepare('SELECT 1 FROM world_placement_exclusions WHERE zone=? AND id=?').get(zone,p.id)&&!rows(zone).some(v=>v.id===p.id)),...rows(zone)];for(const p of logical)if(p.lifetime==='temporary'&&p.edition!==edition&&affected({...p,replacementEdition:edition}).length)fail('Active quests require expiring placement '+p.name+'. Place a persistent replacement or remove it with an explicit failure decision before replacing the map.');
  const definitions=logical.filter(p=>p.lifetime==='persistent'||p.edition===edition),signature=hash([geometry(f),definitions]),old=db.prepare('SELECT * FROM world_placement_maps WHERE zone=? AND edition=?').get(zone,edition);
  if(!definitions.length){if(commit&&old)db.prepare('DELETE FROM world_placement_maps WHERE zone=? AND edition=?').run(zone,edition);return [];}if(old?.signature===signature)return JSON.parse(old.body);
  const free=tiles(f),dry=f.caveChannels?caveReach({...f,managedOccupancy:[]},undefined,true):null,occupied=[...obstacles(f),...players],placements=[];
  for(const p of definitions){const candidates=free.filter(t=>(!p.dry||!dry||dry.has(t.x+','+t.y))&&!occupied.some(o=>Math.abs(o.x-t.x)+Math.abs(o.y-t.y)<=1)).sort((a,b)=>(Math.abs(a.x-p.x)+Math.abs(a.y-p.y))-(Math.abs(b.x-p.x)+Math.abs(b.y-p.y))||a.y-b.y||a.x-b.x),spot=candidates[0];if(!spot)fail('No reachable tile for '+p.name+' in '+zone+'.');const placed={...p,...spot,home:{...spot}};if(p.kind==='npc'&&Array.isArray(p.routes)&&p.routes.length){const snapped=snapRoutes(p.routes,free,f);placed.routes=snapped.routes;if(snapped.dropped)placed.routeDropped=snapped.dropped;}placements.push(placed);occupied.push(spot);}
  if(commit)db.prepare('INSERT INTO world_placement_maps VALUES (?,?,?,?) ON CONFLICT(zone,edition) DO UPDATE SET signature=excluded.signature,body=excluded.body').run(zone,edition,signature,JSON.stringify(placements));return placements;
 }
 function view(zone){const map=base.map(zone);if(!map.floor)return {...map,placements:[]};const placements=realize(zone,map.edition,map.floor,{commit:!readOnly}),fresh=JSON.stringify(map.floor.managedOccupancy??[])===JSON.stringify(placements.filter(p=>p.kind==='npc'&&!p.walking).map(({x,y})=>({x,y})))?map:base.map(zone),revision=hash([fresh.revision,placements]);return {...fresh,baseRevision:fresh.revision,revision,placements};}
 function act(input){
  const map=view(input.zone);if((input.action!=='world_route_content'&&input.revision!==map.revision)||input.edition!==map.edition)fail('The map changed. Refresh before placing content.'); // Routes are checked against the live floor below, so a monster or NPC stepping mid-edit (which changes the revision) never discards a drawn route.
  if((input.action==='world_place'||input.action==='world_move')&&map.placements.some(p=>Math.abs(p.x-input.x)+Math.abs(p.y-input.y)<=1))fail('Choose a tile away from NPCs and quest objectives.');
  if(!['world_place_content','world_update_content','world_remove_content','world_scatter_orbs','world_route_content'].includes(input.action))return base.act({...input,revision:map.baseRevision});
  if(map.job)fail('Wait for regeneration to finish.');
  if(input.action==='world_route_content'){ // Replace one NPC placement's routes; the changed definition re-realizes the map, so the NPC restarts from home.
   const old=map.placements.find(p=>p.id===input.placement);if(!old||old.kind!=='npc')fail('Choose an NPC placement.');
   const routes=normalizeRoutes(input.routes,map.floor),{step,walk,walking,laps,routeDropped,facing,home,...body}=old,saved=rows(input.zone).find(p=>p.id===old.id)??{...body,...home}; // The stored row keeps its authored tile; walking state lives only in the realized map.
   db.prepare('INSERT INTO world_placements VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(old.id,input.zone,JSON.stringify({...saved,routes}));return view(input.zone);
  }
  if(input.action==='world_update_content'){
   const old=map.placements.find(p=>p.id===input.placement);if(!old)fail('This placement no longer exists.');const x=input.x??old.x,y=input.y??old.y;
   if(!tiles(map.floor).some(t=>t.x===x&&t.y===y)||[...obstacles(map.floor),...map.placements.filter(p=>p.id!==old.id),...map.players].some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=1))fail('Choose a reachable tile away from entrances, fixtures and occupants.');
   const updated={...old,x,y,lifetime:input.lifetime==='temporary'?'temporary':'persistent',edition:map.edition};db.prepare('INSERT INTO world_placements VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(old.id,input.zone,JSON.stringify(updated));return view(input.zone);
  } // Moving or changing lifetime keeps stable placement identity and quest references.
  if(input.action==='world_scatter_orbs'){ // The orb generator: spread an ordered chain across the map, first orb nearest the entrance and the last deepest in, like the campaign's orb sequences.
   const list=Array.isArray(input.orbs)?input.orbs:[];if(!list.length||list.length>32||new Set(list).size!==list.length)fail('Choose one to 32 different orbs to scatter.');
   if(rows(input.zone).length+list.length>128)fail('This zone would exceed 128 managed placements.');
   const orbs=list.map(key=>{const o=live.published().orbs?.[key];if(!o||o.retired)fail('Publish every orb before scattering it.');return o;});
   const occupied=[...obstacles(map.floor),...map.placements,...map.players],starts=[map.floor.entrance,...Object.values(map.floor.entries??{})].filter(Boolean);
   const depth=new Map();{const queue=starts.map(p=>({x:p.x,y:p.y,d:0})),walk=new Set(tiles(map.floor).map(t=>t.x+','+t.y));for(const p of queue)depth.set(p.x+','+p.y,0);for(let i=0;i<queue.length;i++){const p=queue[i];for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]){const k=(p.x+dx)+','+(p.y+dy);if(walk.has(k)&&!depth.has(k)){depth.set(k,p.d+1);queue.push({x:p.x+dx,y:p.y+dy,d:p.d+1});}}}} // Walking distance from the nearest entrance.
   const far=Math.max(1,...depth.values()),spread=Math.max(3,Math.floor(Math.sqrt(depth.size/(list.length+1))/2)),chosen=[];
   orbs.forEach((o,i)=>{ // Orb i aims for the (i+1)/(n+1) band of walking distance, away from content, crowds and the other orbs.
    const want=far*(i+1)/(list.length+1),candidates=tiles(map.floor).filter(t=>depth.has(t.x+','+t.y)&&![...occupied,...chosen].some(p=>Math.abs(p.x-t.x)+Math.abs(p.y-t.y)<=1)&&!chosen.some(p=>Math.abs(p.x-t.x)+Math.abs(p.y-t.y)<spread));
    candidates.sort((a,b)=>Math.abs(depth.get(a.x+','+a.y)-want)-Math.abs(depth.get(b.x+','+b.y)-want)||parseInt(hash([o.id,a.x,a.y]).slice(0,8),16)-parseInt(hash([o.id,b.x,b.y]).slice(0,8),16)); // Nearest band first; a stable hash breaks ties so a retry lands on the same tiles.
    const spot=candidates[0];if(!spot)fail('No free reachable tile left for '+o.title+'.');chosen.push(spot);
    const p={id:'place-'+randomUUID(),zone:input.zone,kind:'orb',content:o.id,name:o.title,sprite:'',x:spot.x,y:spot.y,lifetime:input.lifetime==='temporary'?'temporary':'persistent',edition:map.edition,created:now()};
    db.prepare('INSERT INTO world_placements VALUES (?,?,?)').run(p.id,p.zone,JSON.stringify(p));
   });
   return view(input.zone);
  }
  if(input.action==='world_remove_content'){
   const p=map.placements.find(p=>p.id===input.placement);if(!p)fail('Placement no longer exists.');const blockers=affected(p);if(blockers.length){if(input.resolution!=='fail')fail('Active quests depend on this placement: '+blockers.map(q=>q.definition.name).join(', ')+'. Place a replacement or explicitly fail these quests.');failQuests(blockers);}
   db.prepare('DELETE FROM world_placements WHERE id=?').run(p.id);if(map.floor.authoredPlacements?.some(v=>v.id===p.id))db.prepare('INSERT OR IGNORE INTO world_placement_exclusions VALUES (?,?)').run(input.zone,p.id);
  }else{
   if(rows(input.zone).length>=128)fail('This zone already has 128 managed placements.');
   if(!['npc','interact','location','token','orb'].includes(input.placement_kind))fail('Choose an NPC, object, location, token or story orb.');
   const orb=input.placement_kind==='orb'?live.published().orbs?.[input.content]:null;if(input.placement_kind==='orb'&&(!orb||orb.retired))fail('Choose a published story orb.');
   const npc=input.placement_kind==='npc'?live.published().npcs[input.content]:null;if(input.placement_kind==='npc'&&(!npc||npc.retired))fail('Choose a published NPC.');
   const {x,y}=input;if(!tiles(map.floor).some(t=>t.x===x&&t.y===y)||[...obstacles(map.floor),...map.placements,...map.players].some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=1))fail('Choose a reachable tile away from entrances, fixtures and occupants.');
   const key=String(input.content??'');if(!/^[a-z][a-z0-9_-]{1,79}$/.test(key))fail('Use a stable content/objective target ID.');
   const sprite=orb?'':npc?.sprite??live.assetRef(input.sprite??''); // Persist validated token/object artwork independently of monster definitions; orbs draw as glowing lights, not sprites.
   const p={id:'place-'+randomUUID(),zone:input.zone,kind:input.placement_kind,content:key,name:orb?.title??npc?.name??String(input.name??key).slice(0,100),sprite,x,y,lifetime:input.lifetime==='temporary'?'temporary':'persistent',edition:map.edition,created:now()};
   db.prepare('INSERT INTO world_placements VALUES (?,?,?)').run(p.id,p.zone,JSON.stringify(p));
  }
  return view(input.zone);
 }
 function visible(zone,edition,f){return realize(zone,edition,f).map(p=>{const n=live.published().npcs[p.content];return {...p,...(p.kind==='npc'&&n?{name:n.name,sprite:n.sprite,retired:n.retired,facing:npcPlacementFacing(n,p)}:{})};});}
 let presentQuery=null;const lastBusy=new Map(); // lastBusy: zone -> when its routed NPCs last walked with someone present.
 let lastStep=null;const freeTiles=new Map(); // lastStep: the 2 s walking slot already fully handled. freeTiles: zone -> {key, free} walkable-tile set, rebuilt only when the map's edition or placement signature changes.
 function tick(){ // NPC walking is deterministic, bounded, and pauses while a conversation holds its placement.
  const step=Math.floor(now()/2000);if(step===lastStep)return; // Each NPC moves at most once per 2 s slot, so later ticks in a finished slot have nothing to do.
  const npcs=live.published().npcs,wanderers=new Set(Object.keys(npcs).filter(k=>npcs[k]?.wander_radius)); // Only NPCs with a wander radius ever move.
  const zones=wanderers.size?new Set(db.prepare('SELECT zone,body FROM world_placements').all().filter(r=>{const p=JSON.parse(r.body);return p.kind==='npc'&&wanderers.has(p.content);}).map(r=>r.zone)):new Set(); // Realized maps come only from these rows, so a zone without a wandering NPC can skip map building entirely.
  const routed=new Set(db.prepare("SELECT DISTINCT zone FROM world_placements WHERE json_extract(body,'$.kind')='npc' AND json_array_length(body,'$.routes')>0").all().map(r=>r.zone));for(const zone of routed)zones.add(zone); // Zones with a routed NPC tick too.
  const known=zones.size?new Set(base.catalog().map(z=>z.id)):null;let held=false; // Rooms retired by a deployment (Rose Court's old Resting Hall) keep their saved placements but must never be ticked or mapped. held: a conversation paused someone this slot.
  for(const zone of zones){
   if(!known.has(zone))continue;
   const map=base.map(zone),row=db.prepare('SELECT * FROM world_placement_maps WHERE zone=? AND edition=?').get(zone,map.edition);if(!row||!map.floor)continue;const placements=JSON.parse(row.body);let changed=false;
   const key=row.edition+'|'+row.signature;let cached=freeTiles.get(zone);if(cached?.key!==key){cached={key,free:new Set(tiles(map.floor).map(p=>p.x+','+p.y))};freeTiles.set(zone,cached);} // The flood fill is the costly part; the signature already hashes geometry and placements.
   const free=cached.free,fixed=[...obstacles(map.floor),...map.players]; // Terrain obstacles and players, built once per zone instead of once per NPC.
   const busy=routed.has(zone)&&!!(presentQuery??=db.prepare('SELECT 1 FROM quest_presence WHERE zone=? AND seen>? LIMIT 1')).get(zone,now()-30000),snap=busy&&now()-(lastBusy.get(zone)??0)>60000,solid=busy?obstacles(map.floor).map(tileKey):[];if(busy)lastBusy.set(zone,now()); // Routed NPCs only walk while someone is in the zone; after a minute alone they resume where their schedule puts them.
   for(const p of placements){const n=npcs[p.content];
    if(p.kind==='npc'&&p.routes?.length){ // A routed NPC follows its schedule instead of wandering, and walks through players rather than queueing behind them.
     if(!busy||step===(p.step??0))continue;
     if(db.prepare("SELECT 1 FROM online_conversations WHERE placement=? AND expires>?").get(p.id,now())){held=true;if(p.walking){p.walking=false;changed=true;}continue;}
     p.step=step;routeStep(p,now(),free,new Set([...solid,...placements.filter(v=>v.id!==p.id&&!v.walking).map(tileKey)]),snap);changed=true;continue;
    }
    if(p.kind!=='npc'||!n?.wander_radius||step===(p.step??0))continue;if(db.prepare("SELECT 1 FROM online_conversations WHERE placement=? AND expires>?").get(p.id,now())){held=true;continue;}p.step=step;const direction=parseInt(hash([p.id,p.step]).slice(0,2),16)%4,[dx,dy]=[[0,-1],[-1,0],[1,0],[0,1]][direction],x=p.x+dx,y=p.y+dy;
    if(Math.abs(x-p.home.x)+Math.abs(y-p.home.y)<=n.wander_radius&&free.has(x+','+y)&&![...fixed,...placements.filter(v=>v.id!==p.id)].some(v=>v.x===x&&v.y===y)){p.x=x;p.y=y;p.facing=dx? (dx>0?2:3):(dy>0?0:1);}changed=true;
   }if(changed)db.prepare('UPDATE world_placement_maps SET body=? WHERE zone=? AND edition=?').run(JSON.stringify(placements),row.zone,row.edition);
  }
  if(!held)lastStep=step; // An NPC paused by a conversation gets retried on the next tick of this slot, exactly as before.
 }
 return {rows,realize,view,act,visible,tick,positions(zone,edition){const row=db.prepare('SELECT body FROM world_placement_maps WHERE zone=? AND edition=?').get(zone,edition);return row?JSON.parse(row.body).filter(p=>p.kind==='npc'&&!p.walking).map(({x,y})=>({x,y})):[];},catalog:base.catalog};
} // Logical placements and their per-instance positions are persisted separately from terrain.
