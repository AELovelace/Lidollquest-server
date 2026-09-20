import {randomUUID,createHash} from 'node:crypto';
import {weeklyWindow,walkable,inside,seeded,enemyRoams} from './dive-generation.mjs';
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'world_map_conflict'});};
export const mapRevision=record=>createHash('sha256').update(record.edition+JSON.stringify(record.floor)).digest('hex');
export function createDiveControls(db,{now,data,live,current,getFloor,saveFloor,saveCharacter,entry,generate,compute,generator,upgradeFloor}){
 const route=data.config.route,zone=data.config.zone_id??'dive-quarters';let pending=false,closed=false;
 db.exec(`CREATE TABLE IF NOT EXISTS world_routes(route TEXT PRIMARY KEY,week TEXT NOT NULL,edition TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS world_regeneration(id TEXT PRIMARY KEY,route TEXT NOT NULL,week TEXT NOT NULL,source TEXT NOT NULL,edition TEXT NOT NULL,status TEXT NOT NULL,candidate TEXT,error TEXT,created INTEGER NOT NULL);`);
 db.prepare("UPDATE world_regeneration SET status='queued' WHERE route=? AND status='generating'").run(route); // CPU generation is deterministic and safe to resume after restart.
 const activeJob=()=>db.prepare("SELECT * FROM world_regeneration WHERE route=? AND status IN ('queued','generating','draining') ORDER BY created LIMIT 1").get(route);
 const visitors=()=>db.prepare('SELECT * FROM quest_characters').all().filter(c=>JSON.parse(c.state).dive?.route===route);
 const blockers=()=>visitors().filter(c=>{const s=JSON.parse(c.state);return s.run||s.pendingDefeat;}).map(c=>({id:c.id,name:c.name}));
 function view(){const record=current();return {id:zone,kind:'dive',edition:record?.edition,revision:record?mapRevision(record):'',floor:record?.floor??null,players:visitors().map(c=>({id:c.id,name:c.name,...JSON.parse(c.state).dive.position})),job:activeJob(),blockers:blockers()};}
 function check(input){const record=current();if(!record||input.edition!==record.edition||input.revision!==mapRevision(record))fail('The map changed. Refresh before applying this action.');return record;}
 function place(input){const record=check(input),f=record.floor;if(activeJob())fail('Wait for regeneration to finish.');
  if(input.action==='world_remove'){const foe=f.enemies.find(e=>e.id===input.monster);if(!foe||foe.engaged)fail('Choose a monster outside combat.');f.enemies=f.enemies.filter(e=>e!==foe);}
  else {if(f.enemies.filter(e=>e.manual).length>=128)fail('This map already has 128 DM monsters.');const definition=live.published().monsters[input.monster];if(!definition||definition.retired)fail('Choose a published monster.');const {x,y}=input;
   if(!walkable(f,x,y)||[f.entrance,...Object.values(f.entries??{}),...(f.exits??[]),...f.enemies,...f.chests,...(f.pickups??[]),...visitors().map(c=>JSON.parse(c.state).dive.position)].some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<(p===f.entrance?2:1)))fail('Choose a free tile away from entrances and fixtures.');
   f.enemies.push({id:'dm-'+randomUUID(),type:input.monster,definition:structuredClone(definition),x,y,spawn:{x,y},manual:true,respawning:!!input.respawning,roaming:!!input.aggressive,engaged:null,respawnAt:0});
  }saveFloor(record);return view();
 }
 function regenerate(input){const record=check(input);if(activeJob())fail('Regeneration is already queued.');if(input.confirm_reset_rewards!==true)fail('Confirm the treasure and boss reward reset.');const week=weeklyWindow(now()).edition,id=randomUUID();
  db.prepare('INSERT INTO world_regeneration VALUES (?,?,?,?,?,?,NULL,NULL,?)').run(id,route,week,record.edition,week+'-dm-'+id,'queued',now());return view();
 }
 function cancel(input){const job=activeJob();if(!job||input.job!==job.id)fail('Regeneration job changed.');db.prepare("UPDATE world_regeneration SET status='cancelled' WHERE id=?").run(job.id);return view();}
 function tick(){
  const job=activeJob();if(!job||closed)return;
  if(job.week!==weeklyWindow(now()).edition){db.prepare("UPDATE world_regeneration SET status='cancelled',error='Weekly reset superseded this request.' WHERE id=?").run(job.id);return;}
  if(job.status==='queued'&&!pending){pending=true;db.prepare("UPDATE world_regeneration SET status='generating' WHERE id=?").run(job.id);const snapshot=structuredClone(data);
   const work=compute?compute.submit('generate',{generator,data:snapshot,edition:job.edition}):Promise.resolve().then(()=>generate(snapshot,job.edition));
   work.then(floor=>{if(closed)return;for(const foe of floor.enemies)foe.definition=structuredClone(snapshot.enemies[foe.type]);upgradeFloor(floor);db.prepare("UPDATE world_regeneration SET status='draining',candidate=? WHERE id=? AND status='generating'").run(JSON.stringify(floor),job.id);}).catch(()=>{if(!closed)db.prepare("UPDATE world_regeneration SET status='failed',error='Map generation failed; the current map is unchanged.' WHERE id=? AND status='generating'").run(job.id);}).finally(()=>{pending=false;});return;
  }
  if(job.status!=='draining'||blockers().length)return;
  if(current()?.edition!==job.source){db.prepare("UPDATE world_regeneration SET status='cancelled',error='The active map changed.' WHERE id=?").run(job.id);return;}
  const floor=JSON.parse(job.candidate),window=weeklyWindow(now());
  db.prepare('INSERT INTO dive_editions VALUES (?,?,1,?,?,?,?)').run(route,job.edition,window.start,window.ends,JSON.stringify(floor),now());
  db.prepare('INSERT INTO world_routes VALUES (?,?,?) ON CONFLICT(route) DO UPDATE SET week=excluded.week,edition=excluded.edition').run(route,window.edition,job.edition);
  for(const c of visitors()){const s=JSON.parse(c.state),position=entry(floor,s.dive.origin);s.dive.edition=job.edition;s.dive.position={...position};s.dive.safeUntil=now()+10000;delete s.lastResult;s.lastResult=null;saveCharacter(c,s);db.prepare('UPDATE quest_presence SET x=?,y=?,moved=? WHERE character_id=?').run(position.x,position.y,now(),c.id);}
  db.prepare("UPDATE world_regeneration SET status='complete' WHERE id=?").run(job.id);
 } // Called within the simulation transaction: map switch, visitors and fresh claim namespace commit together.
 function reconcile(record){
  const before=record.floor.enemies.length;record.floor.enemies=record.floor.enemies.filter(e=>!(e.manual&&!e.respawning&&e.dead&&!e.engaged));if(before!==record.floor.enemies.length)saveFloor(record);
  if(!live.published().enabled)return;const f=record.floor,t=live.published().zones[zone];if(!t)return;
  const rnd=seeded(record.edition+':content:'+live.published().revision+':'+now()),pool=t.pool,total=pool.reduce((n,e)=>n+e.weight,0),pick=()=>{let n=rnd(total);for(const e of pool){n-=e.weight;if(n<0)return e.enemy_id;}return pool[0]?.enemy_id;};let changed=false;
  for(const foe of f.enemies){
   if(foe.engaged)continue;
   if(foe.dead&&Number.isFinite(foe.diedAt)){const due=foe.diedAt+(foe.id===f.bossId?t.boss_respawn_seconds:t.enemy_respawn_seconds)*1000;if(due!==foe.respawnAt){foe.respawnAt=due;changed=true;}}
   if(foe.dead&&foe.respawnAt<=now()){
    if(foe.manual&&(!foe.respawning||live.published().monsters[foe.type]?.retired)){foe.remove=true;changed=true;continue;}
    if(!foe.manual&&!t.spawning)continue;
    if(!foe.manual)foe.type=foe.id===f.bossId?(t.boss_enemy_id??foe.type):pick()??foe.type;
    foe.definition=structuredClone(data.enemies[foe.type]);foe.dead=false;foe.roaming=foe.manual?foe.roaming:t.roaming&&enemyRoams(data,{type:foe.type});changed=true;
   }
   if(!foe.definition){foe.definition=structuredClone(data.enemies[foe.type]);changed=true;}
  }
  if(f.populationRevision!==live.published().revision){
   if(!t.spawning)for(const e of f.enemies)if(!e.manual&&!e.engaged)e.remove=true;
   if(t.spawning&&t.boss_enemy_id&&!f.enemies.some(e=>e.id===(f.bossId??'world_boss')&&!e.remove)){
    const room=f.rooms.at(-1);let spot=null;
    for(let y=room.y;y<room.y+room.h&&!spot;y++)for(let x=room.x;x<room.x+room.w&&!spot;x++)if(walkable(f,x,y)&&![...f.enemies,...f.chests,...(f.pickups??[]),...(f.exits??[])].some(p=>p.x===x&&p.y===y))spot={x,y};
    if(spot){f.bossId??='world_boss';f.enemies.push({id:f.bossId,type:t.boss_enemy_id,definition:structuredClone(data.enemies[t.boss_enemy_id]),...spot,spawn:{...spot},roaming:false,engaged:null,respawnAt:0});}
   }
   for(const [index,room] of f.rooms.entries()){
    if(index===0||(f.safeRooms??[]).some(r=>inside(r,room.cx??room.x,room.cy??room.y)))continue;
    const residents=f.enemies.filter(e=>!e.manual&&e.id!==f.bossId&&!e.remove&&inside(room,e.spawn.x,e.spawn.y));const wanted=t.spawning?t.enemies_per_room:0;
    let excess=residents.length-wanted;for(const foe of residents)if(excess>0&&!foe.engaged){foe.remove=true;excess--;}
    let missing=wanted-residents.filter(e=>!e.remove).length;
    for(let y=room.y;y<room.y+room.h&&missing>0;y++)for(let x=room.x;x<room.x+room.w&&missing>0;x++)if(walkable(f,x,y)&&![...f.enemies,...f.chests,...(f.pickups??[]),f.entrance,...(f.exits??[]),...visitors().map(c=>JSON.parse(c.state).dive.position)].some(p=>p.x===x&&p.y===y)){
     const type=pick();if(!type)break;const definition=structuredClone(data.enemies[type]);f.enemies.push({id:'spawn-'+randomUUID(),type,definition,x,y,spawn:{x,y},roaming:t.roaming&&enemyRoams(data,{type}),engaged:null,respawnAt:0});missing--;}
   }
   if(!f.enemies.some(e=>e.engaged))f.populationRevision=live.published().revision;changed=true;
  }
  f.enemies=f.enemies.filter(e=>!e.remove);if(changed)saveFloor(record);
 }
 return {view,place,regenerate,cancel,tick,reconcile,draining:()=>activeJob()?.status==='draining',close(){closed=true;}};
}
