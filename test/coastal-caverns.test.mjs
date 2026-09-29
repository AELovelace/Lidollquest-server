import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,cavernsData,coastData,COAST_ZONE,GULCH_ZONE} from '../server/zones.mjs';
import {generateCaverns,addCavernsEntrance,caveReach,CAVERNS_ZONE} from '../server/caverns-generation.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {addCoastFeatures} from '../server/coast-features.mjs';
import {addSideTrail,openExitGaps} from '../server/wilderness-links.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {cavernBreath,cavernStep,cavernDelay} from '../server/caverns-features.mjs';
import {wetGarments,recalculateWetClothing} from '../server/clothing-conditions.mjs';

test('100 cave seeds are deterministic, connected, dry at required landmarks and identical in workers',()=>{
 for(let i=0;i<100;i++){
  const f=generateCaverns(cavernsData,'cave-'+i),reach=caveReach(f),dry=caveReach(f,undefined,true);
  assert.deepEqual(f,generateCaverns(cavernsData,'cave-'+i));assert.ok(validateDesert(f));
  for(const p of [...f.authoredPlacements,...f.exits])assert.ok(dry.has(p.x+','+p.y),p.id??p.zone);
  for(const p of [...f.enemies,...f.chests,...f.pickups])assert.ok(reach.has(p.x+','+p.y));
  assert.equal(new Set(f.authoredPlacements.map(p=>p.x+','+p.y)).size,6);
  assert.ok(f.caveInlets.length>0);assert.equal(f.enemies.filter(p=>p.type==='breakwater_hermit').length,1);
 }
 assert.deepEqual(computeTask('generate',{generator:'caverns',data:cavernsData,edition:'worker'}),generateCaverns(cavernsData,'worker'));
});

test('100 existing Coast seeds gain the exact center entrance without losing trails, entity IDs or claims',()=>{
 for(let i=0;i<100;i++){
  const f=generateDesert(coastData,'coast-center-'+i);addSideTrail(f,{zone_id:GULCH_ZONE,name:'Echo Gulch',side:'left'});addCoastFeatures(f,coastData.config.features);openExitGaps(f);
  const old=structuredClone(f),ids=rows=>rows.map(p=>p.id).sort();assert.equal(addCavernsEntrance(f),true);openExitGaps(f);
  assert.equal(addCavernsEntrance(f),false);assert.ok(validateDesert(f));
  assert.deepEqual(f.exits.slice(0,old.exits.length),old.exits);assert.deepEqual(ids(f.enemies),ids(old.enemies));assert.deepEqual(ids(f.chests),ids(old.chests));assert.deepEqual(ids(f.pickups),ids(old.pickups));
  const door=f.exits.find(p=>p.zone===CAVERNS_ZONE);assert.deepEqual([door.x,door.y],[40,40]);assert.ok(caveReach(f).has('40,40'));assert.deepEqual(f.entries[CAVERNS_ZONE],{x:40,y:41});
  const art=f.decorations.find(p=>p.id==='coastal-caverns-mouth');assert.equal(art.sprite,'sprCoastalCaveEntrance');assert.deepEqual([art.x+1,art.y+2],[door.x,door.y]);
  for(const p of [...f.enemies,...f.chests,...f.pickups])assert.ok(Math.abs(p.x-40)>3||Math.abs(p.y-40)>3);
 }
});

test('phase boundaries, explicit exposure, garment counting and idempotent stat deltas',()=>{
 const config=cavernsData.config,cfg=config.features.cavern_breath;
 assert.deepEqual([0,44999,45000,59999,60000,89999,90000].map(t=>cavernBreath(cfg,t).phase),['ebb','ebb','inhale','inhale','surge','surge','ebb']);
 const f={caveChannels:[[0,1,2]]},p={str:10,def:10,dex:10,int:10,cha:10,wet:5,equipped_pants:'dress',equipped_torso:'dress',equipped_socks:'socks',equipped_shoes:'shoes',equipped_panties:'diaper',equipped_accessory_1:'ring',equipped_accessory_2:'ring',slot_wet_panties:true},s={loadout:{player_info:p}},items={dress:{category:'dress'},diaper:{is_diaper:true}};
 assert.equal(cavernStep(f,s,2,0,config,59999,items),false);assert.equal(cavernStep(f,s,1,0,config,60000,items),true);
 assert.equal(p.slot_wet_pants,undefined);assert.equal(p.wet_clothing_penalty,0);assert.equal(p.wet,6);
 cavernStep(f,s,2,0,config,60000,items);assert.equal(p.slot_wet_torso,true);assert.equal(p.wet_clothing_penalty,1);assert.equal(p.str,9);assert.equal(wetGarments(p,items).length,4);
 cavernStep(f,s,2,0,config,60000,items);assert.equal(p.str,9);assert.equal(p.clothing_water.panties,undefined);
 p.slot_wet_accessory_1=p.slot_wet_accessory_2=true;recalculateWetClothing(p,items);assert.equal(p.wet_clothing_penalty,3);assert.equal(p.str,7);
 p.equipped_accessory_1='';recalculateWetClothing(p,items);assert.equal(p.str,8);
 assert.equal(cavernDelay(f,0,0,config,60000),0);assert.equal(cavernDelay(f,2,0,config,60000),100);assert.equal(cavernDelay(f,2,0,config,90000),0);
 const before=structuredClone(p);for(const busy of ['run','dungeonScene','pendingDefeat']){s[busy]={};assert.equal(cavernStep(f,s,2,0,config,60000,items),false);delete s[busy];}assert.deepEqual(p,before);
});

test('real Coast doorway enters the cavern and returns beside the same center doorway',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-22T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner:'doll',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=500;const r=api.act('',{action,controller:'test',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=r.character;return r;};
 const place=(x,y)=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);if(s.dive)s.dive.position={x,y};db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);db.prepare('UPDATE quest_presence SET x=?,y=?,moved=0 WHERE character_id=?').run(x,y,c.id);};
 try{
  act('create',{name:'Doll'});act('enter',{zone:'littlebig-clockwork',cavern_version:1,content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{level:20,playerHealth:500,playerHealthMax:500},inventory:[],player_spells:[]}});
  place(29,58);assert.equal(act('move',{direction:'south'}).zone,COAST_ZONE);
  place(40,41);let r=act('move',{direction:'north'});assert.equal(r.zone,CAVERNS_ZONE);assert.ok(r.dive.cavernBreath);const cave=r.zones.find(z=>z.id===CAVERNS_ZONE);assert.equal(cave.caveChannels.length,80);
  let crossing;const occupied=[...r.dive.enemies,...r.dive.chests,...r.dive.pickups,...cave.exits];
  for(let y=2;y<78&&!crossing;y++)for(let x=2;x<78&&!crossing;x++)if(cave.caveChannels[y][x]===2&&!cave.walls[y][x-1]&&!occupied.some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<2))crossing={x,y};assert.ok(crossing);
  place(crossing.x-1,crossing.y);const loaded=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state),p=loaded.loadout.player_info;
  for(const slot of ['pants','socks','shoes']){p['equipped_'+slot]='test-'+slot;p['slot_wet_'+slot]=false;}p.wet=0;p.str=10;
  db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(loaded),c.id);time=Math.floor(time/90000)*90000+65000;db.prepare("UPDATE quest_presence SET seen=? WHERE character_id=?").run(time,c.id);
  const request={action:'move',direction:'east',controller:'test',request_id:randomUUID(),character_id:c.id,revision:c.revision,edition:c.dive.edition};
  r=api.act('',request);c=r.character;const confirmed=structuredClone(c.loadout.player_info);assert.equal(confirmed.slot_wet_pants,true);assert.equal(confirmed.wet,1);assert.equal(confirmed.str,9);assert.equal(confirmed.wet_clothing_penalty,1);
  api.act('',request);assert.deepEqual(api.read('',c.id).character.loadout.player_info,confirmed,'A repeated movement receipt cannot apply water twice.');
  const exit=cave.exits[0];place(exit.x,exit.y-1);r=act('move',{direction:'south'});assert.equal(r.zone,COAST_ZONE);assert.deepEqual(r.position,{x:40,y:41});
  const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id),s=JSON.parse(row.state);s.cavernVersion=0;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);
  assert.throws(()=>act('move',{direction:'north'}),/Update your game client/);
 }finally{api.close();db.close();}
});
