import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {combatData} from '../server/combat.mjs';
import {hubData} from '../server/hubs.mjs';
import {cacheStatements} from '../server/statement-cache.mjs';

// A world like deploy/benchmark-world.mjs builds: live content on, so NPC fixtures pass through fixtureSheet.
function world(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-25T12:00:00Z'),owner='a'; // Fixed clock; owner switches per player.
 const live=createWorldContent(db,{now:()=>time,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment});
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,live,grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const loadout={player_info:{class_id:'fighter',playerHealth:100,playerHealthMax:100,str:5,def:5,dex:5,int:5,cha:5,level:1,xp:0,stat_points:0},inventory:[],player_spells:[],player_mp:0,player_mp_max:0};
 const join=(who,combatVersion)=>{owner=who;time+=1000; // Create a character and enter Honeydew with the given client protocol.
  const c=zones.act('',{action:'create',request_id:randomUUID(),controller:'w',name:who}).character;
  zones.act('',{action:'enter',request_id:randomUUID(),controller:'w',character_id:c.id,revision:zones.read('',c.id).character.revision,zone:'honeydew-lantern',loadout,combat_version:combatVersion,content_version:1,quest_version:1});
  return c.id;};
 const read=(who,id)=>{owner=who;return zones.read('',id);};
 return {db,zones,join,read,close:()=>{zones.close();db.close();}};
}

test('rooms a player is not in get the same stub as the old decorated path, and the current room stays full',()=>{
 const w=world();
 try{
  const modern=w.join('a',3),legacy=w.join('b',2); // combat_version 3 takes the light roomStub path; 2 still decorates every room.
  const fast=w.read('a',modern).zones,slow=w.read('b',legacy).zones;
  assert.deepEqual(fast.map(z=>z.id),slow.map(z=>z.id),'same rooms in the same order');
  const stubKeys=['id','name','kind','parent','theme','width','height','spawn','exit','portals','fixtures','walls','category']; // What a v3 client receives for a room it is not in, in this key order.
  let compared=0;
  for(const [i,room] of fast.entries()){
   if(room.id==='honeydew-lantern'||room.id.startsWith('dive-')||room.id.startsWith('dungeon-')||room.id.startsWith('overworld-'))continue; // The current room and the dungeon definition are not stubs.
   assert.deepEqual(Object.keys(room),stubKeys,room.id+' stub key order (snapshot cache keys hash the JSON text)');
   const old=slow[i],expected={id:old.id,name:old.name,kind:old.kind,parent:old.parent,theme:old.theme,width:old.width,height:old.height,spawn:old.spawn,exit:old.exit,portals:old.portals,fixtures:[],walls:[],category:old.category};
   assert.deepEqual(JSON.parse(JSON.stringify(room)),JSON.parse(JSON.stringify(expected)),room.id+' stub matches the decorated definition');compared++;
  }
  assert.ok(compared>10,'checked the other hubs and their rooms ('+compared+')');
  const here=fast.find(z=>z.id==='honeydew-lantern');
  assert.ok(here.fixtures.length>0&&here.walls.length>0,'the room you stand in keeps its fixtures and walls');
  assert.ok(here.fixtures.some(f=>f.kind==='npc'),'its NPCs are still decorated');
 }finally{w.close();}
});

test('statement cache reuses compiled SQL but forgets it after any schema change',()=>{
 const db=cacheStatements(new DatabaseSync(':memory:'));
 try{
  db.exec('CREATE TABLE t(a)');db.prepare('INSERT INTO t VALUES (?)').run(1);
  assert.equal(db.prepare('SELECT * FROM t'),db.prepare('SELECT * FROM t'),'same SQL text, same compiled statement');
  assert.deepEqual({...db.prepare('SELECT * FROM t').get()},{a:1});
  db.exec('ALTER TABLE t ADD COLUMN b DEFAULT 7'); // A reused statement would keep the old column list.
  assert.deepEqual({...db.prepare('SELECT * FROM t').get()},{a:1,b:7},'exec DDL empties the cache');
  db.prepare('ALTER TABLE t ADD COLUMN c DEFAULT 9').run();
  assert.deepEqual({...db.prepare('SELECT * FROM t').get()},{a:1,b:7,c:9},'prepared DDL empties the cache too');
  assert.notEqual(db.prepare('PRAGMA table_info(t)'),db.prepare('PRAGMA table_info(t)'),'PRAGMA is never cached');
  db.exec('BEGIN');db.prepare('INSERT INTO t(a) VALUES (?)').run(2);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n,1,'transactions still roll back cached inserts');
  assert.throws(()=>db.prepare('SELEC nope'),'a syntax error still throws');assert.ok(![...db.statementCache.keys()].includes('SELEC nope'),'and is not cached');
  assert.equal(cacheStatements(db),db,'installing twice is a no-op');
 }finally{db.close();}
});
