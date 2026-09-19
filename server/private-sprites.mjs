import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const fail=(status,message,code='private_sprite_failed')=>{throw Object.assign(Error(message),{status,code});};
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const reserved=['charging','queued','running','ready'];
export function pythonSpriteProvider({python=process.env.PIXELLAB_PYTHON??'python3',token=process.env.PIXELLAB_API_TOKEN}={}){
 if(!token)return null;
 return (prompt,signal)=>new Promise((resolve,reject)=>{
  const child=spawn(python,[fileURLToPath(new URL('../python/private_sprite_worker.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PIXELLAB_API_TOKEN:token},signal});
  let result='',size=0;const timer=setTimeout(()=>child.kill(),30*60000);timer.unref();
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>250000)child.kill();else result+=chunk;});child.stderr.resume();
  child.on('error',()=>{clearTimeout(timer);reject(Error('Generation worker unavailable'));});
  child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('Generation failed'));try{resolve(JSON.parse(result));}catch{reject(Error('Invalid generation output'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({prompt}));
 });
} // Only the service process receives the provider key; subprocess arguments and browser packets contain no credentials.

export function createPrivateSprites(db,{walletClient,provider=pythonSpriteProvider(),now=Date.now}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_private_sprites(id TEXT PRIMARY KEY,owner TEXT NOT NULL,character_id TEXT NOT NULL DEFAULT '',request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,png TEXT,created INTEGER NOT NULL,UNIQUE(owner,request_id));
 CREATE INDEX IF NOT EXISTS quest_private_sprite_slots ON quest_private_sprites(owner,character_id,status);`);
 db.prepare("UPDATE quest_private_sprites SET status='refunding' WHERE status='running'").run(); // An interrupted provider call is never blindly submitted a second time.
 if(!provider)db.prepare("UPDATE quest_private_sprites SET status='refunding' WHERE status='queued'").run();
 const tokens=new Map(),settling=new Map(),workers=new Map();let closed=false;
 const atomic=work=>{db.exec('BEGIN IMMEDIATE');try{const r=work();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const row=id=>db.prepare('SELECT * FROM quest_private_sprites WHERE id=?').get(id);
 function character(owner,id){if(id==='')return;if(!identifier(id)||!db.prepare('SELECT 1 FROM quest_characters WHERE owner=? AND id=?').get(owner,id))fail(404,'Character not found.');}
 function list(owner,id=''){
  character(owner,id);
  const rows=db.prepare("SELECT id,status,created FROM quest_private_sprites WHERE owner=? AND character_id=? AND status!='deleted' ORDER BY CASE WHEN status IN ('charging','queued','running','ready') THEN 0 ELSE 1 END,created DESC,id LIMIT 25").all(owner,id);
  const latest=db.prepare("SELECT status FROM quest_private_sprites WHERE owner=? AND character_id=? AND status!='deleted' ORDER BY created DESC,rowid DESC LIMIT 1").get(owner,id);
  return {enabled:Boolean(provider),cost:1,limit:5,character_id:id,latestStatus:latest?.status??'',used:rows.filter(r=>reserved.includes(r.status)).length,sprites:rows.map(r=>({...r,name:'Private sprite '+r.id.slice(8,14)}))};
 }
 const debitId=r=>'sprite-'+createHash('sha256').update(r.owner+':'+r.request_id).digest('hex');
 async function settle(r,token){
  if(settling.has(r.id))return settling.get(r.id);
  const task=(async()=>{
   r=row(r.id);if(!r||!['charging','refunding'].includes(r.status))return;
   if(r.status==='charging'){
    try{await walletClient.diamonds(token,{request_id:debitId(r),asset:'diamonds',kind:'debit',amount:1});}
    catch(e){if(e.code==='insufficient_balance'){if(!closed)db.prepare("UPDATE quest_private_sprites SET status='insufficient' WHERE id=?").run(r.id);return;}throw e;}
    if(closed)return;db.prepare("UPDATE quest_private_sprites SET status=? WHERE id=?").run(provider?'queued':'refunding',r.id);
   }
   r=row(r.id);
   if(r.status==='refunding'){
    await walletClient.diamonds(token,{request_id:'refund-'+debitId(r),asset:'diamonds',kind:'refund',original_id:debitId(r)});
    if(!closed)db.prepare("UPDATE quest_private_sprites SET status='refunded',png=NULL WHERE id=?").run(r.id);
   }
  })();settling.set(r.id,task);try{await task;}finally{settling.delete(r.id);if(!closed&&!db.prepare("SELECT 1 FROM quest_private_sprites WHERE owner=? AND status IN ('charging','queued','running','refunding')").get(r.owner))tokens.delete(r.owner);pump();}
 } // Both debit and refund IDs are durable: timeouts, retries and renewed logins cannot charge twice.
 function validStrip(output){
  if(output?.frames!==36||typeof output.png!=='string'||output.png.length>240000||!/^[A-Za-z0-9+/]+={0,2}$/.test(output.png))throw Error('Invalid sprite');
  const png=Buffer.from(output.png,'base64');if(png.length<33||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(16)!==2304||png.readUInt32BE(20)!==64)throw Error('Invalid sprite dimensions');
 }
 function pump(){
  if(closed||!provider||workers.size)return;
  const r=db.prepare("SELECT * FROM quest_private_sprites WHERE status='queued' ORDER BY created,id LIMIT 1").get();if(!r)return;
  const controller=new AbortController();workers.set(r.id,controller);db.prepare("UPDATE quest_private_sprites SET status='running' WHERE id=?").run(r.id);
  Promise.resolve().then(()=>provider(r.prompt,controller.signal)).then(output=>{
   if(closed)return;validStrip(output);const current=row(r.id);
   if(current.character_id&&!db.prepare('SELECT 1 FROM quest_characters WHERE id=? AND owner=?').get(current.character_id,r.owner))throw Error('Character deleted');
   db.prepare("UPDATE quest_private_sprites SET status='ready',png=? WHERE id=?").run(output.png,r.id);
  }).catch(()=>{if(!closed)db.prepare("UPDATE quest_private_sprites SET status='refunding' WHERE id=?").run(r.id);}).finally(()=>{
   workers.delete(r.id);if(closed)return;
   if(tokens.has(r.owner))void settle(row(r.id),tokens.get(r.owner)).catch(()=>{});pump();
  });
 } // One worker at a time bounds CPU and provider concurrency without blocking presence or combat requests.
 async function recover(owner,token){tokens.set(owner,token);for(const r of db.prepare("SELECT * FROM quest_private_sprites WHERE owner=? AND status IN ('charging','refunding')").all(owner))await settle(r,token);pump();}
 async function act(owner,token,input){
  if(!input||!identifier(input.request_id)||typeof input.character_id!=='string'||!['generate','delete'].includes(input.action))fail(400,'Choose a sprite action.');
  const cid=input.character_id;character(owner,cid);
  if(input.action==='delete'){
   atomic(()=>{const r=row(input.sprite_id);if(!r||r.owner!==owner||r.character_id!==cid)fail(404,'Sprite not found.');if(r.status==='deleted')return;if(!['ready','refunded','insufficient'].includes(r.status))fail(409,'Wait for this generation to finish.');
    db.prepare("UPDATE quest_private_sprites SET status='deleted',png=NULL WHERE id=?").run(r.id);
    if(cid){const c=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(cid),s=JSON.parse(c.state);if(s.avatar===r.id){s.avatar='player';db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(s),cid);}}
   });return list(owner,cid);
  }
  const prompt=typeof input.prompt==='string'?input.prompt.trim():'';if(prompt.length<10||prompt.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(prompt))fail(400,'Describe your sprite in 10 to 1000 characters.');
  const fingerprint=JSON.stringify([cid,prompt]);
  const r=atomic(()=>{
   const old=db.prepare('SELECT * FROM quest_private_sprites WHERE owner=? AND request_id=?').get(owner,input.request_id);if(old){if(old.fingerprint!==fingerprint)fail(409,'This request ID belongs to another generation.');return old;}
   if(db.prepare('SELECT count(*) n FROM quest_private_sprites WHERE owner=? AND created>?').get(owner,now()-60000).n>=10)fail(429,'Please wait before starting another generation.'); // Bound failed-payment spam without slowing retries of an existing paid request.
   if(!provider)fail(503,'Premium sprite generation is not configured.');
   if(cid===''&&db.prepare('SELECT count(*) n FROM quest_characters WHERE owner=?').get(owner).n>=5)fail(409,'Your account already has five characters.');
   if(db.prepare("SELECT count(*) n FROM quest_private_sprites WHERE owner=? AND character_id=? AND status IN ('charging','queued','running','ready')").get(owner,cid).n>=5)fail(409,'Five sprite slots are full. Delete a saved sprite before generating another.');
   if(db.prepare("SELECT count(*) n FROM quest_private_sprites WHERE status IN ('charging','queued','running')").get().n>=20)fail(429,'The generation queue is full. Try again later.');
   const id='private-'+randomUUID();db.prepare('INSERT INTO quest_private_sprites VALUES (?,?,?,?,?,?,?,NULL,?)').run(id,owner,cid,input.request_id,fingerprint,prompt,'charging',now());return row(id);
  });tokens.set(owner,token);await settle(r,token);return list(owner,row(r.id).character_id);
 }
 function authorize(owner,cid,id){const r=row(id);if(!r||r.owner!==owner||r.character_id!==(cid??'')||r.status!=='ready')fail(403,'This private sprite belongs to another character or is not ready.');return id;}
 function claimDraft(owner,cid){db.prepare("UPDATE quest_private_sprites SET character_id=? WHERE owner=? AND character_id=''").run(cid,owner);} // The first completed character creation claims its account's recoverable draft collection atomically.
 function asset(owner,id){
  const r=row(id);if(!r||r.status!=='ready')fail(404,'Sprite not found.');
  if(r.owner!==owner){
   const target=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(r.character_id);
   const visible=target&&JSON.parse(target.state).avatar===id&&db.prepare('SELECT 1 FROM quest_presence a JOIN quest_presence b ON a.zone=b.zone WHERE a.owner=? AND b.character_id=? AND a.seen>? AND b.seen>?').get(owner,r.character_id,now()-30000,now()-30000);
   if(!visible)fail(404,'Sprite not found.');
  }
  return {id:r.id,png:r.png,frames:36};
 } // Only owners browse saved sprites; nearby players may load an equipped sprite for rendering, never select it.
 function blockDeletion(cid){if(db.prepare("SELECT 1 FROM quest_private_sprites WHERE character_id=? AND status IN ('charging','queued','running','refunding')").get(cid))fail(409,'Wait for sprite generation or its refund before deleting this character.');}
 function deleteCharacter(cid){db.prepare("UPDATE quest_private_sprites SET status='deleted',png=NULL WHERE character_id=?").run(cid);}
 pump();return {list,act,recover,authorize,claimDraft,asset,blockDeletion,deleteCharacter,close(){closed=true;for(const c of workers.values())c.abort();tokens.clear();}};
}
