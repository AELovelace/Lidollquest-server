// Healing poultices (2026-09-27). Doll: "need some form of poultices to revive downed players".
// In a shared party battle (dive-encounters.mjs) a member who goes down keeps their seat in the
// encounter until it settles. An active ally can spend their turn pressing a Healing Poultice on
// them: one poultice leaves the reviver's bag and the downed member stands back up with
// REVIVE_HP_PCT of their max HP, a fresh action gauge, and their hired companion rejoins.
// Fern the Apothecary sells poultices in every hub (hub-data.json, python/export_online_hubs.py).
import {takeFromStack} from './loadout.mjs';

export const POULTICE_ID='healing_poultice'; // items.json / hub-data.json item id
export const REVIVE_HP_PCT=30; // HP a revived member stands back up with, as a percent of max HP
export const DOWNED=Object.freeze(['defeat','charm_backfire']); // Encounter statuses a poultice can undo (fleeing or submitting was a choice, not a knockout).

export function reviveDowned(e,reviver,target,{now,message,reset}){ // reviver/target: roster rows {a (encounter actor), s (state)}. Throws a player-facing Error on a bad target or an empty bag.
 if(!target||target.a.id===reviver.a.id||!DOWNED.includes(target.a.status))throw Object.assign(Error('Choose a knocked-out ally to revive.'),{status:409});
 if(!takeFromStack(reviver.s.loadout.inventory??=[],item=>item?.item_id===POULTICE_ID))throw Object.assign(Error('You have no Healing Poultice.'),{status:409}); // One unit leaves the reviver's stack.
 const a=target.a,maxHp=Math.max(1,Number(a.run.maxHp)||1);
 a.status='active';a.run.status='active';a.run.hp=Math.max(1,Math.ceil(maxHp*REVIVE_HP_PCT/100)); // Back on their feet, a little battered.
 delete a.defeatEnemy;delete a.downedAt; // No defeat scene or recovery timer for a knockout that got undone.
 reset(a,target.s); // Fresh gauge: they act again once it fills, like any new cycle.
 a.readyAt=Math.max(a.readyAt,now()); // Never ready "in the past".
 for(const ally of e.followers??[])if(ally.hirer===a.id&&ally.status==='owner_out')ally.status='active'; // Their companion steps back in with them.
 message(e,reviver.a.name+' presses a Healing Poultice to '+a.name+'. '+a.name+' comes round with a gasp and stands back up!');
}
