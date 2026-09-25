// Player-versus-player duels and party-versus-party battles. Consent first: a leader challenges,
// the other leader accepts, both sides stake what they like (coins through wallet escrow, items
// and drinks straight out of their bags), both leaders say ready, then everyone fights on live
// gauges exactly like a shared Dive encounter, with each side acting as the other's enemies.
// Wager mode: the winners split the coins, the top damage dealer takes the items, the losers
// drink every pooled drink. RP mode: each fighter posts a get-ready RP first; afterwards the
// winners pick victims in damage order and dress and feed them from either bag.
import {randomUUID} from 'node:crypto';
import {combatAction,readyTurn,clearEffects,currentTuning,combatData} from './combat.mjs';
import {applyRunLoadout,syncRunHealth,addToInventory} from './loadout.mjs';
import {applyCombatPatch,actionDelay,encounterTuning} from './dive-encounters.mjs';
import {rowSwapCostsTurn,rowDamageTaken,weaponProfile} from './scaling.mjs';
import {WEARABLE_CATEGORIES} from './loot.mjs';
import {isCrawling} from './crawl.mjs';
import {GODS,FAITH_SETTINGS,wouldBreakUniform,combatFaith} from './faith.mjs'; // Orin's followers gain piety by dressing the pious into anathema.
import {hubData} from './hubs.mjs';
import {withGenerated} from './generated-items.mjs';

export const DUEL_ACTIONS=Object.freeze(['duel_challenge','duel_accept','duel_decline','duel_cancel','duel_stake','duel_unstake','duel_ready','duel_pick','duel_dress','duel_feed','duel_finish']); // Lobby, stakes and aftermath commands.
export const DUEL_FIGHT_ACTIONS=Object.freeze(['turn_ready','attack','cast','charm','allure','use_item','flee','submit','stand','row']); // Fight commands, routed here while run.kind is 'duel'.
const PROPOSAL_TTL=10*60000,DRESSING_TTL=15*60000,DISCONNECT_TTL=150000,GET_READY_WINDOW=30*60000,MAX_COIN_STAKE=100000;
const fail=(message,code='duel_rejected')=>{throw Object.assign(Error(message),{status:409,code});};
const clone=v=>JSON.parse(JSON.stringify(v));
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const isDrink=item=>!!item&&(item.category==='drink'||item.is_drink===true); // Same test as inv_item_is_drink() on the client.
const isFood=item=>!!item&&(item.category==='food'||item.category==='drink'||item.is_snack===true);
const z={theme:'duel',activeTime:true}; // Live gauges: combatAction never resolves an enemy turn itself.

export function createDuels(db,{now=Date.now,roll,parties=null,adjust=()=>{},saveCharacter,pvpAllowed=()=>true,getReadyPosted=()=>true,origins=null,log=()=>{}}={}){ // pvpAllowed(zone): hubs and the open overworld, never a dungeon Dive.
 db.exec(`CREATE TABLE IF NOT EXISTS quest_duels(id TEXT PRIMARY KEY,zone TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS quest_open_duels ON quest_duels(updated) WHERE json_extract(state,'$.finished') IS NOT 1;`);
 const fetch=id=>{const row=db.prepare('SELECT state FROM quest_duels WHERE id=?').get(id??'');return row?JSON.parse(row.state):null;};
 const write=d=>db.prepare('INSERT INTO quest_duels VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated').run(d.id,d.zone,JSON.stringify(d),now());
 const character=id=>db.prepare('SELECT * FROM quest_characters WHERE id=?').get(id);
 const presence=id=>db.prepare('SELECT * FROM quest_presence WHERE character_id=? AND seen>?').get(id,now()-30000);
 function message(d,text){d.sequence++;d.events.push({seq:d.sequence,text});d.events=d.events.slice(-40);}
 const members=d=>d.sides.flatMap((side,index)=>side.members.map(m=>({m,side,index})));
 function roster(d,caller=null,state=null){ // Every fighter with their character row and decoded state; the caller's live state is used in place of the stored copy.
  return members(d).map(({m,side,index})=>{const c=caller?.id===m.id?caller:character(m.id);return {m,side,index,c,s:caller?.id===m.id?state:JSON.parse(c.state)};});
 }
 function persist(d,rows,caller=null){for(const {c,s} of rows)if(c.id!==caller?.id)saveCharacter(c,s);write(d);}
 const sideOf=(d,id)=>d.sides.findIndex(side=>side.members.some(m=>m.id===id));
 const memberOf=(d,id)=>members(d).find(v=>v.m.id===id)?.m??null;
 const alive=m=>m.status==='active'&&(m.hp??1)>0;
 function group(c){ // The party a character fights with: every connected member without a fight, or the character alone.
  const rows=parties?.members(c.id)??[];const people=rows.length?rows:[c];const leader=rows.length?parties.party(c.id)?.leader:c.id;
  return {leader,people};
 }

 // ── Lobby ─────────────────────────────────────────────────────────────────────────────────
 function challenge(c,state,input,p){
  if(state.duel)fail('You already have a duel pending. Finish or cancel it first.');
  if(state.run||state.trade||state.pendingPurchase||state.pendingDefeat||state.worldTurnDue)fail('Finish what you are doing before challenging anyone.');
  if(!pvpAllowed(p.zone))fail('Duels are fought in the hubs and the open overworld, not inside a dungeon Dive.');
  const mode=input.mode==='rp'?'rp':'wager';
  const targetId=String(input.target??'');if(!targetId||targetId===c.id)fail('Choose another player to challenge.');
  const target=character(targetId)??fail('That player is not here.');
  const mine=group(c);if(mine.leader!==c.id)fail('Only the party leader can issue a challenge.');
  let theirs=group(target);const leader=theirs.people.find(other=>other.id===theirs.leader)??target;theirs={leader:leader.id,people:theirs.people}; // Challenging any member reaches their leader.
  const zoneOf=id=>presence(id)?.zone??null;
  const sides=[];
  for(const [label,side] of [['Your side',mine],['Their side',theirs]]){
   const list=[];
   for(const other of side.people){
    const s=other.id===c.id?state:JSON.parse(other.state);
    if(zoneOf(other.id)!==p.zone)fail(other.name+' is not in this room.');
    if((s.dive?.edition??null)!==(state.dive?.edition??null))fail(other.name+' is on another floor.'); // Overworld editions roll weekly; both sides must share the floor they stand on.
    if(other.id!==c.id&&(s.run||s.duel||s.trade||s.pendingPurchase||s.pendingDefeat))fail(other.name+' is busy right now.');
    list.push({id:other.id,name:other.name,owner:other.owner,status:'active',row:'front',damage:0,ready:false});
   }
   if(list.some(m=>side.people.find(o=>o.id===m.id)&&sides.length&&sides[0].members.some(x=>x.id===m.id)))fail('Those players are already on your side.');
   sides.push({leader:side.leader,ready:false,members:list,stakes:{coins:0,items:[],drinks:[]},coinsBy:{},pending:0,label});
  }
  const d={id:randomUUID(),zone:p.zone,created:now(),phase:'proposed',mode,by:c.id,sequence:0,events:[],sides,wagers:{},winner:null,finished:false};
  message(d,c.name+' challenged '+leader.name+(theirs.people.length>1?"'s party":'')+' to a '+(mode==='rp'?'roleplay battle':'wager duel')+'.');
  const rows=roster(d,c,state);for(const {s} of rows)s.duel=d.id;
  persist(d,rows,c);
 }
 function requireDuel(state,phases){const d=fetch(state.duel);if(!d||d.finished)fail('That duel is over.');if(phases&&!phases.includes(d.phase))fail('The duel is not at that stage.');return d;}
 function refund(d,rows){ // Give every stake back to whoever put it in.
  for(const side of d.sides){
   for(const entry of [...side.stakes.items,...side.stakes.drinks]){const row=rows.find(v=>v.m.id===entry.by);if(row){if(entry.item.online_item)origins?.release(entry.item.online_item,row.c.id);addToInventory(row.s.loadout.inventory,entry.item);}}
   side.stakes.items=[];side.stakes.drinks=[];
   for(const [id,amount] of Object.entries(side.coinsBy)){const row=rows.find(v=>v.m.id===id);if(row&&amount>0)adjust(row.c.owner,'coins',amount,randomUUID(),'Duel stake returned');}
   side.coinsBy={};side.stakes.coins=0;
  }
 }
 function close(d,rows,text){d.finished=true;d.phase='cancelled';message(d,text);for(const {s} of rows){delete s.duel;if(s.run?.kind==='duel')s.run=null;}}
 function accept(c,state){const d=requireDuel(state,['proposed']);if(d.sides[1].leader!==c.id)fail('Only the challenged leader can accept.');const rows=roster(d,c,state);d.phase='staking';message(d,c.name+' accepted. Both sides may now add stakes.');persist(d,rows,c);}
 function decline(c,state){const d=requireDuel(state,['proposed']);if(d.sides[1].leader!==c.id)fail('Only the challenged leader can decline.');const rows=roster(d,c,state);close(d,rows,c.name+' declined the duel.');persist(d,rows,c);}
 function cancel(c,state){const d=requireDuel(state,['proposed','staking']);if(!d.sides.some(side=>side.leader===c.id))fail('Only a leader can call the duel off.');const rows=roster(d,c,state);if(d.sides.some(side=>side.pending>0))fail('A coin wager is still settling; try again in a moment.');refund(d,rows);close(d,rows,c.name+' called the duel off. Stakes were returned.');persist(d,rows,c);}

 function stake(c,state,input){
  const d=requireDuel(state,['staking']),rows=roster(d,c,state),index=sideOf(d,c.id),side=d.sides[index];
  if(side.ready)fail('Your side already said ready; unready by cancelling is not possible, so add stakes before ready.');
  const kind=String(input.kind??'');
  if(kind==='coins'){
   const amount=Math.floor(num(input.amount));if(!Number.isSafeInteger(amount)||amount<1||amount>MAX_COIN_STAKE)fail('Stake between 1 and '+MAX_COIN_STAKE+' coins.');
   if(state.pendingPurchase)fail('Your previous wager is still settling.');
   const id=randomUUID();
   db.prepare('INSERT INTO hub_purchases(id,owner,character_id,item,price) VALUES (?,?,?,?,?)').run(id,c.owner,c.id,JSON.stringify({duel_wager:d.id,amount,name:'Duel wager'}),amount); // The same durable debit path shops use; hooks.duelWager reports the outcome.
   state.pendingPurchase=id;state.hubNotice='Escrowing '+amount+' coins for the duel…';state.hubNoticeAt=now();
   d.wagers[id]={side:index,member:c.id,amount};side.pending++;
   message(d,c.name+' is putting up '+amount+' coins.');
  }else if(kind==='item'||kind==='drink'){
   const i=Math.floor(num(input.index,-1)),bag=state.loadout?.inventory??[];if(i<0||i>=bag.length)fail('Choose an item from your bag.');
   const item=bag[i];
   if(item.quest_item||item.loot_locked)fail('Key items cannot be staked.');
   if(kind==='drink'&&!isDrink(item))fail('That is not a drink.');
   if(kind==='item'&&isDrink(item))fail('Pool drinks as drinks, so the loser has to drink them.');
   bag.splice(i,1);side.stakes[kind==='drink'?'drinks':'items'].push({by:c.id,item});if(item.online_item)origins?.park(item.online_item,c.id); // The resale right waits in escrow with the stake.
   message(d,c.name+(kind==='drink'?' poured ':' put up ')+(item.name??item.item_id)+(num(item.quantity)>1?' x'+item.quantity:'')+(kind==='drink'?' into the pool.':'.'));
  }else fail('Stake coins, an item or a drink.');
  persist(d,rows,c);
 }
 function fund(purchaseId,char,state,paid,amount){ // Called by hubs.mjs when a wager debit settles, inside that transaction.
  for(const row of db.prepare("SELECT id,state FROM quest_duels WHERE json_extract(state,'$.finished') IS NOT 1").all()){
   const d=JSON.parse(row.state),w=d.wagers?.[purchaseId];if(!w)continue;
   const side=d.sides[w.side];side.pending=Math.max(0,side.pending-1);delete d.wagers[purchaseId];
   if(paid&&d.phase==='staking'){side.stakes.coins+=amount;side.coinsBy[w.member]=(side.coinsBy[w.member]??0)+amount;message(d,char.name+"'s "+amount+' coins are in the pot.');}
   else if(paid){adjust(char.owner,'coins',amount,randomUUID(),'Duel stake returned');message(d,char.name+"'s coins were returned.");} // The duel moved on before the debit settled.
   else message(d,char.name+' could not cover that wager.');
   state.hubNotice=paid?'Your duel stake is in the pot.':'Not enough LiDollCoins for that wager.';state.hubNoticeAt=now();
   write(d);return;
  }
 }
 function unstake(c,state){
  const d=requireDuel(state,['staking']),rows=roster(d,c,state),side=d.sides[sideOf(d,c.id)];
  if(side.ready)fail('Your side already said ready.');
  let n=0;
  for(const key of ['items','drinks']){const keep=[];for(const entry of side.stakes[key]){if(entry.by===c.id){if(entry.item.online_item)origins?.release(entry.item.online_item,c.id);addToInventory(state.loadout.inventory,entry.item);n++;}else keep.push(entry);}side.stakes[key]=keep;}
  if(!n)fail('You have no items or drinks in the pool. Coins come back only if the duel is called off.');
  message(d,c.name+' took their items back.');persist(d,rows,c);
 }
 function ready(c,state){
  const d=requireDuel(state,['staking']),rows=roster(d,c,state),index=sideOf(d,c.id),side=d.sides[index];
  if(side.leader!==c.id)fail('Only your leader can say ready.');
  if(side.pending>0)fail('A coin wager is still settling; wait a moment.');
  if(d.mode==='rp'){const opponents=d.sides[1-index].members.map(m=>m.id);for(const m of side.members)if(!getReadyPosted(m.id,opponents,now()-GET_READY_WINDOW))fail(m.name+' has not posted a get-ready RP with an opponent as a partner yet.');}
  for(const {m,s} of rows.filter(v=>v.index===index)){if(s.run||s.pendingPurchase||s.pendingDefeat||!s.loadout||s.loadout.player_info.playerHealth<=0)fail(m.name+' is not ready to fight.');}
  side.ready=true;message(d,side.label+' is ready.');
  if(d.sides.every(v=>v.ready))start(d,rows);
  persist(d,rows,c);
 }
 function start(d,rows){
  d.phase='fight';d.started=now();
  for(const {m,s} of rows){
   s.lastResult=null;const duration=actionDelay(s.loadout.player_info.dex);
   s.run={kind:'duel',id:d.id,sharedEncounter:d.id,duel:d.id,zone:d.zone,stage:1,phase:'fight',hp:s.loadout.player_info.playerHealth,maxHp:s.loadout.player_info.playerHealthMax,heals:0,pot:0,handicaps:[],enemy:null,acted:now(),log:[],turn:1,turnReady:false,combatVersion:3,buffs:[],debuffs:[],dots:[]};
   applyRunLoadout(s.run,s.loadout);m.run=s.run; // The member record carries the run between commands, as encounter players do.
   Object.assign(m,{status:'active',row:'front',rowSwapped:false,damage:0,cycle:1,duration,readyAt:now()+duration*(1-encounterTuning.player_initial_fill),prepared:false,mods:{str:0,def:0},hp:s.run.hp,maxHp:s.run.maxHp});
  }
  message(d,'The duel begins!');syncRuns(d,rows); // Every fighter's run now carries gauges, rows and their first opponent.
 }

 // ── Fight ─────────────────────────────────────────────────────────────────────────────────
 function view(d,rows,target){ // The opponent as combat.mjs expects an enemy: their live HP and stats, plus authored numbers for charm difficulty (which duels refuse anyway).
  const row=rows.find(v=>v.m.id===target.id),p=row.s.loadout.player_info;
  return {name:target.name,hp:target.hp,maxHp:target.maxHp,str:Math.max(1,num(p.str)+num(target.mods?.str)),def:Math.max(0,num(p.def)+num(target.mods?.def)),dex:num(p.dex),exp:0,enemy_id:'duelist',turn:0,level:num(p.level,1),player:target.id,avatar:row.s.avatar??'player',authored:{hp:target.maxHp,str:num(p.str),def:num(p.def)}}; // avatar: the client draws the opponent's own sprite.
 }
 function projection(d,rows,m,index){
  const mine=d.sides[index].members.filter(alive),foe=d.sides[1-index].members.find(alive)??d.sides[1-index].members[0];
  return {...(m.run??{}),hp:m.hp,maxHp:m.maxHp,enemy:view(d,rows,foe),sharedEncounter:d.id,duel:d.id,combatVersion:3,cycle:m.cycle,readyAt:m.readyAt,duration:m.duration,prepared:m.prepared,turnReady:m.prepared,phase:'fight',status:m.status,turn:m.cycle,log:d.events.map(v=>v.text),row:m.row,rowSwapped:m.rowSwapped===true,rowPartner:mine.length>1,rowAlone:!mine.some(v=>v.row!=='back')}; // Same fields the Dive projection carries (status, phase, turn, log), so the shared battle HUD reads a duel exactly like a party fight.
 }
 function syncRuns(d,rows){for(const {m,s,index} of rows){if(d.phase==='fight'){s.run=projection(d,rows,m,index);m.run=s.run;syncRunHealth(s,s.run);}}}
 function reset(m,s){m.cycle++;m.prepared=false;m.rowSwapped=false;m.duration=actionDelay(s.loadout.player_info.dex);m.readyAt=now()+m.duration;if(m.run){m.run.turnReady=false;m.run.turn=m.cycle;}} // A new gauge: the next action needs a fresh turn_ready, as in Dive encounters.
 function knockOut(d,m,outcome,text){m.status=outcome;m.prepared=false;m.downedAt=now();message(d,text);}
 function fight(c,state,input){
  const d=requireDuel(state,['fight']),rows=roster(d,c,state),index=sideOf(d,c.id),m=d.sides[index].members.find(v=>v.id===c.id);
  if(input.battle!==undefined&&input.battle!==d.id)fail('This duel has changed.');
  syncRuns(d,rows);
  if(m.status!=='active')fail('You are out of this duel.');
  if(['charm','allure'].includes(input.action))fail('Charms do not work on other players.'); // A rule, not a timing matter: refused before the gauge check.
  if(input.cycle!==undefined&&input.cycle!==m.cycle)fail('That action cycle has already ended.');
  const mine=d.sides[index].members.filter(alive);
  if(input.action==='row'){
   if(mine.length<2)fail('No one is here to hold the line; alone you always fight in front.');
   if(isCrawling(state.loadout))fail('Stand up before changing rows.');
   const costs=rowSwapCostsTurn(currentTuning());if(m.rowSwapped&&!costs)fail('You already changed rows this cycle.');
   if(costs&&now()<m.readyAt)fail('Your action gauge is still filling.');
   m.row=m.row==='back'?'front':'back';m.rowSwapped=true;message(d,m.name+' moves to the '+m.row+' row.');if(costs)reset(m,state);
  }else if(['flee','submit'].includes(input.action)){knockOut(d,m,'out',m.name+(input.action==='flee'?' backs out of the duel.':' submits.'));}
  else{
   if(now()<m.readyAt)fail('Your action gauge is still filling.');
   if(input.action==='turn_ready'){
    if(m.prepared||typeof input.forfeit!=='boolean')fail('This action cycle is already prepared.');
    state.loadout=applyCombatPatch(state.loadout,input.patch??[]);state.run.turnReady=false;readyTurn(state,false,z,roll);m.prepared=true;
    if(input.forfeit){message(d,m.name+' is too distracted to act.');reset(m,state);}
   }else{
    if(!m.prepared)fail('Finish this action cycle’s needs first.');
    if(['charm','allure'].includes(input.action))fail('Charms do not work on other players.');
    const supportSpell=input.action==='cast'&&['heal','cure','buff'].includes(combatData.spells[input.spell]?.type); // Heals, cures and buffs aim at your own side.
    const targetId=input.target??(supportSpell?c.id:undefined);
    const target=supportSpell?d.sides[index].members.find(v=>v.id===targetId&&alive(v)):d.sides[1-index].members.find(v=>v.id===targetId&&alive(v));
    const foe=target&&!supportSpell?target:d.sides[1-index].members.find(alive);
    if(!foe||supportSpell&&!target)fail('Choose an active target.');
    const targetRow=rows.find(v=>v.m.id===(supportSpell?target.id:foe.id));
    state.run.enemy=view(d,rows,foe);state.run.turnReady=true;state.run.dots=[];state.run.debuffs=[];
    if(input.action==='use_item'){state.loadout=applyCombatPatch(state.loadout,input.patch??[]);applyRunLoadout(state.run,state.loadout);}
    const before=foe.hp,defBefore=state.run.enemy.def,strBefore=state.run.enemy.str;
    if(supportSpell&&target.id!==c.id){targetRow.s.run=projection(d,rows,target,index);} // The ally's run receives the heal or buff.
    combatAction(state,input,z,roll,supportSpell?targetRow.s:state);
    for(const line of state.run.log)message(d,m.name+': '+line);
    if(supportSpell){target.hp=targetRow.s.run.hp;}
    else{
     let dealt=Math.max(0,before-state.run.enemy.hp);
     const physical=input.action==='attack'&&weaponProfile(state.loadout).cls!=='gun';
     const foeSide=d.sides[1-index].members.filter(alive);
     if(physical)dealt=Math.max(dealt>0?1:0,Math.floor(dealt*rowDamageTaken(currentTuning(),foe.row,!foeSide.some(v=>v.row!=='back')))); // Their back row halves your melee while an ally holds their front.
     foe.hp=Math.max(0,before-dealt);m.damage+=dealt;
     foe.mods.def+=state.run.enemy.def-defBefore;foe.mods.str+=state.run.enemy.str-strBefore; // Debuffs stick for the duel.
     if(dealt>0)message(d,m.name+' hits '+foe.name+' for '+dealt+'.');
     if(foe.hp<=0)knockOut(d,foe,'defeat',foe.name+' is down!');
    }
    m.hp=state.run.hp;reset(m,state);
   }
  }
  settle(d,rows);if(!d.finished)syncRuns(d,rows);persist(d,rows,c);
 }

 // ── Settlement ────────────────────────────────────────────────────────────────────────────
 function settle(d,rows,force=false){
  const standing=d.sides.map(side=>side.members.some(alive));
  if(!force&&standing[0]&&standing[1])return false;
  const winner=standing[0]&&!standing[1]?0:standing[1]&&!standing[0]?1:null;
  d.winner=winner;d.ended=now();
  const total=d.sides.reduce((n,side)=>n+side.stakes.coins,0),items=d.sides.flatMap(side=>side.stakes.items),drinks=d.sides.flatMap(side=>side.stakes.drinks);
  if(winner===null){refund(d,rows);message(d,'The duel ends in a draw. Every stake goes home.');}
  else{
   const winners=d.sides[winner].members.slice().sort((a,b)=>b.damage-a.damage),losers=d.sides[1-winner].members;
   message(d,d.sides[winner].label==='Your side'?'The challengers win!':'The challenged side wins!');
   if(total>0){const share=Math.floor(total/winners.length);let rest=total-share*winners.length;
    for(const w of winners){const amount=share+(rest>0?1:0);if(rest>0)rest--;if(amount>0){adjust(rows.find(v=>v.m.id===w.id).c.owner,'coins',amount,randomUUID(),'Duel winnings');w.coins=amount;}}
    message(d,winners.map(w=>w.name+' takes '+(w.coins??0)+' coins').join(', ')+'.');
   }
   if(items.length){const top=rows.find(v=>v.m.id===winners[0].id);for(const entry of items){if(entry.item.online_item)origins?.release(entry.item.online_item,top.c.id);addToInventory(top.s.loadout.inventory,entry.item);}message(d,winners[0].name+' claims '+items.map(e=>e.item.name??e.item.item_id).join(', ')+'.');}
   if(drinks.length){const loserRows=losers.map(l=>rows.find(v=>v.m.id===l.id));drinks.forEach((entry,i)=>{const row=loserRows[i%loserRows.length];if(entry.item.online_item)origins?.release(entry.item.online_item,row.c.id);addToInventory(row.s.loadout.inventory,{...entry.item,forced_drink:true});});message(d,losers.map(l=>l.name).join(' and ')+(losers.length>1?' have':' has')+' to drink everything in the pool.');}
   for(const side of d.sides){side.stakes.items=[];side.stakes.drinks=[];side.stakes.coins=0;side.coinsBy={};}
   if(d.mode==='rp'){d.aftermath={order:winners.map(w=>w.id),losers:losers.map(l=>l.id),picks:{},current:0,sessions:{}};if(winners.length===1&&losers.length===1){d.aftermath.picks[winners[0].id]=losers[0].id;d.aftermath.current=1;openSessions(d);}}
  }
  d.phase=d.mode==='rp'&&winner!==null?'aftermath':'settled';
  for(const {m,s,index} of rows){
   s.run=m.run??s.run;if(s.run){clearEffects(s);}
   const won=winner===index,lost=winner!==null&&!won;
   if(lost&&s.run)s.run.hp=Math.max(1,Math.ceil((m.maxHp??s.run.maxHp)/4)); // Losing hurts like any defeat.
   else if(s.run)s.run.hp=m.hp;
   if(s.run)syncRunHealth(s,s.run);
   s.lastResult={outcome:winner===null?'draw':won?'win':'defeat',coins:m.coins??0,rounds:1,zone:d.zone,log:d.events.map(v=>v.text),duel:{id:d.id,mode:d.mode,winner}};
   s.wins=(s.wins??0)+(won?1:0);s.run=null;
   if(d.phase==='settled')delete s.duel; // Wager duels are done; RP duels keep everyone attached until the dressing is finished.
  }
  if(d.phase==='settled')d.finished=true;
  return true;
 }
 function openSessions(d){for(const [w,l] of Object.entries(d.aftermath.picks))d.aftermath.sessions[w]={loser:l,until:now()+DRESSING_TTL,done:false};}
 function pick(c,state,input){
  const d=requireDuel(state,['aftermath']),rows=roster(d,c,state),a=d.aftermath;
  if(a.order[a.current]!==c.id)fail('It is not your turn to pick.');
  const loser=String(input.loser??'');if(!a.losers.includes(loser)||Object.values(a.picks).includes(loser))fail('Pick an opponent nobody has claimed yet.');
  a.picks[c.id]=loser;a.current++;message(d,c.name+' picks '+memberOf(d,loser).name+'.');
  if(a.current>=a.order.length||Object.keys(a.picks).length>=a.losers.length){for(let i=a.current;i<a.order.length;i++)if(!a.picks[a.order[i]])message(d,memberOf(d,a.order[i]).name+' has nobody left to pick.');openSessions(d);}
  persist(d,rows,c);
 }
 function session(d,c){const s=d.aftermath?.sessions?.[c.id];if(!s||s.done)fail('You have no one to dress right now.');if(now()>s.until)fail('Your dressing time is over.');return s;}
 function transfer(c,state,input,rows,d,predicate,flag,verb){
  const s=session(d,c),loserRow=rows.find(v=>v.m.id===s.loser);
  const source=input.source==='theirs'?loserRow.s.loadout.inventory:state.loadout.inventory;
  const i=Math.floor(num(input.index,-1));if(i<0||i>=source.length)fail('Choose an item.');
  const item=source[i];if(!predicate(item))fail('That item cannot be used for this.');
  if(item.quest_item)fail('Key items stay where they are.');
  source.splice(i,1);
  const unit={...item,[flag]:true};if(num(item.quantity)>1){unit.quantity=1;const rest={...item,quantity:item.quantity-1};addToInventory(source,rest);} // One unit at a time from a stack.
  if(unit.online_item&&input.source!=='theirs')origins?.transfer(unit.online_item,c.id,loserRow.c.id); // A winner's own piece changes hands with its right.
  loserRow.s.loadout.inventory.push(unit);
  message(d,c.name+' '+verb+' '+loserRow.m.name+' '+(item.name??item.item_id)+'.');
  const victimGod=loserRow.s.faith?.god;
  if(flag==='forced_wear'&&state.faith?.god==='orin'&&victimGod&&victimGod!=='orin'&&wouldBreakUniform(victimGod,loserRow.s.loadout,unit,withGenerated(hubData.equipment))){ // Orin's followers delight in forcing the pious into anathema.
   const gain=Math.min(FAITH_SETTINGS.orin_anathema_piety,FAITH_SETTINGS.piety_max-state.faith.piety);state.faith.piety+=gain;if(state.loadout)state.loadout.faith=combatFaith(state);
   message(d,c.name+' forces '+loserRow.m.name+' out of '+GODS[victimGod].name+"'s uniform. Orin laughs. (Piety +"+gain+')');
  }
 }
 function dress(c,state,input){const d=requireDuel(state,['aftermath']),rows=roster(d,c,state);transfer(c,state,input,rows,d,item=>WEARABLE_CATEGORIES.includes(item.category),'forced_wear','dresses');persist(d,rows,c);}
 function feed(c,state,input){const d=requireDuel(state,['aftermath']),rows=roster(d,c,state);transfer(c,state,input,rows,d,isFood,'forced_drink','feeds');persist(d,rows,c);}
 function finish(c,state){ // A winner ends their dressing session; anyone leaves a settled duel. The last one out closes it.
  const d=requireDuel(state,['aftermath','settled']),rows=roster(d,c,state);
  const s=d.aftermath?.sessions?.[c.id];if(s&&!s.done){s.done=true;message(d,c.name+' is done dressing '+memberOf(d,s.loser).name+'.');}
  const allDone=!d.aftermath||Object.values(d.aftermath.sessions).every(v=>v.done)&&(d.aftermath.current>=d.aftermath.order.length||Object.keys(d.aftermath.picks).length>=d.aftermath.losers.length);
  if(d.phase==='aftermath'&&allDone){d.phase='settled';for(const {s:other} of rows)delete other.duel;d.finished=true;}
  else if(d.phase==='settled'){delete state.duel;if(rows.every(v=>!v.s.duel))d.finished=true;}
  else if(!s)fail('The winners are still dressing their victims.');
  persist(d,rows,c);
 }

 // ── Time ──────────────────────────────────────────────────────────────────────────────────
 function tick(){ // Expire stale proposals, drop disconnected fighters, end overrun dressing sessions.
  for(const row of db.prepare("SELECT state FROM quest_duels WHERE json_extract(state,'$.finished') IS NOT 1").all()){
   const d=JSON.parse(row.state);let changed=false;const rows=roster(d);
   if(['proposed','staking'].includes(d.phase)&&now()-d.created>PROPOSAL_TTL&&!d.sides.some(side=>side.pending>0)){refund(d,rows);close(d,rows,'The duel proposal expired. Stakes were returned.');changed=true;}
   else if(d.phase==='fight'){
    for(const {m,c} of rows)if(m.status==='active'&&(presence(c.id)?.seen??0)<now()-DISCONNECT_TTL){knockOut(d,m,'out',m.name+' lost connection and is out.');changed=true;}
    if(changed||d.sides.some(side=>!side.members.some(alive))){settle(d,rows);if(!d.finished)syncRuns(d,rows);changed=true;}
   }
   else if(d.phase==='aftermath'){const a=d.aftermath;if(a.current<a.order.length&&Object.keys(a.picks).length<a.losers.length&&now()-d.ended>DRESSING_TTL){for(let i=a.current;i<a.order.length;i++){const left=a.losers.find(l=>!Object.values(a.picks).includes(l));if(left)a.picks[a.order[i]]=left;}a.current=a.order.length;openSessions(d);changed=true;}
    for(const s of Object.values(a.sessions))if(!s.done&&now()>s.until){s.done=true;changed=true;}
    if(Object.keys(a.sessions).length&&Object.values(a.sessions).every(s=>s.done)){d.phase='settled';for(const {s} of rows)delete s.duel;d.finished=true;message(d,'The dressing is over.');changed=true;}
   }
   if(changed)persist(d,rows);
  }
 }

 // ── Views ─────────────────────────────────────────────────────────────────────────────────
 function snapshot(c,state){
  const d=fetch(state?.duel);if(!d)return null;const index=sideOf(d,c.id);
  const card=m=>({id:m.id,name:m.name,status:m.status,row:m.row??'front',ready:m.ready===true,damage:m.damage??0,hp:m.hp??null,maxHp:m.maxHp??null,readyAt:m.readyAt??null,duration:m.duration??null,connected:!!presence(m.id)});
  return {id:d.id,phase:d.phase,mode:d.mode,by:d.by,mine:index,events:d.events.slice(-12),winner:d.winner,
   sides:d.sides.map(side=>({leader:side.leader,ready:side.ready,pending:side.pending>0,members:side.members.map(card),stakes:{coins:side.stakes.coins,items:side.stakes.items.map(e=>({name:e.item.name??e.item.item_id,by:e.by,quantity:num(e.item.quantity,1)})),drinks:side.stakes.drinks.map(e=>({name:e.item.name??e.item.item_id,by:e.by,quantity:num(e.item.quantity,1)}))}})),
   aftermath:d.aftermath?{order:d.aftermath.order,losers:d.aftermath.losers,picks:d.aftermath.picks,current:d.aftermath.current,picker:d.aftermath.order[d.aftermath.current]??null,sessions:Object.fromEntries(Object.entries(d.aftermath.sessions).map(([w,s])=>[w,{loser:s.loser,until:s.until,done:s.done}])),
    ...(()=>{const s=d.aftermath.sessions[c.id];if(!s||s.done)return {victimBag:null,victimWorn:null,victimName:null};const vs=JSON.parse(character(s.loser).state),pi=vs.loadout?.player_info??{}; // The dresser's inventory modal lists the victim's bag under THEIR BAG and their worn slots in the left column.
     return {victimName:memberOf(d,s.loser)?.name??'',victimBag:(vs.loadout?.inventory??[]).map((item,index)=>({...item,index,victim_index:index})),victimWorn:Object.fromEntries(Object.keys(pi).filter(k=>k.startsWith('equipped_')&&typeof pi[k]==='string'&&pi[k]).map(k=>[k,{item_id:pi[k],name:pi.equipped_item_data?.[k.slice(9)]?.name??pi[k]}]))};})()}:null,
   serverTime:now()};
 }
 function encounterSnapshot(c,state){ // Shaped like a shared Dive encounter so the client's battle cards, target picker and gauges work unchanged: my side are `players`, theirs are `enemies`.
  const d=fetch(state?.duel);if(!d||d.phase!=='fight')return null;const index=sideOf(d,c.id);
  const card=m=>({id:m.id,name:m.name,hp:m.hp??0,maxHp:m.maxHp??1,status:m.status,row:m.row??'front',readyAt:m.readyAt,duration:m.duration,cycle:m.cycle,prepared:m.prepared,connected:!!presence(m.id),player:true,avatar:JSON.parse(character(m.id).state).avatar??'player'}); // avatar: the client draws opponents with their overworld sprite.
  return {id:d.id,duel:true,sequence:d.sequence,events:d.events,players:d.sides[index].members.map(card),enemies:d.sides[1-index].members.map(card)};
 }
 function act(i,c,state,input,p){
  const a=input.action;
  if(a==='duel_challenge')return challenge(c,state,input,p);
  if(a==='duel_accept')return accept(c,state);if(a==='duel_decline')return decline(c,state);if(a==='duel_cancel')return cancel(c,state);
  if(a==='duel_stake')return stake(c,state,input);if(a==='duel_unstake')return unstake(c,state);if(a==='duel_ready')return ready(c,state);
  if(a==='duel_pick')return pick(c,state,input);if(a==='duel_dress')return dress(c,state,input);if(a==='duel_feed')return feed(c,state,input);if(a==='duel_finish')return finish(c,state);
  if(DUEL_FIGHT_ACTIONS.includes(a))return fight(c,state,input);
  fail('Unknown duel action.');
 }
 return {act,fund,tick,snapshot,encounterSnapshot,fetch};
}
