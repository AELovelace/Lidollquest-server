// GM "Companions" tab (gm.mjs GET /gm/companions, POST /gm/action companion_*): companion memory tuning, backstory
// review/editing on top of the exported followers-data.json drafts, and per-character memory tools (look up, wipe,
// delete one memory, set a bond for testing). Lives in the main process beside companion-memory.mjs.
import {SLIP_DEFAULTS} from './follower-chat.mjs';
import {MEMORY_DEFAULTS} from './companion-memory.mjs';
import {ADDRESS_DEFAULTS} from './companion-addressing.mjs';
import {REACTION_DEFAULTS,IDLE_DEFAULTS} from './companion-reactions.mjs';
import {AMBIENT_DEFAULTS,AMBIENT_BOUNDS} from './ambient-life.mjs';
import {validateAiPersona} from './quest-content.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,code:'companion_admin_invalid'});};
const clean=v=>String(v??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
export const COMPANION_SETTING_BOUNDS=Object.freeze({ // [min,max] for numbers; a list of allowed values otherwise.
 slip_chance:[0,1], slip_dignity:[0,200], gossip_chance:[0,1],
 bond_hourly_cap:[0,100], keep_per_pair:[20,2000], send_cap:[0,80], impression_min_words:[1,50],
 lore_drafts:['live','hidden'],
 followup_window_s:[0,900], followup_cooldown_s:[1,60], busy_threshold:[1,50],
 hirer_default:['on','off'], fuzzy_names:['on','off'], emote_replies:['on','off'], address_classifier:['on','off'],
 situation_enabled:['on','off'],
 reactions_enabled:['on','off'], reaction_chance:[0,1], reaction_ai_chance:[0,1], reaction_cooldown_s:[10,3600], ai_calls_per_minute:[0,600],
 musings_enabled:['on','off'], musing_after_s:[30,3600], musing_cooldown_min_s:[60,7200], musing_cooldown_max_s:[60,7200], musing_chance:[0,1],
 banter_enabled:['on','off'], banter_chance:[0,1], banter_cooldown_min_s:[60,7200], banter_cooldown_max_s:[60,7200],
 ...AMBIENT_BOUNDS, // Ambient NPC life (ambient-life.mjs): GM NPC personas and shopkeeper beckons; local AI only.
});
const ID_RE=/^[a-z0-9][a-z0-9_-]{0,63}$/,FLAG_RE=/^[a-z][a-z0-9_:.-]{0,63}$/; // Same rules as python/companion_backstory.py.

export function createCompanionAdmin(db,{memory,followers,ambient=()=>null,now=Date.now,pool=()=>[],loreDrafts=process.env.QUEST_COMPANION_LORE_DRAFTS||'live',onLoreChange=()=>{}}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_companion_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS quest_companion_lore(npc TEXT NOT NULL,id TEXT NOT NULL,heading TEXT NOT NULL DEFAULT '',text TEXT NOT NULL DEFAULT '',reveal_bond INTEGER NOT NULL DEFAULT 0,
   reveal_flag TEXT NOT NULL DEFAULT '',draft INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '',PRIMARY KEY(npc,id));`);
 const defaults={...SLIP_DEFAULTS,...MEMORY_DEFAULTS,...ADDRESS_DEFAULTS,...REACTION_DEFAULTS,...IDLE_DEFAULTS,...AMBIENT_DEFAULTS,situation_enabled:'on',lore_drafts:loreDrafts==='hidden'?'hidden':'live'};
 let cached=null;
 function settings(){ // Every knob, GM values over the shipped defaults.
  if(cached)return cached;const out={...defaults};
  for(const row of db.prepare('SELECT key,value FROM quest_companion_settings').all())if(Object.hasOwn(defaults,row.key))out[row.key]=JSON.parse(row.value);
  return cached=out;
 }

 function lore(){ // catalog-shaped {npc:{online:{backstory:[...]}}}: exported sections with GM edits, deletions and additions applied.
  const overrides=db.prepare('SELECT * FROM quest_companion_lore').all(),out={};
  for(const [npc,def] of Object.entries(followers.catalog)){
   const mine=overrides.filter(o=>o.npc===npc),sections=[];
   for(const s of def.online?.backstory??[]){const o=mine.find(x=>x.id===s.id);if(o?.deleted)continue;sections.push(o?{id:o.id,heading:o.heading,text:o.text,reveal:{bond:o.reveal_bond,...(o.reveal_flag?{flag:o.reveal_flag}:{})},draft:!!o.draft,source:'gm'}:{...s,source:'export'});}
   for(const o of mine)if(!o.deleted&&!(def.online?.backstory??[]).some(s=>s.id===o.id))sections.push({id:o.id,heading:o.heading,text:o.text,reveal:{bond:o.reveal_bond,...(o.reveal_flag?{flag:o.reveal_flag}:{})},draft:!!o.draft,source:'gm'});
   out[npc]={name:def.name,online:{backstory:sections}};
  }
  return out;
 }

 function findCharacters(query){ // By id or exact name (any case); a few matches for the GM to choose from.
  const q=clean(query);if(!q)return [];
  return db.prepare('SELECT id,name,owner FROM quest_characters WHERE id=? OR lower(name)=lower(?) LIMIT 5').all(q,q);
 }

 function gmView({character=''}={}){
  const matches=findCharacters(character),chosen=matches.length===1?matches[0]:null;
  return {settings:settings(),defaults,bounds:Object.fromEntries(Object.entries(COMPANION_SETTING_BOUNDS).filter(([key])=>!key.startsWith('ambient_'))),nodes:pool(), // Ambient Life knobs live on their own tab (ambientView).
   companions:Object.entries(lore()).map(([npc,v])=>({npc,name:v.name,sections:v.online.backstory,drafts:v.online.backstory.filter(s=>s.draft).length})),
   matches,character:chosen?{...chosen,...memory.view(chosen.id)}:null};
 }

 function validSection(s){
  const id=clean(s?.id),heading=clean(s?.heading),text=clean(s?.text),bond=Number(s?.reveal?.bond??0),flag=clean(s?.reveal?.flag??'');
  if(!ID_RE.test(id))fail('Section id: 1-64 lowercase letters, digits, - or _.');
  if(!heading||heading.length>80)fail('Heading: 1-80 characters.');
  if(!text||text.length>1200)fail('Text: 1-1200 characters.');
  if(!Number.isInteger(bond)||bond<0||bond>100)fail('Reveal bond: a whole number 0-100.');
  if(flag&&!FLAG_RE.test(flag))fail('Reveal flag: a story flag id (lowercase, starts with a letter).');
  return {id,heading,text,bond,flag,draft:!!s?.draft};
 }
 const putLore=(npc,s,actor,deleted=0)=>db.prepare(`INSERT INTO quest_companion_lore(npc,id,heading,text,reveal_bond,reveal_flag,draft,deleted,updated,actor) VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(npc,id) DO UPDATE SET heading=excluded.heading,text=excluded.text,reveal_bond=excluded.reveal_bond,reveal_flag=excluded.reveal_flag,draft=excluded.draft,deleted=excluded.deleted,updated=excluded.updated,actor=excluded.actor`)
  .run(npc,s.id,s.heading??'',s.text??'',s.bond??0,s.flag??'',s.draft?1:0,deleted,now(),actor);
 const companion=npc=>{if(!followers.catalog[npc])fail('Choose a companion.');return npc;};
 const section=(npc,id)=>lore()[npc]?.online.backstory.find(s=>s.id===id)??fail('That backstory section does not exist.',404);

 const actions={
  companion_settings(input,actor){ // Bounded tuning; unknown keys are refused rather than ignored.
   const values=input.values??{};if(!Object.keys(values).length)fail('Nothing to change.');
   for(const [key,value] of Object.entries(values)){
    const bound=COMPANION_SETTING_BOUNDS[key];if(!bound)fail('Unknown setting: '+key+'.');
    if(typeof bound[0]==='string'){if(!bound.includes(value))fail(key+' must be one of '+bound.join(', ')+'.');}
    else if(typeof value!=='number'||!Number.isFinite(value)||value<bound[0]||value>bound[1])fail(`${key} must be a number from ${bound[0]} to ${bound[1]}.`);
   }
   const put=db.prepare('INSERT INTO quest_companion_settings(key,value,updated,actor) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated,actor=excluded.actor');
   for(const [key,value] of Object.entries(values))put.run(key,JSON.stringify(value),now(),actor);
   cached=null;if('lore_drafts' in values)onLoreChange();return settings();
  },
  companion_lore_save(input,actor){const npc=companion(input.npc),s=validSection(input.section);putLore(npc,s,actor);onLoreChange();return section(npc,s.id);}, // Edit or add; the AI nodes get the new version on the next reply.
  companion_lore_signoff(input,actor){const npc=companion(input.npc),s=section(npc,clean(input.id));putLore(npc,{id:s.id,heading:s.heading,text:s.text,bond:s.reveal?.bond??0,flag:s.reveal?.flag??'',draft:false},actor);onLoreChange();return section(npc,s.id);},
  companion_lore_delete(input,actor){const npc=companion(input.npc),s=section(npc,clean(input.id));putLore(npc,{id:s.id},actor,1);onLoreChange();return {npc,id:s.id,deleted:true};},
  companion_memory_wipe(input){const id=clean(input.character_id);if(!db.prepare('SELECT 1 FROM quest_characters WHERE id=?').get(id))fail('Choose a character.');memory.forget(id);return {character_id:id,wiped:true};},
  companion_memory_delete(input){const id=clean(input.id);if(!memory.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes)fail('That memory does not exist.',404);return {id,deleted:true};},
  companion_bond_set(input){ // For testing secrets: sets the bond outright (the hourly cap still applies to play afterwards).
   const npc=companion(input.npc),id=clean(input.character_id),bond=Number(input.bond);
   if(!db.prepare('SELECT 1 FROM quest_characters WHERE id=?').get(id))fail('Choose a character.');if(!Number.isInteger(bond)||bond<0||bond>100)fail('Bond: a whole number 0-100.');
   memory.db.prepare('INSERT INTO bonds(npc,character_id,bond,hour,hour_gain,updated) VALUES (?,?,?,0,0,?) ON CONFLICT(npc,character_id) DO UPDATE SET bond=excluded.bond,updated=excluded.updated').run(npc,id,bond,now());
   return {npc,character_id:id,bond};
  },
  ambient_settings(input,actor){const values=input.values??{};for(const key of Object.keys(values))if(!Object.hasOwn(AMBIENT_BOUNDS,key))fail('Not an Ambient Life setting: '+key+'.');return actions.companion_settings(input,actor);}, // Same bounded store as companion tuning, limited to ambient_* keys.
  ambient_export(){const life=ambient();if(!life)fail('Ambient life is not running on this server.',409);const jsonl=life.exportDecisions();return {jsonl,rows:jsonl?jsonl.split(String.fromCharCode(10)).length:0};}, // Scrubbed Decider decisions for training (player names -> Player1..n).
 };
 function ambientView(){ // GM "Ambient Life" tab (GET /gm/ambient): its own knobs, the AI nodes, and the live status, transcript and Decider log.
  const all=settings();
  return {settings:Object.fromEntries(Object.keys(AMBIENT_BOUNDS).map(k=>[k,all[k]])),defaults:{...AMBIENT_DEFAULTS},bounds:AMBIENT_BOUNDS,nodes:pool(),ambient:ambient()?.view()??null};
 }
 async function ambientTest(input){ // GM persona editor preview (POST /gm/ambient-test): validated draft persona, one line or one Decider verdict.
  const life=ambient();if(!life)fail('Ambient life is not running on this server.',409);
  const npc=input?.npc;if(!npc||typeof npc!=='object')fail('Send the NPC draft to test.');
  let persona;try{persona=validateAiPersona(npc.ai_persona??{});}catch(error){fail(error.message);}
  return life.test({id:clean(npc.id).slice(0,64),name:clean(npc.name).slice(0,32),ai_persona:persona},{mode:input.mode==='gate'?'gate':'line',message:clean(input.message).slice(0,500),speaker:clean(input.speaker).slice(0,64)||'Traveller'});
 }
 return {settings,lore,gmView,ambientView,actions,ambientTest,invalidate(){cached=null;}};
}
