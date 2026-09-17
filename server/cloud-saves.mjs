import {createHash} from 'node:crypto';
const fail=(status,message,code='cloud_save_failed')=>{throw Object.assign(Error(message),{status,code});};
const key=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
export const CLOUD_CHUNK=128*1024;
export function createCloudSaves(db,{now=Date.now,maxBytes=Number(process.env.QUEST_CLOUD_MAX_BYTES??64*1024*1024)}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<CLOUD_CHUNK||maxBytes>256*1024*1024)throw Error('Invalid cloud save size limit');
 db.exec(`CREATE TABLE IF NOT EXISTS quest_cloud_versions(character_id TEXT NOT NULL,revision INTEGER NOT NULL,owner TEXT NOT NULL,request_id TEXT NOT NULL,checksum TEXT NOT NULL,preview TEXT NOT NULL,created INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(character_id,revision),UNIQUE(owner,request_id));
 CREATE TABLE IF NOT EXISTS quest_cloud_uploads(owner TEXT PRIMARY KEY,id TEXT NOT NULL,character_id TEXT NOT NULL,base_revision INTEGER NOT NULL,checksum TEXT NOT NULL,bytes INTEGER NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS quest_cloud_chunks(owner TEXT NOT NULL,upload_id TEXT NOT NULL,part INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(owner,upload_id,part));`);
 const character=(owner,id)=>{if(!key(id))fail(400,'Choose a character.');const c=db.prepare('SELECT * FROM quest_characters WHERE owner=? AND id=?').get(owner,id);if(!c)fail(404,'Character not found.');return c;};
 const current=id=>db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM quest_cloud_versions WHERE character_id=?').get(id).revision;
 const clear=owner=>{db.prepare('DELETE FROM quest_cloud_chunks WHERE owner=?').run(owner);db.prepare('DELETE FROM quest_cloud_uploads WHERE owner=?').run(owner);};
 const info=r=>r?{revision:r.revision,checksum:r.checksum,bytes:r.bytes??r.data?.length,created:r.created,preview:JSON.parse(r.preview)}:null;
 function prune(){for(const r of db.prepare('SELECT owner FROM quest_cloud_uploads WHERE created<=?').all(now()-86400000))clear(r.owner);}
 function read(owner,q){
  prune();const id=q.character_id;if(!id)return {saves:db.prepare('SELECT v.character_id,v.revision,v.checksum,v.preview,v.created,length(v.data) AS bytes FROM quest_cloud_versions v WHERE owner=? AND revision=(SELECT MAX(revision) FROM quest_cloud_versions x WHERE x.character_id=v.character_id)').all(owner).map(r=>({character_id:r.character_id,...info(r)}))};
  const c=character(owner,id);
  if(q.history==='1')return {versions:db.prepare('SELECT revision,checksum,preview,created,length(data) AS bytes FROM quest_cloud_versions WHERE character_id=? ORDER BY revision DESC').all(id).map(info)};
  const revision=q.revision===undefined?current(id):Number(q.revision),r=db.prepare('SELECT revision,checksum,preview,created,length(data) AS bytes FROM quest_cloud_versions WHERE character_id=? AND revision=?').get(id,revision);
  if(!r)fail(404,'No cloud save yet.');
  if(q.part===undefined)return {...info(r),character_id:id,online_revision:c.revision};
  const part=Number(q.part);if(!Number.isSafeInteger(part)||part<0||part>=Math.ceil(r.bytes/CLOUD_CHUNK))fail(400,'Invalid save chunk.');
  const chunk=db.prepare('SELECT substr(data,?,?) AS data FROM quest_cloud_versions WHERE character_id=? AND revision=?').get(part*CLOUD_CHUNK+1,CLOUD_CHUNK,id,revision);
  return {revision,part,data:Buffer.from(chunk.data).toString('base64')}; // Read only the requested slice, not a full 64 MiB world for every chunk.
 } // Cloud downloads never contain the service's bank, claims, currency or battle tables.
 function act(owner,input){
  prune();if(!input||!key(input.request_id))fail(400,'Supply a stable cloud request ID.');
  db.exec('BEGIN IMMEDIATE');try{const result=change(owner,input);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
 }
 function change(owner,i){
  const c=character(owner,i.character_id),saved=db.prepare('SELECT character_id,revision,checksum,preview,created,length(data) AS bytes FROM quest_cloud_versions WHERE owner=? AND request_id=?').get(owner,i.request_id);
  if(saved){if(saved.character_id!==c.id||(i.checksum&&i.checksum!==saved.checksum))fail(409,'Cloud request ID already used.');return {...info(saved),committed:true};}
  if(i.action==='begin'){
   if(!Number.isSafeInteger(i.bytes)||i.bytes<2||i.bytes>maxBytes||!Number.isSafeInteger(i.base_revision)||i.base_revision<0||!/^[a-f0-9]{40}$/.test(i.checksum??''))fail(400,'Invalid cloud save metadata.');
   const old=db.prepare('SELECT * FROM quest_cloud_uploads WHERE owner=?').get(owner);
   if(old?.id===i.request_id){if(old.character_id!==c.id||old.bytes!==i.bytes||old.checksum!==i.checksum||old.base_revision!==i.base_revision)fail(409,'Upload metadata changed.');return {upload:i.request_id,parts:db.prepare('SELECT part FROM quest_cloud_chunks WHERE owner=? AND upload_id=?').all(owner,i.request_id).map(r=>r.part)};}
   if(current(c.id)!==i.base_revision)fail(409,'Choose which cloud save to keep.','cloud_conflict');
   if(old)fail(409,'Another device is finishing a cloud upload. Retrying shortly.','cloud_upload_busy'); // Do not let simultaneous devices repeatedly erase each other's private chunks.
   clear(owner);db.prepare('INSERT INTO quest_cloud_uploads VALUES (?,?,?,?,?,?,?)').run(owner,i.request_id,c.id,i.base_revision,i.checksum,i.bytes,now());return {upload:i.request_id,parts:[]};
  }
  const u=db.prepare('SELECT * FROM quest_cloud_uploads WHERE owner=? AND id=? AND character_id=?').get(owner,i.request_id,c.id);if(!u)fail(404,'Upload expired; restart this upload.');
  if(i.action==='chunk'){
   const count=Math.ceil(u.bytes/CLOUD_CHUNK),expected=i.part===count-1?u.bytes-i.part*CLOUD_CHUNK:CLOUD_CHUNK;
   if(!Number.isSafeInteger(i.part)||i.part<0||i.part>=count||typeof i.data!=='string'||i.data.length>Math.ceil(CLOUD_CHUNK/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(i.data))fail(400,'Invalid cloud chunk.');
   const data=Buffer.from(i.data,'base64');if(data.length!==expected||data.toString('base64')!==i.data)fail(400,'Incomplete cloud chunk.');
   const old=db.prepare('SELECT data FROM quest_cloud_chunks WHERE owner=? AND upload_id=? AND part=?').get(owner,u.id,i.part);if(old&&!Buffer.from(old.data).equals(data))fail(409,'This chunk already contains different data.');
   db.prepare('INSERT OR IGNORE INTO quest_cloud_chunks VALUES (?,?,?,?)').run(owner,u.id,i.part,data);return {part:i.part};
  }
  if(i.action!=='commit')fail(400,'Unknown cloud action.');
  if(current(c.id)!==u.base_revision)fail(409,'Choose which cloud save to keep.','cloud_conflict');
  const parts=db.prepare('SELECT part,data FROM quest_cloud_chunks WHERE owner=? AND upload_id=? ORDER BY part').all(owner,u.id);
  if(parts.length!==Math.ceil(u.bytes/CLOUD_CHUNK))fail(409,'Upload is incomplete.');
  const data=Buffer.concat(parts.map(r=>Buffer.from(r.data)));if(data.length!==u.bytes||createHash('sha1').update(data).digest('hex')!==u.checksum)fail(400,'Save checksum mismatch.');
  let save;try{save=JSON.parse(data.toString('utf8'));}catch{fail(400,'Invalid save JSON.');}
  if(!save||Array.isArray(save)||save.online_character!==c.id||save.online_account!==owner||!Number.isSafeInteger(save.version)||save.version<1||!save.player_info||typeof save.player_info!=='object'||Array.isArray(save.player_info)||!Array.isArray(save.inventory)||!save.room_data||typeof save.room_data!=='object'||Array.isArray(save.room_data)||typeof save.current_room!=='string'||save.current_room.length>100)fail(400,'Save does not belong to this character or has an invalid format.');
  for(const field of ['token','access_token','refresh_token','coin_wallet','wallet','coins','diamonds'])if(Object.hasOwn(save,field))fail(400,'Credentials and shared balances must not be saved.');
  if(save.current_room.startsWith('rmOnline')||Object.keys(save.room_data).some(room=>room.startsWith('rmOnline')))fail(400,'Shared rooms resume from the service, not a campaign snapshot.');
  const preview={name:String(save.player_info.name??c.name).slice(0,24),level:Number(save.player_info.level)||1,room:save.current_room.slice(0,100),version:save.version,timestamp:String(save.timestamp??'').slice(0,64)};
  const revision=u.base_revision+1;db.prepare('INSERT INTO quest_cloud_versions VALUES (?,?,?,?,?,?,?,?)').run(c.id,revision,owner,u.id,u.checksum,JSON.stringify(preview),now(),data);
  db.prepare('DELETE FROM quest_cloud_versions WHERE character_id=? AND revision<?').run(c.id,revision-2);clear(owner);
  return {revision,checksum:u.checksum,preview,committed:true};
 } // Staging and publication are transactional; restoring a campaign never writes authoritative gameplay state.
 return {read,act,prune};
}
