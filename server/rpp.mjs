import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {refreshMana} from './magic-balance.mjs';
const data=JSON.parse(readFileSync(new URL('./combat-data.json',import.meta.url),'utf8'));
const catalogue=data.magic_tree.rpp_shop??[];
const fail=(status,message)=>{throw Object.assign(Error(message),{status,code:'rpp_request_failed'});};
export function createRpp(db,{now=Date.now}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_rpp_wallets(character_id TEXT PRIMARY KEY,balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0));
 CREATE TABLE IF NOT EXISTS quest_rpp_unlocks(character_id TEXT NOT NULL,unlock_id TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(character_id,unlock_id));
 CREATE TABLE IF NOT EXISTS quest_rpp_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,owner TEXT NOT NULL,character_id TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,balance INTEGER NOT NULL,unlock_id TEXT,actor TEXT NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS quest_rpp_history ON quest_rpp_ledger(owner,id);`);
 const balance=id=>db.prepare('SELECT balance FROM quest_rpp_wallets WHERE character_id=?').get(id)?.balance??0;
 const unlocks=id=>db.prepare('SELECT unlock_id,kind FROM quest_rpp_unlocks WHERE character_id=?').all(id);
 function attach(c,loadout){
  if(!loadout?.player_info)return loadout;
  const owned=unlocks(c.id);loadout.player_info.rpp_abilities=owned.filter(r=>r.kind==='ability').map(r=>r.unlock_id);
  loadout.player_spells=[...new Set([...(Array.isArray(loadout.player_spells)?loadout.player_spells:[]),...owned.filter(r=>r.kind==='spell').map(r=>r.unlock_id)])];
  refreshMana(loadout);return loadout;
 } // A stale campaign import cannot erase purchases or forge server-side passive abilities.
 function snapshot(c,state){
  const l=state?.loadout,cls=l?.player_info?.class_id??'fighter',owned=unlocks(c.id).map(r=>r.unlock_id),level=l?.player_info?.level??1;
  return {balance:balance(c.id),freePicks:state?.mageSpellPicks??0,scope:'character',catalogue:catalogue.map(o=>({...o,name:o.kind==='spell'?data.spells[o.id].name:o.name,description:o.kind==='spell'?data.spells[o.id].description:o.description,mpCost:o.kind==='spell'?data.spells[o.id].mp_cost:0,known:Boolean(owned.includes(o.id)||(o.kind==='spell'&&l?.player_spells?.includes(o.id))),available:o.classes.includes(cls)&&level>=o.level}))};
 }
 function buy(c,state,input){
  const offer=catalogue.find(o=>o.id===input.offer),l=state.loadout,free=input.action==='mage_pick';
  if(!offer||!l)fail(400,'Choose a spell or ability from the RPP shop.');
  if(state.run||state.worldTurnDue||state.pendingDefeat||state.pendingPurchase)fail(409,'Finish the current action before buying an unlock.');
  if(!free&&input.rpp_cost!==offer.cost)fail(409,'The price changed. Refresh the shop before buying.');
  if(!offer.classes.includes(l.player_info.class_id??'fighter')||(l.player_info.level??1)<offer.level)fail(409,'This unlock is not available to your class or level.');
  if(unlocks(c.id).some(r=>r.unlock_id===offer.id)||(offer.kind==='spell'&&l.player_spells.includes(offer.id)))fail(409,'You already know this spell or ability.');
  if(free){
   if(l.player_info.class_id!=='mage'||offer.kind!=='spell'||!(state.mageSpellPicks>0))fail(409,'Choose a spell with an available mage spell choice.');
   state.mageSpellPicks--; // Free choices buy spells only; they never debit or mint RPP.
  }else{
   if(balance(c.id)<offer.cost)fail(409,'You do not have enough RPP.');
   db.prepare('UPDATE quest_rpp_wallets SET balance=balance-? WHERE character_id=?').run(offer.cost,c.id);
  }
  db.prepare('INSERT INTO quest_rpp_unlocks VALUES (?,?,?,?)').run(c.id,offer.id,offer.kind,now());
  db.prepare('INSERT INTO quest_rpp_ledger(request_id,fingerprint,owner,character_id,kind,amount,balance,unlock_id,actor,reason,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('purchase:'+c.id+':'+input.request_id,'',c.owner,c.id,free?'mage_pick':'purchase',free?0:-offer.cost,balance(c.id),offer.id,c.owner,(free?'Free mage choice: ':'Purchased ')+offer.id,now());
  attach(c,l); // The surrounding zone-command transaction commits the debit, unlock, loadout and receipt together.
  return offer.id;
 }
 function gift(input,actor){
  const amount=input.amount,reason=typeof input.reason==='string'?input.reason.trim().slice(0,240):'',id=input.request_id;
  if(!Number.isSafeInteger(amount)||amount<1||amount>1000000||!reason||typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(id))fail(400,'Supply a positive whole RPP amount (up to 1,000,000), review note and stable request ID.');
  const fingerprint=createHash('sha256').update(JSON.stringify([actor,input.character_id,amount,reason])).digest('hex');
  db.exec('BEGIN IMMEDIATE');try{
   const old=db.prepare('SELECT * FROM quest_rpp_ledger WHERE request_id=?').get('gift:'+id);
   if(old){if(old.fingerprint!==fingerprint)fail(409,'This gift request already has different details.');db.exec('COMMIT');return {id:old.id,balance:old.balance,amount:old.amount,replayed:true};}
   const c=db.prepare('SELECT id,owner,name FROM quest_characters WHERE id=?').get(String(input.character_id??''));if(!c)fail(404,'Choose an existing character.');
   if(balance(c.id)+amount>1000000000)fail(409,'This character has reached the RPP balance limit.');
   db.prepare('INSERT INTO quest_rpp_wallets(character_id,balance) VALUES (?,?) ON CONFLICT(character_id) DO UPDATE SET balance=balance+excluded.balance').run(c.id,amount);
   const total=balance(c.id),row=db.prepare('INSERT INTO quest_rpp_ledger(request_id,fingerprint,owner,character_id,kind,amount,balance,actor,reason,created) VALUES (?,?,?,?,?,?,?,?,?,?)').run('gift:'+id,fingerprint,c.owner,c.id,'gift',amount,total,actor,reason,now());
   db.exec('COMMIT');return {id:Number(row.lastInsertRowid),characterId:c.id,name:c.name,balance:total,amount,replayed:false};
  }catch(error){db.exec('ROLLBACK');throw error;}
 } // Staff gifts are independently durable and replay-safe, including a lost browser response.
 function journal(character=''){
  return {characters:db.prepare('SELECT c.id,c.name,c.owner,COALESCE(w.balance,0) AS balance FROM quest_characters c LEFT JOIN quest_rpp_wallets w ON w.character_id=c.id ORDER BY c.name,c.id').all(),ledger:db.prepare('SELECT l.*,c.name FROM quest_rpp_ledger l LEFT JOIN quest_characters c ON c.id=l.character_id WHERE ?=\'\' OR l.character_id=? ORDER BY l.id DESC LIMIT 100').all(character,character)};
 }
 return {attach,snapshot,buy,gift,journal,balance};
}
