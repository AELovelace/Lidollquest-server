import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createOrbs} from '../server/orbs.mjs';
import {validateFlow} from '../server/flow-content.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';

test('orb visibility is personal, persistent, idempotent and cannot bypass reading rules',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE quest_presence(character_id TEXT,zone TEXT,x INTEGER,y INTEGER,seen INTEGER)');
 const c={id:'alice',state:'{}'},bob={id:'bob',state:'{}'},def={id:'memory',title:'Memory',hidden_until_revealed:true,pages:[]},legacy={id:'legacy',title:'Legacy'};
 const rows=[{id:'pin',kind:'orb',content:'memory',x:0,y:0},{id:'old',kind:'orb',content:'legacy',x:1,y:0}],options={now:()=>100,live:{published:()=>({orbs:{memory:def,legacy}})},placements:{view:()=>({placements:rows})},world:{map:()=>({edition:'map'})}};
 db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?)').run(c.id,'zone',0,0,100);let orbs=createOrbs(db,options);
 const read=()=>orbs.act(c,{}, {action:'orb_read',placement:'pin',edition:'map',request_id:randomUUID()});
 try{
  assert.deepEqual(orbs.decorate(c,rows).map(p=>p.id),['old']);assert.throws(read,/not visible/);
  orbs.setVisibility(c,'memory',true);const count=db.prepare('SELECT total_changes() n').get().n;orbs.setVisibility(c,'memory',true);assert.equal(db.prepare('SELECT total_changes() n').get().n,count);
  assert.equal(orbs.decorate(c,rows).length,2);assert.equal(orbs.decorate(bob,rows).length,1);
  orbs.setVisibility(c,'legacy',false);assert.deepEqual(orbs.decorate(c,rows).map(p=>p.id),['pin']);
  orbs=createOrbs(db,options);assert.deepEqual(orbs.decorate(c,rows).map(p=>p.id),['pin']);
  def.story_conditions={all:['story_permission']};assert.equal(orbs.decorate(c,rows)[0].dormant,true);assert.throws(read,/not available/);delete def.story_conditions;
  def.requires='earlier';assert.throws(read,/still dark/);delete def.requires;
  orbs.setVisibility(c,'memory',false);assert.throws(read,/not visible/);orbs.setVisibility(c,'memory',true);read();
  orbs.setVisibility(c,'memory',false);orbs.setVisibility(c,'memory',true);assert.deepEqual(orbs.decorate(c,rows),[]);assert.throws(read,/already know/);
  def.repeatable=true;assert.equal(orbs.decorate(c,rows).length,1);def.retired=true;assert.deepEqual(orbs.decorate(c,rows),[]);
 }finally{db.close();}
});

const story=()=>({id:'reveal_story',name:'Reveal story',nodes:[{id:'start',type:'flag_entry',flag:'story_memory'},{id:'show',type:'reveal_orb',ref:'secret_memory'},{id:'visible',type:'dialogue',text:'The memory appears.'},{id:'hide',type:'hide_orb',ref:'secret_memory'},{id:'hidden',type:'dialogue',text:'The memory fades.'},{id:'end',type:'end'}],edges:[['start','show'],['show','visible'],['visible','hide'],['hide','hidden'],['hidden','end']].map(([from,to])=>({from,port:'next',to}))});
test('visibility blocks validate both orb references and outgoing connections',()=>{
 const options={publish:true,flags:[{id:'story_memory'}],catalog:{orbs:[{id:'secret_memory'}]}};assert.doesNotThrow(()=>validateFlow(story(),options));
 for(const id of ['show','hide']){const d=story();d.nodes.find(n=>n.id===id).ref='missing';assert.throws(()=>validateFlow(d,options),/orbs reference/);}
 assert.throws(()=>validateFlow(story(),{...options,catalog:{orbs:[{id:'secret_memory',retired:true}]}}),/orbs reference/);
 const d=story();d.edges=d.edges.filter(e=>e.from!=='hide');assert.throws(()=>validateFlow(d,options),/Connect/);
});

test('a real trigger reveals and hides map orbs; preview and isolated play cannot change live visibility',()=>{
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells});let now=Date.parse('2026-09-20T12:00:00Z'),api,c;
 const prior=process.env.QUEST_FLOWS_ENABLED;process.env.QUEST_FLOWS_ENABLED='true';
 const boot=()=>api=createQuestZones(db,{live,now:()=>now,roll:()=>0,grant:()=>({owner:'gm',id:'grant',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});boot();
 const act=(action,extra={})=>{now+=250;const r=api.act('',{action,controller:'controller',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 const read=()=>{const r=api.read('',c.id);c=r.character;return r;},shown=r=>r.worldPlacements.some(p=>p.content==='secret_memory');
 try{
  act('create',{name:'GM'});act('enter',{zone:'honeydew-lantern',flow_version:1,quest_version:1,content_version:1,combat_version:3,loadout:{player_info:{playerHealth:20,playerHealthMax:20,level:1},inventory:[],player_spells:[]}});
  api.world.flows.gm({action:'flow_flag_save',entry:{id:'story_memory',name:'Memory unlocked'},revision:0},'gm');
  const orb={id:'secret_memory',title:'Secret memory',colour:'#ffccdd',hidden_until_revealed:true,pages:[{text:'A secret.'}]};
  api.world.flows.gm({action:'flow_publish',id:'reveal_story',revision:0,entry:story(),assets:[{kind:'orb',id:orb.id,entry:orb,revision:0}]},'gm');
  assert.equal(live.published().orbs.secret_memory.hidden_until_revealed,true);
  let map=api.world.map('honeydew-lantern'),pin;
  for(let y=2;y<map.floor.height-2&&!pin;y++)for(let x=2;x<map.floor.width-2&&!pin;x++)try{map=api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'orb',content:orb.id,x,y});pin=map.placements.find(p=>p.content===orb.id);}catch(e){if(!/reachable tile|away from/.test(e.message))throw e;}
  assert.ok(pin);assert.equal(shown(read()),false);
  let preview=api.world.flows.gm({action:'flow_preview',entry:story()},'gm');assert.equal(preview.orbVisibility.secret_memory,true);assert.equal(shown(read()),false);
  preview=api.world.flows.gm({action:'flow_preview',entry:story(),node:'hide',orbVisibility:preview.orbVisibility},'gm');assert.equal(preview.orbVisibility.secret_memory,false);assert.equal(db.prepare('SELECT COUNT(*) n FROM orb_visibility').get().n,0);
  api.world.flows.gm({action:'flow_flag_set',character_id:c.id,revision:c.revision,flag:'story_memory',value:true},'gm');let r=read();assert.equal(r.flowScene.text,'The memory appears.');assert.equal(shown(r),true);
  api.close();boot();r=read();assert.equal(shown(r),true);
  r=act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});assert.equal(r.flowScene.text,'The memory fades.');assert.equal(shown(r),false);
  r=act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});assert.equal(r.flowScene,null);
  const code=api.world.flowTests.create('reveal_story','gm',{},'start').id;r=act('flow_test_start',{test_code:code});assert.equal(shown(r),true);
  assert.equal(db.prepare('SELECT visible FROM orb_visibility WHERE character_id=? AND orb=?').get(c.id,orb.id).visible,0);
  api.close();boot();r=read();assert.equal(r.flowTest.id,code);assert.equal(shown(r),true);r=act('flow_test_stop');assert.equal(shown(r),false);
 }finally{api.close();db.close();if(prior===undefined)delete process.env.QUEST_FLOWS_ENABLED;else process.env.QUEST_FLOWS_ENABLED=prior;}
});
