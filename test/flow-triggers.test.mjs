import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createStoryFlows} from '../server/story-flows.mjs';
import {validateFlow} from '../server/flow-content.mjs';
const quest={id:'parcels',stages:[{id:'gather',objectives:[{id:'parcel'},{id:'other'}]}]};
const definition=()=>({id:'delivery',name:'Delivery',nodes:[{id:'main',type:'entry'},{id:'wait',type:'objective',operation:'flag',conditions:{all:['story_finish']}},{id:'flag_entry',type:'flag_entry',flag:'story_parcel'},{id:'objective_entry',type:'objective_entry',ref:'parcels',stage:'gather',objective:'parcel'},{id:'flag_page',type:'dialogue',text:'Flag scene'},{id:'parcel_page',type:'dialogue',text:'Parcel scene'},{id:'end',type:'end'}],edges:[{from:'main',port:'next',to:'wait'},{from:'wait',port:'complete',to:'end'},{from:'flag_entry',port:'next',to:'flag_page'},{from:'objective_entry',port:'next',to:'parcel_page'},...['flag_page','parcel_page'].map(from=>({from,port:'next',to:'end'}))],bindings:[{kind:'npc',ref:'keeper',entry:'main'}]});
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE quest_characters(id TEXT PRIMARY KEY,state TEXT,revision INTEGER DEFAULT 0);CREATE TABLE online_quests(id TEXT PRIMARY KEY,character_id TEXT,quest TEXT,state TEXT,created INTEGER)');
 const c={id:'alice'},s={flowVersion:1,fullDungeon:{flags:{}}};db.prepare('INSERT INTO quest_characters(id,state) VALUES (?,?)').run(c.id,JSON.stringify(s));
 const published={npcs:{keeper:{id:'keeper'}},monsters:{slime:{id:'slime'}},quests:{parcels:quest},orbs:{}},live={published:()=>published,view:()=>({compiledSprites:[],assets:[],equipment:[]}),bundle:()=>{}};
 let time=0,flows;const adapters={},boot=()=>flows=createStoryFlows(db,{live,world:{catalog:()=>[]},enabled:true,adapters,now:()=>++time});boot();
 for(const id of ['story_parcel','story_finish'])flows.gm({action:'flow_flag_save',entry:{id,name:id},revision:0},'gm');
 const publish=(entry=definition())=>flows.gm({action:'flow_publish',id:entry.id,entry,revision:flows.get(entry.id)?.revision??0},'gm');publish();
 return {db,c,s,adapters,publish,restart:boot,get flows(){return flows;},check(){flows.objectives(c,s);},complete(id='attempt',objective='parcel'){db.prepare('INSERT OR REPLACE INTO online_quests VALUES (?,?,?,?,?)').run(id,c.id,quest.id,JSON.stringify({status:'active',completed_objectives:{['gather:'+objective]:true}}),++time);},continue(){const view=flows.snapshot(c,s);flows.act(c,s,{flow_run:view.id,flow_step:view.step});flows.resume(c,s);},close(){db.close();}};
}
test('flag entries rearm on clear/set and do not consume the main entry',()=>{const f=fixture();try{
 f.check();assert.equal(f.flows.active(f.c),null);f.s.fullDungeon.flags.story_parcel=true;f.check();assert.equal(f.flows.snapshot(f.c,f.s).text,'Flag scene');f.continue();
 f.restart();f.check();assert.equal(f.flows.active(f.c),null);assert.equal(f.flows.start(f.c,f.s,'npc','keeper'),true);
 f.s.fullDungeon.flags.story_parcel=false;f.check();f.s.fullDungeon.flags.story_parcel=true;f.check();assert.equal(f.flows.snapshot(f.c,f.s).text,'Flag scene');f.continue();assert.equal(f.flows.snapshot(f.c,f.s).node,'wait');
}finally{f.close();}});
test('completed objectives enter once per attempt and return to the suspended wait across restart',()=>{const f=fixture();try{
 f.flows.start(f.c,f.s,'npc','keeper');const parent=f.flows.active(f.c).id;f.complete('wrong','other');f.check();assert.equal(f.flows.active(f.c).id,parent);
 f.complete();f.check();assert.equal(f.flows.snapshot(f.c,f.s).text,'Parcel scene');f.restart();f.continue();assert.equal(f.flows.active(f.c).id,parent);
 f.check();assert.equal(f.flows.active(f.c).id,parent);f.complete('second_attempt');f.check();assert.equal(f.flows.snapshot(f.c,f.s).text,'Parcel scene');f.continue();
 f.s.fullDungeon.flags.story_finish=true;f.flows.resume(f.c,f.s);assert.equal(f.flows.active(f.c),null);f.complete('third_attempt');f.check();assert.equal(f.flows.snapshot(f.c,f.s).text,'Parcel scene');
}finally{f.close();}});
test('busy characters queue pinned sub-entries and drain them separately after combat',()=>{const f=fixture();try{
 f.s.run={id:'combat'};f.s.fullDungeon.flags.story_parcel=true;f.complete();f.check();assert.equal(f.flows.active(f.c),null);
 f.s.fullDungeon.flags.story_parcel=false;f.check();const edited=definition();edited.nodes.find(n=>n.id==='flag_page').text='Edited';f.publish(edited);f.restart();delete f.s.run;
 f.check();assert.equal(f.flows.snapshot(f.c,f.s).text,'Flag scene');f.check();assert.equal(f.flows.snapshot(f.c,f.s).text,'Flag scene');f.continue();f.check();assert.equal(f.flows.snapshot(f.c,f.s).text,'Parcel scene');f.continue();f.check();assert.equal(f.flows.active(f.c),null);
}finally{f.close();}});
test('blocked automatic battles keep pickup receipts and retry with the same execution ID',()=>{const f=fixture();try{
 const d=definition();d.nodes.push({id:'fight',type:'battle',monsters:['slime','slime','slime']});d.edges.find(e=>e.from==='objective_entry').to='fight';d.edges.push(...['victory','defeat','retreat'].map(port=>({from:'fight',port,to:'end'})));f.publish(d);
 const receipts=[];let blocked=true;f.adapters.battle=(c,s,n,p,receipt)=>{receipts.push(receipt);s.testMutation=true;if(blocked)throw Object.assign(Error('Crowded'),{status:409});s.run={id:'battle'};return 'battle';};
 f.complete();f.check();assert.equal(f.flows.active(f.c),null);assert.equal(f.s.testMutation,undefined);f.restart();blocked=false;f.check();assert.equal(f.s.run.id,'battle');assert.equal(receipts[0],receipts[1]);f.check();assert.equal(receipts.length,2);
}finally{f.close();}});
test('trigger-only flows validate, preview any entry and reject missing references or incoming edges',()=>{const f=fixture();try{
 const d=definition();d.nodes=d.nodes.filter(n=>!['main','wait'].includes(n.id));d.edges=d.edges.filter(e=>!['main','wait'].includes(e.from));d.bindings=[];f.publish(d);
 assert.equal(f.flows.gm({action:'flow_preview',entry:d,node:'objective_entry'},'gm').node.text,'Parcel scene');
 const options={publish:true,flags:f.flows.flags(),catalog:{quests:[quest]}};assert.doesNotThrow(()=>validateFlow(d,options));
 for(const key of ['ref','stage','objective']){const bad=structuredClone(d);bad.nodes.find(n=>n.type==='objective_entry')[key]='missing';assert.throws(()=>validateFlow(bad,options),/objective/);}
 const bad=structuredClone(d);bad.edges.find(e=>e.from==='parcel_page').to='flag_entry';assert.throws(()=>validateFlow(bad,options),/Automatic entry/);
}finally{f.close();}});
test('isolated play can begin at a selected automatic entry without retriggering its current event',()=>{const f=fixture();try{
 f.s.fullDungeon.flags.story_parcel=true;f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(f.s),f.c.id);
 f.flows.beginTest(f.c.id,definition(),'flag_entry');assert.equal(f.flows.snapshot(f.c,f.s).text,'Flag scene');f.continue();f.check();assert.equal(f.flows.active(f.c),null);
 assert.throws(()=>f.flows.beginTest(f.c.id,definition(),'flag_page'),/entry block/);
}finally{f.close();}});
