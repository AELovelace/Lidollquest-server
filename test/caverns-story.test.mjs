import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData,enemyAction,useTuning} from '../server/combat.mjs';
import {installCavernsContent} from '../server/caverns-content.mjs';
import {CAVERNS_ZONE,caveReach} from '../server/caverns-generation.mjs';

test('shipped block quest: accept, collect once, defer ambush to refuge, boss, reveal/read orb, claim once',()=>{
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells});let time=Date.parse('2026-09-22T12:00:00Z'),api,c,r;
 const prior=process.env.QUEST_FLOWS_ENABLED;process.env.QUEST_FLOWS_ENABLED='true';
 const boot=()=>{api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'gm',id:'grant',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});installCavernsContent(db,live,api.world.flows);};
 const act=(action,extra={})=>{time+=500;r=api.act('',{action,controller:'test',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=r.character;return r;};
 const place=(p)=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);s.dive.position={x:p.x,y:p.y};s.dive.safeUntil=time+600000;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);db.prepare('UPDATE quest_presence SET x=?,y=?,moved=0,seen=? WHERE character_id=?').run(p.x,p.y,time,c.id);};
 const next=(choice)=>act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step,...(choice?{choice}:{})});
 const win=()=>{const encounter=c.run.sharedEncounter,targets=r.encounter.enemies.map(v=>v.id);for(const target of targets){time+=10000;db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(time,c.id);r=api.read('',c.id);c=r.character;act('turn_ready',{battle:encounter,cycle:c.run.cycle,patch:[],forfeit:false});act('attack',{battle:encounter,cycle:c.run.cycle,target});}};
 try{
  boot();act('create',{name:'Doll'});act('enter',{zone:'littlebig-clockwork',flow_version:1,cavern_version:1,quest_version:1,content_version:1,combat_version:3,loadout:{player_info:{level:20,playerHealth:500,playerHealthMax:500},inventory:[],player_spells:[]}});
  db.prepare('UPDATE quest_presence SET x=29,y=58,moved=0 WHERE character_id=?').run(c.id);act('move',{direction:'south'});place({x:40,y:41});act('move',{direction:'north'});act('gm_god_mode',{value:true});
  let map=api.world.map(CAVERNS_ZONE);const dry=caveReach({...map.floor,managedOccupancy:[]},undefined,true);assert.equal(map.placements.length,6);assert.ok(map.placements.every(p=>dry.has(p.x+','+p.y)));
  const npc=map.placements.find(p=>p.kind==='npc');place(npc);act('npc_talk',{placement:npc.id});assert.equal(r.onlineQuests.conversation,null);assert.equal(r.flowScene.node,'offer');next('yes');assert.equal(c.fullDungeon.flags.story_caverns_started,true);next();assert.equal(r.flowScene,null);
  const markers=map.placements.filter(p=>p.kind==='token'),collected=[];
  for(const marker of markers){
   place(marker);r=api.read('',c.id);c=r.character;
   const target=r.questGuide?.target;assert.ok(target,'the minimap guide marks a survey marker in the Caverns');
   assert.ok(!collected.some(m=>m.x===target.x&&m.y===target.y),'the guide never points at a marker this character already picked up (was stuck on the first one)');
   assert.deepEqual(target,{x:marker.x,y:marker.y},'standing on a marker, the nearest remaining one is this one');
   act('quest_interact',{placement:marker.id});collected.push(marker);
  }
  assert.equal(c.fullDungeon.flags.story_caverns_surveyed,true);
  const hermit=map.floor.enemies.find(p=>p.id==='breakwater-hermit');assert.equal(r.questGuide?.objective,'boss','all three markers: stage two guides to the Hermit');assert.deepEqual(r.questGuide.target,{x:hermit.x,y:hermit.y});assert.equal(r.flowScene,null,'Must wait for the refuge, even after collecting all markers.');
  const refuge=map.placements.find(p=>p.kind==='location');place(refuge);r=api.read('',c.id);c=r.character;assert.equal(r.flowScene.node,'ambush_intro');next();assert.equal(r.encounter.enemies.length,2);
  const id=c.id,flowRevision=api.world.flows.get('coastal_caverns_story').revision;api.close();boot();r=api.read('',id);c=r.character;assert.equal(api.world.flows.get('coastal_caverns_story').revision,flowRevision);assert.equal(r.encounter.enemies.length,2);win();assert.equal(r.flowScene.node,'victory');next();
  map=api.world.map(CAVERNS_ZONE);const boss=map.floor.enemies.find(p=>p.id==='breakwater-hermit');place({x:boss.x-1,y:boss.y});act('dive_engage',{encounter:boss.id});win();assert.equal(c.fullDungeon.flags.story_caverns_hermit_defeated,true);assert.equal(r.flowScene.node,'memory_hint');next();
  const orb=map.placements.find(p=>p.kind==='orb');place(orb);act('orb_read',{placement:orb.id});assert.equal(r.flowScene.node,'memory');next();assert.equal(c.fullDungeon.flags.story_caverns_memory_read,true);
  const q=r.onlineQuests.instances.find(q=>q.quest==='caverns_survey');assert.equal(q.status,'ready');act('quest_claim',{quest:q.quest,quest_revision:q.revision});assert.equal(r.onlineQuests.instances.find(q=>q.quest===q.quest).status,'claimed');
  assert.throws(()=>act('quest_claim',{quest:q.quest,quest_revision:q.revision}));
 }finally{api?.close();db.close();if(prior===undefined)delete process.env.QUEST_FLOWS_ENABLED;else process.env.QUEST_FLOWS_ENABLED=prior;}
});

test('Breakwater Hermit warns before its strike, then exposes its shell on combat turns',()=>{
 useTuning(null);const s={loadout:{player_info:{def:5,playerHealth:500},world:{}},run:{enemy:{enemy_id:'breakwater_hermit',name:'Hermit',turn:0,def:8,str:16},hp:500,log:[],handicaps:[]}};
 enemyAction(s,{},()=>1);assert.equal(s.run.hp,500);assert.equal(s.run.enemy.def,13);
 enemyAction(s,{},()=>1);assert.equal(s.run.hp,500);assert.match(s.run.log.at(-1),/next turn/);
 enemyAction(s,{},()=>1);assert.ok(s.run.hp<500);assert.equal(s.run.enemy.def,4);
 enemyAction(s,{},()=>1);assert.equal(s.run.enemy.def,13);
});
