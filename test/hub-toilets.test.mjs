import test from 'node:test';
import assert from 'node:assert/strict';
import {villageRooms,hubCatalog,hubRooms} from '../server/hubs.mjs';
import {validateCourtyard} from '../server/hub-garden.mjs';
import {generateDistrict,districtData,addOuthouses,reachableDistrict,districtBlocked} from '../server/hub-districts.mjs';
import {entryStrip,westStrip,northStrip,southStrip} from '../server/district-layouts.mjs';

const toilets=room=>room.fixtures.filter(f=>f.kind==='toilet');
const besideFree=(room,f,solid)=>{for(let dy=0;dy<(f.span_h??1);dy++)for(const dx of [-1,f.span_w??1])if(!solid(f.x+dx,f.y+dy))return true;return !solid(f.x,f.y-1)||!solid(f.x,f.y+(f.span_h??1));}; // Somewhere to stand beside it.

test('the Honeydew Inn has a toilet in the little closet off the hall',()=>{
 const inn=villageRooms.beds,[loo]=toilets(inn);
 assert.deepEqual([loo.id,loo.style,loo.sprite,loo.x,loo.y],['inn-toilet','porcelain','sprToilet',18,12]);
 assert.equal(inn.walls[12][17],0);assert.ok(validateCourtyard(inn,[])); // The closet tile beside it is floor, and the whole Inn stays reachable.
});

test("Rose Court's garden has an outhouse tucked in its south-east corner",()=>{
 const rose=hubCatalog.find(h=>h.id==='princess-rose'),[out]=toilets(rose);
 assert.deepEqual([out.id,out.style,out.sprite,out.x,out.y,out.span_w,out.span_h],['garden-outhouse','outhouse','sprPlainsEnvOuthouse',18,16,1,2]);
 assert.equal(rose.walls[16][17],0);assert.equal(rose.walls[17][17],0); // The lawn in front of its door.
});

test('The Castle dormitory has a toilet in every new month, and saved months gain it in place',()=>{
 const castle=districtData.districts.find(d=>d.hub==='princess-rose');
 for(const month of ['2026-09','2026-12','2027-03']){
  const f=generateDistrict(castle,{edition:month,ends:0},districtData),loo=f.fixtures.find(x=>x.id==='dormitory-toilet');
  assert.deepEqual([loo.kind,loo.x,loo.y],['toilet',castle.dormitory.x,castle.dormitory.y]);
  assert.ok(besideFree(f,loo,(x,y)=>districtBlocked(f,x,y)));
 }
});

test('Honeydew Village gets three spread-out outhouses each month, off the square, gates and doorsteps, never sealing the town',()=>{
 const honey=districtData.districts.find(d=>d.hub==='honeydew-lantern'),W=50,H=50;
 const strips=[{...entryStrip(W,H),w:W},westStrip(H),northStrip(W),southStrip(W,H)];
 for(const month of ['2026-09','2026-10','2026-11','2026-12','2027-01','2027-02']){
  const f=generateDistrict(honey,{edition:month,ends:0},districtData),outs=toilets(f);
  assert.equal(outs.length,3);assert.ok(outs.every(o=>o.style==='outhouse'&&o.span_h===2));
  for(const a of outs)for(const b of outs)if(a!==b)assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>=14); // Spread round the town.
  for(const o of outs)for(const c of [{x:o.x,y:o.y},{x:o.x,y:o.y+1}])assert.ok(!strips.some(s=>c.x>=s.x&&c.x<s.x+s.w&&c.y>=s.y&&c.y<s.y+s.h));
  const seen=reachableDistrict(f),solid=new Set(f.fixtures.filter(p=>p.solid!==false).flatMap(p=>Array.from({length:(p.span_w??1)*(p.span_h??1)},(_,i)=>(p.x+i%(p.span_w??1))+','+(p.y+Math.floor(i/(p.span_w??1))))));
  assert.equal(seen.size,f.walls.flat().filter(v=>v===0).length-solid.size); // Every open tile is still reachable.
  for(const o of outs)assert.ok([-1,1].some(dx=>[0,1].some(dy=>seen.has((o.x+dx)+','+(o.y+dy))))); // Its door side can be reached.
  const saved={...f,fixtures:f.fixtures.filter(x=>x.kind!=='toilet')};
  assert.equal(addOuthouses(saved,honey,districtData),true);assert.equal(toilets(saved).length,3);assert.equal(addOuthouses(saved,honey,districtData),false); // Saved months upgrade once.
 }
 const city=districtData.districts.find(d=>d.hub==='littlebig-clockwork');
 assert.equal(toilets(generateDistrict(city,{edition:'2026-09',ends:0},districtData)).length,0); // LittleBigCity's toilet lives in its Inn instead.
});

test('the LittleBig Inn is a remodelled boutique hotel: themed bedrooms, lobby, lounge and a washroom toilet',()=>{
 const inn=hubRooms.find(r=>r.id==='littlebig-clockwork-beds');
 assert.equal(inn.width,24);assert.equal(inn.height,16);assert.equal(inn.authored,true);assert.equal(inn.tilesets.floor,'tileLBCInterior');
 assert.equal(inn.fixtures.filter(f=>f.kind==='bed').length,6);
 for(const kind of ['npc','cauldron','toilet'])assert.ok(inn.fixtures.some(f=>f.kind===kind),kind);
 assert.ok(new Set(inn.floors.flat().filter(Boolean)).size>=6); // Different flooring per room, not one rectangle.
 for(let y=0;y<inn.height;y++)for(let x=0;x<inn.width;x++){if(!inn.walls[y][x])assert.ok(inn.floors[y][x]>0,'floor at '+x+','+y);else assert.ok(inn.wallTiles[y][x]>0);} // No holes in the paint.
 const interior=inn.walls.slice(1,-1).some(row=>row.slice(1,-1).some(Boolean));assert.ok(interior); // It has inner walls now.
 assert.ok(validateCourtyard(inn,[]));
 const solid=(x,y)=>inn.walls[y]?.[x]!==0||inn.fixtures.some(f=>f.solid!==false&&x>=f.x&&y>=f.y&&x<f.x+f.span_w&&y<f.y+f.span_h);
 for(const f of inn.fixtures.filter(f=>f.kind!=='scenery'))assert.ok(besideFree(inn,f,solid),f.id+' can be reached');
});
