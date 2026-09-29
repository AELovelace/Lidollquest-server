import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
import {validateFlow} from '../server/flow-content.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells});let time=Date.parse('2026-09-20T12:00:00Z'),c;
 const prior=process.env.QUEST_FLOWS_ENABLED;process.env.QUEST_FLOWS_ENABLED='true';
 const api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'gm',id:'grant',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:25}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=500;const request_id=randomUUID(),r=api.act('',{action,request_id,controller:'controller',character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 act('create',{name:'GM'});const initial=act('enter',{zone:'honeydew-lantern',flow_version:1,quest_version:1,content_version:1,combat_version:3,loadout:{player_info:{playerHealth:20,playerHealthMax:20,level:1},inventory:[],player_spells:[]}});
 const zone=initial.zones.find(z=>z.id===initial.zone),npc=zone.fixtures.find(n=>n.kind==='npc'),ref=zone.id+':'+npc.id,flows=api.world.flows;
 for(const id of ['story_ready','story_finish'])flows.gm({action:'flow_flag_save',revision:0,entry:{id,name:id}},'gm');
 const publish=(entry,assets=[])=>flows.gm({action:'flow_publish',id:entry.id,entry,revision:flows.get(entry.id)?.revision??0,assets},'gm');
 const approach=n=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(n.x+1,n.y,c.id);
 const talk=()=>{approach(npc);return act('hub_talk',{fixture:npc.id});};
 const flag=(id,value)=>{flows.gm({action:'flow_flag_set',character_id:c.id,revision:c.revision,flag:id,value},'gm');c=api.read('',c.id).character;};
 return {db,api,flows,ref,npc,act,talk,flag,publish,approach,read:()=>api.read('',c.id),continue(r){return act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});},close(){api.close();db.close();if(prior===undefined)delete process.env.QUEST_FLOWS_ENABLED;else process.env.QUEST_FLOWS_ENABLED=prior;}};
} // Exercise real hub commands, proximity checks, persisted runs and authoritative snapshots together.
const story=(ref,extra={})=>({id:'npc_override',name:'NPC replacement',nodes:[{id:'start',type:'npc_entry',ref,...extra},{id:'page',type:'dialogue',text:'Server story.'},{id:'done',type:'end'}],edges:[{from:'start',port:'next',to:'page'},{from:'page',port:'next',to:'done'}]});

test('engine NPC entry overrides hub dialogue while eligible and repeats by default',()=>{const f=fixture();try{
 const d=story(f.ref,{conditions:{all:['story_ready']}});f.publish(d);
 assert.equal(f.talk().npcInteraction.source,'default','unmatched entry preserves the native greeting and services');
 f.flag('story_ready',true);let r=f.talk();assert.equal(r.npcInteraction.source,'server');assert.equal(r.npcInteraction.npc,f.ref);assert.equal(r.flowScene.text,'Server story.');assert.equal(r.onlineQuests.conversation,null);assert.equal(r.character.hubNotice,undefined,'a prior native greeting cannot replay beneath the story on reconnect');
 f.continue(r);r=f.talk();assert.equal(r.flowScene.text,'Server story.');f.continue(r);
 f.flag('story_ready',false);assert.equal(f.talk().npcInteraction.source,'default');
 const catalog=f.flows.catalog();assert.ok(catalog.npcs.some(n=>n.id===f.ref&&n.engineOwned));
}finally{f.close();}});

test('silent one-time engine entry suppresses fallback now and releases it on the next interaction',()=>{const f=fixture();try{
 const d=story(f.ref,{repeatable:false});d.nodes=d.nodes.filter(n=>n.id!=='page');d.edges=[{from:'start',port:'next',to:'done'}];f.publish(d);
 let r=f.talk();assert.equal(r.flowScene,null);assert.equal(r.onlineQuests.conversation,null);assert.equal(r.npcInteraction.source,'server');
 const receipt=r.npcInteraction.request_id;assert.equal(f.read().npcInteraction.request_id,receipt,'snapshot retains the owning request for the client');
 r=f.talk();assert.equal(r.npcInteraction.source,'default');assert.notEqual(r.npcInteraction.request_id,receipt);
}finally{f.close();}});

test('waiting engine entry owns dialogue even after its entry flag stops matching',()=>{const f=fixture();try{
 const d=story(f.ref,{repeatable:false,conditions:{all:['story_ready']}});d.nodes[1]={id:'page',type:'objective',operation:'flag',conditions:{all:['story_finish']}};d.edges[1].port='complete';f.publish(d);f.flag('story_ready',true);
 let r=f.talk();assert.equal(r.flowScene.waiting,true);const run=r.flowScene.id;
 f.flag('story_ready',false);r=f.talk();assert.equal(r.npcInteraction.source,'server');assert.equal(r.flowScene.id,run);assert.equal(r.onlineQuests.conversation,null);
 f.flag('story_finish',true);r=f.talk();assert.equal(r.npcInteraction.source,'default');
}finally{f.close();}});

test('separate one-time NPC entries are consumed independently and later candidates remain available',()=>{const f=fixture();try{
 const d=story(f.ref,{repeatable:false});d.nodes.push({id:'second',type:'npc_entry',ref:f.ref,repeatable:false},{id:'page2',type:'dialogue',text:'Second interaction.'});d.edges.push({from:'second',port:'next',to:'page2'},{from:'page2',port:'next',to:'done'});f.publish(d);
 let r=f.talk();assert.equal(r.flowScene.text,'Server story.');f.continue(r);r=f.talk();assert.equal(r.flowScene.text,'Second interaction.');f.continue(r);assert.equal(f.talk().npcInteraction.source,'default');
}finally{f.close();}});

test('placed NPC entry overrides its authored basic page and reaction, then restores them',()=>{const f=fixture();try{
 const npc={id:'keeper',name:'Keeper',dialogue:[{id:'hello',text:'Basic page.',next:'close',actions:[]}],story_reactions:[{conditions:{all:['story_ready']},page:'hello'}]},d=story(npc.id,{repeatable:false});
 f.publish(d,[{kind:'npc',id:npc.id,revision:0,entry:npc}]);f.flag('story_ready',true);
 const map=f.api.world.map('honeydew-lantern');let placed;
 for(let y=2;y<map.floor.height-2&&!placed;y++)for(let x=2;x<map.floor.width-2&&!placed;x++)try{placed=f.api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'npc',content:npc.id,x,y});}catch(e){if(!/reachable tile/.test(e.message))throw e;}
 const at=placed.placements.find(p=>p.content===npc.id);f.approach(at);
 let r=f.act('npc_talk',{placement:at.id,edition:map.edition});assert.equal(r.flowScene.text,'Server story.');assert.equal(r.onlineQuests.conversation,null);f.continue(r);
 r=f.act('npc_talk',{placement:at.id,edition:map.edition});assert.equal(r.onlineQuests.conversation.text,'Basic page.');
 // An existing server conversation must not survive beneath a newly published replacement.
 const changed=story(npc.id);f.publish(changed);r=f.act('npc_talk',{placement:at.id,edition:map.edition});assert.equal(r.flowScene.text,'Server story.');assert.equal(r.onlineQuests.conversation,null);
}finally{f.close();}});

test('NPC roots validate references and reject incoming edges; preview can start at the root',()=>{const f=fixture();try{
 const d=story(f.ref);assert.equal(f.flows.gm({action:'flow_preview',entry:d,node:'start'},'gm').node.text,'Server story.');
 const options={catalog:f.flows.catalog(),publish:true};assert.doesNotThrow(()=>validateFlow(d,options));
 const bad=structuredClone(d);bad.nodes[0].ref='missing';assert.throws(()=>validateFlow(bad,options),/reference/);
 d.edges[1].to='start';assert.throws(()=>validateFlow(d,options),/entry blocks/);
}finally{f.close();}});
