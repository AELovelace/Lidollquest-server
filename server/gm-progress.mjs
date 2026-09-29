// GM panel "Test progress" tools (2026-09-29): look up any character and set/clear their story flags,
// complete/remove their online quests, and let a finished personal story or read orb run again, so staff
// test accounts can replay events. Everything here runs inside gm.mjs's audited /gm/action transaction
// (request-ID receipts via live.once), and every change bumps the character revision so an online client resyncs.
import {setStoryFlag} from './story-flags.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,code:'gm_progress_invalid'});};
const QUEST_OPS={start:'quest_start',advance:'quest_advance',complete:'quest_complete',remove:'quest_reset'}; // Panel words -> online-quests.mjs gm() shortcuts.

export function createGmProgress(db,{live,quests,flows,now=Date.now}){
 const load=id=>{const c=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(typeof id==='string'?id:'');if(!c)fail('Character not found.',404);return c;}; // Always the stored row, never a client copy.
 const memory=s=>{s.fullDungeon??={flags:{},counters:{},once:{}};s.fullDungeon.flags??={};s.fullDungeon.once??={};return s.fullDungeon;}; // Same shape setStoryFlag() creates.
 const runStatus=r=>{const st=JSON.parse(r.state);return st.done?(st.exited?'left':'finished'):st.suspended?'paused':'playing';}; // How the panel labels one story run.

 function search(q){ // Name, character ID or account owner; newest characters first when the box is empty.
  const text=String(q??'').trim().slice(0,80);
  const rows=text?db.prepare("SELECT id,owner,name,revision FROM quest_characters WHERE name LIKE ? ESCAPE '\\' OR id=? OR owner=? ORDER BY name LIMIT 50").all('%'+text.replace(/[\\%_]/g,m=>'\\'+m)+'%',text,text)
   :db.prepare('SELECT id,owner,name,revision FROM quest_characters ORDER BY created DESC LIMIT 50').all();
  return rows.map(r=>({id:r.id,owner:r.owner,name:r.name,revision:r.revision}));
 }

 function detail(id){ // Everything the panel shows for one character.
  const c=load(id),s=JSON.parse(c.state),mem=s.fullDungeon??{},values=mem.flags??{},definitions=flows?.flags()??[];
  const authored=definitions.filter(f=>!f.engineOwned&&!f.retired).map(f=>({id:f.id,name:f.name,description:f.description??'',value:Object.hasOwn(values,f.id)?!!values[f.id]:null})); // null = never set (reads as false).
  const known=new Set(authored.map(f=>f.id));
  const engine=Object.entries(values).filter(([key])=>!known.has(key)).map(([id,value])=>({id,value:!!value})); // Campaign/dungeon memory and retired story flags: clear-only.
  const once=Object.keys(mem.once??{}).filter(key=>mem.once[key]); // One-time campaign choice outcomes.
  const questRows=quests?quests.gmCatalog(c):[];
  const runs=flows?db.prepare('SELECT flow,state FROM story_flow_runs WHERE character_id=? ORDER BY updated').all(c.id):[];
  const stories=(flows?.list()??[]).filter(f=>f.published&&!f.published.retired).map(f=>{const mine=runs.filter(r=>r.flow===f.id);return {id:f.id,name:f.published.name??f.id,repeatable:!!f.published.repeatable,runs:mine.length,status:mine.length?runStatus(mine.at(-1)):''};});
  const reads=new Map(db.prepare("SELECT orb,count FROM orb_reads WHERE character_id=?").all(c.id).map(r=>[r.orb,r.count]));
  const orbs=Object.values(live.published().orbs??{}).filter(o=>!o.retired).map(o=>({id:o.id,title:o.title??o.id,repeatable:!!o.repeatable,reads:reads.get(o.id)??0}));
  return {character:{id:c.id,owner:c.owner,name:c.name,revision:c.revision},flags:{authored,engine,once},quests:questRows,stories,orbs};
 }

 function save(c,s,before){ // Bump the revision even for table-only changes so an online client refetches its quests/story.
  const previous=JSON.parse(before);if(JSON.stringify(s.loadout)!==JSON.stringify(previous.loadout))s.loadoutRevision=c.revision+1; // Same rule zones.mjs saveOther() uses when a loadout changes.
  db.prepare('UPDATE quest_characters SET state=?,revision=revision+1 WHERE id=?').run(JSON.stringify(s),c.id);
 }

 function act(input){ // progress_* actions from the panel; the caller owns the transaction and the audit row.
  const c=load(input.character_id);if(c.revision!==input.revision)fail('This character changed. Refresh before editing.',409); // Never overwrite a newer game save.
  const before=c.state,s=JSON.parse(before),mem=memory(s);let message='';
  if(input.action==='progress_flag_set'){ // Authored story_ flags only; the helper rejects engine achievements.
   setStoryFlag(s,input.flag,input.value,flows?.flags()??[]);message=input.flag+' set to '+input.value+'.';
  }else if(input.action==='progress_flag_clear'){ // Remove the key entirely (missing = false). Works on engine memory too so campaign events can replay.
   const bag=input.kind==='once'?mem.once:mem.flags;
   if(typeof input.flag!=='string'||!Object.hasOwn(bag,input.flag))fail('That character does not have this '+(input.kind==='once'?'one-time event':'flag')+'.');
   delete bag[input.flag];message=(input.kind==='once'?'One-time event ':'Flag ')+input.flag+' cleared.';
  }else if(input.action==='progress_quest'){
   if(!quests)fail('Online quests are not enabled on this server.',409);
   if(typeof input.quest!=='string'||!input.quest)fail('Choose a quest.');
   if(input.op==='finish'){ // Complete without rewards: marks it claimed so prerequisites and once-only rules see it as done.
    const published=live.published().quests[input.quest];
    let row=db.prepare("SELECT id,state FROM online_quests WHERE character_id=? AND quest=? AND json_extract(state,'$.status') IN ('active','choice','ready') ORDER BY created DESC LIMIT 1").get(c.id,input.quest);
    if(!row){quests.gm(c,s,'quest_start',input.quest);row=db.prepare("SELECT id,state FROM online_quests WHERE character_id=? AND quest=? ORDER BY created DESC LIMIT 1").get(c.id,input.quest);} // Starts it first when it isn't active.
    const state=JSON.parse(row.state);state.status='claimed';state.reward={quest:input.quest,name:published?.name??input.quest,coins:0,cappedCoins:0,xp:0,rpp:0,items:[],gm:true};
    db.prepare('UPDATE online_quests SET state=? WHERE id=?').run(JSON.stringify(state),row.id);
    db.prepare('INSERT OR IGNORE INTO online_quest_claims VALUES (?,?,?,?,?)').run(row.id,c.id,input.quest,now(),JSON.stringify(state.reward)); // No coins, XP or items are paid.
    message='Finished '+(published?.name??input.quest)+' without rewards.';
   }else{
    const op=QUEST_OPS[input.op];if(!op)fail('Choose start, advance, complete, finish or remove.');
    const name=quests.gm(c,s,op,input.quest);message={start:'Started',advance:'Advanced',complete:'Completed (ready to turn in)',remove:'Removed'}[input.op]+' quest: '+name+'.';
   }
  }else if(input.action==='progress_story_replay'){ // Forget this character's runs of one personal story so a one-time story can play again.
   if(!flows)fail('Personal stories are not enabled on this server.',409);if(typeof input.flow!=='string'||!input.flow)fail('Choose a story.');
   const open=db.prepare("SELECT 1 FROM story_flow_runs WHERE character_id=? AND flow=? AND json_extract(state,'$.done') IS NOT 1").get(c.id,input.flow);
   if(open&&(s.run||s.pendingDefeat))fail('That character is in a battle from this story. Wait until it ends.',409); // A shared encounter still points at the run.
   const removed=db.prepare('DELETE FROM story_flow_runs WHERE character_id=? AND flow=?').run(c.id,input.flow).changes;
   db.prepare('DELETE FROM story_trigger_events WHERE character_id=? AND flow=?').run(c.id,input.flow); // Flag/objective entry triggers may fire again...
   db.prepare('DELETE FROM story_trigger_flags WHERE character_id=? AND flow=?').run(c.id,input.flow); // ...including right away if their flag is still set.
   if(!removed)fail('That character has not played this story.');
   message='Story '+input.flow+' can play again ('+removed+' run'+(removed===1?'':'s')+' forgotten).';
  }else if(input.action==='progress_orb_forget'){ // A spent (non-repeatable) orb lights up again for this character.
   if(typeof input.orb!=='string'||!db.prepare('DELETE FROM orb_reads WHERE character_id=? AND orb=?').run(c.id,input.orb).changes)fail('That character has not read this orb.');
   message='Orb '+input.orb+' can be read again.';
  }else fail('Unknown progress action.');
  save(c,s,before);return {message,...detail(c.id)};
 }

 return {search,detail,act};
}
