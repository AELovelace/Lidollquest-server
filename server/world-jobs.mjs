import {randomUUID} from 'node:crypto';
import {pythonSpriteProvider} from './private-sprites.mjs';
const fail=message=>{throw Object.assign(Error(message),{status:400,code:'world_generation_failed'});};
export function createWorldJobs(db,{live,now=Date.now,walkProvider=pythonSpriteProvider(),token=process.env.PIXELLAB_API_TOKEN,fetcher=fetch}={}){
 db.exec('CREATE TABLE IF NOT EXISTS world_art_jobs(id TEXT PRIMARY KEY,prompt TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,walking TEXT,reference TEXT,portraits TEXT,provider_job TEXT,error TEXT,created INTEGER NOT NULL)');
 db.prepare("UPDATE world_art_jobs SET status='failed',error='Walking generation was interrupted. Check provider usage before retrying.' WHERE status='running' AND stage='walking'").run();
 db.prepare("UPDATE world_art_jobs SET status='queued' WHERE status='running' AND stage='portrait' AND provider_job IS NOT NULL").run();
 db.prepare("UPDATE world_art_jobs SET status='failed',error='Portrait submission was interrupted. Check provider usage before retrying.' WHERE status='running' AND stage='portrait'").run();
 let busy=false,closed=false,controller=null,activeId=null;
 const get=id=>db.prepare('SELECT * FROM world_art_jobs WHERE id=?').get(id);
 function list(){return db.prepare('SELECT id,prompt,status,stage,walking,portraits,error,created FROM world_art_jobs ORDER BY created DESC LIMIT 100').all().map(r=>({...r,walking:r.walking?JSON.parse(r.walking):null,portraits:r.portraits?JSON.parse(r.portraits):[]}));}
 function act(input){
  if(input.action==='art_generate'){
   if(!walkProvider||!token)fail('Sprite generation is not configured on the server.');
   if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>2000)fail('Describe the monster in up to 2,000 characters.');
   if(db.prepare("SELECT COUNT(*) n FROM world_art_jobs WHERE status IN ('queued','running')").get().n>=20)fail('The generation queue is full.');
   const id=randomUUID();db.prepare("INSERT INTO world_art_jobs VALUES (?,?,'queued','walking',NULL,NULL,NULL,NULL,NULL,?)").run(id,input.prompt.trim(),now());return {id};
  }
  const job=get(input.id);if(!job)fail('Generation job not found.');
  if(input.action==='art_cancel'){db.prepare("UPDATE world_art_jobs SET status='cancelled' WHERE id=? AND status IN ('running','queued')").run(job.id);if(activeId===job.id)controller?.abort();return {id:job.id};}
  if(input.action!=='art_retry'||job.status!=='failed')fail('Choose a failed job to retry.');
  db.prepare("UPDATE world_art_jobs SET status='queued',error=NULL WHERE id=?").run(job.id);return {id:job.id};
 }
 async function request(path,body){
  const response=await fetcher('https://api.pixellab.ai/v2/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
  if(!response.ok)throw Error('PixelLab HTTP '+response.status);return response.json();
 }
 async function pump(){if(busy||closed)return;const job=db.prepare("SELECT * FROM world_art_jobs WHERE status='queued' ORDER BY created LIMIT 1").get();if(!job)return;busy=true;activeId=job.id;controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),30*60000);timeout.unref();
  try{
   db.prepare("UPDATE world_art_jobs SET status='running' WHERE id=?").run(job.id);
   if(job.stage==='walking'){
    const result=await walkProvider(job.prompt,controller.signal);if(closed||get(job.id).status==='cancelled')return;
    if(!result.reference)throw Error('Update the sprite worker to include reference artwork.');
    const walking=live.putAsset({png:result.png,frames:36});
    db.prepare("UPDATE world_art_jobs SET walking=?,reference=?,stage='portrait' WHERE id=?").run(JSON.stringify(walking),result.reference,job.id);
   }
   const current=get(job.id);let providerJob=current.provider_job;
   if(!providerJob){const result=await request('generate-image-v2',{description:job.prompt.slice(0,1850)+', matching monster battle portrait, full body, transparent background',image_size:{width:128,height:128},no_background:true,reference_images:[{image:{base64:current.reference},size:{width:64,height:64}}]});providerJob=result.background_job_id;if(!providerJob)throw Error('PixelLab did not return a portrait job ID.');db.prepare('UPDATE world_art_jobs SET provider_job=? WHERE id=?').run(providerJob,job.id);}
   const result=await request('background-jobs/'+encodeURIComponent(providerJob));if(closed||get(job.id).status==='cancelled')return;
   if(result.status==='failed'){db.prepare('UPDATE world_art_jobs SET provider_job=NULL WHERE id=?').run(job.id);throw Error('PixelLab portrait generation failed. Retrying submits a new portrait job.');}
   if(result.status!=='completed'){db.prepare("UPDATE world_art_jobs SET status='queued' WHERE id=?").run(job.id);return;}
   const raw=result.last_response?.images??[];const portraits=raw.map(v=>live.putAsset({png:(v.base64??v.image?.base64??'').replace(/^data:image\/png;base64,/,''),frames:1}));
   if(!portraits.length)throw Error('PixelLab returned no portrait candidates.');db.prepare("UPDATE world_art_jobs SET status='complete',portraits=? WHERE id=?").run(JSON.stringify(portraits),job.id);
  }catch(error){if(!closed&&get(job.id)?.status!=='cancelled')db.prepare("UPDATE world_art_jobs SET status='failed',error=? WHERE id=?").run(String(error.message??'Generation failed.').slice(0,240),job.id);}
  finally{clearTimeout(timeout);busy=false;controller=null;activeId=null;}
 }
 const timer=setInterval(()=>void pump(),5000);timer.unref();return {list,act,pump,close(){closed=true;clearInterval(timer);controller?.abort();}};
}
