// Story orbs online: GM-authored narrative orbs (world-content kind 'orb') placed on any zone's map
// through the world placement system (kind 'orb'). Mirrors the campaign's story orbs:
//  - a non-repeatable orb disappears for a character once read (the campaign's once_only),
//  - an orb that `requires` another stays dark (dormant) until that one is read (the campaign's ordered sequences),
//  - reading is purely narrative: pages are visual only, so an orb never grants items, stats or quests.
// A read also reports an 'interact' quest event targeting the orb's ID, so quests can say "read the orb".
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status,code:'orb_unavailable'});};
const SCENE_TTL=10*60*1000; // An unread scene stays offered for ten minutes, then drops out of snapshots.

export function createOrbs(db,{live,now=Date.now,placements,world,event=()=>{}}){
 db.exec(`CREATE TABLE IF NOT EXISTS orb_reads(character_id TEXT NOT NULL,orb TEXT NOT NULL,first INTEGER NOT NULL,last INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(character_id,orb));`);
 const readQuery=db.prepare('SELECT orb FROM orb_reads WHERE character_id=?');
 const reads=c=>new Set(readQuery.all(c.id).map(r=>r.orb)); // Every orb this character has read at least once.
 function status(def,seen){ // 'spent' (read once, not repeatable), 'dormant' (waiting on another orb) or 'lit'.
  if(!def.repeatable&&seen.has(def.id))return 'spent';
  if(def.requires&&!seen.has(def.requires))return 'dormant';
  return 'lit';
 }
 function decorate(c,rows){ // Shape the shared placement rows for one character: spent orbs vanish, dormant ones draw dim, retired stories hide.
  const orbs=live.published().orbs??{},seen=c?reads(c):new Set();
  return rows.flatMap(p=>{
   if(p.kind!=='orb')return [p];
   const def=orbs[p.content];if(!def||def.retired)return []; // A retired story leaves its pin in the editor but not in the world.
   const state=status(def,seen);if(state==='spent')return [];
   return [{...p,name:def.title,colour:def.colour,dormant:state==='dormant'}];
  });
 }
 function position(c,s){const p=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);if(!p)return null;return {...p,edition:s.dive?.edition??world.map(p.zone).edition};} // Same instance rule as online quests.
 function act(c,s,input){
  if(input.action==='orb_close'){if(s.orbScene?.id===input.scene)delete s.orbScene;return;} // The client has the pages; stop resending them.
  if(input.action!=='orb_read')fail('Unknown orb action.',400);
  if(s.run||s.pendingDefeat||s.worldTurnDue||s.pendingPurchase)fail('Finish the current action before reading.');
  if(typeof input.placement!=='string'||typeof input.edition!=='string')fail('Refresh the map before reading.',400);
  const p=position(c,s);if(!p||p.seen<=now()-30000)fail('Enter an online zone first.');
  if(p.edition!==input.edition)fail('This map has changed.');
  const n=placements.view(p.zone).placements.find(v=>v.id===input.placement&&v.kind==='orb');
  if(!n||Math.abs(n.x-p.x)+Math.abs(n.y-p.y)>1)fail('Stand on or beside the orb.');
  const def=live.published().orbs?.[n.content];if(!def||def.retired)fail('This orb has faded.');
  const state=status(def,reads(c));
  if(state==='spent')fail('You already know this story.');
  if(state==='dormant')fail('The orb is still dark. Another story comes first.');
  db.prepare('INSERT INTO orb_reads VALUES (?,?,?,?,1) ON CONFLICT(character_id,orb) DO UPDATE SET last=excluded.last,count=count+1').run(c.id,def.id,now(),now());
  s.orbScene={id:input.request_id,orb:def.id,at:now()}; // Only the reference is saved on the character; pages are read from the published story.
  event(c,s,{id:'orb:'+input.request_id,type:'interact',target:def.id,zone:p.zone}); // Quests may target an orb's ID with an ordinary interact objective.
 }
 function scene(s){ // The scene waiting to be played, resolved against the published story.
  const pending=s?.orbScene;if(!pending||pending.at<=now()-SCENE_TTL)return null;
  const def=live.published().orbs?.[pending.orb];if(!def)return null;
  return {id:pending.id,orb:def.id,title:def.title,colour:def.colour,bg:def.bg_color,speed:def.type_speed,pages:def.pages};
 }
 const any=()=>Object.values(live.published().orbs??{}).some(o=>!o.retired); // Snapshots only carry world placements while something is published.
 return {act,decorate,scene,any,reads};
}
