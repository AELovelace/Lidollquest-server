import {randomUUID} from 'node:crypto';

const fail=message=>{throw Object.assign(Error(message),{status:409,code:'party_conflict'});};
export function createParties(db,{now}) {
 db.exec(`CREATE TABLE IF NOT EXISTS quest_parties(id TEXT PRIMARY KEY,leader TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS quest_party_members(character_id TEXT PRIMARY KEY,party_id TEXT NOT NULL,joined INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS quest_party_roster ON quest_party_members(party_id,joined);
 CREATE TABLE IF NOT EXISTS quest_party_invites(id TEXT PRIMARY KEY,party_id TEXT NOT NULL,sender TEXT NOT NULL,target TEXT NOT NULL,expires INTEGER NOT NULL,UNIQUE(party_id,target));`);
 const party=id=>db.prepare('SELECT p.* FROM quest_parties p JOIN quest_party_members m ON m.party_id=p.id WHERE m.character_id=?').get(id);
 const members=id=>{const p=party(id);return p?db.prepare('SELECT c.*,m.joined FROM quest_party_members m JOIN quest_characters c ON c.id=m.character_id WHERE m.party_id=? ORDER BY m.joined,c.id').all(p.id):[];};
 const presence=id=>db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(id);
 function available(c){ // Joining and group transfers never bypass an unfinished inventory or needs transaction.
  const s=JSON.parse(c.state);
  if(s.pendingDefeat||s.run||s.worldTurnDue||s.pendingPurchase||db.prepare("SELECT 1 FROM quest_management WHERE character_id=? AND status='pending'").get(c.id))fail(c.name+' must finish their current action first.');
  return s;
 }
 function sameArea(a,b){const ap=presence(a.id),bp=presence(b.id),as=JSON.parse(a.state),bs=JSON.parse(b.state);
  return ap&&bp&&ap.zone===bp.zone&&ap.seen>now()-30000&&bp.seen>now()-30000&&as.dive?.edition===bs.dive?.edition;
 }
 function remove(id){ // The final member removes the party; otherwise leadership follows the oldest connected member.
  const p=party(id);if(!p)return;
  db.prepare('DELETE FROM quest_party_members WHERE character_id=?').run(id);
  const roster=db.prepare('SELECT m.character_id,p.seen FROM quest_party_members m LEFT JOIN quest_presence p ON p.character_id=m.character_id WHERE m.party_id=? ORDER BY m.joined,m.character_id').all(p.id);
  if(!roster.length){db.prepare('DELETE FROM quest_parties WHERE id=?').run(p.id);db.prepare('DELETE FROM quest_party_invites WHERE party_id=?').run(p.id);}
  else if(p.leader===id)db.prepare('UPDATE quest_parties SET leader=? WHERE id=?').run((roster.find(m=>m.seen>now()-30000)??roster[0]).character_id,p.id);
 }
 function tick(){
  db.prepare('DELETE FROM quest_party_invites WHERE expires<=?').run(now());
  for(const m of db.prepare('SELECT m.character_id,p.seen FROM quest_party_members m LEFT JOIN quest_presence p ON p.character_id=m.character_id').all())if(!m.seen||m.seen<=now()-150000)remove(m.character_id);
  for(const p of db.prepare('SELECT * FROM quest_parties').all())if((presence(p.leader)?.seen??0)<=now()-30000){const next=members(p.leader).find(c=>(presence(c.id)?.seen??0)>now()-30000);if(next)db.prepare('UPDATE quest_parties SET leader=? WHERE id=?').run(next.id,p.id);}
 } // A stale connection has a two-minute reservation after its thirty-second presence lease expires.
 function act(c,input){
  const p=party(c.id);
  if(input.action==='party_decline'){db.prepare('DELETE FROM quest_party_invites WHERE id=? AND target=?').run(input.invitation,c.id);return;}
  available(c);
  if(input.action==='party_invite'){
   if(p&&p.leader!==c.id)fail('Only the party leader can invite players.');
   const target=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(input.member??'');
   if(!target||target.id===c.id||!sameArea(c,target))fail('Choose another player in this online area.');
   available(target);if(party(target.id))fail('That player already belongs to a party.');
   if(JSON.parse(c.state).diveCombatVersion!==3||JSON.parse(target.state).diveCombatVersion!==3)fail('Both players need the current party-capable game.');
   if(p&&members(c.id).length>=3)fail('Your party already has three players.');
   if(db.prepare('SELECT COUNT(*) AS n FROM quest_party_invites WHERE sender=? AND expires>?').get(c.id,now()).n>=8)fail('Wait for your outstanding invitations.');
   const id=p?.id??randomUUID();if(!p){db.prepare('INSERT INTO quest_parties VALUES (?,?,?)').run(id,c.id,now());db.prepare('INSERT INTO quest_party_members VALUES (?,?,?)').run(c.id,id,now());}
   db.prepare('INSERT INTO quest_party_invites VALUES (?,?,?,?,?) ON CONFLICT(party_id,target) DO UPDATE SET id=excluded.id,sender=excluded.sender,expires=excluded.expires').run(randomUUID(),id,c.id,target.id,now()+60000);return;
  }
  if(input.action==='party_accept'){
   if(p)fail('Leave your current party first.');
   const invite=db.prepare('SELECT * FROM quest_party_invites WHERE id=? AND target=? AND expires>?').get(input.invitation??'',c.id,now());
   const leader=invite&&db.prepare('SELECT c.* FROM quest_parties p JOIN quest_characters c ON c.id=p.leader WHERE p.id=?').get(invite.party_id);
   if(!leader||!sameArea(c,leader))fail('This invitation has expired or the party moved.');
   const roster=members(leader.id);if(roster.length>=3)fail('That party is full.');
   for(const other of roster)if(!JSON.parse(other.state).pendingDefeat)available(other); // A recovering member does not prevent survivors from filling an empty party slot.
   db.prepare('INSERT INTO quest_party_members VALUES (?,?,?)').run(c.id,invite.party_id,now());db.prepare('DELETE FROM quest_party_invites WHERE target=?').run(c.id);return;
  }
  if(!p)fail('You are not in a party.');
  for(const other of members(c.id))if(JSON.parse(other.state).run?.sharedEncounter)fail('The battle roster stays together until combat finishes.');
  if(input.action==='party_leave'){remove(c.id);return;}
  if(p.leader!==c.id)fail('Only the party leader can change the roster.');
  if(input.action==='party_kick'){if(party(input.member)?.id!==p.id||input.member===c.id)fail('Choose another party member.');remove(input.member);return;}
  if(input.action==='party_disband'){for(const other of members(c.id))remove(other.id);return;}
  fail('Unknown party action.');
 }
 function snapshot(c){
  if(!c)return {party:null,partyInvitations:[]};const p=party(c.id);
  return {party:p?{id:p.id,leader:p.leader,members:members(c.id).map(other=>{const s=JSON.parse(other.state),pos=presence(other.id);return {id:other.id,name:other.name,avatar:s.avatar??'player',connected:(pos?.seen??0)>now()-30000,zone:pos?.zone??null,fighting:!!s.run,recovering:!!s.pendingDefeat};})}:null,
   partyInvitations:db.prepare('SELECT i.id,i.expires,c.name AS name FROM quest_party_invites i JOIN quest_characters c ON c.id=i.sender WHERE i.target=? AND i.expires>? ORDER BY i.expires LIMIT 8').all(c.id,now())};
 } // Roster views disclose only social status, never other members' loadouts or needs.
 function transfer(c,state,before,after){
  if(!before||!after||before.zone===after.zone)return;
  const roster=members(c.id).filter(other=>!JSON.parse(other.state).pendingDefeat&&(other.id===c.id||presence(other.id)?.zone===before.zone)); // Survivors can travel while a downed member remains at the defeat location.
  if(roster.length<2)return;
  for(const other of roster){available(other);const pos=other.id===c.id?before:presence(other.id);if(!pos||pos.zone!==before.zone)fail(other.name+' is no longer in the same area.');}
  const ids=roster.map(m=>m.id),occupied=db.prepare('SELECT character_id FROM quest_presence WHERE zone=? AND seen>?').all(after.zone,now()-30000).filter(p=>!ids.includes(p.character_id)).length;
  if(occupied+roster.length>64)fail('The destination has no room for the whole party.');
  for(const other of roster){if(other.id===c.id)continue;const s=JSON.parse(other.state);
   s.dive=state.dive?structuredClone(state.dive):null;s.diveReturned=state.diveReturned??null;s.diveReturnedPosition=state.diveReturnedPosition?structuredClone(state.diveReturnedPosition):null;
   if(!s.dive)s.hubVisit=after.zone;else delete s.hubVisit;
   db.prepare('UPDATE quest_presence SET zone=?,x=?,y=?,moved=? WHERE character_id=?').run(after.zone,after.x,after.y,now(),other.id);
   db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(s),other.id);
  }
 } // The caller owns the transaction: a failed group validation rolls back the initiator's portal too.
 return {act,members,party,remove,tick,snapshot,transfer,available};
}
