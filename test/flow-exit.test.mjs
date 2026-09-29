import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';

// A player can always leave a story page (2026-09-28): Esc twice / Leave story sends flow_exit, so a broken
// or unwanted flow can never softlock a character. Leaving before any reward lets the story start again;
// leaving after one ends a one-time story for good (no farming).
function fixture(){
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-20T12:00:00Z'),api,c;const live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells}),paid=[];
 const prior=process.env.QUEST_FLOWS_ENABLED;process.env.QUEST_FLOWS_ENABLED='true';
 api=createQuestZones(db,{live,now:()=>now,roll:()=>0,grant:()=>({owner:'gm',id:'grant',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:25}),adjust:(...args)=>paid.push(args),diveOptions:{log:()=>{}}});
 const act=(action,extra={})=>{now+=500;const r=api.act('',{action,request_id:randomUUID(),controller:'controller',character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 const transaction=work=>{db.exec('BEGIN');try{const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');live.invalidate();throw e;}};
 act('create',{name:'GM'});act('enter',{zone:'honeydew-lantern',flow_version:1,quest_version:1,content_version:1,combat_version:3,loadout:{player_info:{playerHealth:20,playerHealthMax:20,level:1},inventory:[],player_spells:[]}});
 const entry={id:'scout_story',name:'Scout story',nodes:[{id:'start',type:'entry'},{id:'say',type:'dialogue',text:'Help the scout.'},{id:'reward',type:'reward',rewards:{coins:3,xp:1}},{id:'say2',type:'dialogue',text:'Thanks again.'},{id:'done',type:'end'}],
  edges:[{from:'start',port:'next',to:'say'},{from:'say',port:'next',to:'reward'},{from:'reward',port:'next',to:'say2'},{from:'say2',port:'next',to:'done'}],bindings:[{kind:'npc',ref:'scout',entry:'start',conditions:{all:[],any:[],none:[]}}],repeatable:false};
 const npc={id:'scout',name:'Scout',quests:[],dialogue:[{id:'hello',text:'Hello',next:'close',actions:[]}]};
 transaction(()=>api.world.flows.gm({action:'flow_publish',id:entry.id,entry,revision:0,assets:[{kind:'npc',id:npc.id,entry:npc,revision:0}]},'gm'));
 const map=api.world.map('honeydew-lantern');let placed;
 for(let y=2;y<map.floor.height-2&&!placed;y++)for(let x=2;x<map.floor.width-2&&!placed;x++)try{placed=api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'npc',content:'scout',x,y});}catch(e){if(!/reachable tile/.test(e.message))throw e;}
 const at=placed.placements.find(p=>p.content==='scout');
 const talk=()=>{db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(at.x+1,at.y,c.id);return act('npc_talk',{placement:at.id,edition:map.edition}).onlineQuests.conversation;};
 const story=conversation=>{const choice=conversation.choices.find(v=>v.label==='Continue personal story');return choice?act('npc_choice',{conversation:conversation.id,page:conversation.page,choice:choice.index}):null;};
 return {db,act,talk,story,paid,read:()=>api.read('',c.id),close:()=>{db.close();process.env.QUEST_FLOWS_ENABLED=prior;}};
}

test('Esc leaves a story page: early exits can restart, rewarded one-time stories end for good',()=>{
 const f=fixture();try{
  let r=f.story(f.talk());assert.equal(r.flowScene.text,'Help the scout.');
  assert.throws(()=>f.act('hub_visit',{zone:'honeydew-lantern-inn'}),/Finish the current story page first/,'an open page blocks other actions');
  assert.throws(()=>f.act('flow_exit',{flow_run:'someone-else'}),/already moved on/);
  r=f.act('flow_exit',{flow_run:r.flowScene.id});
  assert.equal(r.flowScene,null,'the page is gone');assert.deepEqual(r.character.lastResult.log,['You leave the story for now.']);
  assert.doesNotThrow(()=>{try{f.act('hub_visit',{zone:'honeydew-lantern-inn'});}catch(e){if(/story page/.test(e.message))throw e;}},'other actions are no longer blocked by the story');
  r=f.story(f.talk());assert.ok(r,'nothing was given yet, so the one-time story can start again');assert.equal(r.flowScene.text,'Help the scout.');
  r=f.act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});assert.equal(r.flowScene.text,'Thanks again.');assert.equal(f.paid.length,1,'the reward was paid');
  r=f.act('flow_exit',{flow_run:r.flowScene.id});assert.equal(r.flowScene,null);
  assert.equal(f.story(f.talk()),null,'after a reward, leaving ends the one-time story: it cannot be farmed');assert.equal(f.paid.length,1);
 }finally{f.close();}
});

test('a story parked on a missing block still renders and can be left, instead of breaking every snapshot',()=>{
 const f=fixture();try{
  let r=f.story(f.talk());const run=r.flowScene.id;
  const row=f.db.prepare('SELECT state FROM story_flow_runs WHERE id=?').get(run),state=JSON.parse(row.state);state.node='ghost';f.db.prepare('UPDATE story_flow_runs SET state=? WHERE id=?').run(JSON.stringify(state),run); // What a bad publish or manual edit could leave behind.
  r=f.read();assert.match(r.flowScene.text,/missing/);assert.deepEqual(r.flowScene.choices,[]);
  assert.throws(()=>f.act('flow_continue',{flow_run:run,flow_step:r.flowScene.step}),/missing/);
  assert.throws(()=>f.act('hub_visit',{zone:'honeydew-lantern-inn'}),/Finish the current story page first/);
  r=f.act('flow_exit',{flow_run:run});assert.equal(r.flowScene,null,'the escape hatch still works');
 }finally{f.close();}
});
