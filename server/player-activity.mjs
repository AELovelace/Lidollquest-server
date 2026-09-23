const messages={online_accident_seq:name=>name+' had an accident.',online_change_seq:name=>name+' changed their diaper.',online_hold_seq:name=>name+' fidgets and shifts their weight around',online_excitement_seq:name=>'Uh-Oh, '+name+' got way too excited in public ;)'};
const counters=Object.keys(messages);
const sequence=value=>Number.isSafeInteger(value)&&value>=0?Math.min(value,1000000000):0;
const actions=new Set(['world_turn','loadout','use_item','turn_ready','hub_rest']);

export function publishPlayerActivity(db,{previous,state,action,character,owner,area,now}){
 const before=previous.loadout?.player_info,after=state.loadout?.player_info;
 if(!after)return;
 const events=[];
 for(const key of counters){
  const old=sequence(before?.[key]),next=sequence(after[key]);
  if(before&&actions.has(action)&&next>old)events.push(messages[key](character.name));
  if(key in after||old>0)after[key]=Math.max(old,next); // Imports and stale drafts cannot roll event counters backward.
 }
 if(!events.length)return;
 const spot=area();if(!spot)return; // Companion-only writes and offline imports have no shared area to notify.
 const zone=typeof spot==='string'?spot:spot.id,x=typeof spot==='string'?null:spot.x,y=typeof spot==='string'?null:spot.y; // Callers may pass a bare area id (heard everywhere) or {id,x,y} (heard within the chat radius).
 for(const message of events)db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created,x,y) VALUES (?,?,?,?,?,?,?,?)').run(zone,'activity:'+owner,character.id,'Activity',message,now(),x,y);
 db.prepare('DELETE FROM quest_chat WHERE zone=? AND seq NOT IN (SELECT seq FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 100)').run(zone,zone);
} // Called inside the command transaction: receipts prevent repeat announcements and failed updates publish nothing.
