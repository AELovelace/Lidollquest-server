import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createOnlineQuests} from '../server/online-quests.mjs';
import {validateQuestContent} from '../server/quest-content.mjs';
import {validateFlow} from '../server/flow-content.mjs';

const stage=(id,objectives,next='complete',extra={})=>({id,objectives,next,...extra});
const objective=(id,type='story',extra={})=>({id,type,count:1,...extra});
const definition=stages=>validateQuestContent('quest',{id:'story_task',name:'Station testing',givers:['keeper'],turn_in:{mode:'journal'},stages,rewards:{coins:3}},{assetRef:v=>v,spells:{},equipment:{}});
function fixture(stages){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,state TEXT,revision INTEGER);CREATE TABLE quest_presence(character_id TEXT,zone TEXT,x INTEGER,y INTEGER,seen INTEGER);CREATE TABLE quest_reward_days(owner TEXT,day INTEGER,coins INTEGER,PRIMARY KEY(owner,day));');
 const quest=definition(stages),published={quests:{[quest.id]:quest},npcs:{}},paid=[],c={id:'alice',owner:'account'},s={loadout:{player_info:{level:1,xp:0},inventory:[],player_spells:[]},fullDungeon:{flags:{}}};
 const options={live:{registerQuestPack(){},setReferenceCheck(){},published:()=>published},now:()=>1000,world:{catalog:()=>[],map:()=>({edition:'map'})},parties:{members:()=>[]},adjust:(...args)=>paid.push(args),roll:()=>0};
 let quests=createOnlineQuests(db,options);const pinned={assets:{quests:published.quests}};
 const op=(operation,stage,objective)=>quests.flow(c,s,{ref:quest.id,operation,stage,objective},pinned);
 const current=()=>JSON.parse(db.prepare('SELECT state FROM online_quests WHERE character_id=? ORDER BY created DESC').get(c.id).state);
 return {db,c,s,quest,paid,op,current,get quests(){return quests;},restart(){quests=createOnlineQuests(db,options);},close(){db.close();}};
} // Exercise real quest storage and settlement while leaving maps, parties and wallets as inert dependencies.

test('story objectives coexist with gameplay, complete once across restart and leave rewards for Claim',()=>{
 const f=fixture([stage('checks',[objective('pods','story',{on_complete_flags:['story_pods']}),objective('workshop'),objective('tower'),objective('fight','kill',{target:'slime'})])]);
 try{
  assert.throws(()=>f.op('complete_objective','checks','pods'),/Accept this quest/);f.op('accept');
  assert.equal(f.current().status,'active');f.op('complete_objective','checks','pods');
  assert.equal(f.s.fullDungeon.flags.story_pods,true);assert.equal(f.current().progress['checks:pods'],1);assert.equal(f.current().progress['checks:workshop'],0);
  f.s.fullDungeon.flags.story_pods=false;f.restart();f.op('complete_objective','checks','pods');assert.equal(f.s.fullDungeon.flags.story_pods,false,'Replay does not reapply flags');
  f.op('complete_objective','checks','workshop');f.op('complete_objective','checks','tower');assert.equal(f.current().status,'active','A story block cannot implicitly finish the kill objective');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quests WHERE character_id=?').get('bob').n,0,'Progress belongs only to the story owner');
  f.quests.event(f.c,f.s,{id:'battle-one',type:'kill',target:'slime'});assert.equal(f.current().status,'ready');assert.deepEqual(f.paid,[]);
  f.op('complete_stage','checks');assert.deepEqual(f.paid,[]);f.op('claim');assert.equal(f.paid.length,1);assert.equal(f.paid[0][2],3);
  assert.throws(()=>f.op('claim'),/not ready/);assert.equal(f.paid.length,1);
  f.op('complete_objective','checks','pods');f.op('complete_stage','checks');assert.equal(f.paid.length,1,'Replaying completed story tasks after Claim is harmless');
 }finally{f.close();}
});

test('named stage completion preserves branches, flags, stage guards and completed receipts',()=>{
 const f=fixture([stage('intro',[objective('scene','story',{on_complete_flags:['story_intro']})],'middle'),stage('middle',[objective('talked')],'ending',{branches:[{id:'continue',label:'Continue',to:'ending'}]}),stage('ending',[objective('last')])]);
 try{
  f.op('accept');assert.throws(()=>f.op('complete_stage','ending'),/not active/);assert.equal(f.current().stage,'intro');
  f.op('complete_stage','intro');assert.equal(f.current().stage,'middle');assert.equal(f.s.fullDungeon.flags.story_intro,true);
  f.restart();f.op('complete_stage','intro');assert.equal(f.current().stage,'middle','Repeating an earlier stage block cannot skip the current stage');
  f.op('complete_stage','middle');assert.equal(f.current().status,'choice');f.op('complete_stage','middle');assert.equal(f.current().status,'choice');
  f.quests.flow(f.c,f.s,{ref:f.quest.id,operation:'branch',branch:'continue'},{assets:{quests:{[f.quest.id]:f.quest}}});assert.equal(f.current().stage,'ending');
  f.op('complete_stage','ending');assert.equal(f.current().status,'ready');assert.equal(f.paid.length,0);
 }finally{f.close();}
});

test('explicit objective completion stays satisfied for dynamic objectives and respects the accepted definition',()=>{
 const f=fixture([stage('checks',[objective('item','collect',{target:'missing_item'}),objective('later')])]);
 try{
  f.op('accept');f.op('complete_objective','checks','item');f.restart();
  f.quests.event(f.c,f.s,{id:'unrelated',type:'visit',target:'elsewhere'});assert.equal(f.current().progress['checks:item'],1);
  f.quest.stages[0].objectives.push(objective('new_objective'));
  assert.throws(()=>f.op('complete_objective','checks','new_objective'),/accepted quest/);assert.equal(f.current().status,'active');
  f.op('complete_objective','checks','later');assert.equal(f.current().status,'ready');
 }finally{f.close();}
});

test('any stages only complete the selected objective and unknown operations never abandon quests',()=>{
 const f=fixture([stage('checks',[objective('first','story',{on_complete_flags:['story_first']}),objective('other','story',{on_complete_flags:['story_other']})],'complete',{mode:'any'})]);
 try{f.op('accept');assert.throws(()=>f.op('bogus'),/Unknown story quest operation/);assert.equal(f.current().status,'active');
  f.op('complete_objective','checks','first');assert.equal(f.current().status,'ready');assert.equal(f.s.fullDungeon.flags.story_first,true);assert.equal(f.s.fullDungeon.flags.story_other,undefined);
 }finally{f.close();}
});

test('flow validation retains named targets and rejects missing, foreign or unpublished quest targets',()=>{
 const quest=definition([stage('checks',[objective('pods')])]),catalog={quests:[quest]},make=(operation,extra={})=>({id:'station_story',name:'Station story',nodes:[{id:'start',type:'entry'},{id:'progress',type:'quest',operation,ref:quest.id,stage:'checks',objective:'pods',...extra},{id:'done',type:'end'}],edges:[{from:'start',port:'next',to:'progress'},{from:'progress',port:'next',to:'done'}]});
 for(const operation of ['complete_objective','complete_stage']){
  const result=validateFlow(make(operation),{catalog,publish:true}).flow.nodes[1];assert.equal(result.stage,'checks');if(operation==='complete_objective')assert.equal(result.objective,'pods');
  for(const extra of [{stage:''},{stage:'missing'},{ref:'other'}])assert.throws(()=>validateFlow(make(operation,extra),{catalog,publish:true}),/quest|stage/);
 }
 assert.throws(()=>validateFlow(make('complete_objective',{objective:'missing'}),{catalog,publish:true}),/objective/);
 assert.throws(()=>validateFlow(make('complete_objective',{objective:''}),{publish:true}),/objective/);
});

test('published quest blocks run through real NPC commands with replay and restart protection',async()=>{
 const [{createQuestZones},{createWorldContent},{hubData},{combatData},{randomUUID}]=await Promise.all([import('../server/zones.mjs'),import('../server/world-content.mjs'),import('../server/hubs.mjs'),import('../server/combat.mjs'),import('node:crypto')]);
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells}),paid=[],previous=process.env.QUEST_FLOWS_ENABLED;
 process.env.QUEST_FLOWS_ENABLED='true';let api,c,time=Date.parse('2026-10-10T12:00:00Z');
 const boot=()=>api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:(...args)=>paid.push(args),diveOptions:{log:()=>{}}});
 const command=(action,extra={})=>({action,request_id:randomUUID(),controller:'test',character_id:c?.id,revision:c?.revision,...extra});
 const send=input=>{time+=500;const r=api.act('',input);c=r.character;return r;},act=(action,extra)=>send(command(action,extra));
 boot();
 try{
  const npc={id:'keeper',name:'Keeper',dialogue:[{id:'hello',text:'Welcome.',next:'close'}]},quest=definition([stage('intro',[objective('scene')],'finish'),stage('finish',[objective('report')])]);
  const nodes=[{id:'entry',type:'entry'},{id:'accept',type:'quest',operation:'accept',ref:quest.id},{id:'intro_page',type:'dialogue',text:'Test this station.'},{id:'stage_done',type:'quest',operation:'complete_stage',ref:quest.id,stage:'intro'},{id:'report_page',type:'dialogue',text:'Report your findings.'},{id:'objective_done',type:'quest',operation:'complete_objective',ref:quest.id,stage:'finish',objective:'report'},{id:'ready_page',type:'dialogue',text:'Ready for your reward.'},{id:'claim',type:'quest',operation:'claim',ref:quest.id},{id:'end',type:'end'}];
  const story={id:'station_story',name:'Station test',nodes,edges:nodes.slice(0,-1).map((n,i)=>({from:n.id,port:'next',to:nodes[i+1].id})),bindings:[{kind:'npc',ref:npc.id,entry:'entry'}]};
  api.world.flows.gm({action:'flow_publish',id:story.id,revision:0,entry:story,assets:[{kind:'npc',id:npc.id,revision:0,entry:npc},{kind:'quest',id:quest.id,revision:0,entry:quest}]},'gm');
  act('create',{name:'Alice'});act('enter',{zone:'honeydew-lantern',content_version:1,quest_version:1,flow_version:1,combat_version:3,loadout:{player_info:{playerHealth:20,playerHealthMax:20,level:1},inventory:[],player_spells:[]}});
  const map=api.world.map('honeydew-lantern');let placed;
  for(let y=2;y<map.floor.height-2&&!placed;y++)for(let x=2;x<map.floor.width-2&&!placed;x++)try{placed=api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'npc',content:npc.id,x,y});}catch(e){if(!/reachable tile/.test(e.message))throw e;}
  assert.ok(placed);const pin=placed.placements.find(p=>p.content===npc.id);db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(pin.x+1,pin.y,c.id);
  let r=act('npc_talk',{placement:pin.id,edition:map.edition});assert.equal(r.flowScene.node,'intro_page');assert.equal(r.onlineQuests.instances.find(q=>q.quest===quest.id).stage,'intro');
  const step=command('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});r=send(step);r=send(step);assert.equal(r.flowScene.node,'report_page');assert.equal(r.onlineQuests.instances.find(q=>q.quest===quest.id).stage,'finish');
  api.close();boot();r=api.read('',c.id);c=r.character;assert.equal(r.flowScene.node,'report_page');
  r=act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});assert.equal(r.onlineQuests.instances.find(q=>q.quest===quest.id).status,'ready');assert.equal(paid.length,0);
  const claim=command('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});send(claim);r=send(claim);assert.equal(paid.length,1);assert.equal(paid[0][2],3);assert.equal(r.onlineQuests.instances.find(q=>q.quest===quest.id).status,'claimed');
 }finally{api.close();db.close();if(previous===undefined)delete process.env.QUEST_FLOWS_ENABLED;else process.env.QUEST_FLOWS_ENABLED=previous;}
});
