// AMBIENT_NPC_LIFE_PLAN.md: a GM NPC's ai_persona (Doll's character template) turned into what the AI services need.
//  - personaText(): the <=1500-character persona npc-rag's resident prompt reads (/v1/companion/chat, ambient_* kinds).
//  - participationProfile(): the Decider's {role, interests} (/v1/participation/decide candidate).
// GMs never write one big persona blob: they fill occupation / desires / traits / background / relationships in the editor.
export const PERSONA_MAX=1500; // npc-rag CompanionChatRequest.persona max_length.

const clip=(s,max)=>String(s??'').replace(/\s+/g,' ').trim().slice(0,max); // One line, bounded.
const article=w=>/^[aeiou]/i.test(w)?'an':'a'; // "an tavernkeeper" reads badly in the prompt.

export function personaText(name,p,{names={}}={}){ // names: GM NPC id -> display name, for relationships that point at another NPC.
 if(!p)return '';
 const who=clip(name,64)||'This character',parts=[];
 const job=clip(p.occupation,80);
 parts.push(job?`${who}${p.pronouns?' ('+clip(p.pronouns,40)+')':''} is ${/^(the|a|an)\s/i.test(job)?job:article(job)+' '+job}.`:`${who} lives here.`); // "Felix (he/him) is a bar wench."
 if(p.traits?.length)parts.push('Personality: '+p.traits.map(t=>t.note?`${clip(t.name,40)} - ${clip(t.note,200)}`:clip(t.name,40)).join('; ')+'.');
 if(p.desires?.length)parts.push('Wants: '+p.desires.map(d=>clip(d,160).replace(/[.!]+$/,'')).join('; ')+'.');
 if(p.background)parts.push('Background: '+clip(p.background,900));
 if(p.relationships?.length)parts.push('People: '+p.relationships.map(r=>`${clip(names[r.ref]??r.name??r.ref,64)}: ${clip(r.note,200)}`).join('; ')+'.');
 if(p.avoid?.length)parts.push('Never brings up: '+p.avoid.map(a=>clip(a,120)).join('; ')+'.');
 let text=parts.join('\n');
 if(text.length>PERSONA_MAX)text=text.slice(0,PERSONA_MAX-1).replace(/\s+\S*$/,'')+'.'; // Cut at a word; background is the usual overflow.
 return text;
}

export function participationProfile(p){ // The Decider only needs a short role and up to four topics; never the persona itself.
 return {role:clip(p?.occupation,80)||'resident',interests:(p?.interests??[]).map(i=>clip(i,64)).filter(Boolean).slice(0,4)};
}
