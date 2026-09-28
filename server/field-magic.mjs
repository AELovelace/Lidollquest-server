// Field magic (2026-09-28): cast Heal, Cure and Buff spells on a party member outside battle.
// The caster must stand within screen reach of the target (the same rectangle area chat uses).
// The server spends the caster's MP and leaves the effect in the target's
// loadout.player_info.incoming_spells queue. The target's game applies it with its ordinary
// campaign routines (online_party_spell_apply) and pushes the loadout back, the same way duel feeding works.
// Buffs never touch stats outside battle: they are "primed" in player_info.field_buffs and
// combat.mjs beginRound() turns them into normal battle buffs at the start of the next fight.
import {combatData,playerSpells,classId,mageScaling,currentTuning} from './combat.mjs';
import {healScale} from './scaling.mjs';

export const FIELD_CAST_ACTIONS=Object.freeze(['field_cast']);
export const FIELD_SPELL_TYPES=Object.freeze(['heal','cure','buff']); // attacks and debuffs need an enemy
export const INCOMING_CAP=8; // spells waiting to land on one player; stops a flood while their game is offline
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'field_cast_rejected'});};
const num=(n,d=0)=>Number.isFinite(Number(n))?Number(n):d;

export function fieldEffect(casterLoadout,targetLoadout,spellId,tuning=currentTuning()){ // The amount uses the CASTER's INT and mage scaling, like an in-battle support cast.
 const s=combatData.spells[spellId],p=casterLoadout.player_info??{},int=num(p.int),m=mageScaling(casterLoadout);
 const base={spell_id:spellId,name:s.name,kind:s.type};
 if(s.type==='heal')return {...base,stat:'hp',amount:Math.floor((Math.floor((s.power+int*2)*m.magic)+m.flat)*healScale(tuning,num(targetLoadout.player_info?.playerHealthMax,100)))}; // grows with the target's HP bar
 if(s.type==='cure')return {...base,stat:s.stat_effect,amount:Math.abs(num(s.stat_amount))+Math.floor(int*1.5)}; // the target's game lowers wet/tum (or raises stamina) by this much
 return {...base,stat:s.stat_effect,amount:num(s.stat_amount)+Math.floor(int/3),turns:num(s.dot_turns,3)}; // buff: primed for the target's next fight
}

export function fieldCast(caster,target,spellId,{onScreen,tuning=currentTuning()}){ // caster/target: {id,name,state,pos,connected,partyId}. Returns the queued entry.
 const cs=caster.state,l=cs.loadout;
 if(!l?.player_info)fail('Load your character before casting.');
 if(cs.run||cs.pendingDefeat||cs.duel||cs.trade||cs.pendingPurchase)fail('Finish what you are doing before casting on a friend.');
 const s=combatData.spells[spellId];
 if(!s||!playerSpells.includes(spellId)||!(l.player_spells??[]).includes(spellId))fail('Choose a spell you have learned.');
 if(!FIELD_SPELL_TYPES.includes(s.type))fail(s.name+' can only be cast during battle.');
 if(classId(l)==='diplomat')fail('Diplomats do not cast spells.');
 if(!target||target.id===caster.id)fail('Choose another party member.'); // self casts stay on the local journal path
 if(!caster.partyId||caster.partyId!==target.partyId)fail(target.name+' is not in your party.');
 if(!target.connected||!target.pos||!caster.pos||target.pos.zone!==caster.pos.zone||(cs.dive?.edition??null)!==(target.state.dive?.edition??null))fail(target.name+' is not in this area.'); // same room AND the same dungeon edition, like parties.sameArea
 if(!onScreen(caster.pos,target.pos))fail(target.name+' is too far away. Walk closer first.');
 const ts=target.state;
 if(ts.run)fail(target.name+' is in a fight.');
 if(ts.pendingDefeat)fail(target.name+' is knocked out. A Healing Poultice can stand them up.');
 if(!ts.loadout?.player_info)fail(target.name+' has not loaded in yet.');
 if(num(l.player_mp)<s.mp_cost)fail('Not enough MP.');
 const tp=ts.loadout.player_info,queue=Array.isArray(tp.incoming_spells)?tp.incoming_spells:[];
 if(queue.length>=INCOMING_CAP)fail(target.name+' already has spells waiting to land.');
 const entry={...fieldEffect(l,ts.loadout,spellId,tuning),from:caster.id,from_name:caster.name};
 l.player_mp=num(l.player_mp)-s.mp_cost;          // spend only after every check passed
 tp.incoming_spells=[...queue,entry];              // the target's game applies and clears this
 return entry;
}

export function createFieldMagic(db,{now=Date.now,parties,saveCharacter,onScreen}){ // Wires fieldCast to the database: party roster, presence rows and the other player's save.
 const character=id=>db.prepare('SELECT * FROM quest_characters WHERE id=?').get(id);
 const presence=id=>db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(id);
 function act(c,state,input,p){
  const targetId=String(input.member??'');
  const other=targetId&&targetId!==c.id?character(targetId):null;
  if(!other)fail('Choose another party member.');
  const tpos=presence(other.id),ts=JSON.parse(other.state);
  const entry=fieldCast(
   {id:c.id,name:c.name,state,pos:p,connected:true,partyId:parties.party(c.id)?.id??null},
   {id:other.id,name:other.name,state:ts,pos:tpos,connected:(tpos?.seen??0)>now()-30000,partyId:parties.party(other.id)?.id??null},
   String(input.spell??''),{onScreen});
  saveCharacter(other,ts);                         // bumps the target's loadoutRevision so their game re-pulls
  return {...entry,target:other.id,target_name:other.name};
 }
 return {act};
}
