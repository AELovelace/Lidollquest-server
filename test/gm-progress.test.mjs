import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {createQuestService} from '../server/service.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';

// GM panel "Test progress" (2026-09-29): staff can set/clear a character's flags, complete/remove quests and
// replay finished personal stories, so test accounts can run the same event twice.
function fixture(){
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-20T12:00:00Z'),api,c;const live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells}),paid=[];
 const prior=process.env.QUEST_FLOWS_ENABLED;process.env.QUEST_FLOWS_ENABLED='true';
 api=createQuestZones(db,{live,now:()=>now,roll:()=>0,grant:()=>({owner:'gm',id:'grant',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:25}),adjust:(...args)=>paid.push(args),diveOptions:{log:()=>{}}});
 const act=(action,extra={})=>{now+=500;const r=api.act('',{action,request_id:randomUUID(),controller:'controller',character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 const transaction=work=>{db.exec('BEGIN');try{const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');live.invalidate();throw e;}};
 act('create',{name:'Tester'});act('enter',{zone:'honeydew-lantern',flow_version:1,quest_version:1,content_version:1,combat_version:3,loadout:{player_info:{playerHealth:20,playerHealthMax:20,level:1},inventory:[],player_spells:[]}});
 api.world.flows.gm({action:'flow_flag_save',revision:0,entry:{id:'story_helped',name:'Helped the scout'}},'gm');
 const entry={id:'scout_story',name:'Scout story',nodes:[{id:'start',type:'entry'},{id:'say',type:'dialogue',text:'Help the scout.'},{id:'flag',type:'set_flag',flag:'story_helped'},{id:'done',type:'end'}],
  edges:[{from:'start',port:'next',to:'say'},{from:'say',port:'next',to:'flag'},{from:'flag',port:'next',to:'done'}],bindings:[{kind:'npc',ref:'scout',entry:'start',conditions:{all:[],any:[],none:[]}}],repeatable:false};
 const npc={id:'scout',name:'Scout',quests:['scout_quest'],dialogue:[{id:'hello',text:'Hello',next:'close',actions:[]}]};
 const quest={id:'scout_quest',name:'Visit scout',givers:['scout'],turn_in:{mode:'journal'},stages:[{id:'visit',objectives:[{id:'win',type:'kill',target:Object.keys(live.published().monsters)[0]}],next:'complete'}]};
 transaction(()=>api.world.flows.gm({action:'flow_publish',id:entry.id,entry,revision:0,assets:[{kind:'npc',id:npc.id,entry:npc,revision:0},{kind:'quest',id:quest.id,entry:quest,revision:0}]},'gm'));
 const map=api.world.map('honeydew-lantern');let placed;
 for(let y=2;y<map.floor.height-2&&!placed;y++)for(let x=2;x<map.floor.width-2&&!placed;x++)try{placed=api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'npc',content:'scout',x,y});}catch(e){if(!/reachable tile/.test(e.message))throw e;}
 const at=placed.placements.find(p=>p.content==='scout');
 const talk=()=>{db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(at.x+1,at.y,c.id);return act('npc_talk',{placement:at.id,edition:map.edition});};
 const progress=api.world.progress,gm=(action,extra={})=>{const r=progress.act({action,character_id:c.id,revision:progress.detail(c.id).character.revision,...extra});c=api.read('',c.id).character;return r;};
 return {db,act,talk,progress,gm,paid,id:()=>c.id,character:()=>c,close:()=>{db.close();process.env.QUEST_FLOWS_ENABLED=prior;}};
}

test('a finished one-time story can be replayed and its flag cleared from the panel',()=>{
 const f=fixture();try{
  let r=f.talk();assert.equal(r.flowScene.text,'Help the scout.');r=f.act('flow_continue',{flow_run:r.flowScene.id,flow_step:r.flowScene.step});
  assert.equal(f.character().fullDungeon.flags.story_helped,true);
  r=f.talk();assert.equal(r.flowScene,null,'the one-time story is used up');f.act('npc_close');
  let d=f.progress.detail(f.id());assert.deepEqual(d.stories.find(s=>s.id==='scout_story'),{id:'scout_story',name:'Scout story',repeatable:false,runs:1,status:'finished'});
  assert.deepEqual(d.flags.authored.find(x=>x.id==='story_helped').value,true);
  d=f.gm('progress_story_replay',{flow:'scout_story'});assert.match(d.message,/play again/);assert.equal(d.stories.find(s=>s.id==='scout_story').runs,0);
  d=f.gm('progress_flag_clear',{flag:'story_helped',kind:'flag'});assert.equal(d.flags.authored.find(x=>x.id==='story_helped').value,null,'cleared = unset');
  r=f.talk();assert.equal(r.flowScene?.text,'Help the scout.','the same event runs a second time');
  assert.throws(()=>f.gm('progress_story_replay',{flow:'nope'}),/not played/);
 }finally{f.close();}
});

test('flags: authored set true/false, engine memory is clear-only, stale revisions are refused',()=>{
 const f=fixture();try{
  let d=f.gm('progress_flag_set',{flag:'story_helped',value:true});assert.equal(d.flags.authored[0].value,true);
  d=f.gm('progress_flag_set',{flag:'story_helped',value:false});assert.equal(d.flags.authored[0].value,false);
  assert.throws(()=>f.gm('progress_flag_set',{flag:'visited:1',value:true}),/Engine achievements/);
  f.db.prepare('UPDATE quest_characters SET state=json_set(state,\'$.fullDungeon.flags."visited:1"\',json(\'true\'),\'$.fullDungeon.once.boss_speech\',json(\'true\')) WHERE id=?').run(f.id()); // What campaign play leaves behind.
  d=f.progress.detail(f.id());assert.deepEqual(d.flags.engine,[{id:'visited:1',value:true}]);assert.deepEqual(d.flags.once,['boss_speech']);
  d=f.gm('progress_flag_clear',{flag:'visited:1',kind:'flag'});d=f.gm('progress_flag_clear',{flag:'boss_speech',kind:'once'});
  assert.deepEqual(d.flags.engine,[]);assert.deepEqual(d.flags.once,[]);
  assert.throws(()=>f.gm('progress_flag_clear',{flag:'boss_speech',kind:'once'}),/does not have/);
  const rev=f.progress.detail(f.id()).character.revision;
  assert.throws(()=>f.progress.act({action:'progress_flag_set',character_id:f.id(),revision:rev-1,flag:'story_helped',value:true}),/changed/);
 }finally{f.close();}
});

test('quests: start, complete, finish without rewards, then remove so it can be taken again',()=>{
 const f=fixture();try{
  let d=f.gm('progress_quest',{quest:'scout_quest',op:'start'});assert.equal(d.quests.find(q=>q.id==='scout_quest').status,'active');
  d=f.gm('progress_quest',{quest:'scout_quest',op:'complete'});assert.equal(d.quests.find(q=>q.id==='scout_quest').status,'ready');
  d=f.gm('progress_quest',{quest:'scout_quest',op:'finish'});assert.equal(d.quests.find(q=>q.id==='scout_quest').status,'claimed');
  assert.equal(f.paid.length,0,'finish pays nothing');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quest_claims WHERE character_id=?').get(f.id()).n,1,'prerequisites see it as done');
  d=f.gm('progress_quest',{quest:'scout_quest',op:'remove'});assert.equal(d.quests.find(q=>q.id==='scout_quest').status,'');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quest_claims WHERE character_id=?').get(f.id()).n,0);
  d=f.gm('progress_quest',{quest:'scout_quest',op:'finish'});assert.equal(d.quests.find(q=>q.id==='scout_quest').status,'claimed','finish also works on a quest never taken');
  assert.throws(()=>f.gm('progress_quest',{quest:'scout_quest',op:'explode'}),/Choose start/);
 }finally{f.close();}
});

test('the /gm/progress route and progress_* actions are staff-only, audited and replay-safe',async()=>{
 const staff='s'.repeat(43),player='p'.repeat(43),service=createQuestService({walletClient:{authenticate:async token=>({owner:token===staff?'staff':'player',gamemaster:token===staff,client:'lidollquest',coins:0,scope:'social:read'})}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port,auth=t=>({Authorization:'Bearer '+t});
 try{
  service.db.prepare('INSERT INTO quest_characters(id,owner,name,created,revision,state,creation_id) VALUES (?,?,?,?,?,?,?)').run('char-test-1','tester','Test Doll',1,3,'{}','c1');
  assert.equal((await fetch(base+'/gm/progress?q=Test',{headers:auth(player)})).status,403);
  const found=await (await fetch(base+'/gm/progress?q=Test',{headers:auth(staff)})).json();assert.deepEqual(found.characters.map(c=>c.id),['char-test-1']);
  const detail=(await (await fetch(base+'/gm/progress?character=char-test-1',{headers:auth(staff)})).json()).detail;assert.equal(detail.character.revision,3);
  service.db.prepare("INSERT INTO quest_characters(id,owner,name,created,revision,state,creation_id) VALUES ('char-test-2','tester','Other',2,0,?, 'c2')").run(JSON.stringify({fullDungeon:{flags:{'visited:3':true},once:{}}}));
  const body={action:'progress_flag_clear',request_id:randomUUID(),character_id:'char-test-2',revision:0,flag:'visited:3',kind:'flag'};
  const send=()=>fetch(base+'/gm/action',{method:'POST',headers:{...auth(staff),'Content-Type':'application/json'},body:JSON.stringify(body)});
  const a=await send(),b=await send();assert.equal(a.status,200);assert.deepEqual(await a.json(),await b.json(),'a retried click replays the receipt');
  assert.equal(service.db.prepare('SELECT revision FROM quest_characters WHERE id=?').get('char-test-2').revision,1,'applied once');
  assert.equal(service.db.prepare('SELECT COUNT(*) n FROM gm_audit WHERE action=?').get('progress_flag_clear').n,1);
  const page=await (await fetch(base+'/gm')).text();assert.match(page,/Test progress: flags, quests/);new Function(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
 }finally{await new Promise(resolve=>service.server.close(resolve));}
});
