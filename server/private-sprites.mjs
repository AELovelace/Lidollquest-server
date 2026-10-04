import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
const fail=(status,message,code='private_sprite_failed')=>{throw Object.assign(Error(message),{status,code});};
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const reserved=['charging','queued','running','ready'];
const diagnosticCodes=new Set(['python_dependency_missing','python_unavailable','worker_missing','worker_start_failed','worker_timeout','provider_http_error','provider_timeout','provider_network_error','incomplete_animation','invalid_sprite_output','generation_failed']);
const diagnosticStages=new Set(['startup','create','fetch','animate','pack']);
function safeDiagnostic(value){const result={code:diagnosticCodes.has(value?.code)?value.code:'generation_failed',stage:diagnosticStages.has(value?.stage)?value.stage:'startup'};if(Number.isInteger(value?.http_status)&&value.http_status>=400&&value.http_status<=599)result.http_status=value.http_status;if(result.code==='incomplete_animation')for(const key of ['idle_count','south','north','east','west'])if(Number.isInteger(value?.[key])&&value[key]>=0&&value[key]<=256)result[key]=value[key];return result;} // Log only fixed labels, an HTTP status and bounded frame counts; never arbitrary Python/provider messages.
const generationError=diagnostic=>Object.assign(Error('Sprite generation failed'),{diagnostic:safeDiagnostic(diagnostic)});
export function pythonSpriteProvider({python=process.env.PIXELLAB_PYTHON??'python3',token=process.env.PIXELLAB_API_TOKEN,spawnWorker=spawn,admin=false}={}){
 if(!token)return null;
 return (prompt,signal)=>new Promise((resolve,reject)=>{
  const workerPath=fileURLToPath(new URL(admin?'../python/world_art_worker.py':'../python/private_sprite_worker.py',import.meta.url));
  if(!existsSync(workerPath))return reject(generationError({code:'worker_missing',stage:'startup'}));
  const child=spawnWorker(python,[workerPath],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PIXELLAB_API_TOKEN:token},signal});
  let result='',stderr='',size=0,failure=null;const timer=setTimeout(()=>{failure={code:'worker_timeout'};child.kill();},30*60000);timer.unref();
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>280000){failure={code:'invalid_sprite_output',stage:'pack'};child.kill();}else result+=chunk;});
  child.stderr.on('data',chunk=>{if(stderr.length<8192)stderr+=chunk.toString().slice(0,8192-stderr.length);}); // Bound diagnostics even if an interpreter or dependency prints a long traceback.
  child.on('error',error=>{clearTimeout(timer);reject(generationError({code:error.code==='ENOENT'?'python_unavailable':'worker_start_failed',stage:'startup'}));});
  child.on('close',code=>{clearTimeout(timer);if(code!==0||failure){let diagnostic=failure;for(const line of stderr.split('\n')){try{const parsed=JSON.parse(line);if(!diagnostic&&parsed?.error)diagnostic=safeDiagnostic(parsed.error);}catch{}}return reject(generationError(diagnostic));}try{resolve(JSON.parse(result));}catch{reject(generationError({code:'invalid_sprite_output',stage:'pack'}));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(admin?prompt:{prompt}));
 });
} // Only the service process receives the provider key; subprocess arguments and browser packets contain no credentials.

// The paid player generator and its artwork are retired. Only historical receipt settlement remains.
export function createPrivateSprites(db,{walletClient,now=Date.now}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_private_sprites(id TEXT PRIMARY KEY,owner TEXT NOT NULL,character_id TEXT NOT NULL DEFAULT '',request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,png TEXT,created INTEGER NOT NULL,UNIQUE(owner,request_id));
 CREATE INDEX IF NOT EXISTS quest_private_sprite_slots ON quest_private_sprites(owner,character_id,status);`);
 db.prepare("UPDATE quest_private_sprites SET status='refunding' WHERE status IN ('running','queued')").run(); // Already-paid unfinished jobs refund after the owner's next authorized login.
 db.exec(`BEGIN IMMEDIATE;
 UPDATE quest_characters SET state=json_set(state,'$.avatar',CASE WHEN json_type(state,'$.look')='object' THEN 'look' ELSE 'player' END),revision=revision+1 WHERE json_extract(state,'$.avatar') LIKE 'private-%';
 UPDATE quest_private_sprites SET png=NULL,status=CASE WHEN status='ready' THEN 'retired' ELSE status END;
 COMMIT;`); // Idempotent retirement: remove old artwork and current selections, preserving look/setup and purchase receipt identities.
 const settling=new Map();let closed=false;
 const row=id=>db.prepare('SELECT * FROM quest_private_sprites WHERE id=?').get(id);
 const debitId=r=>'sprite-'+createHash('sha256').update(r.owner+':'+r.request_id).digest('hex');
 function character(owner,id){if(id==='')return;if(!identifier(id)||!db.prepare('SELECT 1 FROM quest_characters WHERE owner=? AND id=?').get(owner,id))fail(404,'Character not found.');}
 function list(owner,id=''){
  character(owner,id);
  const rows=db.prepare("SELECT id,status,created FROM quest_private_sprites WHERE owner=? AND character_id=? AND status!='deleted' ORDER BY created DESC,id LIMIT 25").all(owner,id);
  return {enabled:false,retired:true,cost:0,limit:0,character_id:id,latestStatus:rows[0]?.status??'',used:rows.filter(r=>reserved.includes(r.status)).length,sprites:rows.map(r=>({...r,name:'Retired sprite receipt '+r.id.slice(8,14)}))};
 } // Legacy clients can still reconcile their saved request without seeing a generation offer.
 async function settle(id,token){
  if(settling.has(id))return settling.get(id);
  const task=(async()=>{
   let r=row(id);if(closed||!r||!['charging','refunding'].includes(r.status))return;
   if(r.status==='charging'){
    try{await walletClient.diamonds(token,{request_id:debitId(r),asset:'diamonds',kind:'debit',amount:1});}
    catch(e){if(e.code==='insufficient_balance'){if(!closed)db.prepare("UPDATE quest_private_sprites SET status='insufficient' WHERE id=?").run(id);return;}throw e;}
    if(closed)return;db.prepare("UPDATE quest_private_sprites SET status='refunding' WHERE id=?").run(id);
   } // Replaying an existing ambiguous debit establishes the original receipt; no new generation can create one.
   r=row(id);
   await walletClient.diamonds(token,{request_id:'refund-'+debitId(r),asset:'diamonds',kind:'refund',original_id:debitId(r)});
   if(!closed)db.prepare("UPDATE quest_private_sprites SET status='refunded',png=NULL WHERE id=?").run(id);
  })();settling.set(id,task);try{await task;}finally{settling.delete(id);}
 } // Durable original debit/refund IDs make retries safe after lost responses or restarts.
 async function recover(owner,token){for(const r of db.prepare("SELECT id FROM quest_private_sprites WHERE owner=? AND status IN ('charging','refunding')").all(owner))await settle(r.id,token);}
 async function act(owner,token,input){
  if(!input||!identifier(input.request_id)||typeof input.character_id!=='string'||!['generate','delete'].includes(input.action))fail(400,'Choose a sprite action.');
  const cid=input.character_id;character(owner,cid);
  if(input.action==='generate'){
   const old=db.prepare('SELECT * FROM quest_private_sprites WHERE owner=? AND request_id=?').get(owner,input.request_id);
   if(!old)fail(410,'The premium sprite generator has retired. Use the Sprite Workshop or Wardrobe.','sprite_generator_retired');
   if(old.fingerprint!==JSON.stringify([cid,typeof input.prompt==='string'?input.prompt.trim():'']))fail(409,'This request ID belongs to another generation.');
   await settle(old.id,token);return list(owner,row(old.id).character_id);
  } // Only historical request replays survive; there is no provider call, job insertion or new charge path.
  db.exec('BEGIN IMMEDIATE');try{
   const r=row(input.sprite_id);if(!r||r.owner!==owner||r.character_id!==cid)fail(404,'Sprite not found.');
   if(r.status!=='deleted'){
    if(!['retired','refunded','insufficient'].includes(r.status))fail(409,'Wait for the old generation refund before deleting this sprite.');
    db.prepare("UPDATE quest_private_sprites SET status='deleted',png=NULL WHERE id=?").run(r.id);
    if(cid){const c=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(cid),state=JSON.parse(c.state);if(state.avatar===r.id){state.avatar=state.look?'look':'player';db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),cid);}}
   }
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}return list(owner,cid);
 }
 function authorize(){fail(410,'Private sprites have retired. Use the Wardrobe.','sprite_generator_retired');}
 function claimDraft(){} // Creation replay records remain intact; no retired artwork can be selected or transferred.
 function asset(){fail(410,'Private sprite artwork is no longer available.','sprite_art_retired');}
 function blockDeletion(cid){if(db.prepare("SELECT 1 FROM quest_private_sprites WHERE character_id=? AND status IN ('charging','refunding')").get(cid))fail(409,'Wait for the old sprite refund before deleting this character.');}
 function deleteCharacter(cid){db.prepare("UPDATE quest_private_sprites SET status='deleted',png=NULL WHERE character_id=?").run(cid);}
 return {list,act,recover,authorize,claimDraft,asset,blockDeletion,deleteCharacter,close(){closed=true;}};
}
