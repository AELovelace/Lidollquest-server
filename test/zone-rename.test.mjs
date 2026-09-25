import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrateZoneIds,currentZoneId,ZONE_RENAMES} from '../server/zone-rename.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {ZONE_CATEGORY} from '../server/zone-categories.mjs';

// 2026-09-25: overworld zone ids moved from dive-<name> to overworld-<name>, campaign full dungeons to dungeon-<name>. Saved worlds hold the old ids in
// plain columns, JSON text and JSON-inside-JSON; one migration moves them all, once, and leaves Dives alone.
test('the zone rename migrates every saved form once and leaves Dives, lookalikes and the audit log alone',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE quest_presence(owner TEXT PRIMARY KEY,zone TEXT NOT NULL,x INTEGER);
  CREATE TABLE quest_chat(seq INTEGER PRIMARY KEY,zone TEXT NOT NULL,text TEXT NOT NULL);
  CREATE TABLE quest_characters(id TEXT PRIMARY KEY,state TEXT NOT NULL);
  CREATE TABLE world_placements(id TEXT PRIMARY KEY,zone TEXT NOT NULL,body TEXT NOT NULL);
  CREATE TABLE gm_audit(id INTEGER PRIMARY KEY,detail TEXT NOT NULL);`);
  db.prepare('INSERT INTO quest_presence VALUES (?,?,?)').run('a','dive-desert',3); // Standing in the desert.
  db.prepare('INSERT INTO quest_presence VALUES (?,?,?)').run('b','dive-quarters',4); // A real Dive keeps its id.
  db.prepare('INSERT INTO quest_presence VALUES (?,?,?)').run('c','dive-high-desert',5); // Contains "desert" but is its own zone.
  db.prepare('INSERT INTO quest_chat VALUES (?,?,?)').run(1,JSON.stringify(['dive-tundra','frostveil-crossing','2026-09-21',1]),'I said dive-tundra out loud'); // Chat area ids are JSON arrays; player text is not an id.
  const state={dive:{zone:'dive-taiga',route:'frostveil-taiga',returnZone:'honeydew-lantern'},note:JSON.stringify({zone:'dive-seafoam-coast'}),campaign:{flags:{'visited:dive-castle-dungeon:boss':true}},last:'dive-auto-nursery'}; // A nested JSON string, a visited-room flag key and a full dungeon, too.
  db.prepare('INSERT INTO quest_characters VALUES (?,?)').run('c1',JSON.stringify(state));
  db.prepare('INSERT INTO world_placements VALUES (?,?,?)').run('p1','dive-farmstead',JSON.stringify({zone:'dive-farmstead',content:'dive-farmstead:scarecrow'})); // Resident keys use zone:id.
  db.prepare('INSERT INTO gm_audit VALUES (?,?)').run(1,'warped to dive-desert');

  assert.ok(migrateZoneIds(db,{log:()=>{}})>0);
  assert.deepEqual(db.prepare('SELECT owner,zone FROM quest_presence ORDER BY owner').all().map(r=>r.zone),['overworld-desert','dive-quarters','overworld-high-desert']);
  const chat=db.prepare('SELECT zone,text FROM quest_chat').get();
  assert.deepEqual(JSON.parse(chat.zone),['overworld-tundra','frostveil-crossing','2026-09-21',1]);assert.equal(chat.text,'I said dive-tundra out loud');
  const saved=JSON.parse(db.prepare('SELECT state FROM quest_characters').get().state);
  assert.equal(saved.dive.zone,'overworld-taiga');assert.equal(saved.dive.route,'frostveil-taiga','route ids never changed');assert.equal(JSON.parse(saved.note).zone,'overworld-seafoam-coast');
  assert.deepEqual(saved.campaign.flags,{'visited:dungeon-castle-dungeon:boss':true});assert.equal(saved.last,'dungeon-auto-nursery');
  const placement=db.prepare('SELECT zone,body FROM world_placements').get();
  assert.equal(placement.zone,'overworld-farmstead');assert.deepEqual(JSON.parse(placement.body),{zone:'overworld-farmstead',content:'overworld-farmstead:scarecrow'});
  assert.equal(db.prepare('SELECT detail FROM gm_audit').get().detail,'warped to dive-desert','history stays as it happened');

  db.prepare('INSERT INTO quest_presence VALUES (?,?,?)').run('d','dive-desert',1); // Written after the migration (an old tool, say).
  assert.equal(migrateZoneIds(db,{log:()=>{}}),0,'runs only once');assert.equal(db.prepare("SELECT zone FROM quest_presence WHERE owner='d'").get().zone,'dive-desert');
 }finally{db.close();}
});

test('old ids alias forward, and every renamed route answers to its new id',()=>{
 assert.equal(Object.keys(ZONE_RENAMES).length,15);
 assert.equal(currentZoneId('dive-emberfall-caldera'),'overworld-emberfall-caldera');assert.equal(currentZoneId('dive-regression-school'),'dungeon-regression-school');assert.equal(currentZoneId('dive-quarters'),'dive-quarters');assert.equal(currentZoneId(undefined),undefined);
 const db=new DatabaseSync(':memory:');const zones=createQuestZones(db,{now:()=>Date.parse('2026-09-25T12:00:00Z'),grant:()=>({owner:'a',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 try{
  const dungeons=zones.read('',null).dungeons,byId=new Map(dungeons.map(d=>[d.id,d.category]));
  for(const id of Object.values(ZONE_RENAMES))assert.equal(byId.get(id),ZONE_CATEGORY.OVERWORLD,id); // Every new id is a live route; full dungeons keep the overworld category.
  assert.ok(dungeons.every(d=>d.category===ZONE_CATEGORY.DIVE?d.id.startsWith('dive-'):/^(overworld|dungeon)-/.test(d.id)),'only instanced Dives keep dive-');
 }finally{zones.close();db.close();}
});
