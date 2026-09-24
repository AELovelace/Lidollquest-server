// Campaign defeat dignity loss, mirrored from objBattleManager Step_0 (the block after "You were defeated...").
// Dignity (stored as player_info.shame) runs 1024 (adult-minded) down to 0; only level-ups (+15) climb it back.
// Amounts come from the live tuning: defeat_dignity_loss (64, like the campaign) and defeat_dignity_childish_extra (32, worn outfit childish 7+),
// then Shame multiplies them (0.5x calm to 2x mortified, dignity.mjs shameMultiplier).
import {currentTuning} from './combat.mjs';
import {dignityTuning,loseDignity,shameMultiplier,shameOf} from './dignity.mjs';
const losses=new Set(['defeat','submit','submitted','charm_backfire']); // Same outcomes that dress the loser in defeat-equipment.mjs; flee/forfeit keep their dignity.

const DEFEAT_LINES=[ // [below this dignity, plain line, childish-outfit line] — the campaign's text, checked lowest-first so the deeper tiers are reachable.
 [128,"You can't even remember how to talk like a grown-up! Goo goo ga ga!","You can't even remember how to talk like a grown-up! Goo goo ga ga! Your outfit is the silliest!"],
 [256,'You feel like a big baby! Everything is so fun and squishy and you wanna giggle lots!','You feel like a big baby! Everything is so fun and squishy and you wanna giggle lots! Your outfit makes it even sillier!'],
 [512,"You feel super silly and your thoughts get fuzzy... Did you just say 'widdle'? Uh oh!","You feel super duper silly in your outfit! Your thoughts get fuzzy... Did you just say 'widdle'? Uh oh!"],
 [Infinity,'You feel embarrassed and a little childish after losing...','You feel embarrassed and extra childish after losing in your silly outfit...']
];
const defeatLine=(dignity,childish)=>DEFEAT_LINES.find(([below])=>dignity<below)[childish?2:1]; // First tier the new dignity sits under.

export function applyDefeatDignity(state,run,outcome,tuning=currentTuning()){ // Returns the log lines it added (empty when nothing changed) so party settlement can show them too.
 if(!losses.has(outcome)||!state.loadout||!run||state.defeatDignityReceipt===run.id)return []; // Receipt: polling and reconnects never drain dignity twice for one fight.
 const p=state.loadout.player_info,childish=Number(state.loadout.childish)>=7; // loadout.childish is the same 0-10 worn-outfit average as get_player_childish().
 const t=dignityTuning(tuning),base=t.defeatLoss+(childish?t.defeatChildishExtra:0); // Live /gm Loot tab values.
 state.defeatDignityReceipt=run.id; // Durable per-character receipt, stored beside defeatEquipmentReceipt.
 if(base<=0)return []; // A GM switched defeat loss off: no change, no log line.
 const mult=shameMultiplier(p,tuning),lost=loseDignity(p,base,tuning); // Shame scales the loss; the 0 floor may take less.
 const lines=[defeatLine(p.shame,childish),'Dignity -'+lost+' ('+p.shame+' / 1024)'+(Math.abs(mult-1)>0.01?' - Shame '+shameOf(p)+' made it x'+mult.toFixed(2)+'.':'.')];
 run.log?.push(...lines); // Solo Dive and arena results already carry run.log to the client's message log.
 return lines;
}
