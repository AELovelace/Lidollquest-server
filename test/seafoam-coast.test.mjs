import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createQuestZones,coastData,COAST_ZONE,autumnalPlainsData,AUTUMNAL_PLAINS_ZONE,WILDERNESS_LINKS} from '../server/zones.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {addSideTrail,openExitGaps} from '../server/wilderness-links.mjs';
import {addCoastFeatures,tideAt,isTideFlat} from '../server/coast-features.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {wildernessGates,hubPortals} from '../server/hubs.mjs';
import {routeLevelFor} from '../server/scaling.mjs';

const CITY='littlebig-clockwork',FEATURES=coastData.config.features;
const upgraded=edition=>{const f=generateDesert(coastData,edition);addSideTrail(f,{zone_id:AUTUMNAL_PLAINS_ZONE,name:'Autumnal Plains',side:'left'});addCoastFeatures(f,FEATURES);openExitGaps(f);return f;}; // What the live engine's upgradeFloor does.

test('40 Seafoam Coast editions: sea to the east, beaches and rocks inland, LittleBigCity north and the Plains west',()=>{
 for(let n=0;n<40;n++){
  const raw=generateDesert(coastData,'coast-'+n);assert.deepEqual(raw,generateDesert(coastData,'coast-'+n));assert.ok(validateDesert(raw));
  assert.equal(raw.theme,'coast');assert.equal(raw.shore.length,80);
  assert.deepEqual(raw.exits,[{x:40,y:1,zone:CITY,name:'LittleBigCity'}]);
  for(let y=1;y<79;y++){assert.ok(raw.shore[y]>=58&&raw.shore[y]<=70);for(let x=raw.shore[y];x<79;x++)assert.equal(raw.walls[y][x],1);} // Open sea east of the wavy shoreline.
  assert.ok([...raw.enemies,...raw.chests,...raw.pickups].every(p=>p.x<raw.shore[p.y])); // Nothing out at sea.
  const f=upgraded('coast-'+n);assert.ok(validateDesert(f));
  assert.deepEqual(f.exits.map(e=>[e.zone,e.side,e.style]),[[CITY,'top','gap'],[AUTUMNAL_PLAINS_ZONE,'left','gap']]);
  const huts=f.decorations.filter(d=>d.toilet);assert.equal(huts.length,FEATURES.huts);
  for(const h of huts){assert.equal(h.style,'cabana');for(let dy=0;dy<h.span_h;dy++)for(let dx=0;dx<h.span_w;dx++)assert.ok(!isTideFlat({...f,props:f.props.map(r=>r.map(()=>0))},h.x+dx,h.y+dy,FEATURES.tide.reach));} // Huts stand on dry sand.
  for(const a of huts)for(const b of huts)if(a!==b)assert.ok(Math.abs(a.y-b.y)>=10); // Spread along the beach.
  assert.equal(f.exposed,true);assert.ok(f.cover.every(r=>r.length===80&&/^[02]+$/.test(r))); // Public beach: shelter only beside huts and scenery.
  assert.equal(addCoastFeatures(f,FEATURES),false); // Idempotent.
 }
 assert.deepEqual(computeTask('generate',{generator:'desert',data:coastData,edition:'2026-09-21'}),generateDesert(coastData,'2026-09-21')); // Worker parity.
});

test('tides are high half the time on a schedule everyone shares',()=>{
 let high=0;for(let m=0;m<24*60;m++){const t=tideAt('seafoam-coast',FEATURES.tide,m*60000);assert.deepEqual(t,tideAt('seafoam-coast',FEATURES.tide,m*60000));assert.ok(t.until>m*60000);if(t.high)high++;}
 assert.equal(high,12*60);assert.deepEqual(tideAt('x',null,0),{high:false,until:0});
});

test('the Plains open an east trail to the coast; LittleBigCity opens a south gate onto it; the band sits between the Plains and the Desert',()=>{
 assert.ok(WILDERNESS_LINKS.some(([a,b])=>a===AUTUMNAL_PLAINS_ZONE&&b===COAST_ZONE));
 const plains=generateDesert(autumnalPlainsData,'east-1');assert.equal(addSideTrail(plains,{zone_id:COAST_ZONE,name:'Seafoam Coast',side:'right'}),true);assert.ok(validateDesert(plains));
 assert.ok(wildernessGates(CITY).some(g=>g.target===COAST_ZONE&&g.side==='bottom'&&g.x===29&&g.y===59));
 assert.ok(hubPortals(CITY).some(p=>p.target===COAST_ZONE));
 const tuning=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8')).loot.tuning,coast=routeLevelFor(tuning,'seafoam-coast');
 assert.ok(coast>routeLevelFor(tuning,'autumnal-plains')&&coast<routeLevelFor(tuning,'dustbreak-crossing'));
});

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),api;const ids={};
 const loadout={player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:20,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const still=(...args)=>{const f=generateDesert(...args);f.enemies.forEach(e=>e.roaming=false);return f;},quiet={log:()=>{},generate:still};
 api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:quiet,tundraOptions:quiet,taigaOptions:quiet,highDesertOptions:quiet,autumnalPlainsOptions:quiet,coastOptions:quiet});
 const snap=name=>api.read(name,ids[name]);
 function act(name,action,extra={}){time+=350;const s=snap(name);return api.act(name,{action,controller:'window',request_id:randomUUID(),character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra});}
 function player(name){ids[name]=api.act(name,{action:'create',name,controller:'window',request_id:randomUUID()}).character.id;return act(name,'enter',{zone:CITY,combat_version:3,content_version:1,quest_version:1,loadout});}
 function place(name,p){const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]),state=JSON.parse(row.state);if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids[name]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[name]);}
 const floor=name=>{const s=snap(name);return s.zones.find(z=>z.id===s.zone);};
 return {snap,act,player,place,floor,close(){api.close();db.close();}};
}

test('online: LittleBigCity south gate -> Coast -> Plains -> Coast -> LittleBigCity, with shore and tide in the snapshot',()=>{const f=fixture();try{
 f.player('alice');f.place('alice',{x:29,y:58});const coast=f.act('alice','move',{direction:'south',world_step:true});
 assert.equal(coast.zone,COAST_ZONE);assert.deepEqual(coast.position,{x:40,y:1});
 const room=f.floor('alice'),s=f.snap('alice');assert.equal(room.theme,'coast');assert.equal(room.shore.length,80);assert.equal(room.exposed,true);
 assert.equal(typeof s.dive.tide.high,'boolean');assert.equal(s.dive.tide.reach,FEATURES.tide.reach);assert.equal(s.dive.tide.wade_wet,FEATURES.tide.wade_wet);
 const west=room.exits.find(e=>e.zone===AUTUMNAL_PLAINS_ZONE);f.place('alice',{x:west.x+1,y:west.y});const plains=f.act('alice','dive_exit',{zone:AUTUMNAL_PLAINS_ZONE});
 assert.equal(plains.zone,AUTUMNAL_PLAINS_ZONE);
 const east=f.floor('alice').exits.find(e=>e.zone===COAST_ZONE);assert.equal(east.side,'right');f.place('alice',{x:east.x-1,y:east.y});
 const back=f.act('alice','dive_exit',{zone:COAST_ZONE});assert.equal(back.zone,COAST_ZONE);
 f.place('alice',{x:40,y:1});const home=f.act('alice','move',{direction:'north',world_step:true});assert.equal(home.zone,CITY);assert.deepEqual(home.position,{x:29,y:58}); // One tile inside the city's south gate.
}finally{f.close();}});
