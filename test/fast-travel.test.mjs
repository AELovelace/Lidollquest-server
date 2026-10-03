import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {beaconPosition} from '../server/fast-travel.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');let at=Date.parse('2026-10-03T12:00:00Z'),zones;const ids={};
 const setup=()=>zones=createQuestZones(db,{now:()=>at,roll:()=>0,grant:key=>({id:key,owner:key,client:'lidollquest'}),wallet:()=>({coins:19}),adjust:()=>{throw Error('Travel must not charge currency');},diveOptions:{log:()=>{}}});setup();
 const snap=who=>zones.read(who,ids[who]),input=(who,action,extra={})=>({action,controller:'test',request_id:randomUUID(),character_id:ids[who],revision:snap(who).character.revision,...extra});
 const act=(who,action,extra={})=>{at+=1000;return zones.act(who,input(who,action,extra));};
 const enter=(who,zone)=>act(who,'enter',{zone,combat_version:3,follower_version:1,full_dungeon_version:1,quest_version:1,content_version:1,loadout:{player_info:{level:5,playerHealth:100,playerHealthMax:100,str:10,def:10,dex:10,int:10,cha:10},inventory:[]}});
 function create(who,zone='princess-rose'){ids[who]=zones.act(who,{action:'create',name:who,controller:'test',request_id:randomUUID()}).character.id;return enter(who,zone);}
 const state=who=>JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[who]).state);
 function patch(who,edit){const s=state(who);edit(s);db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),ids[who]);}
 function place(who,position=snap(who).fastTravel.marker){assert.ok(position);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(position.x,position.y,at,ids[who]);patch(who,s=>{if(s.dive)s.dive.position={x:position.x,y:position.y};});}
 return {db,ids,snap,act,input,create,enter,place,patch,state,raw:(who,command)=>zones.act(who,command),restart(){zones.close();setup();},close(){zones.close();db.close();}};
} // Use real entry and travel commands; fixture positioning only skips walking to the marker.

test('beacons require personal discovery and proximity, persist across restart and replay safely',()=>{
 const f=fixture();try{
  const first=f.create('alice');assert.ok(first.fastTravel.marker);assert.deepEqual(first.fastTravel.destinations,[]);
  f.place('alice');assert.throws(()=>f.act('alice','fast_travel',{zone:'honeydew-lantern'}),/not linked/);
  f.patch('alice',s=>{s.fastTravel=['honeydew-lantern'];});assert.throws(()=>f.act('alice','fast_travel',{zone:'honeydew-lantern'}),/not linked/);
  f.act('alice','leave');f.enter('alice','honeydew-lantern');assert.ok(f.snap('alice').fastTravel.destinations.some(d=>d.zone==='princess-rose'));
  f.place('alice',{x:0,y:0});assert.throws(()=>f.act('alice','fast_travel',{zone:'princess-rose'}),/beside/);
  f.place('alice');const command=f.input('alice','fast_travel',{zone:'princess-rose'}),arrived=f.raw('alice',command);assert.equal(arrived.zone,'princess-rose');assert.equal(arrived.coins,19);
  assert.equal(f.raw('alice',command).character.revision,arrived.character.revision);f.restart();assert.ok(f.snap('alice').fastTravel.destinations.some(d=>d.zone==='honeydew-lantern'));
  f.db.prepare('DELETE FROM quest_characters WHERE id=?').run(f.ids.alice);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM quest_fast_travel').get().n,0);
 }finally{f.close();}
});

test('the leader can bring undiscovered party members, while distance and busy actions roll back everyone',()=>{
 const f=fixture();try{
  f.create('alice','honeydew-lantern');f.act('alice','leave');f.enter('alice','princess-rose');f.create('bob');f.place('alice');f.place('bob');
  f.act('alice','party_invite',{member:f.ids.bob});f.act('bob','party_accept',{invitation:f.snap('bob').partyInvitations[0].id});
  assert.ok(!f.snap('bob').fastTravel.destinations.some(d=>d.zone==='honeydew-lantern'));
  assert.throws(()=>f.act('bob','fast_travel',{zone:'honeydew-lantern'}),/not linked|leader/);
  f.place('bob',{x:0,y:0});assert.throws(()=>f.act('alice','fast_travel',{zone:'honeydew-lantern'}),/whole party/);assert.equal(f.snap('alice').zone,'princess-rose');
  f.place('bob');f.patch('bob',s=>{s.worldTurnDue={id:'pending'};});assert.throws(()=>f.act('alice','fast_travel',{zone:'honeydew-lantern'}),/finish/);assert.equal(f.snap('alice').zone,'princess-rose');
  f.patch('bob',s=>delete s.worldTurnDue);f.act('alice','fast_travel',{zone:'honeydew-lantern'});assert.equal(f.snap('bob').zone,'honeydew-lantern');
  assert.ok(f.db.prepare('SELECT 1 FROM quest_fast_travel WHERE character_id=? AND zone=?').get(f.ids.bob,'honeydew-lantern'),'arrival links the passenger destination');
  assert.throws(()=>f.act('bob','fast_travel',{zone:'princess-rose'}),/leader/);
 }finally{f.close();}
});

test('overworld beacon travel preserves inventory and progress, and refuses combat',()=>{
 const f=fixture();try{
  f.create('alice','honeydew-lantern');f.act('alice','dive_enter',{zone:'overworld-desert'});const start=f.snap('alice');assert.ok(start.fastTravel.marker);
  f.place('alice');f.patch('alice',s=>{s.run={kind:'dive',phase:'fight'};});assert.throws(()=>f.act('alice','fast_travel',{zone:'honeydew-lantern'}),/finish/i);f.patch('alice',s=>{s.run=null;});
  const loadout=f.state('alice').loadout;f.act('alice','fast_travel',{zone:'honeydew-lantern'});f.place('alice');f.act('alice','fast_travel',{zone:'overworld-desert'});
  const returned=f.snap('alice');assert.equal(returned.zone,'overworld-desert');assert.equal(returned.dive.edition,start.dive.edition);assert.deepEqual(f.state('alice').loadout,loadout);assert.equal(returned.dive.claimed,start.dive.claimed);
  assert.ok(Math.abs(returned.position.x-returned.fastTravel.marker.x)+Math.abs(returned.position.y-returned.fastTravel.marker.y)<=1);
 }finally{f.close();}
});

test('beacon placement follows reachable floor and avoids exits and fixtures',()=>{
 const floor={width:7,height:7,spawn:{x:3,y:3},fixtures:[{x:3,y:5}],exits:[{x:4,y:4}]},blocked=(x,y)=>x<1||y<1||x>5||y>5;
 const p=beaconPosition(floor,blocked);assert.ok(p);assert.notDeepEqual(p,floor.fixtures[0]);assert.notDeepEqual(p,floor.exits[0]);assert.ok(!blocked(p.x,p.y));
 assert.equal(beaconPosition(floor,()=>true),null);
});

test('overworld snapshots and travel agree when treasure occupies the first beacon candidate',()=>{
 const f=fixture();try{
  f.create('alice','honeydew-lantern');f.act('alice','dive_enter',{zone:'overworld-desert'});const before=f.snap('alice'),visit=f.state('alice').dive;
  const floor=JSON.parse(f.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=? AND depth=1').get(visit.route,visit.edition).content);
  assert.ok(floor.chests.length);Object.assign(floor.chests[0],{x:before.fastTravel.marker.x,y:before.fastTravel.marker.y}); // Relocate real treasure so wilderness loot maintenance keeps its supported metadata.
  f.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=? AND depth=1').run(JSON.stringify(floor),visit.route,visit.edition);
  const after=f.snap('alice');assert.notDeepEqual(after.fastTravel.marker,before.fastTravel.marker,'The visible marker avoids the same treasure as the authoritative command');
  f.place('alice');assert.equal(f.act('alice','fast_travel',{zone:'honeydew-lantern'}).zone,'honeydew-lantern');
 }finally{f.close();}
});

test('Auto-Nursery has no beacon even after Rosalind is defeated',()=>{
 const f=fixture();try{
  f.create('alice','utopia-arcanum');const portal=f.snap('alice').zones.find(z=>z.id==='utopia-arcanum').portals.find(p=>p.target==='dungeon-auto-nursery');assert.ok(portal);f.place('alice',portal);
  f.act('alice','dive_enter',{zone:'dungeon-auto-nursery'});assert.equal(f.snap('alice').fastTravel.marker,null);
  assert.equal(f.db.prepare('SELECT 1 FROM quest_fast_travel WHERE character_id=? AND zone=?').get(f.ids.alice,'dungeon-auto-nursery'),undefined);
  f.patch('alice',s=>{s.fullDungeon??={flags:{}};s.fullDungeon.flags.matron_rosalind_defeated=true;});assert.equal(f.snap('alice').fastTravel.marker,null);
  assert.equal(f.db.prepare('SELECT 1 FROM quest_fast_travel WHERE character_id=? AND zone=?').get(f.ids.alice,'dungeon-auto-nursery'),undefined);
 }finally{f.close();}
});

test('dungeons and dives have no beacons and old saved links cannot be used',()=>{
 const f=fixture();try{
  f.create('alice');f.act('alice','dive_enter',{zone:'dive-quarters'});
  assert.equal(f.snap('alice').fastTravel.marker,null);
  assert.equal(f.db.prepare('SELECT 1 FROM quest_fast_travel WHERE character_id=? AND zone=?').get(f.ids.alice,'dive-quarters'),undefined);
  assert.throws(()=>f.act('alice','fast_travel',{zone:'princess-rose'}),/beside/);
  f.act('alice','dive_exit',{edition:f.snap('alice').dive.edition});f.place('alice');
  const removed=['dive-quarters','dive-forest','dungeon-castle-dungeon','dungeon-auto-nursery','dungeon-coastal-caverns','dungeon-regression-school','dungeon-regression-hospital','overworld-spooky-mansion'];
  for(const zone of removed)f.db.prepare('INSERT OR IGNORE INTO quest_fast_travel VALUES (?,?,?,?)').run(f.ids.alice,zone,'{}',1);
  assert.ok(f.snap('alice').fastTravel.destinations.every(d=>!removed.includes(d.zone)),'Retired destinations disappear even when previously discovered');
  for(const zone of removed)assert.throws(()=>f.act('alice','fast_travel',{zone}),/available linked beacon/);
  assert.equal(f.snap('alice').zone,'princess-rose');
 }finally{f.close();}
});
test('talking to an NPC earlier never blocks fast travel (the talk receipt is not an unfinished action)',()=>{
 const f=fixture();try{
  f.create('alice');f.act('alice','leave');f.enter('alice','honeydew-lantern'); // Link both lobbies by visiting them.
  f.patch('alice',s=>{s.npcInteraction={request_id:randomUUID(),npc:'honeydew-lantern:npc-innkeeper',source:'default'};}); // What hub_talk leaves behind for the client to match request ids against; it is never cleared.
  f.place('alice');const arrived=f.act('alice','fast_travel',{zone:'princess-rose'});assert.equal(arrived.zone,'princess-rose');
  assert.ok(f.state('alice').npcInteraction); // The receipt stays for the client; travel only stops caring about it.
  f.patch('alice',s=>{s.trade='open-trade';});f.place('alice');assert.throws(()=>f.act('alice','fast_travel',{zone:'honeydew-lantern'}),/finish their current action/); // Real unfinished actions still block.
 }finally{f.close();}
});
