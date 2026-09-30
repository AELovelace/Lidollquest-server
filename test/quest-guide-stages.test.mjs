import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';

// Multi-part quests: the minimap guide must follow the quest from objective to objective and stage to stage.
test('the guide follows a multi-part weekly quest through every objective, stage and the turn-in',()=>{
 const pack=JSON.parse(readFileSync(new URL('../content/weekly_quests.json',import.meta.url),'utf8'));
 const db=new DatabaseSync(':memory:');
 const live=createWorldContent(db,{spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment,questPack:pack.quests});
 let time=Date.parse('2026-09-20T12:00:00Z');
 const api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 try{
  let c=null,last=null;
  const act=(action,extra={})=>{time+=1000;last=api.act('',{action,controller:'control',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=last.character;return last;};
  const moveTo=(zone,x,y)=>{db.prepare('UPDATE quest_presence SET zone=?,x=?,y=? WHERE character_id=?').run(zone,x,y,c.id);}; // Teleport; the next command evaluates visits there.
  act('create',{name:'Alice'});
  act('enter',{zone:'princess-rose-garden',content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{cha:2,playerHealth:20,playerHealthMax:20,level:1,xp:0},inventory:[],player_spells:[]}});
  const quest=pack.quests.find(q=>q.id==='rose_pages_long_way');
  const map=api.world.map('princess-rose-garden'),page=map.floor.fixtures.find(f=>f.id==='castle-page');
  moveTo('princess-rose-garden',page.x+1,page.y);act('npc_talk',{placement:page.id,edition:map.edition});
  const choose=label=>{const t=last.onlineQuests.conversation,choice=t.choices.find(c=>c.label===label);assert.ok(choice,'Missing '+label);act('npc_choice',{conversation:t.id,page:t.page,choice:choice.index});};
  choose('Ask about quests');choose(quest.name);choose('Accept quest');act('npc_close');
  const g=()=>last.questGuide,summary=()=>({objective:g()?.objective,zone:g()?.zone,here:g()?.here,note:g()?.note,stage:last.onlineQuests.instances.find(q=>q.quest===quest.id)?.stage,status:last.onlineQuests.instances.find(q=>q.quest===quest.id)?.status});
  assert.equal(g().objective,'past_the_market');
  const shops=api.world.map('princess-rose-shops');moveTo('princess-rose-shops',shops.floor.spawn?.x??5,shops.floor.spawn?.y??5);act('face',{direction:'north'});
  assert.equal(summary().stage,'hand_it_over','visiting the Market Hall finishes stage 1');
  assert.equal(g().objective,'ask_celia','stage 2: the guide moves to the librarian');
  assert.equal(g().zone,'princess-rose-garden');assert.equal(g().here,false);assert.ok(g().exit,'a door out of the Market Hall is marked');
  const lib=map.floor.fixtures.find(f=>f.id==='castle-librarian');moveTo('princess-rose-garden',lib.x+1,lib.y);act('face',{direction:'north'});
  assert.deepEqual(g().target,{x:lib.x,y:lib.y},'in The Castle the librarian herself is marked');
  act('npc_talk',{placement:lib.id,edition:map.edition});
  for(let i=0;i<6&&last.onlineQuests.conversation;i++){const t=last.onlineQuests.conversation;if(!t.choices?.length)break;act('npc_choice',{conversation:t.id,page:t.page,choice:t.choices[0].index});}
  if(last.onlineQuests.conversation)act('npc_close');
  assert.equal(summary().status,'ready');
  assert.equal(g().objective,'turn_in');assert.deepEqual(g().target,{x:page.x,y:page.y},'ready: back to the castle page');
 }finally{api.close();db.close();}
});
