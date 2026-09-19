import {createHash} from 'node:crypto';
const fail=(status,message,code='character_management_failed')=>{throw Object.assign(Error(message),{status,code});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
export const appearanceFields=['gender','hair_style','hair_color','has_breasts','nipple_style','penis_style','pubes_style'];
export function appearanceChoices(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!appearanceFields.includes(k)))fail(400,'Choose paperdoll appearance only.');
 if(!['Female','Male'].includes(value.gender)||!['Black','Blonde','Brown','Pink','Purple','Red','Silver','UltraPink','UltraRed'].includes(value.hair_color)||typeof value.has_breasts!=='boolean')fail(400,'Invalid appearance choices.');
 for(const [key,min,max] of [['hair_style',1,4],['nipple_style',0,2],['penis_style',0,5],['pubes_style',0,3]])if(!Number.isInteger(value[key])||value[key]<min||value[key]>max)fail(400,'Invalid appearance choices.');
 return Object.fromEntries(appearanceFields.map(key=>[key,value[key]]));
} // Class, stats, equipment and NPC sprite cannot be changed through a paperdoll purchase.
export function managementSchema(db){db.exec(`CREATE TABLE IF NOT EXISTS quest_management(owner TEXT NOT NULL,request_id TEXT NOT NULL,character_id TEXT NOT NULL,fingerprint TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,cost INTEGER NOT NULL,status TEXT NOT NULL,result TEXT,PRIMARY KEY(owner,request_id));
 CREATE TABLE IF NOT EXISTS quest_deleted_characters(id TEXT PRIMARY KEY,owner TEXT NOT NULL,creation_id TEXT NOT NULL,deleted INTEGER NOT NULL,UNIQUE(owner,creation_id));`);}
export function createCharacterManagement(db,{walletClient,cloud,sprites,now=Date.now,log=console.warn}){
 managementSchema(db);const running=new Map();
 const atomic=work=>{db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
 function prepare(owner,i){
  if(!i||!id(i.request_id)||!id(i.character_id)||!['rename','appearance','delete'].includes(i.action))fail(400,'Choose a character management action.');
  const payload=i.action==='rename'?{name:typeof i.name==='string'?i.name.trim():''}:i.action==='appearance'?appearanceChoices(i.appearance):{};
  if(i.action==='rename'&&(!payload.name||payload.name.length>24||/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069#]/.test(payload.name)))fail(400,'Use a character name of 1 to 24 characters.');
  const fingerprint=JSON.stringify([i.character_id,i.action,i.revision,payload,i.confirm??null]);
  const old=db.prepare('SELECT * FROM quest_management WHERE owner=? AND request_id=?').get(owner,i.request_id);
  if(old){if(old.fingerprint!==fingerprint)fail(409,'This request ID describes another change.');return old;}
  const c=db.prepare('SELECT * FROM quest_characters WHERE owner=? AND id=?').get(owner,i.character_id);if(!c)fail(404,'Online character not found.');
  if(!Number.isSafeInteger(i.revision)||i.revision!==c.revision)fail(409,'Character changed. Refresh before managing it.');
  const state=JSON.parse(c.state);
  if(state.run||state.pendingPurchase||state.worldTurnDue||db.prepare('SELECT 1 FROM quest_presence WHERE character_id=? AND seen>?').get(c.id,now()-30000))fail(409,'Leave online rooms and finish pending battles or purchases before managing this character.');
  if(db.prepare("SELECT 1 FROM quest_management WHERE character_id=? AND status='pending'").get(c.id))fail(409,'Another character change is still settling.','character_change_pending');
  if(i.action==='delete'&&i.confirm!==c.name)fail(400,'Type the character name to confirm permanent deletion.');
  if(i.action==='delete')sprites?.blockDeletion(c.id);
  if(i.action==='rename'&&payload.name===c.name)fail(400,'Choose a different character name.');
  const cost=i.action==='rename'?5:i.action==='appearance'?1:0;
  db.prepare('INSERT INTO quest_management VALUES (?,?,?,?,?,?,?,?,NULL)').run(owner,i.request_id,c.id,fingerprint,i.action,JSON.stringify(payload),cost,'pending');
  return db.prepare('SELECT * FROM quest_management WHERE owner=? AND request_id=?').get(owner,i.request_id);
 } // Freeze the validated purchase before the remote debit; gameplay is locked until the result commits.
 async function settle(row,token){
  if(row.status!=='pending')return JSON.parse(row.result);
  const lock=row.owner+':'+row.request_id;if(running.has(lock))return running.get(lock);
  const task=(async()=>{
   if(row.cost){
    try{await walletClient.stars(token,{request_id:'character-'+createHash('sha256').update(lock).digest('hex'),asset:'stars',kind:'debit',amount:row.cost});}
    catch(error){
     if(error.code==='insufficient_balance'){const result={failed:true,message:'Not enough stars.'};db.prepare("UPDATE quest_management SET status='failed',result=? WHERE owner=? AND request_id=?").run(JSON.stringify(result),row.owner,row.request_id);return result;}
     log('quest_character_change_pending',row.character_id,error.status??'transport');fail(503,'Your change is pending; reconnect to finish it. You will only be charged once.','character_change_pending');
    }
   }
   return atomic(()=>{
    const current=db.prepare('SELECT * FROM quest_management WHERE owner=? AND request_id=?').get(row.owner,row.request_id);if(current.status!=='pending')return JSON.parse(current.result);
    const c=db.prepare('SELECT * FROM quest_characters WHERE id=? AND owner=?').get(row.character_id,row.owner);if(!c)throw Error('Pending character change lost its character');
    const state=JSON.parse(c.state),payload=JSON.parse(row.payload);let result;
    if(row.action==='delete'){
     cloud.deleteCharacter(c.id);sprites?.deleteCharacter(c.id);
     for(const table of ['quest_presence','quest_commands','quest_bank','quest_item_origins','dive_progress'])db.prepare(`DELETE FROM ${table} WHERE character_id=?`).run(c.id);
     db.prepare('INSERT INTO quest_deleted_characters VALUES (?,?,?,?)').run(c.id,c.owner,c.creation_id,now());db.prepare('DELETE FROM quest_characters WHERE id=?').run(c.id);
     result={character_id:c.id,deleted:true}; // Keep shared friendships, wallet receipts, account reward caps and unpaid payouts intact.
    }else{
     if(row.action==='rename'){c.name=payload.name;state.nameLocked=true;}
     else state.profileAppearance=payload;
     if(state.loadout?.player_info)Object.assign(state.loadout.player_info,{name:c.name},state.profileAppearance??{});
     state.loadoutRevision=c.revision+1;c.revision++;
     db.prepare('UPDATE quest_characters SET name=?,revision=?,state=? WHERE id=?').run(c.name,c.revision,JSON.stringify(state),c.id);
     result={character_id:c.id,name:c.name,revision:c.revision,appearance:state.profileAppearance??null,cost:row.cost};
    }
    db.prepare("UPDATE quest_management SET status='done',result=? WHERE owner=? AND request_id=?").run(JSON.stringify(result),row.owner,row.request_id);return result;
   });
  })();running.set(lock,task);try{return await task;}finally{running.delete(lock);}
 }
 async function recover(owner,token){for(const row of db.prepare("SELECT * FROM quest_management WHERE owner=? AND status='pending'").all(owner))await settle(row,token);}
 async function act(owner,token,input){const row=atomic(()=>prepare(owner,input));const result=await settle(row,token);if(result.failed)fail(409,result.message,'insufficient_balance');return result;}
 return {act,recover};
} // Durable receipts survive restarts and lost responses without repeating star debits.
