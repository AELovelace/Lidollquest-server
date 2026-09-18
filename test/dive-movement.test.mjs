import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,desertData,tundraData} from '../server/zones.mjs';
import {campaignDives} from '../server/hubs.mjs';
import {diveData} from '../server/dive.mjs';
import {enemyRoams,pathTo,walkable,inside} from '../server/dive-generation.mjs';

const routes=[diveData,desertData,tundraData,...campaignDives];
test('movement policy covers authored enemies, stationary mimics, guardians and legacy Quarters',()=>{
 for(const data of routes)for(const [type,definition] of Object.entries(data.enemies)){
  assert.equal(enemyRoams(data,{id:'regular',type}),definition.roaming??(type==='diaper_fairy'));
  assert.equal(enemyRoams(data,{id:'regular',type,roaming:false}),false);
  assert.equal(enemyRoams(data,{id:data.config.boss_id??'iris',type,roaming:true}),false);
 }
 const mansion=campaignDives.find(d=>d.config.theme==='mansion'),dungeon=campaignDives.find(d=>d.config.theme==='dungeon');
 assert.equal(enemyRoams(mansion,{id:'legacy-ghost',type:'ghost'}),true);
 assert.equal(enemyRoams(mansion,{id:'legacy-chest',type:'chest_mimic'}),false);
 assert.equal(enemyRoams(dungeon,{id:'legacy-crib',type:'crib_mimic'}),false);
});

test('server clock pursues and engages on every route, including existing editions without movement flags',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),c;
 const setup=()=>createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{}});
 let api=setup();
 const read=()=>{const s=api.read('',c.id);c=s.character;return s;};
 const act=(action,extra={})=>{time+=350;if(c)read();const s=api.act('',{action,request_id:randomUUID(),controller:'a',character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const state=()=>JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);
 const saveState=s=>db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);
 try{
  act('create',{name:'Walker'});
  for(const data of routes){
   const hub=data.config.hub??(data.config.zone_id==='dive-desert'?'honeydew-lantern':'princess-rose'),zone=data.config.zone_id??'dive-quarters';
   act('enter',{zone:hub,loadout:{player_info:{playerHealth:100,playerHealthMax:100,stat_points:0},inventory:[]}});
   place(10,3);const hall=act('hub_visit',{zone:hub+'-dives'}),pad=hall.zones.find(z=>z.id===hall.zone).portals.find(p=>p.target===zone);
   assert.ok(pad);place(pad.x,pad.y);act('dive_enter',{zone});
   const visit=c.dive,record=()=>JSON.parse(db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(visit.route,visit.edition).content);
   const saveFloor=f=>db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=?').run(JSON.stringify(f),visit.route,visit.edition);
   for(const legacy of [false,true]){
    let f=record();const foe=f.enemies.find(e=>enemyRoams(data,e)&&!e.engaged),safe=f.safeRooms??f.rooms.slice(0,1);
    assert.ok(foe,zone+' has mobile enemies');
    const others=new Set(f.enemies.filter(e=>e.id!==foe.id).map(e=>e.x+','+e.y));
    let path;
    for(let y=1;y<f.height-1&&!path;y++)for(let x=1;x<f.width-1&&!path;x++){
     if(!walkable(f,x,y)||safe.some(r=>inside(r,x,y)))continue;
     const candidate=pathTo(f,foe,{x,y},3);
     if(candidate?.length===3&&candidate.every(p=>!others.has(p.x+','+p.y)&&!safe.some(r=>inside(r,p.x,p.y))))path=candidate;
    }
    assert.ok(path,zone+' has a clear three-step pursuit path');
    for(const enemy of f.enemies)if(enemy.id!==foe.id)enemy.roaming=false;
    if(legacy&&data!==desertData&&data!==tundraData)delete foe.roaming; // Crossings already persisted explicit movement before this fix.
    const start={x:foe.x,y:foe.y},target=path.at(-1);saveFloor(f);
    let s=state();s.dive.position={...target};s.dive.safeUntil=0;saveState(s);place(target.x,target.y);
    time+=1100;api.tick();f=record();let moved=f.enemies.find(e=>e.id===foe.id);
    assert.deepEqual({x:moved.x,y:moved.y},path[0],zone+' pursues on the first clock tick (legacy='+legacy+')');
    assert.ok(walkable(f,moved.x,moved.y));
    time+=1100;api.tick();time+=1100;api.tick();read();
    assert.equal(c.run?.encounter,foe.id,zone+' starts combat on contact');
    assert.equal(record().enemies.filter(e=>e.engaged===c.id).length,1);
    const locked=record().enemies.find(e=>e.id===foe.id);time+=1100;api.tick();assert.deepEqual(record().enemies.find(e=>e.id===foe.id),locked,'locked enemies stop moving');
    act('flee');f=record();moved=f.enemies.find(e=>e.id===foe.id);Object.assign(moved,start,{roaming:true,respawnAt:time+60000});saveFloor(f);
    time+=1100;api.tick();assert.deepEqual(record().enemies.find(e=>e.id===foe.id),moved,'respawning enemies stay still');
    moved.respawnAt=0;saveFloor(f);
    const mist=structuredClone(f.mist),claims=db.prepare('SELECT state FROM dive_progress WHERE character_id=? AND route=? AND edition=?').get(c.id,visit.route,visit.edition)?.state;
    api=setup();read();assert.deepEqual(record().mist,mist);assert.equal(db.prepare('SELECT state FROM dive_progress WHERE character_id=? AND route=? AND edition=?').get(c.id,visit.route,visit.edition)?.state,claims);
    assert.equal(c.run,null,'safe entrance prevents a reconnect ambush');
   }
   act('dive_exit');place(10,9);act('hub_visit',{zone:hub});act('leave');
  }
 }finally{db.close();}
});
