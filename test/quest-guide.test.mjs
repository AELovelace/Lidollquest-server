import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {buildGuideGraph,guideRoutes,guideGoal,locateGoal,firstOpenObjective,createQuestGuide} from '../server/quest-guide.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';

// A tiny hand-made world: hub <-> annex, hub <-> overworld <-> branch, and a campaign Dive with no exits.
const world=[
 {id:'hub',exits:[{to:'hub-beds',x:5,y:0,style:'door'},{to:'wild',x:0,y:5,w:1,h:2,style:'gap',side:'left'},{to:'wild',x:19,y:5,w:1,h:2,style:'gap',side:'right'},{to:'hub-dives',x:10,y:0,style:'door'}]},
 {id:'hub-beds',exits:[{to:'hub',x:1,y:9,style:'door'}]},
 {id:'hub-dives',exits:[{to:'hub',x:9,y:11,w:2,h:1,style:'gap',side:'bottom'},{to:'dive-cave',x:4,y:4,style:'warp'}]},
 {id:'wild',exits:[{to:'hub',x:10,y:1,w:2,h:1,style:'gap',side:'top'},{to:'branch',x:30,y:10,style:'gap',side:'right'},{to:'disabled',x:3,y:3}]},
 {id:'branch',exits:[{to:'wild',x:1,y:10,style:'gap',side:'left'}]},
 {id:'dive-cave',exits:[{to:null,x:2,y:2,style:'warp',name:'Way out'}]},
];

test('the graph drops unknown destinations and turns "way out" into edges back to every way in',()=>{
 const g=buildGuideGraph(world);
 assert.ok(!g.get('wild').some(e=>e.to==='disabled'),'A disabled or unknown zone must never become a route.');
 assert.deepEqual(g.get('dive-cave').map(e=>e.to),['hub-dives'],'An exit-less Dive leads back to the hall whose pad enters it.');
 assert.equal(g.get('hub').find(e=>e.to==='wild').w,1,'Gap footprints survive for the minimap.');
});

test('BFS picks the first door of the shortest route, and the nearest of several doors',()=>{
 const g=buildGuideGraph(world);
 assert.equal(guideRoutes(g,'hub',2,6).get('branch').exit.x,0,'Standing west, the west gate is the nearest way to the wilderness.');
 assert.equal(guideRoutes(g,'hub',18,6).get('branch').exit.x,19,'Standing east, the east gate wins.');
 assert.equal(guideRoutes(g,'hub',2,6).get('branch').hops,2);
 assert.equal(guideRoutes(g,'dive-cave').get('hub-beds').exit.name,'Way out','Inside a Dive the way out is the first door.');
});

test('the first unfinished objective is guided, in authored order',()=>{
 const q={status:'active',objectives:[{id:'a',type:'visit',target:'hub',count:1,progress:1},{id:'b',type:'talk',target:'hub-beds:innkeeper',count:1,progress:0},{id:'c',type:'visit',target:'branch',count:1,progress:0}]};
 assert.equal(firstOpenObjective(q).id,'b');
 const goal=guideGoal(q,{isZone:id=>world.some(z=>z.id===id),contentZones:()=>[]});
 assert.deepEqual([goal.objective,goal.zones[0],goal.fixture],['b','hub-beds','innkeeper'],'Resident keys carry their zone and fixture id.');
});

test('goals cover turn-in, journal, tokens, kills and unplaceable objectives',()=>{
 const opts={isZone:id=>world.some(z=>z.id===id),contentZones:key=>key==='lost-doll'?['branch']:[]};
 assert.equal(guideGoal({status:'ready',turn_in:{mode:'npc',npc:'hub:mayor'},objectives:[]},opts).zones[0],'hub','A finished quest walks back to its turn-in NPC.');
 assert.equal(guideGoal({status:'ready',turn_in:{mode:'journal'},objectives:[]},opts).note,'journal');
 assert.equal(guideGoal({status:'choice',objectives:[]},opts).note,'choice');
 assert.deepEqual(guideGoal({status:'active',objectives:[{id:'t',type:'collect',token:true,target:'lost-doll',count:1}]},opts).zones,['branch'],'Tokens are found through their placements.');
 assert.equal(guideGoal({status:'active',objectives:[{id:'i',type:'collect',target:'baby_wipes',count:1}]},opts).note,'anywhere','Ordinary items can come from anywhere.');
 assert.equal(guideGoal({status:'active',objectives:[{id:'k',type:'kill',target:'goblin',zone:'wild',count:3}]},opts).enemy,'goblin');
});

test('locateGoal finds fixtures, placements, the nearest living monster and room centres',()=>{
 assert.deepEqual(locateGoal({fixture:'innkeeper'},{fixtures:[{id:'innkeeper',x:12,y:15}]}),{x:12,y:15});
 assert.deepEqual(locateGoal({content:'bench',npc:''},{placements:[{kind:'location',content:'bench',x:3,y:4}]}),{x:3,y:4});
 assert.deepEqual(locateGoal({content:'teddy'},{fixtures:[{kind:'token',content:'teddy',x:8,y:9}]}),{x:8,y:9},'Full-dungeon tokens are floor fixtures.');
 assert.deepEqual(locateGoal({enemy:'goblin'},{x:0,y:0,time:100,enemies:[{type:'goblin',x:9,y:9},{type:'goblin',x:1,y:1,respawnAt:500},{type:'goblin',x:3,y:3}]}),{x:3,y:3},'Respawning monsters are skipped; the nearest living one wins.');
 assert.deepEqual(locateGoal({room:'intake'},{rooms:[{type:'intake',x:10,y:10,w:5,h:3}]}),{x:12,y:11});
 assert.equal(locateGoal({content:'missing'},{}),null,'No tile means "somewhere in this zone".');
});

test('guide() answers with the exit, the target tile, or a note',()=>{
 let time=0;const guide=createQuestGuide({now:()=>time,zones:()=>world,contentZones:()=>[]});
 const q={id:'inst',status:'active',objectives:[{id:'go',type:'talk',target:'branch:hermit',count:1,progress:0}]};
 const away=guide.guide(q,{zone:'hub',x:2,y:6});
 assert.deepEqual([away.zone,away.here,away.exit.to,away.exit.x],['branch',false,'wild',0],'Away from the objective the guide names the door to take.');
 const here=guide.guide(q,{zone:'branch',x:1,y:1,locate:()=>({x:7,y:7})});
 assert.deepEqual([here.here,here.target],[true,{x:7,y:7}],'In the right zone the guide names the tile.');
 assert.equal(guide.guide({...q,objectives:[{id:'x',type:'talk',target:'nowhere-npc',count:1,progress:0}]},{zone:'hub'}).note,'unknown');
 assert.equal(guide.guide({...q,status:'claimed'},{zone:'hub'}),null,'An ended quest shows nothing.');
});

test('a tracked weekly quest guides through the real Rose Court doors',()=>{
 const pack=JSON.parse(readFileSync(new URL('../content/weekly_quests.json',import.meta.url),'utf8'));
 const equipment={...hubData.equipment,...combatData.defeat_items};
 const db=new DatabaseSync(':memory:');
 const live=createWorldContent(db,{spells:combatData.spells,equipment,defeatEquipment:combatData.defeat_equipment,questPack:pack.quests});
 const time=Date.parse('2026-09-20T12:00:00Z');
 const api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 try{
  let c=null,last=null;
  const act=(action,extra={})=>{last=api.act('',{action,controller:'control',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=last.character;return last;};
  act('create',{name:'Alice'});
  act('enter',{zone:'princess-rose-garden',content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{cha:2,playerHealth:20,playerHealthMax:20,level:1,xp:0},inventory:[],player_spells:[]}});
  assert.equal(last.questGuide,null,'Nothing is tracked yet.');
  const quest=pack.quests.find(q=>q.id==='rose_pages_long_way');
  const map=api.world.map('princess-rose-garden'),resident=map.floor.fixtures.find(f=>f.kind==='npc'&&f.id==='castle-page');
  db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(resident.x+1,resident.y,c.id);
  act('npc_talk',{placement:resident.id,edition:map.edition});
  const choose=label=>{const t=last.onlineQuests.conversation,choice=t.choices.find(c=>c.label===label);assert.ok(choice,'Missing '+label);act('npc_choice',{conversation:t.id,page:t.page,choice:choice.index});};
  choose('Ask about quests');choose(quest.name);choose('Accept quest');
  const instance=last.onlineQuests.instances.find(q=>q.quest===quest.id);
  assert.equal(last.onlineQuests.tracked,instance.id,'Accepting with nothing tracked tracks the new quest (like the campaign).');
  act('npc_close');
  const guide=last.questGuide;
  assert.ok(guide,'A tracked quest ships a guide.');
  assert.deepEqual([guide.objective,guide.zone,guide.here],['past_the_market','princess-rose-shops',false],'Standing in The Castle completes the first visit; the guide moves on to the Market Hall.');
  assert.deepEqual([guide.exit.to,guide.exit.name,guide.exit.style,guide.exit.side],['princess-rose','Rose Court','gap','right'],"The Castle district's right-wall gap leads back to Rose Court, one step toward the Market.");
  assert.equal(guide.quest,instance.id);
  act('quest_track',{quest:''});
  assert.equal(last.onlineQuests.tracked,null,'An empty quest key untracks.');
  assert.equal(last.questGuide,null,'Untracked means no markers.');
  act('quest_track',{quest:quest.id});
  assert.equal(last.onlineQuests.tracked,instance.id,'Tracking again pins that one quest.');
  assert.throws(()=>act('quest_track',{quest:'not-a-quest'}),/not active/,'Only open quests can be tracked.');
 }finally{api.close();db.close();}
});

test('the real online world is one connected graph from Honeydew',async()=>{
 const db=new DatabaseSync(':memory:');
 const live=createWorldContent(db,{spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment,questPack:[]});
 const api=createQuestZones(db,{live,now:()=>Date.parse('2026-09-20T12:00:00Z'),roll:()=>0,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 try{
  await api.prepare(); // Generate every weekly floor so overworld exits exist.
  const g=api.questGuideGraph();
  const routes=guideRoutes(g,'honeydew-lantern');
  for(const id of ['honeydew-lantern-beds','overworld-autumnal-plains','princess-rose','littlebig-clockwork','arcadia-foundry','utopia-arcanum'])assert.ok(routes.has(id),'Honeydew must reach '+id);
  assert.equal(routes.get('overworld-autumnal-plains').hops,1,"The Plains are straight through Honeydew's south gate.");
 }finally{api.close();db.close();}
});
