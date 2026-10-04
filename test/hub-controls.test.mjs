import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createHubDistricts,districtZone,districtData} from '../server/hub-districts.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';

const HONEYDEW='honeydew-lantern',SEPT=Date.parse('2026-09-24T12:00:00Z'),OCT=Date.parse('2026-10-10T12:00:00Z');
const presence=db=>db.exec('CREATE TABLE quest_presence(zone TEXT,x INTEGER,y INTEGER,moved INTEGER,seen INTEGER)');

test('regenerate rolls a fresh seed this month; lock pins a layout across monthly resets and restarts',()=>{
 const db=new DatabaseSync(':memory:');let now=SEPT;presence(db);
 try{
  let d=createHubDistricts(db,{now:()=>now});const base=d.resolve({id:HONEYDEW});
  assert.equal(base.district.layoutKey,'2026-09:v'+districtData.version);assert.equal(d.status(HONEYDEW).locked,true);assert.equal(d.status(HONEYDEW).resetsAt,null); // Hub maps are static by default.
  assert.equal(d.lock(HONEYDEW,false).layoutKey,base.district.layoutKey); // Unlocked, it follows the calendar on the same layout.
  assert.equal(d.status('princess-rose'),null); // Fixed courtyard: nothing to lock or reroll.
  db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?)').run(HONEYDEW,30,30,1,now);
  const r1=d.regenerate(HONEYDEW);assert.equal(r1.layoutKey,'2026-09-r1:v'+districtData.version);assert.equal(r1.pending,false);
  const after=d.resolve({id:HONEYDEW});assert.notDeepEqual(after.walls,base.walls); // A genuinely new layout.
  assert.deepEqual({...db.prepare('SELECT x,y FROM quest_presence').get()},{x:after.spawn.x,y:after.spawn.y}); // Visitors return to the spawn.
  assert.equal(after.walls[0][24],0); // The north gate still opens onto the Woods.
  assert.equal(d.regenerate(HONEYDEW).layoutKey,'2026-09-r2:v'+districtData.version);
  const r2=structuredClone(d.resolve({id:HONEYDEW}).walls);
  assert.equal(d.lock(HONEYDEW,true).locked,true);
  now=OCT;d=createHubDistricts(db,{now:()=>now}); // Restart after the October reset.
  assert.equal(d.status(HONEYDEW).layoutKey,'2026-09-r2:v'+districtData.version);assert.deepEqual(d.resolve({id:HONEYDEW}).walls,r2);assert.equal(d.status(HONEYDEW).resetsAt,null);
  const other=districtZone(districtData.districts.find(x=>x.hub==='littlebig-clockwork'));assert.equal(d.status(other).layoutKey,'2026-10:v'+districtData.version); // A hub first seen in October pins October's layout.
  assert.equal(d.regenerate(HONEYDEW).layoutKey,'2026-10-r1:v'+districtData.version);assert.equal(d.status(HONEYDEW).locked,true); // Regenerating a locked hub keeps it locked on the new layout.
  now=Date.parse('2026-11-10T12:00:00Z');assert.equal(d.status(HONEYDEW).layoutKey,'2026-10-r1:v'+districtData.version);
  assert.equal(d.lock(HONEYDEW,false).layoutKey,'2026-11:v'+districtData.version); // Unlocking follows the calendar again; old rerolls expire.
 }finally{db.close();}
});

test('a regenerated hub waits for battles in it to finish, and a lock pins what visitors actually see',()=>{
 const db=new DatabaseSync(':memory:');let busy=true;presence(db);
 try{
  const d=createHubDistricts(db,{now:()=>SEPT,beforeActivate:()=>{if(busy)throw Error('Finish existing encounters before changing this district.');}});
  const shown=d.resolve({id:HONEYDEW}).district.layoutKey;d.lock(HONEYDEW,false); // Follow the calendar, so the later lock is a real change.
  const queued=d.regenerate(HONEYDEW);assert.equal(queued.pending,true);assert.equal(queued.layoutKey,shown); // Nobody is yanked out of a fight.
  assert.equal(d.lock(HONEYDEW,true).layoutKey,shown); // Locking now pins the layout on screen, not the waiting one.
  busy=false;assert.equal(d.status(HONEYDEW).layoutKey,shown);
  d.lock(HONEYDEW,false);assert.equal(d.status(HONEYDEW).layoutKey,'2026-09-r1:v'+districtData.version); // Unlocked, the reroll activates now that the battle is over.
 }finally{db.close();}
});

test('the GM world API locks and regenerates hub maps, refuses fixed rooms and unconfirmed rerolls',()=>{
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment});
 const api=createQuestZones(db,{live,now:()=>SEPT,roll:()=>0,grant:()=>({owner:'gm',id:'g',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 try{
  let map=api.world.map(HONEYDEW);assert.equal(map.district.locked,true); // Static by default.
  const act=(action,extra={})=>{map=api.world.map(extra.zone??HONEYDEW);return api.world.act({action,zone:HONEYDEW,edition:map.edition,revision:map.revision,request_id:randomUUID(),...extra});};
  assert.throws(()=>act('world_hub_regenerate'),/Confirm/);
  assert.equal(act('world_hub_regenerate',{confirm_reset:true}).district.layoutKey,'2026-09-r1:v'+districtData.version);
  assert.equal(act('world_hub_lock',{locked:false}).district.locked,false);
  assert.equal(act('world_hub_lock',{locked:true}).district.locked,true);
  assert.equal(api.world.map(HONEYDEW).district.locked,true);
  assert.throws(()=>act('world_hub_lock',{zone:'princess-rose',locked:true}),/monthly hub maps/);
 }finally{api.close();db.close();}
});

test('hub maps are static by default: an untouched hub keeps its layout across monthly resets, and saved "follow the calendar" controls are converted once',()=>{
 const db=new DatabaseSync(':memory:');let now=SEPT;presence(db);
 try{
  db.exec('CREATE TABLE hub_district_controls(zone TEXT PRIMARY KEY,locked INTEGER NOT NULL,pinned TEXT,month TEXT,reroll INTEGER NOT NULL)');db.prepare('INSERT INTO hub_district_controls VALUES (?,0,NULL,NULL,0)').run(HONEYDEW); // Saved before the update.
  let d=createHubDistricts(db,{now:()=>now});const walls=structuredClone(d.resolve({id:HONEYDEW}).walls);assert.equal(d.status(HONEYDEW).locked,true);
  now=OCT;d=createHubDistricts(db,{now:()=>now});assert.equal(d.status(HONEYDEW).layoutKey,'2026-09:v'+districtData.version);assert.deepEqual(d.resolve({id:HONEYDEW}).walls,walls);
  assert.equal(d.regenerate(HONEYDEW).layoutKey,'2026-10-r1:v'+districtData.version);assert.equal(d.status(HONEYDEW).locked,true); // A GM can still roll a new static layout.
  d.lock(HONEYDEW,false);d=createHubDistricts(db,{now:()=>now});assert.equal(d.status(HONEYDEW).locked,false,'unlocking after the update survives a restart');
 }finally{db.close();}
});

test('overworlds are static by default while Dives and full dungeons keep their weekly reroll; saved zone settings are converted once',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE world_content(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,draft TEXT NOT NULL,published TEXT,PRIMARY KEY(kind,id))');
 const saved=JSON.stringify({id:'overworld-tundra',static:false,spawning:true,pool:[]});
 db.prepare('INSERT INTO world_content VALUES (?,?,?,?,?)').run('zone','overworld-tundra',1,saved,saved);db.prepare('INSERT INTO world_content VALUES (?,?,?,?,?)').run('zone','dive-quarters',1,saved,saved); // Saved before the update.
 const build=()=>createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment});let live=build();
 const api=createQuestZones(db,{live,now:()=>SEPT,roll:()=>0,grant:()=>({owner:'gm',id:'g',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 try{
  const zones=live.published().zones,ids=Object.keys(zones);assert.ok(ids.some(id=>id.startsWith('overworld-'))&&ids.some(id=>id.startsWith('dungeon-'))&&ids.some(id=>id.startsWith('dive-')));
  for(const id of ids)assert.equal(zones[id].static,id.startsWith('overworld-'),id);assert.equal(zones['dungeon-spooky-mansion'].static,false); // The Spooky Mansion is a dungeon, so it keeps rerolling.
  assert.equal(api.world.map('overworld-tundra').kind,'dive','a static overworld still offers the GM regenerate control');
  const row=JSON.stringify({...zones['overworld-tundra'],static:false});db.prepare("UPDATE world_content SET draft=?,published=? WHERE id='overworld-tundra'").run(row,row);live=build(); // A GM unticks "static" after the update.
  assert.equal(JSON.parse(db.prepare("SELECT published FROM world_content WHERE id='overworld-tundra'").get().published).static,false,'the conversion runs once');
 }finally{api.close();db.close();}
});
