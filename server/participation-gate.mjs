// Bounded model context shared by the live companion gate and its load-test harness.
const text=(value,max)=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
export function participationContext(def,{message,playerName='Player',kind='chat',history=[],conversation=false,hired=false,nearbyNames=[]}={}){
 const name=text(def.name,64)||'Companion',profile=def.online?.participation??{};
 return {candidate:{name,kind:'companion',role:text(profile.role,80)||'companion',
   interests:(Array.isArray(profile.interests)?profile.interests:[]).map(s=>text(s,64)).filter(Boolean).slice(0,4)},
  speaker:text(playerName,64)||'Player',message:text(message,500),kind,
  nearby_names:[...new Set([name,...nearbyNames.map(n=>text(n,64)).filter(Boolean)])].slice(0,8),
  recent_turns:history.slice(-4).filter(t=>['player','npc','user','assistant'].includes(t.role)&&text(t.content,240)).map(t=>({speaker:['npc','assistant'].includes(t.role)?name:text(playerName,64)||'Player',text:text(t.content,240)})),
  conversation_with_candidate:!!conversation,speaker_hired_candidate:!!hired};
} // No personas, private memories or unbounded chat logs enter this lightweight decision.

export function npcParticipationContext(actor,{speaker='Someone',message,kind='chat',turns=[],conversation=false,nearbyNames=[]}={}){ // AMBIENT_NPC_LIFE_PLAN.md: a GM NPC or shopkeeper as the candidate.
 const name=text(actor?.name,64)||'Resident',profile=actor?.profile??{};
 return {candidate:{name,kind:'npc',role:text(profile.role,80)||'resident',interests:(Array.isArray(profile.interests)?profile.interests:[]).map(s=>text(s,64)).filter(Boolean).slice(0,4)},
  speaker:text(speaker,64)||'Someone',message:text(message,500),kind:['chat','emote','ooc'].includes(kind)?kind:'chat',
  nearby_names:[...new Set([name,...nearbyNames.map(n=>text(n,64)).filter(Boolean)])].slice(0,8),
  recent_turns:turns.slice(-4).map(t=>({speaker:text(t.speaker,64)||'Someone',text:text(t.text,240)})).filter(t=>t.text), // Real speaker names: NPCs and players alike.
  conversation_with_candidate:!!conversation,speaker_hired_candidate:false}; // Only companions can be hired.
} // Same bounded contract as the companion gate: role and interests only, never the persona text.

export function participationSaysJoin(body){
 const knownModel=(body?.model==='lidoll/decider-chat-0-1'&&body?.policy==='participation-sociable-v1-schema_first')
   ||(['lidoll/decider-multitask-v2','lidoll/decider-multitask-v3'].includes(body?.model)&&body?.policy==='routing-participation-multitask-v1'); // Preserve v2 rollback while accepting v3 only with its trained policy.
 if(!body||!['join','quiet'].includes(body.decision)||typeof body.join!=='boolean'||body.join!==(body.decision==='join')
    ||!Number.isFinite(body.join_probability)||body.join_probability<0||body.join_probability>1
    ||!knownModel)throw Error('Invalid participation response');
 return body.join;
} // A malformed or wrong-model response is an availability failure, never a silent YES.
