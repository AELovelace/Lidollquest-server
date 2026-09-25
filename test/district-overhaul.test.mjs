import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {districtData,generateDistrict,createHubDistricts,monthlyWindow,districtZone} from '../server/hub-districts.mjs';

test('districts express distinct host layouts rather than the old universal open grid',()=>{
 const signatures=new Set();
 for(const d of districtData.districts)for(let n=0;n<12;n++){
  const f=generateDistrict(d,{edition:'grammar-'+n,ends:0}),solid=f.walls.slice(1,49).flatMap(row=>row.slice(1,49)).filter(Boolean).length;
  assert.ok(solid>200,'landmarks are separated by real walls, woodland or city blocks');
  assert.ok(f.rooms.length>=3);assert.ok(f.district.routeCount>=4);
  signatures.add(JSON.stringify(f.walls));
  if(d.style==='castle')assert.ok(new Set(f.rooms.map(r=>r.w+','+r.h)).size>=3,'castle partitions produce varied room sizes');
  if(d.style==='market'){
   assert.ok(f.rooms.length>=4,'village clearings branch away from the main square');
   assert.equal(f.floors[Math.floor(f.height/2)][Math.floor(f.width/2)],8,'central flagstone square survives road carving');
  }
  if(d.style==='nightlife'){
   assert.ok(f.blocks.some(b=>b.kind==='city_block'));assert.ok(f.rooms.some(r=>r.kind==='park'));
   assert.ok(f.axes.x.includes(Math.floor(f.width/2))&&f.axes.y.includes(Math.floor(f.height/2))); // The boulevards cross at the centre of whatever size the district is (LittleBigCity is 60x60).
  }
 }
 assert.equal(signatures.size,districtData.districts.length*12,'different months retain different layouts');
});

test('deploying a layout version archives existing maps and safely returns visitors without waiting for another month',()=>{
 const db=new DatabaseSync(':memory:'),now=Date.parse('2026-09-17T12:00:00Z'),data=structuredClone(districtData),window=monthlyWindow(now);
 db.exec('CREATE TABLE quest_presence(zone TEXT,x INTEGER,y INTEGER,moved INTEGER)');
 try{
  const districts=createHubDistricts(db,{now:()=>now,data});
  for(const d of data.districts){
   const id=districtZone(d);districts.resolve({id});
   db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?)').run(id,25,25,0);
  }
  const originals=db.prepare('SELECT * FROM hub_district_editions ORDER BY zone').all();
  data.version++;
  for(const d of data.districts){
   const id=districtZone(d),map=districts.resolve({id});
   assert.equal(map.district.edition,window.edition);assert.equal(map.district.layoutVersion,data.version);
   assert.deepEqual({...db.prepare('SELECT x,y FROM quest_presence WHERE zone=?').get(id)},map.spawn); // Annex districts return visitors to the east entrance; the village to its square.
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_district_editions').get().n,districtData.districts.length*2); // One archived and one current map per district.
  for(const row of originals)assert.equal(db.prepare('SELECT content FROM hub_district_editions WHERE zone=? AND edition=?').get(row.zone,row.edition).content,row.content);
  const restarted=createHubDistricts(db,{now:()=>now,data});
  for(const d of data.districts){const id=districtZone(d);db.prepare('UPDATE quest_presence SET x=45,y=25 WHERE zone=?').run(id);restarted.resolve({id});assert.equal(db.prepare('SELECT x FROM quest_presence WHERE zone=?').get(id).x,45,'restart does not repeatedly return visitors to the entrance');}
 }finally{db.close();}
});
