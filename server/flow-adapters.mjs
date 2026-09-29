import {applyDungeonEffects} from './full-dungeon-rules.mjs';
import {dailyCoinCap} from './hubs.mjs';
import {battleMonsters} from './flow-content.mjs';

export function createFlowAdapters(db,{quests,orbs,gmTools,engines,hubEvents,items,capacity=99,origins,adjust,roll,now}){
 const context={db,data:{items,config:{inventory_capacity:capacity}},origins,adjust,roll,now};
 const encounter=(c,s,n,pinned,receipt,fight)=>{
  const p=db.prepare('SELECT zone FROM quest_presence WHERE character_id=?').get(c.id);
  if(!p)throw Error('A story encounter needs an online location.');
  return (engines.get(p.zone)??hubEvents.engine(p.zone)).storyEncounter(c,s,fight?battleMonsters(n).map(id=>pinned.assets.monsters[id]):pinned.assets.monsters[n.ref],receipt,fight);
 }; // Combat keeps the existing server-controlled roster and settlement rules.
 return {
  canStart:c=>!!db.prepare('SELECT 1 FROM quest_presence WHERE character_id=?').get(c.id), // Offline completion waits until the owner returns to a map.
  battle:(c,s,n,p,r)=>encounter(c,s,n,p,r,true),
  spawn:(c,s,n,p,r)=>encounter(c,s,n,p,r,false),
  reveal_orb:(c,s,n)=>orbs.setVisibility(c,n.ref,true), // Visibility follows this story's owner across reconnects and map visits.
  hide_orb:(c,s,n)=>orbs.setVisibility(c,n.ref,false),
  quest:(c,s,n,p)=>quests.flow(c,s,n,p),
  objective:(c,s,n)=>quests.flowObjective(c,n.ref),
  travel:(c,s,n)=>gmTools.storyTravel(c,s,n.ref),
  effect:(c,s,n)=>applyDungeonEffects(n.effects,c,s,context),
  reward(c,s,n,p,receipt){
   const r=n.rewards;
   applyDungeonEffects([...(r.xp?[{type:'xp',amount:r.xp}]:[]),...r.items.flatMap(i=>Array.from({length:i.count},()=>({type:'give_item',item:i.id})))],c,s,context);
   if(r.rpp){const balance=db.prepare('SELECT balance FROM quest_rpp_wallets WHERE character_id=?').get(c.id)?.balance??0;
    if(balance+r.rpp>1000000000)throw Object.assign(Error('Spend some RPP before continuing.'),{status:409});
    db.prepare('INSERT INTO quest_rpp_wallets VALUES (?,?) ON CONFLICT(character_id) DO UPDATE SET balance=balance+excluded.balance').run(c.id,r.rpp);
    db.prepare('INSERT INTO quest_rpp_ledger(request_id,fingerprint,owner,character_id,kind,amount,balance,actor,reason,created) VALUES (?,?,?,?,?,?,?,?,?,?)').run(receipt,receipt,c.owner,c.id,'quest',r.rpp,balance+r.rpp,'story',p.flow.name,now());
   }
   const day=Math.floor(now()/86400000),spent=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(c.owner,day)?.coins??0,paid=Math.min(r.coins,Math.max(0,dailyCoinCap()-spent));
   if(paid){adjust(c.owner,'coins',paid,receipt,p.flow.name);db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(c.owner,day,paid);}
  } // Stable flow-step receipts protect external credits; local changes share the command transaction.
 };
}
