const fail=message=>{throw Object.assign(Error(message),{status:409,code:'fast_travel_unavailable'});};
const distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);

export function beaconPosition(floor,blocked){
 const start=floor.spawn??floor.entrance;if(!start)return null;
 const fixtures=[...(floor.fixtures??[]),...(floor.portals??[]),...(floor.exits??[]),...(floor.chests??[]),...(floor.pickups??[]),...(floor.exit?[floor.exit]:[])];
 const occupied=(x,y)=>fixtures.some(f=>x>=f.x&&y>=f.y&&x<f.x+(f.span_w??f.w??1)&&y<f.y+(f.span_h??f.h??1));
 const queue=[start],seen=new Set([start.x+','+start.y]);
 for(let index=0;index<queue.length&&index<1024;index++){
  const p=queue[index];if(distance(p,start)>=2&&!blocked(p.x,p.y)&&!occupied(p.x,p.y))return {x:p.x,y:p.y};
  for(const [dx,dy] of [[0,1],[1,0],[-1,0],[0,-1]]){const x=p.x+dx,y=p.y+dy,key=x+','+y;if(seen.has(key)||blocked(x,y))continue;seen.add(key);queue.push({x,y});}
 }
 return null;
} // Search reachable floor from the entrance, without rerolling maps or blocking a doorway; moving actors never change the marker's location.

export function createFastTravel(db,{now,info,parties,relocate,busy=()=>false}){
 db.exec('CREATE TABLE IF NOT EXISTS quest_fast_travel(character_id TEXT NOT NULL,zone TEXT NOT NULL,visit TEXT NOT NULL,discovered INTEGER NOT NULL,PRIMARY KEY(character_id,zone))');
 db.exec('CREATE TRIGGER IF NOT EXISTS quest_fast_travel_character_delete AFTER DELETE ON quest_characters BEGIN DELETE FROM quest_fast_travel WHERE character_id=OLD.id; END'); // Character deletion removes discovery history without touching account-wide receipts or currency.
 const known=(id,zone)=>db.prepare('SELECT visit FROM quest_fast_travel WHERE character_id=? AND zone=?').get(id,zone);
 const presence=id=>db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(id);
 function marker(state,p,floorOverride){
  const def=p&&info(p.zone);if(!def?.enabled)return null;
  const map=def.map(floorOverride);if(!map||state?.dive?.zone===p.zone&&map.edition!==state.dive.edition)return null;
  const position=beaconPosition(map.floor,(x,y)=>def.blocked(map.floor,x,y));
  return position?{id:'beacon:'+p.zone,zone:p.zone,name:def.name,...position}:null;
 }
 function discover(c,state,p){
  if(!c||!p||p.seen<=now()-30000||known(c.id,p.zone)||!marker(state,p))return;
  const visit=state.dive?Object.fromEntries(['origin','hubOrigin','hubEntryZone','returnZone','gate'].filter(k=>state.dive[k]!==undefined).map(k=>[k,state.dive[k]])):{};
  db.prepare('INSERT OR IGNORE INTO quest_fast_travel VALUES (?,?,?,?)').run(c.id,p.zone,JSON.stringify(visit),now());
 } // Discovery is personal server data; campaign imports and client-supplied destination lists cannot grant it.
 function view(c,state,p,floor){
  const current=marker(state,p,floor),destinations=c?db.prepare('SELECT zone FROM quest_fast_travel WHERE character_id=? ORDER BY discovered,zone').all(c.id).filter(row=>row.zone!==p?.zone&&info(row.zone)?.enabled).map(row=>({zone:row.zone,label:info(row.zone).name})):[];
  return {marker:current,destinations};
 }
 function travel(c,state,p,target){
  const source=marker(state,p);if(!source||distance(p,source)>1)fail('Stand on or beside a fast travel beacon.');
  if(target===p.zone||!info(target)?.enabled)fail('Choose an available linked beacon.');
  if(!known(c.id,target))fail('You have not linked that destination yet.'); // The leader may bring party members who have never visited; their story flags are not granted by travel.
  const group=parties.party(c.id),roster=group?parties.members(c.id):[c];
  if(group&&group.leader!==c.id)fail('The party leader chooses fast travel.');
  for(const other of roster){
   const s=other.id===c.id?state:JSON.parse(other.state),at=other.id===c.id?p:presence(other.id);
   parties.available(other);
   if(s.run||s.pendingDefeat||s.worldTurnDue||s.pendingPurchase||s.duel||s.trade||s.dungeonScene||busy(other))fail(other.name+' must finish their current action before fast travel.'); // npcInteraction is deliberately absent: it is the receipt of the last NPC talk (kept so the client can match request ids) and is never cleared, so blocking on it locked fast travel forever after one chat; an unfinished story conversation is what busy() reports.
   if(!at||at.seen<=now()-30000||at.zone!==p.zone||s.dive?.edition!==state.dive?.edition||distance(at,source)>1)fail('Gather the whole party beside this beacon.');
   const def=info(target);if(def.full&&(s.fullDungeonVersion!==1||s.questVersion!==1)||def.cavern&&s.cavernVersion!==1)fail(other.name+' needs to update the game before travelling there.');
  }
  const destination=marker(state,{zone:target}),record=known(c.id,target); // Resolve coordinates on the current edition, never coordinates saved in a retired map.
  if(!destination)fail('That beacon is unavailable while its area changes.');
  relocate(c,state,target,destination,JSON.parse(record.visit));state.lastResult={log:['You travel to '+info(target).name+'.']};
 } // The caller's command transaction and existing party transfer commit the whole journey and its retry receipt together.
 return {discover,view,travel};
}
