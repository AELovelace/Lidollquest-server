import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {combatData} from '../server/combat.mjs';
import {hubData} from '../server/hubs.mjs';
import {enemyRoams} from '../server/dive-generation.mjs';

// A frozen (static) map keeps one floor forever, so every enemy that respawns on it is born from the World
// panel's reconcile step. That step used to bake the zone's "roaming" toggle into each respawned enemy, and a
// zone row saved without the toggle read as off, so frozen maps slowly filled with enemies that never moved.

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-16T12:00:00Z'),owner='alice';
 const live=createWorldContent(db,{now:()=>time,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment});
 const options={now:()=>time,roll:()=>0,live,grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}};let zones=createQuestZones(db,options);
 const loadout={player_info:{class_id:'fighter',playerHealth:500,playerHealthMax:500,str:100,def:8,dex:8,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:[],player_mp:0,player_mp_max:0};
 const read=id=>zones.read('',id);
 const act=(id,action,extra={})=>{time+=350;const s=id?read(id):null;return zones.act('',{action,request_id:randomUUID(),controller:'window',character_id:id,revision:s?.character.revision,...(s?.character.dive?{edition:s.dive.edition}:{}),...extra});};
 function player(name='alice'){owner=name;const c=act(null,'create',{name}).character;act(c.id,'enter',{zone:'princess-rose',loadout,combat_version:3,content_version:1,defeat_version:1});act(c.id,'dive_enter',{loadout});return c.id;}
 const record=()=>{const row=db.prepare("SELECT * FROM dive_editions WHERE route='quarters-pilot' AND depth=1 ORDER BY starts DESC LIMIT 1").get();return {...row,floor:JSON.parse(row.content)};};
 const saveFloor=r=>db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=? AND depth=1').run(JSON.stringify(r.floor),r.route,r.edition);
 function publish(kind,entry){let revision=0;try{revision=live.entry(kind,entry.id).revision;}catch{}return live.change({action:'content_publish',kind,id:entry.id,revision,entry},'dm');}
 const positions=()=>Object.fromEntries(record().floor.enemies.map(e=>[e.id,e.x+','+e.y]));
 function ticks(id,n){for(let i=0;i<n;i++){time+=1001;db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(time,id);zones.tick();}} // The service ticks once a second while somebody is on the floor.
 const moved=(before,after)=>Object.keys(before).filter(id=>after[id]&&after[id]!==before[id]).length;
 return {db,live,read,act,player,record,saveFloor,publish,positions,ticks,moved,zone:()=>live.entry('zone','dive-quarters').draft,advance:ms=>time+=ms,restart(){zones.close();zones=createQuestZones(db,options);},close(){zones.close();db.close();}};
}

test('respawned enemies on a frozen map keep walking; the zone switch is live and defaults to on; frozen enemies thaw',()=>{
 const f=fixture();try{
  f.publish('zone',{...f.zone(),static:true});const a=f.player();f.advance(15000);
  const start=f.positions();f.ticks(a,6);assert.ok(f.moved(start,f.positions())>0,'a fresh static floor roams');
  // Every regular enemy dies and respawns: reconcile must give them back their monster's roaming, not a stale zone toggle.
  const r=f.record();for(const foe of r.floor.enemies){if(foe.id===r.floor.bossId)continue;foe.dead=true;foe.diedAt=Date.parse('2026-09-16T12:00:00Z');foe.respawnAt=0;foe.roaming=false;}f.saveFloor(r);
  f.advance(2*3600*1000);f.ticks(a,2);
  const revived=f.record().floor.enemies.filter(e=>e.id!==f.record().floor.bossId);assert.ok(revived.length>0);
  assert.ok(revived.every(e=>!e.dead),'everyone respawned');
  assert.ok(revived.every(e=>e.roaming===enemyRoams({config:{boss_id:'iris'},enemies:f.live.published().monsters},{id:e.id,type:e.type})),'respawns walk the way their monster is authored');
  const after=f.positions();f.ticks(a,6);assert.ok(f.moved(after,f.positions())>0,'respawned enemies move on the frozen map');
  // A zone row saved before the switch existed (or with the retired "roaming" key set false) must not freeze anything.
  f.db.prepare("UPDATE world_content SET draft=json_set(draft,'$.roaming',json('false')),published=json_set(published,'$.roaming',json('false')) WHERE kind='zone' AND id='dive-quarters'").run();
  f.db.prepare("UPDATE world_content SET draft=json_remove(draft,'$.enemies_roam'),published=json_remove(published,'$.enemies_roam') WHERE kind='zone' AND id='dive-quarters'").run();
  f.restart();f.act(a,'enter',{zone:'dive-quarters',loadout,combat_version:3,content_version:1,defeat_version:1});
  assert.equal(f.live.published().zones['dive-quarters'].enemies_roam,undefined);
  const legacy=f.positions();f.ticks(a,6);assert.ok(f.moved(legacy,f.positions())>0,'a legacy zone row without the switch still roams');
  // The live switch: off stops everyone at once, on resumes without touching the floor.
  f.publish('zone',{...f.zone(),enemies_roam:false});
  const frozen=f.positions();f.ticks(a,6);assert.equal(f.moved(frozen,f.positions()),0,'enemies roam off: nobody moves');
  f.publish('zone',{...f.zone(),enemies_roam:true});
  const thawed=f.positions();f.ticks(a,6);assert.ok(f.moved(thawed,f.positions())>0,'enemies roam on: movement resumes');
  // Enemies frozen by the old code (roaming baked false while alive) are repaired by the next reconcile.
  const r2=f.record();for(const foe of r2.floor.enemies)if(foe.id!==r2.floor.bossId)foe.roaming=false;f.saveFloor(r2);
  f.ticks(a,2);assert.ok(f.record().floor.enemies.filter(e=>e.id!==f.record().floor.bossId).every(e=>e.roaming===enemyRoams({config:{boss_id:'iris'},enemies:f.live.published().monsters},{id:e.id,type:e.type})),'baked-in stationary flags are repaired');
  const repaired=f.positions();f.ticks(a,6);assert.ok(f.moved(repaired,f.positions())>0,'repaired enemies move again');
 }finally{f.close();}
});
const loadout={player_info:{class_id:'fighter',playerHealth:500,playerHealthMax:500,str:100,def:8,dex:8,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:[],player_mp:0,player_mp_max:0};
