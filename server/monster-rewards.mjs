import {randomUUID} from 'node:crypto';
import {dailyCoinCap} from './hubs.mjs';

export function awardMonsterCoins(db,{character,enemies,adjust,now,roll}) {
 if(!adjust)return 0; // Read-only encounter fixtures have no wallet writer.
 const amount=enemies.reduce((sum,enemy)=>{
  if(enemy.wildlife)return sum; // Hunting animals yields their authored materials.
  const low=Number.isSafeInteger(enemy.gold_min)?Math.max(0,enemy.gold_min):1;
  const high=Number.isSafeInteger(enemy.gold_max)?Math.max(low,enemy.gold_max):Math.max(low,3);
  return sum+low+roll(high-low+1); // Older online exports omitted gold ranges; restore the campaign's 1–3 fallback.
 },0);
 const day=Math.floor(now()/86400000),used=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(character.owner,day)?.coins??0;
 const paid=Math.min(amount,Math.max(0,dailyCoinCap()-used)); // Monster, boss, quest and sale income share the account's UTC allowance.
 if(paid){
  adjust(character.owner,'coins',paid,randomUUID(),'Monster victory'); // The caller's settlement transaction also owns the durable wallet outbox.
  db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(character.owner,day,paid);
 }
 return paid;
}
