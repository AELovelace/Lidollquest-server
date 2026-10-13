// Companions speaking up on their own when something happens (COMPANION_LIFELIKE_PLAN.md phase C).
// companion-memory.drain() hands every newly stored experience to follower-chat, which asks planReaction() whether and
// how the companion reacts, then posts the line in Area chat like a reply:
//   template  a written line (companions.json online.reactions, or GENERIC_REACTIONS), no AI cost
//   ai        a /v1/companion/chat call with kind 'reaction' (big moments; falls back to the template)
//   slip      an embarrassing moment in front of others: the AI may tease, and Dignity follows the slip rules
export const REACTION_DEFAULTS=Object.freeze({
 reactions_enabled:'on',
 reaction_chance:.3,        // Ordinary wins and first visits: how often the companion comments at all.
 reaction_ai_chance:.25,    // Big moments (bosses, quests, new places): how often the line comes from the AI instead of a template.
 reaction_cooldown_s:180,   // A companion speaks up on their own at most this often (a greeting on hire always goes).
 ai_calls_per_minute:30,    // Shared budget for optional AI lines (reactions now, musings and banter later); replies to players never wait on it.
});
export const REACTION_KINDS=Object.freeze(['hire','battle_win','boss_win','battle_lost','revived','quest','zone','comfort']);

// Fallbacks for companions without their own lines. Placeholders: {player} {enemy} {zone} {quest}.
export const GENERIC_REACTIONS=Object.freeze({
 hire:['Ready when you are, {player}.','Lead the way, {player}.'],
 battle_win:['Nicely done, {player}.','That one is down. Keep moving.'],
 boss_win:['We beat {enemy}! I knew we could.','{enemy} is down. That was a real fight, {player}.'],
 battle_lost:['That went badly. Let us catch our breath, {player}.','We will do better next time. Are you all right?'],
 revived:['You are back on your feet. Do not scare me like that.','There you are. Stay close, {player}.'],
 quest:['We finished "{quest}". Well done, {player}.','"{quest}" is done. That feels good.'],
 zone:['So this is {zone}. Stay sharp.','{zone}. I have a good feeling about this. Mostly.'],
 comfort:['Hey. It happens. Let us get you sorted, {player}.','No one saw. I have you, {player}.'],
});
const EMBARRASSING=new Set(['accident','change','care']);

export function planReaction(kind,data={},{roll=Math.random,knobs={},listeners=0}={}){ // -> {mode,line} or null
 const k={...REACTION_DEFAULTS,...knobs};
 if(k.reactions_enabled!=='on')return null;
 if(EMBARRASSING.has(kind)){ // Alone: gentle comfort. With others on screen: only ever as a slip (chance + Dignity rules).
  if(listeners===0)return {mode:'template',line:'comfort'};
  return roll()<Number(k.slip_chance??.15)?{mode:'slip',line:null}:null;
 }
 switch(kind){
  case 'hire':return {mode:'template',line:'hire'};
  case 'battle_lost':return {mode:'template',line:'battle_lost'};
  case 'revived':return {mode:'template',line:'revived'};
  case 'battle_win':
   if(data.boss)return {mode:roll()<k.reaction_ai_chance?'ai':'template',line:'boss_win'};
   return roll()<k.reaction_chance?{mode:'template',line:'battle_win'}:null;
  case 'quest':return {mode:roll()<k.reaction_ai_chance?'ai':'template',line:'quest'};
  case 'zone':return roll()<k.reaction_chance?{mode:roll()<k.reaction_ai_chance?'ai':'template',line:'zone'}:null;
  default:return null;
 }
}

export function fillTemplate(def,line,vars,roll=Math.random){ // A companion's own lines first, then the generic ones.
 const own=def?.online?.reactions?.[line],lines=Array.isArray(own)&&own.length?own:GENERIC_REACTIONS[line]??[];
 if(!lines.length)return '';
 const text=lines[Math.min(lines.length-1,Math.floor(roll()*lines.length))];
 return text.replace(/\{(player|enemy|zone|quest)\}/g,(_,key)=>String(vars[key]??'').slice(0,60)||'that').slice(0,240);
}

// Phase D: idle life. Musings when the hirer waits around somewhere safe; banter between two hired companions nearby.
export const IDLE_DEFAULTS=Object.freeze({
 musings_enabled:'on',
 musing_after_s:240,        // The hirer has stood still this long in a safe town before the companion muses.
 musing_cooldown_min_s:300, // Doll 2026-10-13: about every 5-7 minutes (picked at random each time).
 musing_cooldown_max_s:420,
 musing_chance:.8,
 banter_enabled:'on',
 banter_chance:.5,          // Per pair, checked every 5-7 minutes while two hired companions are near each other.
 banter_cooldown_min_s:300,
 banter_cooldown_max_s:420,
});
