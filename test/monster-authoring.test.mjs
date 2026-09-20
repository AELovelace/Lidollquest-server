import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createWorldContent} from '../server/world-content.mjs';
import {createWorldJobs} from '../server/world-jobs.mjs';
import {defaultScenes,resolvedDefeat,compiledArtwork,pinDefeat} from '../server/defeat-scenes.mjs';
import {defeatPresentation} from '../server/combat.mjs';
const tiny='iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAN0lEQVR4nO3QQREAMAgDQYofTCKxhspUBZ+NgcvsudUvFpebcQcIECBAgAABAgQIECBAgACBTzBf6ALAS4QDIwAAAABJRU5ErkJggg==';
const monster={id:'test_monster',enemy_id:'goblin',name:'Test',hp:20,str:4,def:2,dex:3,exp:5,sprite:'',battle_sprite:'',roaming:false};
function fixture(){const db=new DatabaseSync(':memory:'),live=createWorldContent(db);const row=live.change({action:'content_save',kind:'monster',id:monster.id,revision:0,entry:monster},'dm');return {db,live,row};}

test('defaults retain every variant without creating overrides on stat saves; old scenes and rollback remain valid',()=>{
 const {db,live,row}=fixture();try{
  assert.equal(row.defeat_source,'Game default');assert.equal(row.effective_defeat.first.dialogues.length,3);assert.ok(row.effective_defeat.repeat.dialogues[0].pages.length);assert.equal(row.draft.defeat,undefined);
  let current=live.change({action:'content_publish',kind:'monster',id:monster.id,revision:row.revision,entry:{...row.draft,hp:99}},'dm');assert.equal(current.draft.defeat,undefined);assert.ok(live.published().monsters.test_monster.defeat_ref);
  const pinned=pinDefeat(structuredClone(live.published().monsters.test_monster));const first=defeatPresentation({id:'battle-123',kind:'hub_event',enemy:pinned},'defeat');assert.ok(first.defeatScene.content.first.dialogue.length);
  current=live.change({action:'content_publish',kind:'monster',id:monster.id,revision:current.revision,entry:{...current.draft,defeat:{first:{dialogue:[{text:'Custom scene',next:'close'}],aftermath:[]}}}},'dm');assert.equal(current.defeat_source,'Admin override');assert.equal(live.published().monsters.test_monster.defeat.first.dialogue[0].text,'Custom scene');assert.deepEqual(defeatPresentation({id:'battle-123',kind:'hub_event',enemy:pinned},'defeat'),first);
  current=live.change({action:'content_rollback',kind:'monster',id:monster.id,revision:current.revision,target_revision:2},'dm');assert.equal(current.defeat_source,'Game default');assert.equal(createWorldContent(db).entry('monster',monster.id).effective_defeat.first.dialogues.length,3);
 }finally{db.close();}
});

test('every exported default validates, numeric branches normalize, and large bounded scenes publish',()=>{
 const {db,live}=fixture();try{
  for(const [enemy_id,defeat] of Object.entries(defaultScenes))live.change({action:'content_save',kind:'monster',id:monster.id,revision:live.entry('monster',monster.id).revision,entry:{...monster,enemy_id,defeat}},'dm');
  const pages=Array.from({length:8},(_,i)=>({id:'p'+i,text:'A'.repeat(3000),next:i===7?'close':i+1}));const saved=live.change({action:'content_publish',kind:'monster',id:monster.id,revision:live.entry('monster',monster.id).revision,entry:{...monster,defeat:{first:{dialogue:pages}}}},'dm');assert.equal(saved.draft.defeat.first.dialogue[0].next,'p1');
  assert.throws(()=>live.change({action:'content_save',kind:'monster',id:monster.id,revision:saved.revision,entry:{...monster,defeat:{first:{dialogue:[{text:'Bad',next:99}]}}}},'dm'),/unknown page/);
  for(const [key,asset] of Object.entries(compiledArtwork))assert.deepEqual(live.asset(key),asset);
 }finally{db.close();}
});

test('scene selection is stable across receipts and charm outcomes use their own variants',()=>{
 const value=Object.values(defaultScenes).find(v=>v.charm);assert.ok(value);const a=resolvedDefeat(value,'receipt','charm_backfire');assert.deepEqual(a,resolvedDefeat(value,'receipt','charm_backfire'));assert.equal(a.first.dialogue_variant,'charm');assert.deepEqual(a.first,a.repeat);
});

test('historical default references survive restart and are pinned independently of the current export',()=>{
 const {db,live}=fixture();try{const old=structuredClone(defaultScenes.goblin);old.first.dialogues[0].pages[0].text='Earlier release';const body=JSON.stringify(old),hash=createHash('sha256').update(body).digest('hex');db.prepare('INSERT INTO world_default_scenes VALUES (?,?)').run(hash,body);createWorldContent(db);const pinned=pinDefeat({...monster,defeat_ref:hash});assert.equal(pinned.defeat.first.dialogues[0].pages[0].text,'Earlier release');assert.notEqual(live.entry('monster',monster.id).effective_defeat.first.dialogues[0].pages[0].text,'Earlier release');}finally{db.close();}
});

function generation(){
 const f=fixture(),posts=[],downloads=[];let portraitFails=false,networkFails=false;
 const put=f.live.putAsset;f.live.putAsset=v=>put({...v,frames:1}); // Asset encoding has separate PNG tests; isolate provider orchestration here.
 const options={live:f.live,token:'test',download:async input=>{downloads.push(input.stage);return {png:tiny,reference:tiny};},fetcher:async(url,options)=>{
  if(options.method==='POST'){posts.push(url.split('/').pop());if(networkFails)throw Error('Network disconnected');return {ok:true,json:async()=>({background_job_id:url.split('/').pop(),character_id:'character-1'})};}
  return {ok:true,json:async()=>({status:portraitFails&&url.endsWith('generate-image-v2')?'failed':'completed',last_response:{character_id:'character-1',images:[{base64:tiny}]}})};
 }};
 let jobs=createWorldJobs(f.db,options);const job=()=>jobs.list()[0];const action=(name,extra={})=>jobs.act({action:name,id:job().id,job_revision:job().job_revision,...extra},'dm');
 return {...f,posts,downloads,job,action,queue(){jobs.act({action:'art_generate',monster:monster.id,revision:f.row.revision,prompt:'Test monster'},'dm');},pump:()=>jobs.pump(),restart(){jobs.close();jobs=createWorldJobs(f.db,options);},portraitFails:v=>portraitFails=v,networkFails:v=>networkFails=v,close(){jobs.close();f.db.close();}};
}
test('design approval gates paid stages; portrait retry retains walking and assignment only saves the draft',async()=>{
 const f=generation();try{f.queue();await f.pump();assert.equal(f.job().status,'awaiting_approval');assert.deepEqual(f.posts,['create-character-with-4-directions']);await f.pump();assert.equal(f.posts.length,1);f.restart();assert.equal(f.job().status,'awaiting_approval');f.action('art_approve');await f.pump();assert.ok(f.job().walking);assert.equal(f.job().stage,'portrait');f.portraitFails(true);await f.pump();assert.equal(f.job().status,'failed');f.portraitFails(false);f.action('art_retry');await f.pump();assert.equal(f.job().status,'complete');assert.deepEqual(f.downloads,['design','walking']);assert.equal(f.posts.filter(p=>p==='animate-character').length,1);
  assert.throws(()=>f.action('art_assign',{revision:0,portrait:f.job().portraits[0].id}),/changed/);f.action('art_assign',{revision:f.row.revision,portrait:f.job().portraits[0].id});const row=f.live.entry('monster',monster.id);assert.ok(row.draft.sprite.startsWith('managed-'));assert.equal(row.published,null);
 }finally{f.close();}
});
test('ambiguous submissions require explicit review, survive restart and never automatically spend again',async()=>{
 const f=generation();try{f.networkFails(true);f.queue();await f.pump();assert.equal(f.job().status,'needs_review');f.restart();await f.pump();assert.equal(f.posts.length,1);assert.throws(()=>f.action('art_retry'),/explicitly confirm/);f.networkFails(false);f.action('art_retry',{confirm_resubmit:true});await f.pump();assert.equal(f.job().status,'awaiting_approval');assert.equal(f.posts.length,2);}finally{f.close();}
});
test('cancelled design retains its asset and cannot be approved or submit animation',async()=>{
 const f=generation();try{f.queue();await f.pump();const asset=f.job().design.id;f.action('art_cancel');await f.pump();assert.equal(f.job().design.id,asset);assert.equal(f.job().status,'cancelled');assert.throws(()=>f.action('art_approve'),/not waiting/);assert.equal(f.posts.length,1);}finally{f.close();}
});
test('restart polls known submissions rather than repeating generation',async()=>{
 const f=generation();try{f.queue();await f.pump();f.action('art_approve');await f.pump();const raw=f.db.prepare('SELECT details FROM world_art_jobs WHERE id=?').get(f.job().id),details=JSON.parse(raw.details);details.jobs=['generate-image-v2'];f.db.prepare("UPDATE world_art_jobs SET status='running',details=? WHERE id=?").run(JSON.stringify(details),f.job().id);f.restart();await f.pump();assert.equal(f.job().status,'complete');assert.equal(f.posts.filter(p=>p==='generate-image-v2').length,0);}finally{f.close();}
});
