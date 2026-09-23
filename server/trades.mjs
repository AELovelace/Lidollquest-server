// Player-to-player trading: items for items, items for coins, or any mix. One player offers a
// trade from the right-click player panel, the other accepts, both put items and coins on the
// table, both confirm, and the server swaps everything at once. Coins are escrowed through the
// same durable wallet debit path the shops use, so a lost response can never double-charge, and
// server-issued resale rights move to the new owner with the item.
import {randomUUID} from 'node:crypto';
import {addToInventory,stackable,slotsUsed} from './loadout.mjs';

export const TRADE_ACTIONS=Object.freeze(['trade_offer','trade_accept','trade_decline','trade_cancel','trade_add','trade_remove','trade_confirm']);
const PROPOSAL_TTL=10*60000,MAX_COIN_OFFER=1000000,INVENTORY_CAPACITY=99;
const fail=(message,code='trade_rejected')=>{throw Object.assign(Error(message),{status:409,code});};
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;

export function createTrades(db,{now=Date.now,adjust=()=>{},saveCharacter,origins=null,capacity=INVENTORY_CAPACITY}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS quest_trades(id TEXT PRIMARY KEY,zone TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS quest_open_trades ON quest_trades(updated) WHERE json_extract(state,'$.finished') IS NOT 1;`);
 const fetch=id=>{const row=db.prepare('SELECT state FROM quest_trades WHERE id=?').get(id??'');return row?JSON.parse(row.state):null;};
 const write=t=>db.prepare('INSERT INTO quest_trades VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated').run(t.id,t.zone,JSON.stringify(t),now());
 const character=id=>db.prepare('SELECT * FROM quest_characters WHERE id=?').get(id);
 const presence=id=>db.prepare('SELECT * FROM quest_presence WHERE character_id=? AND seen>?').get(id,now()-30000);
 function message(t,text){t.sequence++;t.events.push({seq:t.sequence,text});t.events=t.events.slice(-20);}
 function roster(t,caller=null,state=null){return t.sides.map((side,index)=>{const c=caller?.id===side.id?caller:character(side.id);return {side,index,c,s:caller?.id===side.id?state:JSON.parse(c.state)};});}
 function persist(t,rows,caller=null){for(const {c,s} of rows)if(c.id!==caller?.id)saveCharacter(c,s);write(t);}
 const mine=(t,id)=>t.sides.findIndex(side=>side.id===id);
 const label=item=>(item.name??item.item_id)+(num(item.quantity)>1?' x'+item.quantity:'');
 function unconfirm(t){for(const side of t.sides)side.confirmed=false;} // Any change to either offer needs a fresh confirmation from both.

 function offer(c,state,input,p){
  if(state.trade)fail('You already have a trade open. Finish or cancel it first.');
  if(state.run||state.duel||state.pendingPurchase||state.pendingDefeat||state.worldTurnDue)fail('Finish what you are doing before trading.');
  const targetId=String(input.target??'');if(!targetId||targetId===c.id)fail('Choose another player to trade with.');
  const target=character(targetId)??fail('That player is not here.');
  if(presence(target.id)?.zone!==p.zone)fail(target.name+' is not in this room.');
  const ts=JSON.parse(target.state);if(ts.run||ts.duel||ts.trade||ts.pendingPurchase||ts.pendingDefeat)fail(target.name+' is busy right now.');
  const side=(ch)=>({id:ch.id,name:ch.name,owner:ch.owner,items:[],coins:0,coinsPending:0,confirmed:false});
  const t={id:randomUUID(),zone:p.zone,created:now(),phase:'proposed',by:c.id,sequence:0,events:[],sides:[side(c),side(target)],escrow:{},finished:false};
  message(t,c.name+' offered to trade with '+target.name+'.');
  const rows=roster(t,c,state);for(const {s} of rows)s.trade=t.id;persist(t,rows,c);
 }
 function requireTrade(state,phases){const t=fetch(state.trade);if(!t||t.finished)fail('That trade is over.');if(phases&&!phases.includes(t.phase))fail('The trade is not at that stage.');return t;}
 function refund(t,rows){for(const {side,s,c} of rows){for(const item of side.items){if(item.online_item)origins?.release(item.online_item,c.id);addToInventory(s.loadout.inventory,item);}side.items=[];if(side.coins>0)adjust(c.owner,'coins',side.coins,randomUUID(),'Trade coins returned');side.coins=0;}}
 function close(t,rows,text){t.finished=true;t.phase='cancelled';message(t,text);for(const {s} of rows)delete s.trade;}
 function accept(c,state){const t=requireTrade(state,['proposed']);if(t.sides[1].id!==c.id)fail('Only the player who was offered the trade can accept.');const rows=roster(t,c,state);t.phase='open';message(t,c.name+' accepted. Put items or coins on the table, then both confirm.');persist(t,rows,c);}
 function decline(c,state){const t=requireTrade(state,['proposed']);if(t.sides[1].id!==c.id)fail('Only the player who was offered the trade can decline.');const rows=roster(t,c,state);close(t,rows,c.name+' declined the trade.');persist(t,rows,c);}
 function cancel(c,state){const t=requireTrade(state,['proposed','open']);const rows=roster(t,c,state);if(t.sides.some(side=>side.coinsPending>0))fail('A coin offer is still settling; try again in a moment.');refund(t,rows);close(t,rows,c.name+' cancelled the trade. Everything went back.');persist(t,rows,c);}

 function add(c,state,input){
  const t=requireTrade(state,['open']),rows=roster(t,c,state),side=t.sides[mine(t,c.id)];
  const kind=String(input.kind??'');
  if(kind==='coins'){
   const amount=Math.floor(num(input.amount));if(!Number.isSafeInteger(amount)||amount<1||amount>MAX_COIN_OFFER)fail('Offer between 1 and '+MAX_COIN_OFFER+' coins.');
   if(state.pendingPurchase)fail('Your previous coin offer is still settling.');
   const id=randomUUID();
   db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,c.owner,c.id,JSON.stringify({trade_escrow:t.id,amount,name:'Trade coins'}),amount); // Durable debit; hooks.tradeEscrow reports the outcome.
   state.pendingPurchase=id;state.hubNotice='Escrowing '+amount+' coins for the trade…';state.hubNoticeAt=now();
   t.escrow[id]={side:side.id,amount};side.coinsPending++;unconfirm(t);message(t,c.name+' is adding '+amount+' coins.');
  }else if(kind==='item'){
   const i=Math.floor(num(input.index,-1)),bag=state.loadout?.inventory??[];if(i<0||i>=bag.length)fail('Choose an item from your bag.');
   const item=bag[i];if(item.quest_item||item.loot_locked)fail('Key items cannot be traded.');
   if(item.forced_wear||item.forced_drink)fail('That item is owed to you by a duel; use it first.');
   bag.splice(i,1);side.items.push(item);if(item.online_item)origins?.park(item.online_item,c.id);unconfirm(t);message(t,c.name+' put '+label(item)+' on the table.'); // The resale right waits in escrow with the item.
  }else fail('Add coins or an item.');
  persist(t,rows,c);
 }
 function fund(purchaseId,char,state,paid,amount){ // Called by hubs.mjs when a trade escrow debit settles, inside that transaction.
  for(const row of db.prepare("SELECT id,state FROM quest_trades WHERE json_extract(state,'$.finished') IS NOT 1").all()){
   const t=JSON.parse(row.state),e=t.escrow?.[purchaseId];if(!e)continue;
   const side=t.sides.find(v=>v.id===e.side);side.coinsPending=Math.max(0,side.coinsPending-1);delete t.escrow[purchaseId];
   if(paid&&t.phase==='open'){side.coins+=amount;message(t,char.name+"'s "+amount+' coins are on the table.');}
   else if(paid){adjust(char.owner,'coins',amount,randomUUID(),'Trade coins returned');message(t,char.name+"'s coins were returned.");}
   else message(t,char.name+' could not cover that offer.');
   state.hubNotice=paid?'Your coins are on the table.':'Not enough LiDollCoins for that offer.';state.hubNoticeAt=now();
   write(t);return;
  }
 }
 function remove(c,state){
  const t=requireTrade(state,['open']),rows=roster(t,c,state),side=t.sides[mine(t,c.id)];
  if(!side.items.length&&side.coins<=0)fail('You have nothing on the table.');
  for(const item of side.items){if(item.online_item)origins?.release(item.online_item,c.id);addToInventory(state.loadout.inventory,item);}side.items=[];
  if(side.coins>0){adjust(c.owner,'coins',side.coins,randomUUID(),'Trade coins returned');side.coins=0;}
  unconfirm(t);message(t,c.name+' took their offer back.');persist(t,rows,c);
 }
 function confirm(c,state){
  const t=requireTrade(state,['open']),rows=roster(t,c,state),index=mine(t,c.id),side=t.sides[index];
  if(side.coinsPending>0)fail('Your coin offer is still settling; wait a moment.');
  side.confirmed=true;message(t,c.name+' confirmed.');
  if(t.sides.every(v=>v.confirmed&&v.coinsPending===0)){
   const zones=rows.map(({c:other})=>presence(other.id)?.zone??null);let blocked=zones[0]!==zones[1]||!zones[0]?'Both of you need to be in the same room to finish the trade.':'';
   for(const {side:giver,index:gi} of rows){ // Room check first: nothing moves unless both bags can take everything.
    const receiver=rows[1-gi];const singles=giver.items.filter(item=>!stackable(item)).length;
    if(!blocked&&singles&&slotsUsed(receiver.s.loadout.inventory)+singles>capacity)blocked=receiver.side.name+' needs '+singles+' free bag slot'+(singles===1?'':'s')+' for this trade.';
   }
   if(blocked){unconfirm(t);message(t,blocked);state.hubNotice=blocked;state.hubNoticeAt=now();persist(t,rows,c);return;} // Recorded, not thrown: a throw would roll the reset back and leave stale confirmations standing.
   for(const {side:giver,index:gi,c:from} of rows){
    const receiver=rows[1-gi];
    for(const item of giver.items){if(item.online_item)origins?.release(item.online_item,receiver.c.id);addToInventory(receiver.s.loadout.inventory,item);} // The escrowed resale right is released to the new owner.
    if(giver.coins>0)adjust(receiver.c.owner,'coins',giver.coins,randomUUID(),'Trade with '+giver.name);
    receiver.s.hubNotice='Trade complete: '+(giver.items.length?giver.items.map(label).join(', '):'')+(giver.items.length&&giver.coins>0?' and ':'')+(giver.coins>0?giver.coins+' coins':'')+(giver.items.length||giver.coins>0?' from '+giver.name+'.':' nothing from '+giver.name+'.');receiver.s.hubNoticeAt=now();
    giver.items=[];giver.coins=0;
   }
   t.phase='done';t.finished=true;message(t,'The trade is complete.');for(const {s} of rows)delete s.trade;
  }
  persist(t,rows,c);
 }
 function tick(){ // Expired proposals and abandoned tables give everything back.
  for(const row of db.prepare("SELECT state FROM quest_trades WHERE json_extract(state,'$.finished') IS NOT 1").all()){
   const t=JSON.parse(row.state);if(t.sides.some(side=>side.coinsPending>0))continue;
   const stale=now()-t.created>PROPOSAL_TTL,gone=t.sides.some(side=>!presence(side.id));
   if(!stale&&!gone)continue;
   const rows=roster(t);refund(t,rows);close(t,rows,stale?'The trade timed out. Everything went back.':'A trader left the room. Everything went back.');persist(t,rows);
  }
 }
 function snapshot(c,state){
  const t=fetch(state?.trade);if(!t)return null;
  return {id:t.id,phase:t.phase,by:t.by,mine:mine(t,c.id),events:t.events.slice(-8),serverTime:now(),
   sides:t.sides.map(side=>({id:side.id,name:side.name,coins:side.coins,pending:side.coinsPending>0,confirmed:side.confirmed,items:side.items.map(item=>({name:item.name??item.item_id,quantity:num(item.quantity,1),category:item.category}))}))};
 }
 function act(i,c,state,input,p){
  switch(input.action){
   case 'trade_offer':return offer(c,state,input,p);case 'trade_accept':return accept(c,state);case 'trade_decline':return decline(c,state);case 'trade_cancel':return cancel(c,state);
   case 'trade_add':return add(c,state,input);case 'trade_remove':return remove(c,state);case 'trade_confirm':return confirm(c,state);
  }
  fail('Unknown trade action.');
 }
 return {act,fund,tick,snapshot,fetch};
}
