import {randomUUID} from 'node:crypto';
export const triggerTypes=['flag_entry','objective_entry'];
export function createFlowTriggers(db,{now,list,pin}){
 db.exec(`CREATE TABLE IF NOT EXISTS story_trigger_flags(character_id TEXT,flow TEXT,node TEXT,source TEXT,value INTEGER,sequence INTEGER,PRIMARY KEY(character_id,flow,node));
 CREATE TABLE IF NOT EXISTS story_trigger_events(id TEXT PRIMARY KEY,character_id TEXT,flow TEXT,node TEXT,event TEXT,definition TEXT,revision INTEGER,created INTEGER,started INTEGER DEFAULT 0,UNIQUE(character_id,flow,node,event));
 CREATE INDEX IF NOT EXISTS story_trigger_pending ON story_trigger_events(character_id,started,created);`);
 function observe(c,s){
  for(const f of list().filter(f=>f.published&&!f.published.retired))for(const n of f.published.nodes.filter(n=>triggerTypes.includes(n.type))){
   const enqueue=event=>{if(db.prepare('SELECT 1 FROM story_trigger_events WHERE character_id=? AND flow=? AND node=? AND event=?').get(c.id,f.id,n.id,event))return;const revision=db.prepare('SELECT MAX(revision) AS revision FROM story_flow_history WHERE id=?').get(f.id).revision;db.prepare('INSERT INTO story_trigger_events(id,character_id,flow,node,event,definition,revision,created) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),c.id,f.id,n.id,event,JSON.stringify(pin(f.published)),revision,now());};
   if(n.type==='flag_entry'){
    const old=db.prepare('SELECT * FROM story_trigger_flags WHERE character_id=? AND flow=? AND node=?').get(c.id,f.id,n.id),value=s.fullDungeon?.flags?.[n.flag]?1:0;
    const was=old?.source===n.flag?old.value:0,sequence=(old?.sequence??0)+(value&&!was?1:0);
    if(value&&!was)enqueue('flag:'+n.flag+':'+sequence);
    if(!old||old.source!==n.flag||old.value!==value)db.prepare('INSERT INTO story_trigger_flags VALUES (?,?,?,?,?,?) ON CONFLICT(character_id,flow,node) DO UPDATE SET source=excluded.source,value=excluded.value,sequence=excluded.sequence').run(c.id,f.id,n.id,n.flag,value,sequence);
   }else{
    for(const q of db.prepare('SELECT id,state FROM online_quests WHERE character_id=? AND quest=? ORDER BY created,id').all(c.id,n.ref))if(JSON.parse(q.state).completed_objectives?.[n.stage+':'+n.objective])enqueue('objective:'+q.id+':'+n.stage+':'+n.objective);
   }
  }
 } // Observe while a character is busy too; each accepted quest attempt or false-to-true flag transition has its own durable receipt.
 return {observe,pending:(c,ready=()=>true)=>db.prepare('SELECT * FROM story_trigger_events WHERE character_id=? AND started=0 ORDER BY created,rowid').all(c.id).find(ready),started:id=>db.prepare('UPDATE story_trigger_events SET started=1 WHERE id=?').run(id)}; // A distant location-scoped scene must not block unrelated eligible entries.
} // Queued entries pin their definitions immediately and survive publication, restart and delayed combat.
