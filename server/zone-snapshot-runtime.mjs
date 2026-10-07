import {DEFAULT_ZONE_CAPACITY,parseZoneCapacity} from './zone-capacity.mjs';
import {performance} from 'node:perf_hooks';
import {openZoneSnapshotDatabase} from './zone-snapshot-database.mjs';
import {createWorldContent} from './world-content.mjs';
import {createQuestZones} from './zones.mjs';
import {createTutor} from './tutor.mjs';
import {combatData} from './combat.mjs';
import {hubData} from './hubs.mjs';
import {parseKnown,elide} from './snapshot-cache.mjs';

export function createZoneSnapshotRuntime({filename,blankCanvas=true,questPack=[],followerEnabled=true,zoneCapacity=DEFAULT_ZONE_CAPACITY}){
 zoneCapacity=parseZoneCapacity(zoneCapacity); // Reject invalid limits before opening the read-only connection.
 const database=openZoneSnapshotDatabase(filename),{db}=database;let at=Date.now(),timings=[];
 const now=()=>at,measure=(name,work)=>{const start=performance.now();let failed=true;try{const value=work();failed=false;return value;}finally{timings.push({name,elapsed:performance.now()-start,failed});}};
 const live=createWorldContent(db,{now,blankCanvas,questPack,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment});
 let suspended=null; // Owners suspended at this render's moment, loaded once per render instead of one query per neighbour (peers and RP candidates each ask for every player in the room).
 const enabled=owner=>{if(!suspended)suspended=new Set(db.prepare("SELECT owner FROM gm_sanctions WHERE kind='suspend' AND (until=0 OR until>?)").all(now()).map(r=>r.owner));return !suspended.has(owner);};
 const zones=createQuestZones(db,{now,readOnly:true,live,zoneCapacity,enabled,measure,followerOptions:{enabled:followerEnabled},grant:()=>{throw Error('Snapshot workers cannot accept commands');},adjust:()=>{throw Error('Snapshot workers cannot award currency');},wallet:owner=>({coins:db.prepare('SELECT coins FROM wallet_cache WHERE owner=?').get(owner)?.coins??0})});
 const tutor=createTutor(db,{now,live,log:()=>{}});zones.setTutor(tutor);database.ready(); // No timers, wallet client, AI requests or writable database are installed in a zone worker.
 const hasEpochs=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='zone_snapshot_epochs'").get();let epochs={};
 function render(input){
  at=input.at;timings=[];suspended=null;db.exec('BEGIN'); // Fresh suspension list for this render's clock and WAL snapshot.
  try{
   const next=hasEpochs?Object.fromEntries(db.prepare('SELECT domain,revision FROM zone_snapshot_epochs').all().map(r=>[r.domain,r.revision])):null;
   zones.invalidateSnapshotCaches(next?Object.keys(next).filter(key=>next[key]!==epochs[key]):undefined); // One WAL snapshot pairs the cache epochs with their committed content, even while the coordinator writes.
   epochs=next??{};
   if(!enabled(input.identity.owner))throw Object.assign(Error('This account is suspended from online play.'),{status:403,code:'account_suspended'});
   const result=zones.snapshotOnly(input.identity,input.character,input.view,input.badges);
   if(input.receipt)result.receipt=input.receipt;
   result.pendingCoins=db.prepare('SELECT COALESCE(SUM(amount-paid),0) AS n FROM reward_outbox WHERE owner=? AND delivered=0').get(input.identity.owner).n;
   result.tutor=tutor.view(result.character?.id??null);result.capabilities=input.capabilities;
   const known=parseKnown(input.known);if(known)measure('response.cache',()=>elide(result,known));
   const bytes=measure('response.serialize',()=>new TextEncoder().encode(JSON.stringify(result)));
   db.exec('COMMIT');return {bytes,timings}; // Transfer the encoded buffer directly; the gateway neither parses nor rebuilds a large snapshot.
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 return {render,close(){zones.close();db.close();}};
}
