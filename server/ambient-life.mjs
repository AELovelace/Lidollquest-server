import {speakingStyleFields} from './speaking-style.mjs';
import {randomUUID} from 'node:crypto';
import {createResidentMemory} from './resident-memory.mjs';
// Ambient NPC life (AMBIENT_NPC_LIFE_PLAN.md): GM NPCs with an enabled ai_persona strike up short conversations with each
// other or with a passing player, and anyone in earshot can join in. System shopkeepers only beckon players toward their shop.
//
//   start   a dice roll (chance x chattiness/50) per NPC every ambient_check_s, with a 3-6 minute cooldown and a line budget
//   reply   Decider Chat (/v1/participation/decide): JOIN = speak, QUIET = the conversation is over; 5 responses per NPC at most
//   join    after a line, the closest persona NPCs (ambient_gate_fanout) are gated in parallel; the best JOIN chimes in, once
//   player  a player's area line near persona NPCs: a name goes straight to that NPC, otherwise the Decider picks at most one
//   lines   npc-rag /v1/companion/chat ambient_* / shop_beckon kinds: LOCAL ONLY (npc-rag PAID_KINDS cost guard); a 429
//           "local_busy" means the local slots are kept for players, so the line is skipped and its budget token refunded
//   down    any Decider failure, or QUEST_PARTICIPATION_BACKEND other than 'decider': nothing ambient happens (Doll's call)
//
// Conversations live in memory (they are seconds long); lines are ordinary quest_chat rows at the NPC's tile, heard through
// stampHearers like every area line. character_id 'npc:<zone>:<placement or shop:fixture>', owner 'ambient:<area>'.
import {participationSaysJoin,npcParticipationContext} from './participation-gate.mjs';
import {personaText,participationProfile} from './ambient-persona.mjs';
import {situationFacts} from './companion-situation.mjs';
import {trimLine} from './follower-chat.mjs';

export const AMBIENT_DEFAULTS=Object.freeze({ // GM Companions tab knobs (companion-admin.mjs AMBIENT bounds); the master switch ships off.
 ambient_memory:'on',ambient_gossip:'on',
 ambient_enabled:'off',ambient_chance:0.25,ambient_check_s:20,ambient_chime_chance:0.35,ambient_talk_range:4,
 ambient_cooldown_min_s:180,ambient_cooldown_max_s:360,ambient_max_responses:5,ambient_gate_fanout:3,
 ambient_calls_per_minute:20,ambient_gate_calls_per_minute:60,ambient_line_gap_s:4,ambient_idle_s:60,
 ambient_beckons:'off',ambient_beckon_chance:0.2,ambient_beckon_range:5,ambient_beckon_cooldown_s:300,ambient_conversations_per_area:4,
});
export const AMBIENT_BOUNDS=Object.freeze({ // [min,max] numbers or allowed values, merged into COMPANION_SETTING_BOUNDS.
 ambient_memory:['on','off'],ambient_gossip:['on','off'],
 ambient_enabled:['on','off'],ambient_chance:[0,1],ambient_check_s:[5,600],ambient_chime_chance:[0,1],ambient_talk_range:[1,15],
 ambient_cooldown_min_s:[30,7200],ambient_cooldown_max_s:[30,7200],ambient_max_responses:[1,10],ambient_gate_fanout:[1,8],
 ambient_calls_per_minute:[0,600],ambient_gate_calls_per_minute:[0,600],ambient_line_gap_s:[1,30],ambient_idle_s:[15,600],
 ambient_beckons:['on','off'],ambient_beckon_chance:[0,1],ambient_beckon_range:[2,10],ambient_beckon_cooldown_s:[30,7200],ambient_conversations_per_area:[1,4],
});
const TICK_MS=5000;        // Strike-ups and beckons are considered at most this often; heard player lines every tick.
const GATE_DOWN_MS=60000;  // A failed Decider call pauses all ambient life this long.
const HEARD_MAX_AGE=15000; // A queued player line older than this is no longer worth answering.
const RING=200;            // Decision log and transcript sizes (GM panel, training export).

const clean=s=>String(s??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim(); // One printable line.
const near=(a,b,r)=>Math.abs(a.x-b.x)<=r&&Math.abs(a.y-b.y)<=r; // Square talk range, in tiles.
const dist=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const defaultSleep=ms=>new Promise(r=>{const t=setTimeout(r,ms);t.unref?.();}); // Never holds the process open.
const grams=(text,n=5)=>{const w=String(text).toLowerCase().match(/[a-z']+/g)??[],out=new Set();for(let i=0;i+n<=w.length;i++)out.add(w.slice(i,i+n).join(' '));return out;}; // Word 5-grams for the repeat check.
const repeats=(text,said)=>{const mine=grams(text,7);return said.some(old=>clean(old).toLowerCase()===clean(text).toLowerCase()||[...grams(old,7)].some(g=>mine.has(g)));}; /* 7 words in a row or the same line: 5-word runs matched everyday phrases and silenced openers (2026-10-15). */ // Live 2026-10-14: Wren said one line three times.
const TOPICS=[['hungry','hunger','starv','peckish','eat','food','snack','meal','stew','feed'],['thirsty','thirst','parched','drink'],['hurt','wound','injur','bruis'],['toilet','potty','fidget','desperate','squirm'],['accident'],['padding','diaper','nappy','soggy','soaked','mess','squish'],['smell','stink','whiff','pong']]; // Word starts that mean the same observation; no plain "wet" ("wet the whistle" is a tavern line, not a padding remark).
const said=(text,words)=>words.some(w=>new RegExp('\\b'+w,'i').test(String(text))); // Word starts: "eat" never matches "great".
const unsaid=(facts,lines)=>facts.filter(f=>{const topic=TOPICS.find(words=>said(f,words));return !topic||!lines.some(l=>said(l,topic));}); // Doll 2026-10-15: remark on what you notice once per conversation, not four times in a row.
const nameIn=(text,name)=>{const first=clean(name).split(' ')[0];if(first.length<3)return false;return new RegExp('\\b'+first.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i').test(text);}; // "Padma, what's good?" names Padma.

// scenes(zoneIds|null, {beckons}) -> [{zone, npcs:[{ref,content,x,y}], shops:[{ref,name,x,y,wares}], players:[{id,owner,name,x,y,area,state}]}]
// is supplied by zones.mjs: realized world placements, hub shop fixtures and present players of the zones that matter.
export function createAmbientLife(db,{now=Date.now,gameMinute=()=>undefined,roll=Math.random,pool=()=>null,gateBackend=process.env.QUEST_PARTICIPATION_BACKEND||'qwen',
 tuning=()=>({}),npcs=()=>({}),scenes=()=>[],stamp=()=>{},hold=()=>{},onScreen=(a,b)=>near(a,b,15),sleep=defaultSleep,log=console.warn,speakingStyle=null,memoryFile=':memory:'}={}){ // speakingStyle(npcId): the GM dialogue preset over the persona's own
 let closed=false,lastTick=-Infinity,gateDownUntil=0,alarms=0;
 const memory=createResidentMemory(db,{file:memoryFile,now,log}),memorySession=randomUUID(); // Stable placement IDs persist; session IDs keep old encounters distinct after a restart.
 const stop=new AbortController();
 const convos=new Map();       // conversation id -> {id,zone,area,actors:Map,responses:Map,lines,players:Set,target,chimed,running,lastAt}; up to ambient_conversations_per_area per room
 const busy=new Set();         // conversation ids with an AI step on the way, plus 'heard:<area>' while a room's player lines are answered in order
 let convoSeq=0;
 const nextCheck=new Map();    // actor key -> when its next strike-up roll may happen
 const cooldown=new Map();     // actor key -> when it may start (or be pulled into) another conversation
 const beckoned=new Map();     // shop key|character -> when that player may be beckoned by that shop again
 const recentSaid=new Map();   // actor key -> its last 12 lines across conversations (never said again; live 2026-10-15 the same exchange every time)
 const recentTopics=new Map(); // actor key -> the last 3 topics it opened with, so the next opener picks a different one
 const heard=[];               // queued player lines {c,text,area,zone,x,y,emote,companion,at}
 const decisions=[],transcript=[],stats={lines:0,busy:0,quiet:0,join:0,gate_failures:0,ai_failures:0,repeats:0,openers_dropped:0},drops={}; // drops: npc-rag guard verdict -> count (repeated, unsupported_terms, leak_blocked).
 const warned=new Map();
 function warn(what,error){const t=now();if(t-(warned.get(what)??-Infinity)<60000)return;warned.set(what,t);log('ambient_'+what+'_failed',String(error?.message??error).slice(0,200));} // One line per kind per minute.
 const knobs=()=>{const out={...AMBIENT_DEFAULTS},raw=tuning()??{};for(const key of Object.keys(AMBIENT_DEFAULTS))if(raw[key]!==undefined)out[key]=raw[key];return out;};
 const on=k=>!closed&&k.ambient_enabled==='on'&&gateBackend==='decider'&&!!pool()&&now()>=gateDownUntil; // Every condition for any ambient line.
 function bucket(key){let tokens=null,at=0;return {spend(n=1){const cap=Math.max(0,Number(knobs()[key])||0),t=now();if(tokens===null){tokens=cap;at=t;}tokens=Math.min(cap,tokens+cap*(t-at)/60000);at=t;if(tokens<n)return false;tokens-=n;return true;},refund(n=1){tokens=(tokens??0)+n;},view(){return Math.floor(tokens??Number(knobs()[key])??0);}};} // Refills continuously up to one minute's worth.
 const lineBudget=bucket('ambient_calls_per_minute'),gateBudget=bucket('ambient_gate_calls_per_minute');
 const pause=(k,lo,hi)=>{const a=Number(k[lo])*1000,b=Math.max(a,Number(k[hi])*1000);return a+roll()*(b-a);};
 const push=(ring,row)=>{ring.push(row);if(ring.length>RING)ring.shift();};

 const styleOf=(id,persona)=>{const gm=speakingStyle?.(String(id));return gm===undefined?persona?.speaking_style:gm;}; // null = persona voice
 function residents(){ // GM panel: every GM NPC with its AI persona on, and its authored dialogue preset.
  return Object.entries(npcs()??{}).filter(([,d])=>d&&!d.retired&&d.ai_persona?.enabled).map(([id,d])=>({id,name:clean(d.name).slice(0,32)||id,authored:d.ai_persona.speaking_style??null}));
 }

 // ── Actors: persona NPC placements and beckoning shops, in one shape ──
 function actorsOf(scene){
  const defs=npcs()??{},names=Object.fromEntries(Object.entries(defs).map(([id,n])=>[id,n?.name??id])),out=[];
  for(const p of scene.npcs??[]){
   const def=defs[p.content],persona=def?.ai_persona;if(!def||def.retired||!persona?.enabled)continue; // Only GM NPCs whose persona is switched on.
   out.push({key:'resident:'+p.ref,ref:p.ref,charId:'npc:'+scene.zone+':'+p.ref,npcId:String(p.content).slice(0,64),kind:'npc',zone:scene.zone,x:p.x,y:p.y,name:clean(def.name).slice(0,32)||'Resident',
    persona:personaText(def.name,persona,{names}),relationships:persona.relationships??[],voice:(persona.voice??[]).slice(0,5),...speakingStyleFields(styleOf(p.content,persona)),profile:participationProfile(persona),
    topics:[...(persona.interests??[]),...(persona.desires??[]),...(persona.relationships??[]).map(r=>clean((names[r.ref]??r.name)+': '+r.note))].map(t=>clean(t).slice(0,160)).filter(Boolean),talksTo:persona.talks_to??'both',chattiness:Number(persona.chattiness??50)});
  }
  for(const s of scene.shops??[]){ // A shopkeeper only calls out to players; it has no persona beyond its shop.
   const wares=(s.wares??[]).map(w=>clean(w)).filter(Boolean).slice(0,6),name=clean(s.name).slice(0,32)||'Shopkeeper';
   out.push({key:scene.zone+':shop:'+s.ref,ref:'shop:'+s.ref,charId:'npc:'+scene.zone+':shop:'+s.ref,npcId:('shop_'+s.ref).slice(0,64),kind:'shop',zone:scene.zone,x:s.x,y:s.y,name,
    persona:`${name} runs a shop here${wares.length?' and sells '+wares.join(', '):''}.`,voice:[],profile:{role:'shopkeeper',interests:wares.slice(0,4)},topics:wares,talksTo:'players',chattiness:50,wares});
  }
  return out;
 }
 const sceneFor=zone=>{if(closed)return null;try{return scenes([zone],{beckons:knobs().ambient_beckons==='on'})[0]??null;}catch(error){warn('scene',error);return null;}};
 const hearers=(scene,at,area)=>(scene?.players??[]).filter(p=>p.area===area&&onScreen(at,p)); // Players who would hear a line spoken at `at`.

 // ── The Decider: one candidate per call, at most one speaker per line ──
 async function gate(candidates,{speaker,message,kind='chat',convo,nearby=[],players=null}){ // -> chosen actor or null; throws GateDown on any failure. convo: a conversation, or a function actor -> its conversation.
  const affordable=[];for(const a of candidates)if(gateBudget.spend())affordable.push(a);else break; // Closest first: the budget trims the far end.
  if(!affordable.length)return null;
  const convoOf=typeof convo==='function'?convo:()=>convo;
  const results=await Promise.all(affordable.map(async a=>{
   const cv=convoOf(a),turns=(cv?.lines??[]).map(l=>({speaker:l.speaker,text:l.text})),who=players??[...(cv?.playerNames??[])];
   const body=npcParticipationContext(a,{speaker,message,kind,turns,conversation:!!cv&&cv.actors.has(a.key),nearbyNames:nearby});
   const t0=now();let res;try{res=await pool().request('/v1/participation/decide',body,{timeoutMs:12000,signal:stop.signal});}catch(error){throw Object.assign(Error('decider unreachable: '+(error?.message??error)),{gateDown:true});}
   if(!res.ok)throw Object.assign(Error('decider answered '+res.status),{gateDown:true});
   let join;try{join=participationSaysJoin(res.body);}catch(error){throw Object.assign(error,{gateDown:true});} // A malformed reply is an outage, never a silent JOIN.
   push(decisions,{at:t0,area:cv?.area??'',candidate:body.candidate.name,role:body.candidate.role,interests:body.candidate.interests,speaker:body.speaker,message:body.message,kind:body.kind,
    recent_turns:body.recent_turns,nearby_names:body.nearby_names,conversation_with_candidate:body.conversation_with_candidate,decision:res.body.decision,join_probability:res.body.join_probability,ms:now()-t0,players:who});
   stats[join?'join':'quiet']++;return {actor:a,join,p:res.body.join_probability};
  }));
  const joins=results.filter(r=>r.join).sort((a,b)=>b.p-a.p); // join_probability only ranks JOINs; it is never a threshold (uncalibrated).
  return joins[0]?.actor??null;
 }
 function gateDown(error){gateDownUntil=now()+GATE_DOWN_MS;stats.gate_failures++;warn('decider',error);for(const c of convos.values())c.running=false;} // Doll: gate down = nothing ambient happens.

 // ── One generated line, local only ──
 function residentContext(actor,other,extra,convo){
  if(actor.kind!=='npc'||!other)return undefined;
  const npc=other.kind==='npc',peer=npc?other.key:String(other.id),conversation=memorySession+':'+convo.id,requestId=randomUUID();
  const relationship=npc?(actor.relationships??[]).filter(r=>r.ref===other.npcId||(!r.ref&&clean(r.name).toLowerCase()===other.name.toLowerCase())).map(r=>clean(r.note)).join('; ').slice(0,400):'';
  const enabled=knobs().ambient_memory==='on';
  const audit={conversation,requestId,targetKind:npc?'npc':'player',targetPeer:peer,targetName:other.name};
  const memories=enabled&&(npc||!extra.audience)?memory.recall(actor.key,npc?'npc':'player',peer,{...audit,message:extra.message||extra.partner?.line||extra.topic}):[];
  const gossip=enabled&&npc&&knobs().ambient_gossip==='on'?memory.gossip(actor.key,{...audit,message:extra.partner?.line||extra.topic}):[];
  convo.recallTargets??=new Map();convo.recallTargets.set(actor.key,!npc&&memories.length?peer:null);
  if(gossip.length)convo.memoryGossip=true; // Never save generated gossip back as another resident's firsthand encounter memory.
  return {kind:npc?'npc':'player',name:clean(other.name).slice(0,64),relationship,memories,gossip};
 } // Relationship notes are selected before persona truncation; personal recall never travels to a different player.
 async function line(actor,extra,convo=null,other=null){ // -> text or '' (skipped); never throws for an AI failure
  if(!lineBudget.spend())return '';
  const said=(recentSaid.get(actor.key)??[]).slice(-8); // Lines from earlier conversations: shown as "never say again" and checked below.
  const body={npc_id:actor.npcId,npc_name:actor.name,persona:actor.persona.slice(0,1500),...speakingStyleFields(actor.speaking_style),voice:actor.voice.map(v=>clean(v).slice(0,200)),said,message:'(ambient)',...extra,
   resident_context:residentContext(actor,other,extra,convo)};
  let res;try{res=await pool().request('/v1/companion/chat',body,{timeoutMs:20000,signal:stop.signal,busyStatuses:[429]});}catch(error){stats.ai_failures++;warn('line',error);return '';}
  if(res.status===429){lineBudget.refund();stats.busy++;return '';} // local_busy: the local slots belong to players right now; no charge, no line.
  if(!res.ok||res.body?.fallback){stats.ai_failures++;warn('line','AI answered '+res.status);return '';}
  if(res.body?.lane==='cloud'){alarms++;log('ambient_cost_guard','an ambient line came back from the paid cloud; dropped');return '';} // Cannot happen (npc-rag PAID_KINDS); dropped and counted if it ever does.
  const verdict=String(res.body?.guard??'passed');if(!verdict.startsWith('passed')){drops[verdict]=(drops[verdict]??0)+1;if(verdict==='repeated')stats.repeats++;return '';} // npc-rag gave up on this line (it kept repeating itself, or named things it shouldn't): silence.
  const text=trimLine(clean(String(res.body?.reply??'').replace(/<\/?think>/gi,' '))); // A stray reasoning tag never reaches chat (live 2026-10-15). // Whole sentences or words, never a mid-word cut.
  if(repeats(text,[...(recentSaid.get(actor.key)??[]),...(convo?convo.lines.filter(l=>l.key===actor.key).map(l=>l.text):[])])){stats.repeats++;return '';} // Never say the same thing twice in one conversation.
  return text;
 }
 function post(actor,text,convo,{player=null,message='',playerSourceSeq=null}={}){ // One ambient line and its memory outbox events commit together.
  if(closed)return false; // The service shut down while the line was being written.
  const scene=sceneFor(convo.zone),current=scene&&actorsOf(scene).find(a=>a.key===actor.key);if(!current)return false;actor=current; // Drop delayed replies after a resident crosses into another zone.
  const audience=hearers(scene,actor,convo.area),privateTarget=convo.recallTargets?.get(actor.key);
  if(player&&!audience.some(p=>p.id===player.id))return false; // A departed player must not leave a phantom encounter.
  if(privateTarget&&audience.some(p=>p.id!==privateTarget))return false; // Recheck privacy if someone arrived during generation.
  const conversation=memorySession+':'+convo.id;
  db.exec('BEGIN IMMEDIATE');try{
   const result=db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created,emote,x,y) VALUES (?,?,?,?,?,?,0,?,?)').run(convo.area,'ambient:'+convo.area,actor.charId,actor.name,text,now(),actor.x,actor.y);
   const sourceSeq=Number(result.lastInsertRowid);
   if(knobs().ambient_memory==='on'&&actor.kind==='npc'&&player){
    const pair={resident:actor.key,peerKind:'player',peer:String(player.id),conversation,sourceSeq};
    if(message)memory.remember({...pair,sourceSeq:playerSourceSeq??sourceSeq,speaker:player.name,speakerKind:'player',text:message});
    memory.remember({...pair,speaker:actor.name,speakerKind:'npc',text});
   }else if(knobs().ambient_memory==='on'&&actor.kind==='npc'&&!convo.playerNames.size&&!convo.memoryGossip){
    for(const peer of actorsOf(scene).filter(a=>a.kind==='npc'&&a.key!==actor.key&&convo.actors.has(a.key)&&onScreen(actor,a))){
     memory.remember({resident:actor.key,peerKind:'npc',peer:peer.key,conversation,sourceSeq,speaker:actor.name,speakerKind:'npc',text});
     memory.remember({resident:peer.key,peerKind:'npc',peer:actor.key,conversation,sourceSeq,speaker:actor.name,speakerKind:'npc',text});
    }
   } // Only actual participants remember posted speech; rejected output and overheard player details do not become NPC memories.
   db.prepare('DELETE FROM quest_chat WHERE zone=? AND seq NOT IN (SELECT seq FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 100)').run(convo.area,convo.area); // Same 100-row cap as speak().
   stamp();db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  memory.drain(); // Only after chat commits: move its durable events to the separate resident-memory database.
  convo.actors.set(actor.key,actor);convo.responses.set(actor.key,(convo.responses.get(actor.key)??0)+1);convo.lines.push({speaker:actor.name,text,key:actor.key});convo.lastAt=now();stats.lines++;
  if(actor.kind==='npc')hold(actor.ref,now()+Number(knobs().ambient_idle_s)*1000); // Wanderers and routed NPCs stand still while they talk.
  push(transcript,{at:now(),zone:convo.zone,area:convo.area,speaker:actor.name,text});
  const mine=recentSaid.get(actor.key)??[];mine.push(text);if(mine.length>12)mine.shift();recentSaid.set(actor.key,mine);
  return true;
 }
 const capped=(convo,a,k)=>(convo.responses.get(a.key)??0)>=Number(k.ambient_max_responses); // Doll: 5 responses per NPC per conversation.
 const newConvo=(zone,area)=>{const c={id:zone+'#'+(++convoSeq),zone,area,actors:new Map(),responses:new Map(),lines:[],players:new Set(),playerNames:new Set(),target:null,chimed:false,running:true,lastAt:now()};convos.set(c.id,c);return c;};
 const inRoom=area=>[...convos.values()].filter(c=>c.area===area);
 const live=c=>c.running||busy.has(c.id); // A conversation still taking its turns.
 const engaged=()=>new Set([...convos.values()].filter(live).flatMap(c=>[...c.actors.keys()])); // NPCs already talking: never pulled into a second conversation.
 const thread=c=>c.lines.slice(-8).map(l=>({speaker:l.speaker.slice(0,64),text:l.text.slice(0,300)}));
 const partnerOf=a=>({name:a.name,persona:clean(`${a.name} is a ${a.profile.role}. Interests: ${a.profile.interests.join(', ')}.`,600),line:''}); // Preserve the partner's identity and interests instead of truncating a long personal backstory.
 function topicFor(a){ // One of their interests, desires or people, never one of the last three they opened with.
  const all=a.topics??[];if(!all.length)return '';
  const used=recentTopics.get(a.key)??[],fresh=all.filter(t=>!used.includes(t)),pool=fresh.length?fresh:all,topic=pool[Math.floor(roll()*pool.length)%pool.length];
  used.push(topic);if(used.length>Math.min(3,all.length-1))used.shift();recentTopics.set(a.key,used);return topic;
 }
 const place=scene=>situationFacts({name:'',state:{},zone:scene.zone,now:now(),gameMinute:gameMinute()}).slice(0,1).map(f=>f.text); // Just where and when.
 const about=(player,zone)=>situationFacts({name:clean(player.name).slice(0,32),state:player.state??{},zone,now:now(),gameMinute:gameMinute()}).map(f=>f.text).slice(0,10); // Doll: visible state may be remarked on in public (no Dignity cost).
 function present(convo){ // Refresh the participants from the live scene; false once the conversation can't go on.
  const scene=sceneFor(convo.zone);if(!scene)return null;const live=new Map(actorsOf(scene).map(a=>[a.key,a]));
  for(const key of convo.actors.keys()){const a=live.get(key);if(!a)return null;convo.actors.set(key,a);} // A retired, moved-away or switched-off NPC ends it.
  const anyone=[...convo.actors.values()].some(a=>hearers(scene,a,convo.area).length);return anyone?scene:null; // Nobody left to hear it: stop spending.
 }

 // ── NPC <-> NPC: roll to open, the Decider keeps it going, one chime-in ──
 async function converse(convo,a,b,scene,k){
  convo.actors.set(b.key,b); // B is part of it from the start: present() watches it and the Decider knows it was spoken to.
  const opener=await line(a,{kind:'ambient_open',partner:partnerOf(b),situation:place(scene),topic:topicFor(a)},convo,b);if(!opener){retrySoon(a,b);return;} // Nothing was said: try again soon with a fresh topic.
  if(!post(a,opener,convo))return;hold(b.ref,now()+Number(k.ambient_idle_s)*1000);
  let speaker=a,listener=b;
  for(;;){
   await sleep(Number(k.ambient_line_gap_s)*1000*(0.7+0.6*roll()));
   k=knobs();if(!on(k)||!convo.running||convo.interrupted)return; // A player spoke: the NPCs turn to them (hear() takes over).
   const now2=present(convo);if(!now2)return;listener=convo.actors.get(listener.key);speaker=convo.actors.get(speaker.key);
   if(capped(convo,listener,k))return;
   const last=convo.lines.at(-1),nearby=[...convo.actors.values()].map(x=>x.name).concat(hearers(now2,speaker,convo.area).map(p=>p.name));
   const chosen=await gate([listener],{speaker:speaker.name,message:last.text,convo,nearby});if(!chosen){return;} // QUIET: the conversation ends naturally.
   const reply=await line(listener,{kind:'ambient_reply',partner:{...partnerOf(speaker),line:last.text.slice(0,300)},thread:thread(convo),situation:place(now2)},convo,speaker);if(!reply||!convo.running)return;
   if(!post(listener,reply,convo))return;
   if(!convo.chimed&&roll()<Number(k.ambient_chime_chance)){ // Someone else in earshot may join, once per conversation.
    const joiner=await chime(convo,now2,listener,k);if(joiner){speaker=joiner;continue;} // The chimer spoke to the last speaker, who answers next.
   }
   [speaker,listener]=[listener,speaker];
  }
 }
 async function chime(convo,scene,last,k){
  convo.chimed=true;
  const talking=engaged(),pool2=actorsOf(scene).filter(x=>x.kind==='npc'&&!convo.actors.has(x.key)&&!talking.has(x.key)&&x.talksTo!=='players'&&onScreen(last,x)&&!capped(convo,x,k)&&(cooldown.get(x.key)??0)<=now()&&roll()<Math.min(1,x.chattiness/50))
   .sort((x,y)=>dist(x,last)-dist(y,last)).slice(0,Number(k.ambient_gate_fanout)); // Chattier NPCs are likelier to be considered at all.
  if(!pool2.length)return null;
  const heard2=convo.lines.at(-1),nearby=[...convo.actors.values(),...pool2].map(x=>x.name);
  const chosen=await gate(pool2,{speaker:last.name,message:heard2.text,convo,nearby});if(!chosen||!convo.running)return null;
  const text=await line(chosen,{kind:'ambient_chime',partner:{...partnerOf(last),line:heard2.text.slice(0,300)},thread:thread(convo),situation:place(scene)},convo,last);if(!text||!convo.running)return null;
  if(!post(chosen,text,convo))return null;cooldown.set(chosen.key,now()+pause(k,'ambient_cooldown_min_s','ambient_cooldown_max_s'));return chosen;
 }

 // ── NPC -> player: a greeting, then the player's own lines route back through hear() ──
 function retrySoon(...actors){stats.openers_dropped++;const k=knobs();for(const a of actors)if(a)cooldown.set(a.key,now()+Number(k.ambient_check_s)*1000);} // A dropped opener must not silence both NPCs for minutes.
 async function greet(convo,a,player,scene,k){
  const others=hearers(scene,a,convo.area).filter(p=>p.id!==player.id).length;
  const text=await line(a,{kind:'ambient_greet',topic:topicFor(a),player_name:clean(player.name).slice(0,64),audience:Math.min(500,others),situation:[...place(scene),...about(player,scene.zone)].slice(0,10)},convo,player);if(!text){retrySoon(a);return;}
  if(!post(a,text,convo,{player}))return;convo.players.add(player.id);convo.playerNames.add(clean(player.name));convo.target=player.id;
 }
 async function beckon(convo,shop,player,scene){
  const text=await line(shop,{kind:'shop_beckon',player_name:clean(player.name).slice(0,64),about:(shop.wares.length?`${shop.name} sells: ${shop.wares.join(', ')}.`:`${shop.name} runs a shop here.`).slice(0,300),situation:place(scene)},convo);if(!text)return;
  post(shop,text,convo);convo.players.add(player.id);convo.playerNames.add(clean(player.name));convo.target=player.id;
 }

 // ── A player's area line near persona NPCs (called from zones.speak inside its transaction: queue only) ──
 function hear(c,text,{area,zone,x,y,emote=false,companion=false,sourceSeq=null}){
  if(closed||x==null||y==null)return;const k=knobs();if(!on(k))return;
  heard.push({c:{id:c.id,name:c.name},text:clean(text).slice(0,500),area,zone,x,y,emote,sourceSeq,companion:typeof companion==='function'?!!companion():!!companion,at:now()});if(heard.length>50)heard.shift(); // sourceSeq retains the actual player chat row for memory audits.
 }
 async function answer(h,k){ // A player's line: the named NPC, or the Decider's pick among nearby NPCs, answers in that NPC's own conversation.
  const scene=sceneFor(h.zone);if(!scene)return;
  const spot={x:h.x,y:h.y},all=actorsOf(scene).filter(a=>onScreen(spot,a)),idleMs=Number(k.ambient_idle_s)*1000;
  const fresh=inRoom(h.area).filter(c=>now()-c.lastAt<idleMs),convoOf=a=>fresh.find(c=>c.actors.has(a.key))??null,mine=fresh.find(c=>c.players.has(h.c.id))??null;
  const named=all.find(a=>nameIn(h.text,a.name));
  let chosen=null;
  if(named){const cv=convoOf(named);if(!cv||!capped(cv,named,k))chosen=named;} // A name always reaches that NPC, no gate (like companions).
  else{
   if(h.companion)return; // The line went to a companion (follower-chat queued a reply): residents stay out of it.
   const range=Number(k.ambient_talk_range),inConvo=a=>!!convoOf(a);
   const parts=all.filter(a=>inConvo(a)&&near(spot,a,range+2)).sort((a,b)=>(convoOf(b)===mine)-(convoOf(a)===mine)||dist(a,spot)-dist(b,spot)); // The conversation this player is already in comes first.
   const closeBy=all.filter(a=>a.talksTo!=='npcs'&&near(spot,a,range)&&!inConvo(a)).sort((a,b)=>dist(a,spot)-dist(b,spot));
   const candidates=[...parts,...closeBy].filter(a=>{const cv=convoOf(a);return !cv||!capped(cv,a,k);}).slice(0,Number(k.ambient_gate_fanout));
   if(!candidates.length)return;
   const nearby=[...new Set([...all.map(a=>a.name),...hearers(scene,spot,h.area).map(p=>p.name)])];
   chosen=await gate(candidates,{speaker:clean(h.c.name)||'Someone',message:h.text,kind:h.emote?'emote':'chat',convo:a=>convoOf(a)??mine,nearby,players:[...new Set([...(mine?.playerNames??[]),...fresh.flatMap(c=>[...c.playerNames]),clean(h.c.name)])]});
   if(!chosen)return;
  }
  const convo=convoOf(chosen)??mine??newConvo(h.zone,h.area);
  if(convo.running)convo.interrupted=true; // Only this NPC's exchange stops to turn to the player; the room's other conversations carry on.
  convo.running=true;
  try{
   const player=scene.players.find(p=>p.id===h.c.id)??{id:h.c.id,name:h.c.name,state:{}};
   const others=hearers(scene,chosen,h.area).filter(p=>p.id!==player.id).length;
   const seen=unsaid(about(player,scene.zone),convo.lines.filter(l=>l.key===chosen.key).map(l=>l.text)); // Each observation once per conversation: Wren said "you look hungry" four times (2026-10-14).
   const text=await line(chosen,{kind:'ambient_answer',message:h.text.slice(0,500),player_name:clean(h.c.name).slice(0,64),audience:Math.min(500,others),thread:thread(convo),situation:[...place(scene),...seen].slice(0,10)},convo,player);
   convo.lines.push({speaker:clean(h.c.name).slice(0,64)||'Someone',text:h.text,key:'player:'+player.id});convo.playerNames.add(clean(h.c.name));convo.lastAt=now(); // The player's line is part of the thread from now on.
   if(!text)return;
   if(!post(chosen,text,convo,{player,message:h.text,playerSourceSeq:h.sourceSeq}))return;convo.players.add(player.id);convo.target=player.id;
  }finally{convo.running=false;}
 }

 // ── The ticker (zones.tick, every second) ──
 function run(key,work){ // key: a conversation id (its turns, one at a time) or 'heard:<area>' (a room's player lines, in order). A Decider failure pauses everything.
  busy.add(key);
  void work().catch(error=>{if(closed)return;if(error?.gateDown)gateDown(error);else warn('step',error);}).finally(()=>{busy.delete(key);const c=convos.get(key);if(c)c.running=false;});
 }
 function tick(){
  if(closed)return;memory.drain(); // Retry committed memory/deletion events even when Ambient Life is switched off.
  const k=knobs(),t=now();
  if(!on(k)){heard.length=0;return;}
  for(let i=0;i<heard.length;){ // Players first: answers are never more than a tick late.
   const h=heard[i];if(t-h.at>HEARD_MAX_AGE){heard.splice(i,1);continue;}
   if(busy.has('heard:'+h.area)){i++;continue;} // That room's previous player line is answered first; later lines keep their order.
   heard.splice(i,1);run('heard:'+h.area,()=>answer(h,k));
  }
  for(const [id,c] of convos)if(!live(c)&&t-c.lastAt>Number(k.ambient_idle_s)*1000)convos.delete(id); // Finished and quiet: forget it.
  if(t-lastTick<TICK_MS)return;lastTick=t;
  let list=[];try{list=scenes(null,{beckons:k.ambient_beckons==='on'});}catch(error){warn('scene',error);return;}
  for(const scene of list)startIn(scene,k,t);
 }
 function startIn(scene,k,t){
  const actors=actorsOf(scene);if(!actors.length)return;
  const talking=engaged(),range=Number(k.ambient_talk_range),free=a=>(cooldown.get(a.key)??0)<=t&&!talking.has(a.key);
  const room=area=>inRoom(area).filter(live).length<Number(k.ambient_conversations_per_area); // Doll 2026-10-15: up to 4 conversations at once per room.
  for(const a of actors){
   if(!free(a))continue;
   const listeners=(scene.players??[]).filter(p=>onScreen(a,p));if(!listeners.length)continue; // Nobody would hear it.
   const area=listeners[0].area;if(!room(area))continue;
   if(a.kind==='shop'){ // Beckons: a player passing by, not already at the counter.
    if(k.ambient_beckons!=='on')continue;
    const target=listeners.find(p=>p.area===area&&near(a,p,Number(k.ambient_beckon_range))&&dist(a,p)>1&&!p.state?.run&&(beckoned.get(a.key+'|'+p.id)??0)<=t);if(!target)continue;
    if(t<(nextCheck.get(a.key)??0))continue;nextCheck.set(a.key,t+Number(k.ambient_check_s)*1000*(0.75+0.5*roll()));
    if(roll()>=Number(k.ambient_beckon_chance))continue;
    beckoned.set(a.key+'|'+target.id,t+Number(k.ambient_beckon_cooldown_s)*1000);cooldown.set(a.key,t+60000); // At most a call a minute per shop.
    const convo=newConvo(scene.zone,area);run(convo.id,()=>beckon(convo,a,target,scene));continue;
   }
   if(!nextCheck.has(a.key)){nextCheck.set(a.key,t+roll()*Number(k.ambient_check_s)*1000);continue;} // Staggered first rolls: a restart never opens every conversation at once.
   if(t<nextCheck.get(a.key))continue;nextCheck.set(a.key,t+Number(k.ambient_check_s)*1000*(0.75+0.5*roll()));
   const npcTargets=a.talksTo==='players'?[]:actors.filter(b=>b!==a&&b.kind==='npc'&&b.talksTo!=='players'&&free(b)&&near(a,b,range)&&listeners.some(p=>onScreen(b,p)));
   const playerTargets=a.talksTo==='npcs'?[]:listeners.filter(p=>p.area===area&&near(a,p,range)&&!p.state?.run);
   const targets=[...npcTargets.map(b=>({b})),...playerTargets.map(p=>({p}))];if(!targets.length)continue;
   if(roll()>=Math.min(1,Number(k.ambient_chance)*a.chattiness/50))continue; // The strike-up check.
   const pick=targets[Math.floor(roll()*targets.length)],until=t+pause(k,'ambient_cooldown_min_s','ambient_cooldown_max_s');
   cooldown.set(a.key,until);if(pick.b)cooldown.set(pick.b.key,until);
   const convo=newConvo(scene.zone,area);hold(a.ref,t+Number(k.ambient_idle_s)*1000);if(pick.b)convo.actors.set(pick.b.key,pick.b); // Both are engaged from this moment.
   run(convo.id,()=>pick.b?converse(convo,a,pick.b,scene,k):greet(convo,a,pick.p,scene,k));
   return; // One new conversation per zone per tick.
  }
 }

 function exportDecisions(){ // JSONL for the next Decider training round: player names become Player1..n, NPC names stay.
  const map=new Map(),alias=name=>{const key=clean(name).toLowerCase();if(!map.has(key))map.set(key,'Player'+(map.size+1));return map.get(key);};
  for(const d of decisions)for(const n of d.players??[])alias(n);
  const scrub=s=>{let out=String(s??'');for(const [name,label] of map)if(name)out=out.replace(new RegExp('\\b'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','gi'),label);return out;};
  return decisions.map(d=>JSON.stringify({source:'live_review',candidate:{name:d.candidate,kind:'npc',role:d.role,interests:d.interests},speaker:scrub(d.speaker),message:scrub(d.message),kind:d.kind,
   recent_turns:d.recent_turns.map(t=>({speaker:scrub(t.speaker),text:scrub(t.text)})),nearby_names:d.nearby_names.map(scrub),conversation_with_candidate:d.conversation_with_candidate,speaker_hired_candidate:false,
   decision:d.decision,join_probability:d.join_probability})).join('\n');
 }
 function view(){ // GM panel: switches, health, live conversations, transcript and recent decisions.
  const k=knobs(),t=now();
  return {enabled:k.ambient_enabled==='on',backend:gateBackend,ai:!!pool(),gate_down_for_ms:Math.max(0,gateDownUntil-t),cost_alarms:alarms,stats:{...stats},
   budgets:{lines:lineBudget.view(),gates:gateBudget.view()},drops:{...drops},memory:memory.view(),
   conversations:[...convos.values()].map(c=>({id:c.id,area:c.area,running:live(c),speakers:[...c.actors.values()].map(a=>a.name),lines:c.lines.length,players:c.players.size,age_s:Math.round((t-c.lastAt)/1000)})),
   transcript:transcript.slice(-50).reverse(),decisions:decisions.slice(-50).reverse().map(({players,...d})=>d)}; // Raw player lists never leave the server.
 }
 async function test(def,{mode='line',message='',speaker='Traveller'}={}){ // GM persona editor: one line or one Decider verdict for a draft NPC; no budgets, still local only.
  const ai=pool();if(!ai)return {ok:false,status:0,error:'No AI nodes are configured on this server.'};
  const persona=def.ai_persona??{},actor={name:clean(def.name).slice(0,32)||'NPC',npcId:String(def.id||'gm_test').slice(0,64),persona:personaText(def.name,persona),voice:(persona.voice??[]).slice(0,5),...speakingStyleFields(persona.speaking_style),profile:participationProfile(persona)};
  if(mode==='gate'){
   const body=npcParticipationContext(actor,{speaker,message:message||'Hello there!',nearbyNames:[speaker]});
   const res=await ai.request('/v1/participation/decide',body,{timeoutMs:12000,signal:stop.signal});if(!res.ok)return {ok:false,status:res.status};
   participationSaysJoin(res.body);return {ok:true,decision:res.body.decision,join_probability:res.body.join_probability,candidate:body.candidate};
  }
  const res=await ai.request('/v1/companion/chat',{npc_id:actor.npcId,npc_name:actor.name,persona:actor.persona.slice(0,1500),...speakingStyleFields(actor.speaking_style),voice:actor.voice.map(v=>clean(v).slice(0,200)),message:message||'(ambient)',
   kind:message?'ambient_answer':'ambient_greet',player_name:clean(speaker).slice(0,64)||'Traveller'},{timeoutMs:20000,signal:stop.signal}); // A resident kind: npc-rag never bills it.
  return {ok:res.ok,status:res.status,text:clean(res.body?.reply),lane:res.body?.lane??null,persona:actor.persona};
 }
 return {tick,hear,view,residents,exportDecisions,test,forgetPlayer:memory.forgetPlayer,close(){if(closed)return;closed=true;stop.abort();memory.close();}};
}
