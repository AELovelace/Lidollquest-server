import {randomUUID,createHash} from 'node:crypto';
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'quest_placement_conflict'});};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function createQuestPlacements(db,{live,now,base,affected=()=>[],failQuests=()=>{}}){
 db.exec(`CREATE TABLE IF NOT EXISTS world_placements(id TEXT PRIMARY KEY,zone TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS world_placement_maps(zone TEXT NOT NULL,edition TEXT NOT NULL,signature TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(zone,edition));`);
 const rows=zone=>db.prepare('SELECT body FROM world_placements WHERE zone=? ORDER BY id').all(zone).map(r=>JSON.parse(r.body));
 function geometry(f){return hash([f.width,f.height,f.walls,f.props,f.entrance,f.entries,f.exits,(f.fixtures??[]).filter(p=>p.kind!=='npc'),f.portals]);}
 function tiles(f){ // Flood from every required entrance, excluding solid terrain; relocated objectives stay reachable.
  const fixtures=(f.fixtures??[]).filter(p=>p.solid!==false);const walk=(x,y)=>Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<f.width&&y<f.height&&!f.walls?.[y]?.[x]&&!f.props?.[y]?.[x]&&!fixtures.some(p=>x>=p.x&&x<p.x+(p.span_w??1)&&y>=p.y&&y<p.y+(p.span_h??1));
  const queue=[f.entrance,...Object.values(f.entries??{})].filter(p=>p&&walk(p.x,p.y)),seen=new Set(queue.map(p=>p.x+','+p.y));
  for(let i=0;i<queue.length;i++){const p=queue[i];for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]){const x=p.x+dx,y=p.y+dy,key=x+','+y;if(walk(x,y)&&!seen.has(key)){seen.add(key);queue.push({x,y});}}}return queue;
 }
 const obstacles=f=>[f.entrance,...Object.values(f.entries??{}),...(f.exits??[]),...(f.portals??[]),...(f.fixtures??[]),...(f.chests??[]),...(f.pickups??[]),...(f.enemies??[]).filter(e=>!e.dead)].filter(Boolean);
 function realize(zone,edition,f,{commit=true,players=[]}={}){
  const logical=rows(zone);for(const p of logical)if(p.lifetime==='temporary'&&p.edition!==edition&&affected({...p,replacementEdition:edition}).length)fail('Active quests require expiring placement '+p.name+'. Place a persistent replacement or remove it with an explicit failure decision before replacing the map.');
  const definitions=logical.filter(p=>p.lifetime==='persistent'||p.edition===edition),signature=hash([geometry(f),definitions]),old=db.prepare('SELECT * FROM world_placement_maps WHERE zone=? AND edition=?').get(zone,edition);
  if(!definitions.length){if(commit&&old)db.prepare('DELETE FROM world_placement_maps WHERE zone=? AND edition=?').run(zone,edition);return [];}if(old?.signature===signature)return JSON.parse(old.body);
  const free=tiles(f),occupied=[...obstacles(f),...players],placements=[];
  for(const p of definitions){const candidates=free.filter(t=>!occupied.some(o=>Math.abs(o.x-t.x)+Math.abs(o.y-t.y)<=1)).sort((a,b)=>(Math.abs(a.x-p.x)+Math.abs(a.y-p.y))-(Math.abs(b.x-p.x)+Math.abs(b.y-p.y))||a.y-b.y||a.x-b.x),spot=candidates[0];if(!spot)fail('No reachable tile for '+p.name+' in '+zone+'.');const placed={...p,...spot,home:{...spot}};placements.push(placed);occupied.push(spot);}
  if(commit)db.prepare('INSERT INTO world_placement_maps VALUES (?,?,?,?) ON CONFLICT(zone,edition) DO UPDATE SET signature=excluded.signature,body=excluded.body').run(zone,edition,signature,JSON.stringify(placements));return placements;
 }
 function view(zone){const map=base.map(zone);if(!map.floor)return {...map,placements:[]};const placements=realize(zone,map.edition,map.floor),fresh=JSON.stringify(map.floor.managedOccupancy??[])===JSON.stringify(placements.filter(p=>p.kind==='npc').map(({x,y})=>({x,y})))?map:base.map(zone),revision=hash([fresh.revision,placements]);return {...fresh,baseRevision:fresh.revision,revision,placements};}
 function act(input){
  const map=view(input.zone);if(input.revision!==map.revision||input.edition!==map.edition)fail('The map changed. Refresh before placing content.');
  if(input.action==='world_place'&&map.placements.some(p=>Math.abs(p.x-input.x)+Math.abs(p.y-input.y)<=1))fail('Choose a tile away from NPCs and quest objectives.');
  if(!['world_place_content','world_remove_content'].includes(input.action))return base.act({...input,revision:map.baseRevision});
  if(map.job)fail('Wait for regeneration to finish.');
  if(input.action==='world_remove_content'){
   const p=map.placements.find(p=>p.id===input.placement);if(!p)fail('Placement no longer exists.');const blockers=affected(p);if(blockers.length){if(input.resolution!=='fail')fail('Active quests depend on this placement: '+blockers.map(q=>q.definition.name).join(', ')+'. Place a replacement or explicitly fail these quests.');failQuests(blockers);}
   db.prepare('DELETE FROM world_placements WHERE id=?').run(p.id);
  }else{
   if(rows(input.zone).length>=128)fail('This zone already has 128 managed placements.');
   if(!['npc','interact','location','token'].includes(input.placement_kind))fail('Choose an NPC, object, location or token.');
   const npc=input.placement_kind==='npc'?live.published().npcs[input.content]:null;if(input.placement_kind==='npc'&&(!npc||npc.retired))fail('Choose a published NPC.');
   const {x,y}=input;if(!tiles(map.floor).some(t=>t.x===x&&t.y===y)||[...obstacles(map.floor),...map.placements,...map.players].some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=1))fail('Choose a reachable tile away from entrances, fixtures and occupants.');
   const key=String(input.content??'');if(!/^[a-z][a-z0-9_-]{1,79}$/.test(key))fail('Use a stable content/objective target ID.');
   const sprite=npc?.sprite??live.assetRef(input.sprite??''); // Persist validated token/object artwork independently of monster definitions.
   const p={id:'place-'+randomUUID(),zone:input.zone,kind:input.placement_kind,content:key,name:npc?.name??String(input.name??key).slice(0,100),sprite,x,y,lifetime:input.lifetime==='temporary'?'temporary':'persistent',edition:map.edition,created:now()};
   db.prepare('INSERT INTO world_placements VALUES (?,?,?)').run(p.id,p.zone,JSON.stringify(p));
  }
  return view(input.zone);
 }
 function visible(zone,edition,f){return realize(zone,edition,f).map(p=>{const n=live.published().npcs[p.content];return {...p,...(p.kind==='npc'&&n?{name:n.name,sprite:n.sprite,retired:n.retired}:{})};});}
 function tick(){ // NPC walking is deterministic, bounded, and pauses while a conversation holds its placement.
  for(const {zone} of db.prepare('SELECT DISTINCT zone FROM world_placement_maps').all()){
   const map=base.map(zone),row=db.prepare('SELECT * FROM world_placement_maps WHERE zone=? AND edition=?').get(zone,map.edition);if(!row||!map.floor)continue;const placements=JSON.parse(row.body),free=new Set(tiles(map.floor).map(p=>p.x+','+p.y));let changed=false;
   for(const p of placements){const n=live.published().npcs[p.content];if(p.kind!=='npc'||!n?.wander_radius||Math.floor(now()/2000)===(p.step??0))continue;if(db.prepare("SELECT 1 FROM online_conversations WHERE placement=? AND expires>?").get(p.id,now()))continue;p.step=Math.floor(now()/2000);const direction=parseInt(hash([p.id,p.step]).slice(0,2),16)%4,[dx,dy]=[[0,-1],[-1,0],[1,0],[0,1]][direction],x=p.x+dx,y=p.y+dy;
    if(Math.abs(x-p.home.x)+Math.abs(y-p.home.y)<=n.wander_radius&&free.has(x+','+y)&&![...obstacles(map.floor),...placements.filter(v=>v.id!==p.id),...map.players].some(v=>v.x===x&&v.y===y)){p.x=x;p.y=y;}changed=true;
   }if(changed)db.prepare('UPDATE world_placement_maps SET body=? WHERE zone=? AND edition=?').run(JSON.stringify(placements),row.zone,row.edition);
  }
 }
 return {rows,realize,view,act,visible,tick,positions(zone,edition){const row=db.prepare('SELECT body FROM world_placement_maps WHERE zone=? AND edition=?').get(zone,edition);return row?JSON.parse(row.body).filter(p=>p.kind==='npc').map(({x,y})=>({x,y})):[];},catalog:base.catalog};
} // Logical placements and their per-instance positions are persisted separately from terrain.
