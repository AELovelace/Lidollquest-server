// Who is a line of Area chat (or an emote) meant for? COMPANION_LIFELIKE_PLAN.md phase A.
// follower-chat.mjs enqueue() asks addressees() for every companion in earshot and gets back who should answer and why:
//   name      the companion's name or alias, exactly (word boundaries)
//   fuzzy     one letter off a 5+ letter alias ("Elwen"), or a GM nickname phrase ("shield lady")
//   followup  the companion answered this speaker less than followup_window_s ago and they are still in earshot
//   hirer     the speaker hired this companion
//   you       the only companion in earshot, and the line talks to someone ("you", or a question)
// gate: true when the 4-token classifier should confirm it would be natural for the companion to answer (others around).
export const ADDRESS_DEFAULTS=Object.freeze({
 followup_window_s:180,   // Doll 2026-10-13: a conversation stays open 3 minutes, anywhere within earshot.
 followup_cooldown_s:4,   // Between lines of an ongoing conversation (everyone else keeps the 10 s companion cooldown).
 busy_threshold:4,        // Other players on screen at which only names and the same speaker's follow-ups count.
 hirer_default:'on',      // A hirer's lines reach their companion (alone: always; with others: through the classifier).
 fuzzy_names:'on',        // One-letter typos of a 5+ letter name, and GM nicknames.
 emote_replies:'on',      // "/me hugs Elowen" gets a reaction.
 address_classifier:'on', // Ask the classifier before answering an unclear line; off: unclear lines are dropped.
});
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const wordRe=w=>new RegExp('(?<![\\p{L}\\p{N}_])'+esc(w)+'(?![\\p{L}\\p{N}_])','iu');
function oneEdit(a,b){ // True when a and b differ by at most one insertion, deletion, substitution or swap of neighbours.
 if(a===b)return true;if(Math.abs(a.length-b.length)>1)return false;
 let i=0;while(i<a.length&&i<b.length&&a[i]===b[i])i++;
 if(a.length===b.length)return a.slice(i+1)===b.slice(i+1)||(a[i]===b[i+1]&&a[i+1]===b[i]&&a.slice(i+2)===b.slice(i+2));
 return a.length>b.length?a.slice(i+1)===b.slice(i):a.slice(i)===b.slice(i+1);
}
export function nameMatch(text,def,{fuzzy=true}={}){ // 'name', 'fuzzy' or null.
 const names=[def.name,...(def.online?.aliases??[])].filter(Boolean);
 if(names.some(n=>wordRe(n).test(text)))return 'name';
 if(!fuzzy)return null;
 if((def.online?.nicknames??[]).some(n=>n&&wordRe(n).test(text)))return 'fuzzy';
 const words=String(text).toLowerCase().match(/\p{L}+/gu)??[];
 const singles=names.flatMap(n=>n.toLowerCase().split(/\s+/)).filter(n=>n.length>=5);
 return words.some(w=>w.length>=4&&singles.some(n=>oneEdit(w,n)))?'fuzzy':null;
}
const SPOKEN_TO=/(?<![\p{L}])(you|your|you're|yours|u|ya)(?![\p{L}])|\?\s*$/iu; // "how are you", "can u", or any question.

export function addressees({text,targets,catalog,speaker,hire=null,convo=[],listeners=0,emote=false,tuning={}}){
 const t={...ADDRESS_DEFAULTS,...tuning},on=k=>t[k]==='on'||t[k]===true;
 if(emote&&!on('emote_replies'))return [];
 const busy=listeners>=t.busy_threshold,out=[];
 for(const target of targets){ // Named companions answer; nobody else does.
  const how=nameMatch(text,catalog[target.npc]??{},{fuzzy:on('fuzzy_names')});
  if(how)out.push({target,reason:how,gate:false});
 }
 if(out.length)return out;
 const open=convo.find(r=>targets.some(x=>x.npc===r.npc)); // Most recent open conversation with a companion still in earshot.
 if(open)return [{target:targets.find(x=>x.npc===open.npc),reason:'followup',gate:listeners>0}];
 if(busy)return []; // A crowded hub: say their name.
 const mine=hire&&on('hirer_default')?targets.find(x=>x.npc===hire.npc&&x.rental===hire.id):null;
 if(mine)return [{target:mine,reason:'hirer',gate:listeners>0}]; // Doll 2026-10-13: with others around, the classifier decides.
 if(!emote&&targets.length===1&&listeners<=1&&SPOKEN_TO.test(text))return [{target:targets[0],reason:'you',gate:true}];
 return [];
}

export function gatePrompt(def,{hired=false}={}){ // The classifier's yes/no question (4 tokens, temperature 0).
 return `A player in an online RPG said this out loud. ${def.name} is a companion character standing nearby${hired?' who is traveling with that player':''}. `+
  `Would it be natural for ${def.name} to answer or chime in? Reply with exactly one word: YES or NO.`;
}
export const gateSaysYes=text=>/^\W*yes\b/i.test(String(text??'').trim()); // Anything else, or nothing, is a no.
