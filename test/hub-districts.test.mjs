import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {districtData,districtZone,monthlyWindow,generateDistrict,reachableDistrict,districtBlocked} from '../server/hub-districts.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {hubPortals} from '../server/hubs.mjs';

test('monthly reset uses the first at 04:00 Pacific, including daylight-saving months',()=>{
 assert.equal(monthlyWindow(Date.parse('2026-10-01T10:59:59Z')).edition,'2026-09');
 assert.equal(monthlyWindow(Date.parse('2026-10-01T11:00:00Z')).edition,'2026-10');
 assert.equal(monthlyWindow(Date.parse('2026-12-01T11:59:59Z')).edition,'2026-11');
 assert.equal(monthlyWindow(Date.parse('2026-12-01T12:00:00Z')).edition,'2026-12');
 const march=monthlyWindow(Date.parse('2026-03-17T12:00:00Z'));
 assert.equal(march.ends-march.starts,31*86400000-3600000);
});
test('300 monthly maps retain connected native scenery, accessible NPCs and safe exits',()=>{
 for(const def of districtData.districts)for(let n=0;n<100;n++){
  const window={edition:'seed-'+n,ends:n},f=generateDistrict(def,window),seen=reachableDistrict(f),occupied=new Set();
  assert.equal(f.width,50);assert.equal(f.height,50);assert.ok(seen.has('49,25'));assert.equal(districtBlocked(f,48,25),false);
  assert.equal(f.fixtures.filter(p=>p.kind==='npc').length,def.npcs.length+(def.lobby?1:0));assert.ok(f.fixtures.filter(p=>p.kind==='scenery').length>=12); // A lobby town also hosts the Cursebreaker.
  for(const p of f.fixtures){for(let dy=0;dy<p.span_h;dy++)for(let dx=0;dx<p.span_w;dx++){
   const x=p.x+dx,y=p.y+dy,key=x+','+y;assert.equal(f.walls[y][x],0);assert.ok(!occupied.has(key));occupied.add(key);
   assert.equal(Boolean(districtBlocked(f,x,y)),p.solid!==false);
  }if(p.kind==='npc')assert.ok([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen.has((p.x+dx)+','+(p.y+dy))));}
  const solid=new Set(f.fixtures.filter(p=>p.solid!==false).flatMap(p=>Array.from({length:p.span_h},(_,dy)=>Array.from({length:p.span_w},(_,dx)=>(p.x+dx)+','+(p.y+dy))).flat()));
  assert.equal(seen.size,f.walls.flat().filter(v=>v===0).length-solid.size);
  if(n===0)assert.deepEqual(f,generateDistrict(def,window));
 }
});
test('district travel, monthly persistence, talks, shared chat and safe live rollover preserve character state',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-30T12:00:00Z'),api,c;
 const setup=()=>api=createQuestZones(db,{now:()=>now,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:100}),adjust:()=>{throw Error('Safe districts never award coins');}});
 const act=(action,extra={})=>{now+=500;const value=api.act('',{action,controller:'browser',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=value.character;return value;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 try{
  setup();act('create',{name:'Alice'});
  for(const def of districtData.districts){
   const id=districtZone(def);let entered=act('enter',{zone:def.hub,loadout:{player_info:{playerHealth:77},inventory:[{item_id:'adult_food'}]}});
   if(!def.lobby){const gate=hubPortals(def.hub).find(p=>p.target===id);place(gate.side==='left'?1:18,gate.y+1);entered=act('move',{direction:gate.side==='left'?'west':'east'});} // Annex districts open from the left wall (Rose's Tundra gate is its right wall); a lobby town is where you already are.
   const map=entered.zones.find(z=>z.id===id);
   assert.equal(entered.zone,id);assert.equal(map.name,def.name);assert.deepEqual(entered.position,map.spawn);assert.ok(Buffer.byteLength(JSON.stringify(entered))<262144);
   if(def.lobby)assert.ok(act('start').character.run,'the village is still the arena lobby');else assert.throws(()=>act('start'),/arena lobby/);
   if(def.lobby)act('flee');
   assert.throws(()=>act('hub_talk',{fixture:'npc-0'}),/Stand next/);
   const npc=map.fixtures.find(p=>p.id==='npc-0');place(npc.x,npc.y+1);act('hub_talk',{fixture:npc.id});assert.ok(c.hubNotice.includes(npc.line));
   act('chat',{text:'Meeting in '+def.name});const saved=JSON.stringify(map);
   setup();assert.equal(JSON.stringify(act('enter',{zone:def.hub}).zones.find(z=>z.id===id)),saved,'restart retains the materialized monthly edition');
   assert.equal(c.loadout.inventory.length,1);place(48,25);
   if(def.lobby){assert.equal(act('move',{direction:'east',world_step:true}).zone,'dive-desert');assert.deepEqual(act('dive_exit').position,{x:48,y:25});} /* The village's east gap is the Desert gate; leaving Dustbreak lands back beside it. */else assert.equal(act('move',{direction:'east'}).zone,def.hub);
   act('leave');
  }
  const hub='princess-rose',id=hub+'-garden';act('enter',{zone:hub});place(1,13);const old=act('move',{direction:'west'}).zones.find(z=>z.id===id);
  const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id),state=JSON.parse(row.state);state.worldTurnDue={id:'pending-needs'};db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),c.id);
  place(10,10);now=Date.parse('2026-10-01T11:00:00Z');db.prepare('UPDATE quest_presence SET seen=?').run(now);
  const next=api.read('',c.id),map=next.zones.find(z=>z.id===id);assert.equal(map.district.edition,'2026-10');assert.notDeepEqual(map.fixtures,old.fixtures);assert.deepEqual(next.position,{x:48,y:25});assert.equal(next.character.worldTurnDue.id,'pending-needs');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hub_district_editions').get().n,6,'prior month editions are retained');
 }finally{db.close();}
});
