import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {districtData,generateDistrict,createHubDistricts,monthlyWindow,districtBlocked} from '../server/hub-districts.mjs';
import {moveDistrictResidents} from '../server/district-residents.mjs';
import {createQuestZones} from '../server/zones.mjs';

test('residents stroll safely without moving scenery, blocking routes or changing the original layout seed',()=>{
 for(const def of districtData.districts)for(let seed=0;seed<20;seed++){
  const window={edition:'residents-'+seed,ends:0};
  const old=generateDistrict({...def,npcs:def.npcs.filter(n=>!n.roaming)},window,{...districtData,resident_version:0});
  const floor=generateDistrict(def,window),fixed=structuredClone(floor.fixtures.filter(n=>!n.roaming)),original=structuredClone(floor.fixtures.filter(n=>n.roaming));
  assert.deepEqual(floor.walls,old.walls);assert.deepEqual(fixed,old.fixtures);
  assert.equal(original.length,4);
  let moves=0;
  for(let tick=1;tick<=100;tick++){
   if(moveDistrictResidents(floor,[floor.spawn],tick*3000,districtData))moves++;
   const residents=floor.fixtures.filter(n=>n.roaming);
   assert.equal(new Set(residents.map(n=>n.x+','+n.y)).size,4);
   for(const n of residents){assert.equal(n.solid,false);assert.equal(districtBlocked(floor,n.x,n.y),false);assert.ok(Math.abs(n.x-n.home.x)+Math.abs(n.y-n.home.y)<=districtData.roam_radius);assert.ok(!(n.x>=42&&n.y>=22&&n.y<=27));}
  }
  assert.ok(moves>25);assert.deepEqual(floor.fixtures.filter(n=>!n.roaming),fixed);
  const npc=floor.fixtures.find(n=>n.roaming),position={x:npc.x,y:npc.y};
  for(let tick=101;tick<108;tick++)moveDistrictResidents(floor,[position],tick*3000,districtData);
  assert.deepEqual({x:npc.x,y:npc.y},position,'resident waits while a player is close enough to talk');
 }
});

test('resident-only upgrades preserve live maps and visitors; movement persists across restart with no catch-up',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-17T12:00:00Z');
 db.exec('CREATE TABLE quest_presence(zone TEXT,x INTEGER,y INTEGER,moved INTEGER,seen INTEGER)');
 try{
  const oldData={...structuredClone(districtData),resident_version:0},prior=createHubDistricts(db,{now:()=>now,data:oldData});
  const originals=new Map();
  for(const def of districtData.districts){const id=def.hub+'-garden';originals.set(id,structuredClone(prior.resolve({id})));db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?)').run(id,47,25,123,now);}
  let live=createHubDistricts(db,{now:()=>now});
  for(const [id,old] of originals){const next=live.resolve({id});assert.deepEqual(next.walls,old.walls);assert.deepEqual(next.fixtures.filter(n=>!n.roaming),old.fixtures);assert.equal(next.district.layoutKey,old.district.layoutKey);assert.deepEqual({...db.prepare('SELECT x,y,moved FROM quest_presence WHERE zone=?').get(id)},{x:47,y:25,moved:123});}
  for(let n=0;n<12;n++){now+=3000;db.prepare('UPDATE quest_presence SET seen=?').run(now);live.tick();}
  const saved=[...originals.keys()].map(id=>[id,structuredClone(live.resolve({id}).fixtures)]);
  live=createHubDistricts(db,{now:()=>now});
  for(const [id,fixtures] of saved)assert.deepEqual(live.resolve({id}).fixtures,fixtures);
  now+=3600000;live.tick(); // Expired/empty districts do not wander while nobody is present.
  for(const [id,fixtures] of saved)assert.deepEqual(live.resolve({id}).fixtures,fixtures);
  db.prepare('UPDATE quest_presence SET seen=?').run(now);live.tick();
  for(const [id,fixtures] of saved)for(const npc of live.resolve({id}).fixtures.filter(n=>n.roaming)){const before=fixtures.find(n=>n.id===npc.id);assert.ok(Math.abs(npc.x-before.x)+Math.abs(npc.y-before.y)<=1);}
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_district_editions').get().n,3);
 }finally{db.close();}
});

test('two visitors share clock-driven positions and can talk privately without modifying needs or inventory',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-17T12:00:00Z');const chars={};
 const api=createQuestZones(db,{now:()=>now,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{throw Error('Residents cannot award coins');}});
 const act=(owner,action,extra={})=>{const c=chars[owner],s=api.act(owner,{action,character_id:c?.id,revision:c?.revision,controller:owner,request_id:randomUUID(),...extra});chars[owner]=s.character;return s;};
 const map=s=>s.zones.find(z=>z.id===s.zone);
 try{
  for(const owner of ['alice','bob']){act(owner,'create',{name:owner});act(owner,'enter',{zone:'princess-rose-garden',loadout:{player_info:{playerHealth:40},inventory:[{item_id:'adult_food'}]}});}
  const before=structuredClone(map(api.read('alice',chars.alice.id)).fixtures);
  for(let n=0;n<4;n++){now+=3000;api.tick();}
  const a=api.read('alice',chars.alice.id),b=api.read('bob',chars.bob.id),npc=map(a).fixtures.find(n=>n.roaming);
  assert.deepEqual(map(a).fixtures,map(b).fixtures);assert.notDeepEqual(map(a).fixtures,before);
  assert.ok(Buffer.byteLength(JSON.stringify(a))<262144);
  assert.throws(()=>act('alice','hub_talk',{fixture:npc.id}),/Stand next/);
  db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(npc.x,npc.y,chars.alice.id);
  const loadout=structuredClone(chars.alice.loadout);now+=3000;api.tick();
  const talked=act('alice','hub_talk',{fixture:npc.id});assert.ok(talked.character.hubNotice.includes(npc.line));assert.deepEqual(talked.character.loadout,loadout);assert.equal(talked.chat.length,0);
  assert.equal(api.read('bob',chars.bob.id).character.hubNotice,undefined);
 }finally{db.close();}
});
