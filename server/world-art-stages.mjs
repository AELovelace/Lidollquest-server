import {randomUUID} from 'node:crypto';
import {pythonSpriteProvider} from './private-sprites.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,code:'world_generation_failed'});};
export function createStagedArt(db,{live,now,token,fetcher,download=pythonSpriteProvider({admin:true,token})}){
 if(!db.prepare('PRAGMA table_info(world_art_jobs)').all().some(c=>c.name==='details'))db.exec('ALTER TABLE world_art_jobs ADD COLUMN details TEXT');
 const get=id=>db.prepare('SELECT * FROM world_art_jobs WHERE id=?').get(id);
 function update(id,changes){const keys=Object.keys(changes);db.prepare('UPDATE world_art_jobs SET '+keys.map(k=>k+'=?').join(',')+' WHERE id=?').run(...keys.map(k=>changes[k]),id);}
 function meta(job){return JSON.parse(job.details);}
 function save(job,m,changes={}){m.revision++;update(job.id,{details:JSON.stringify(m),...changes});}
 for(const job of db.prepare("SELECT * FROM world_art_jobs WHERE details IS NOT NULL AND status='running'").all()){
  const m=meta(job);update(job.id,{status:m.submitting?'needs_review':'queued',error:m.submitting?'Submission was interrupted. Review provider usage before explicitly resubmitting.':null});
 }
 function checkMonster(input){const row=live.entry('monster',input.monster);if(row.revision!==input.revision)fail('This draft changed. Save or reload it before generating artwork.',409);if(!row.revision)fail('Save this monster draft before generating artwork.');return row;}
 function act(input,actor){
  if(input.action==='art_generate'&&input.monster){
   checkMonster(input);if(!token||!download)fail('Sprite generation is not configured on the server.');
   if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>2000)fail('Describe the monster in up to 2,000 characters.');
   if(db.prepare("SELECT COUNT(*) n FROM world_art_jobs WHERE status IN ('queued','running')").get().n>=20)fail('The generation queue is full.');
   for(const prior of db.prepare("SELECT details FROM world_art_jobs WHERE details IS NOT NULL AND status IN ('queued','running')").all())if(meta(prior).monster===input.monster)fail('This monster already has artwork in progress. Wait for it or cancel it before starting another.');
   const id=randomUUID(),details={monster:input.monster,draft_revision:input.revision,revision:1,animation:'lidoll-walk-'+randomUUID(),jobs:[],directions:[],submitting:false};
   db.prepare("INSERT INTO world_art_jobs(id,prompt,status,stage,created,details) VALUES (?,?,'queued','design',?,?)").run(id,input.prompt.trim(),now(),JSON.stringify(details));return {id};
  }
  const job=typeof input.id==='string'?get(input.id):null;if(!job?.details)return undefined;const m=meta(job);
  if(input.job_revision!==m.revision)fail('This generation job changed. Refresh its progress.',409);
  if(input.action==='art_assign'){
   const row=checkMonster({...input,monster:m.monster}),portraits=JSON.parse(job.portraits??'[]');
   if(!job.walking||!portraits.some(p=>p.id===input.portrait))fail('Choose a completed walking sprite and portrait candidate.');
   return live.change({action:'content_save',kind:'monster',id:m.monster,revision:row.revision,entry:{...row.draft,sprite:JSON.parse(job.walking).id,battle_sprite:input.portrait}},actor);
  }
  if(input.action==='art_approve'){
   if(job.status!=='awaiting_approval')fail('This design is not waiting for approval.');
   m.approved=true;m.jobs=[];save(job,m,{status:'queued',stage:'walking',error:null});return {id:job.id};
  }
  if(input.action==='art_cancel'){save(job,m,{status:'cancelled'});return {id:job.id};} // Completed assets remain available; cancellation prevents further submissions.
  if(input.action==='art_retry'){
   if(!['failed','needs_review'].includes(job.status))fail('Choose a failed stage.');
   if(job.status==='needs_review'&&input.confirm_resubmit!==true)fail('Review provider usage, then explicitly confirm a new paid submission.');
   m.submitting=false;save(job,m,{status:'queued',error:null});return {id:job.id};
  }
  fail('Unknown artwork action.');
 }
 async function pump(job,signal,stopped){
  let m=meta(job);const active=()=>!stopped()&&get(job.id).status!=='cancelled';
  async function request(path,body){const r=await fetcher('https://api.pixellab.ai/v2/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal});if(!r.ok){const e=Error('PixelLab HTTP '+r.status);e.rejected=r.status>=400&&r.status<500;throw e;}return r.json();}
  async function submit(path,body){
   m.submitting=true;save(job,m); // Persist ambiguity before crossing the provider boundary.
   let result;try{result=await request(path,body);}catch(error){if(error.rejected){m.submitting=false;save(job,m);}throw error;}
   m.jobs=result.background_job_ids??(result.background_job_id?[result.background_job_id]:[]);m.directions=result.directions??[];m.character=result.character_id??m.character;
   if(!m.jobs.length)throw Error('Provider returned no job ID. Review usage before resubmitting.');
   m.submitting=false;save(job,m); // Record accepted IDs even if cancellation arrived while the response was in flight.
  }
  async function completed(){const results=[];for(const id of m.jobs){const r=await request('background-jobs/'+encodeURIComponent(id));if(r.status==='failed'){m.jobs=[];save(job,m);throw Error('PixelLab '+job.stage+' failed. Retrying submits a new job for this stage.');}if(r.status!=='completed')return null;results.push(r);}return results;}
  try{
   update(job.id,{status:'running',error:null});
   if(job.stage==='design'){
    if(!m.jobs.length)await submit('create-character-with-4-directions',{description:job.prompt,image_size:{width:64,height:64},outline:'thin',shading:'flat',detail:'medium',view:'high top-down'});
    if(!active())return;const results=await completed();if(!active())return;if(!results){update(job.id,{status:'queued'});return;}
    m.character=m.character??results[0].last_response?.character_id??results[0].output?.character_id??results[0].character_id;if(!m.character)throw Error('Completed design has no character ID.');save(job,m);
    const art=await download({stage:'design',character:m.character},signal);if(!active())return;
    m.design=live.putAsset({png:art.png,frames:1});save(job,m,{reference:art.reference,status:'awaiting_approval'});return;
   }
   if(job.stage==='walking'){
    if(!m.approved)fail('Approve a design before animating.');
    if(!m.jobs.length)await submit('animate-character',{character_id:m.character,mode:'v3',action_description:'walking, smooth looping walk cycle, in place',frame_count:8,keep_first_frame:false,animation_name:m.animation,directions:['south','north','east','west']});
    if(!active())return;const results=await completed();if(!active())return;if(!results){update(job.id,{status:'queued'});return;}
    const art=await download({stage:'walking',character:m.character,animation:m.animation,jobs:m.jobs,directions:m.directions},signal);if(!active())return;
    const walking=live.putAsset({png:art.png,frames:36});m.jobs=[];save(job,m,{walking:JSON.stringify(walking),stage:'portrait',status:'queued'});return;
   }
   if(!m.jobs.length)await submit('generate-image-v2',{description:job.prompt.slice(0,1850)+', matching monster battle portrait, full body, transparent background',image_size:{width:128,height:128},no_background:true,reference_images:[{image:{base64:job.reference},size:{width:64,height:64}}]});
   if(!active())return;const results=await completed();if(!active())return;if(!results){update(job.id,{status:'queued'});return;}
   const portraits=(results[0].last_response?.images??[]).map(v=>live.putAsset({png:(v.base64??v.image?.base64??'').replace(/^data:image\/png;base64,/,''),frames:1}));
   if(!portraits.length)throw Error('PixelLab returned no portrait candidates.');save(job,m,{portraits:JSON.stringify(portraits),status:'complete'});
  }catch(error){if(active())update(job.id,{status:m.submitting?'needs_review':'failed',error:(error.diagnostic?'Artwork download failed: '+error.diagnostic.code+' ('+error.diagnostic.stage+').':String(error.message)).slice(0,240)});}
 }
 function publicFields(job){if(!job.details)return {};const m=meta(job);return {monster:m.monster,job_revision:m.revision,design:m.design??null,approved:!!m.approved};}
 return {act,pump,publicFields};
}
