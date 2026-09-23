import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

function fixture(){ // Players standing in one hub room, exactly as the client drives the gateway.
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-23T12:00:00Z');const ids={},awards=[];
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,grant:secret=>({id:secret,owner:secret,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:(owner,asset,n,id,reason)=>awards.push({owner,n,reason}),diveOptions:{log:()=>{}}});
 const loadout=(hp,str,extra={})=>({player_info:{class_id:'fighter',playerHealth:hp,playerHealthMax:hp,str,def:2,dex:8,int:5,cha:5,level:10,xp:0,stat_points:0},inventory:extra.inventory??[],player_spells:['heal_light'],player_mp:20,player_mp_max:20});
 const snap=name=>zones.read(name,ids[name]);
 function command(name,action,extra={}){const s=snap(name);return {action,request_id:randomUUID(),controller:'window',character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...(s.encounter?{battle:s.encounter.id,cycle:s.character.run.cycle}:{}),...extra};}
 function act(name,action,extra={}){time+=100;return zones.act(name,command(name,action,extra));}
 function player(name,hp=100,str=10,extra={}){const s=zones.act(name,{action:'create',name,controller:'window',request_id:randomUUID()});ids[name]=s.character.id;const r=act(name,'enter',{zone:'princess-rose',combat_version:3,loadout:loadout(hp,str,extra)});db.prepare('UPDATE quest_presence SET x=5,y=5 WHERE character_id=?').run(ids[name]);return r;}
 function join(leader,name){act(leader,'party_invite',{member:ids[name]});return act(name,'party_accept',{invitation:snap(name).partyInvitations[0].id});}
 function settleCoins(name,paid=true){const id=snap(name).character.pendingPurchase;assert.ok(id,'a wager debit is pending');zones.completePurchase(id,paid);}
 function fightUntil(attacker,target,max=12){for(let n=0;n<max;n++){let s=snap(attacker);if(!s.encounter||!s.character.run)return s;time=Math.max(time,Number(s.character.run.readyAt)||time)+1;if(!s.character.run.turnReady)act(attacker,'turn_ready',{patch:[],forfeit:false});s=snap(attacker);if(!s.encounter)return s;act(attacker,'attack',{target:ids[target]});}return snap(attacker);}
 function dive(name,zone){act(name,'dive_enter',{zone});const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]).state);s.dive.position={x:3,y:3};s.dive.safeUntil=time+600000;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),ids[name]);db.prepare('UPDATE quest_presence SET x=3,y=3,seen=? WHERE character_id=?').run(time,ids[name]);} // Stand both on the same tile of the route's floor.
 return {db,ids,awards,snap,act,player,join,dive,settleCoins,fightUntil,advance:ms=>{time+=ms;zones.tick();},zones,close:()=>db.close()};
}

test('wager duel: challenge, accept, coin escrow, item and drink stakes, live fight, payout, forced drinks',()=>{
 const f=fixture();try{
  f.player('alice',100,100,{inventory:[{item_id:'iron_dagger',category:'weapon',name:'Iron Dagger'}]});
  f.player('bob',60,10,{inventory:[{item_id:'sippy_juice',category:'food',is_drink:true,name:'Sippy Juice',quantity:2},{item_id:'plush_hammer',category:'weapon',name:'Plush Hammer'}]});
  assert.equal(f.snap('alice').duelSupport,true);
  f.act('alice','duel_challenge',{target:f.ids.bob,mode:'wager'});
  let view=f.snap('bob').duel;assert.equal(view.phase,'proposed');assert.equal(view.mine,1);assert.equal(view.by,f.ids.alice);assert.equal(view.sides[0].members[0].name,'alice');
  assert.throws(()=>f.act('alice','duel_accept'),/challenged leader/);
  assert.throws(()=>f.act('alice','duel_challenge',{target:f.ids.bob}),/already have a duel/);
  f.act('bob','duel_accept');assert.equal(f.snap('alice').duel.phase,'staking');
  f.act('alice','duel_stake',{kind:'coins',amount:50});assert.equal(f.snap('alice').duel.sides[0].pending,true);
  assert.throws(()=>f.act('alice','duel_ready'),/still settling/);
  f.settleCoins('alice');assert.equal(f.snap('alice').duel.sides[0].stakes.coins,50);assert.equal(f.snap('alice').character.pendingPurchase,undefined);
  f.act('alice','duel_stake',{kind:'item',index:0});assert.equal(f.snap('alice').character.loadout.inventory.length,0);assert.equal(f.snap('bob').duel.sides[0].stakes.items[0].name,'Iron Dagger');
  assert.throws(()=>f.act('bob','duel_stake',{kind:'item',index:0}),/Pool drinks as drinks/);
  f.act('bob','duel_stake',{kind:'drink',index:0});assert.equal(f.snap('bob').duel.sides[1].stakes.drinks[0].quantity,2);
  f.act('bob','duel_unstake');assert.equal(f.snap('bob').character.loadout.inventory.length,2,'items and drinks come back before ready');
  f.act('bob','duel_stake',{kind:'drink',index:f.snap('bob').character.loadout.inventory.findIndex(i=>i.item_id==='sippy_juice')});
  f.act('alice','duel_ready');assert.equal(f.snap('bob').duel.sides[0].ready,true);assert.equal(f.snap('bob').duel.phase,'staking');
  f.act('bob','duel_ready');
  const started=f.snap('alice');assert.equal(started.duel.phase,'fight');assert.equal(started.character.run.kind,'duel');assert.equal(started.encounter.duel,true);
  assert.deepEqual(started.encounter.players.map(p=>p.name),['alice']);assert.deepEqual(started.encounter.enemies.map(p=>p.name),['bob']);assert.equal(started.character.run.enemy.name,'bob');
  assert.throws(()=>f.act('alice','row'),/alone you always fight in front/);
  assert.throws(()=>f.act('alice','charm'),/Charms do not work/);
  f.db.prepare("UPDATE quest_characters SET state=json_set(state,'$.loadout.player_info.class_id','diplomat') WHERE id=?").run(f.ids.alice); // A diplomat fights like anyone else in a duel.
  assert.throws(()=>f.act('alice','allure'),/Charms do not work/);
  const done=f.fightUntil('alice','bob');
  assert.equal(done.encounter,null);assert.ok(done.character.lastResult.log.some(t=>/alice: You slap bob/.test(t)),'the diplomat slapped instead of being told to use Allure');assert.equal(done.character.run,null);assert.equal(done.character.lastResult.outcome,'win');assert.equal(done.character.lastResult.duel.winner,0);
  assert.equal(done.character.duel,undefined,'a settled wager duel lets go of both players');
  assert.deepEqual(f.awards.map(a=>[a.owner,a.n]),[['alice',50]],'the winner takes the escrowed pot');
  assert.equal(done.character.loadout.inventory.some(i=>i.item_id==='iron_dagger'),true,'staked items go to the top damage dealer');
  const bob=f.snap('bob');assert.equal(bob.character.lastResult.outcome,'defeat');assert.equal(bob.character.loadout.player_info.playerHealth,15,'losing hurts like a defeat');
  const drink=bob.character.loadout.inventory.find(i=>i.item_id==='sippy_juice');assert.equal(drink.forced_drink,true,'the loser has to drink the pool');assert.equal(drink.quantity,2);
 }finally{f.close();}
});

test('cancel and decline return every stake; an expired proposal returns them too',()=>{
 const f=fixture();try{
  f.player('alice',100,10,{inventory:[{item_id:'iron_dagger',category:'weapon',name:'Iron Dagger'}]});f.player('bob',100,10);
  f.act('alice','duel_challenge',{target:f.ids.bob});f.act('bob','duel_decline');
  assert.equal(f.snap('alice').duel,null);assert.equal(f.snap('bob').character.duel,undefined);
  f.act('alice','duel_challenge',{target:f.ids.bob});f.act('bob','duel_accept');
  f.act('alice','duel_stake',{kind:'coins',amount:20});f.settleCoins('alice');f.act('alice','duel_stake',{kind:'item',index:0});
  f.act('bob','duel_cancel');
  assert.equal(f.snap('alice').character.loadout.inventory[0].item_id,'iron_dagger');assert.deepEqual(f.awards.map(a=>[a.owner,a.n,a.reason]),[['alice',20,'Duel stake returned']]);
  f.act('alice','duel_challenge',{target:f.ids.bob});f.advance(11*60000);assert.equal(f.snap('alice').duel,null,'stale proposals expire');for(const n of ['alice','bob']){f.act(n,'enter',{zone:'princess-rose',combat_version:3});f.db.prepare('UPDATE quest_presence SET x=5,y=5 WHERE character_id=?').run(f.ids[n]);} // Eleven minutes also expired both presence leases.
  f.act('alice','duel_challenge',{target:f.ids.bob});f.act('bob','duel_accept');f.act('bob','duel_stake',{kind:'coins',amount:30});f.settleCoins('bob',false);
  assert.equal(f.snap('bob').duel.sides[1].stakes.coins,0,'a declined debit stakes nothing');assert.match(f.snap('bob').character.hubNotice,/Not enough/);
 }finally{f.close();}
});

test('roleplay battle: get-ready posts gate the fight, then the winner picks, dresses and feeds the loser',()=>{
 const f=fixture();try{
  f.player('alice',100,100,{inventory:[{item_id:'frilly_dress',category:'dress',name:'Frilly Dress'}]});
  f.player('bob',60,10,{inventory:[{item_id:'baby_food',category:'food',name:'Baby Food'},{item_id:'onesie',category:'torso',name:'Onesie'}]});
  f.act('alice','duel_challenge',{target:f.ids.bob,mode:'rp'});f.act('bob','duel_accept');
  assert.throws(()=>f.act('alice','duel_ready'),/get-ready RP/);
  f.act('alice','rp_post',{text:'Alice cracks her knuckles and grins.',partners:[f.ids.bob]});f.act('alice','duel_ready');
  assert.throws(()=>f.act('bob','duel_ready'),/get-ready RP/);
  f.act('bob','rp_post',{text:'Bob gulps and squares up.',partners:[f.ids.alice]});f.act('bob','duel_ready');
  assert.equal(f.snap('alice').duel.phase,'fight');
  const won=f.fightUntil('alice','bob');
  assert.equal(won.duel.phase,'aftermath');assert.equal(won.character.duel,won.duel.id,'RP duels keep everyone attached until the dressing is done');
  assert.deepEqual(won.duel.aftermath.picks,{[f.ids.alice]:f.ids.bob},'one winner, one loser: picked automatically');
  assert.ok(Array.isArray(won.duel.aftermath.victimBag)&&won.duel.aftermath.victimBag.some(i=>i.name==='Baby Food'),'the winner sees the victim\'s bag');
  assert.throws(()=>f.act('bob','duel_finish'),/still dressing/);
  f.act('alice','duel_dress',{source:'mine',index:0});
  assert.throws(()=>f.act('alice','duel_dress',{source:'theirs',index:0}),/cannot be used/);
  f.act('alice','duel_feed',{source:'theirs',index:0});
  const bob=f.snap('bob').character.loadout.inventory;
  assert.equal(bob.find(i=>i.item_id==='frilly_dress').forced_wear,true);assert.equal(bob.find(i=>i.item_id==='baby_food').forced_drink,true);
  assert.equal(f.snap('alice').character.loadout.inventory.length,0);
  f.act('alice','duel_finish');
  assert.equal(f.snap('alice').duel,null);assert.equal(f.snap('bob').duel,null);assert.equal(f.snap('bob').character.lastResult.outcome,'defeat');
 }finally{f.close();}
});

test('party versus party: leaders challenge, everyone fights, rows work, coins split among the winners in damage order',()=>{
 const f=fixture();try{
  f.player('alice',100,60);f.player('bob',100,60);f.player('cara',300,10);
  f.join('alice','bob');
  assert.throws(()=>f.act('bob','duel_challenge',{target:f.ids.cara}),/party leader/);
  f.act('alice','duel_challenge',{target:f.ids.cara});
  const view=f.snap('cara').duel;assert.deepEqual(view.sides[0].members.map(m=>m.name),['alice','bob']);assert.equal(view.sides[1].leader,f.ids.cara);
  f.act('cara','duel_accept');f.act('cara','duel_stake',{kind:'coins',amount:31});f.settleCoins('cara');
  f.act('alice','duel_ready');f.act('cara','duel_ready');
  assert.equal(f.snap('bob').duel.phase,'fight');
  f.act('bob','row');assert.equal(f.snap('bob').character.run.row,'back');assert.equal(f.snap('alice').encounter.players.find(p=>p.name==='bob').row,'back');
  f.fightUntil('alice','cara',3);f.fightUntil('bob','cara',3);
  const end=f.fightUntil('alice','cara');
  if(end.encounter)f.fightUntil('bob','cara');
  const alice=f.snap('alice'),bob=f.snap('bob');
  assert.equal(alice.character.lastResult.outcome,'win');assert.equal(bob.character.lastResult.outcome,'win');
  const split=f.awards.filter(a=>a.reason==='Duel winnings').map(a=>a.n).sort();assert.deepEqual(split,[15,16],'31 coins split, the odd coin to the higher damage');
  assert.equal(f.snap('cara').character.lastResult.outcome,'defeat');
 }finally{f.close();}
});

test('duels happen in hubs and the open overworld but never inside a dungeon Dive',()=>{
 const f=fixture();try{
  f.player('alice',100,100);f.player('bob',60,10);
  f.dive('alice','dive-tundra');f.dive('bob','dive-tundra');
  assert.equal(f.snap('alice').duelAllowed,true,'the Tundra is a story overworld');
  f.act('alice','duel_challenge',{target:f.ids.bob});f.act('bob','duel_accept');f.act('alice','duel_ready');f.act('bob','duel_ready');
  assert.equal(f.snap('bob').character.run.kind,'duel');
  const done=f.fightUntil('alice','bob');assert.equal(done.character.lastResult.outcome,'win');assert.equal(f.snap('bob').character.lastResult.outcome,'defeat');
  assert.equal(f.snap('alice').character.dive.zone,'dive-tundra','everyone stays on the floor afterwards');
  for(const n of ['alice','bob']){f.act(n,'dive_exit');f.act(n,'enter',{zone:'princess-rose',combat_version:3});f.db.prepare('UPDATE quest_presence SET x=5,y=5 WHERE character_id=?').run(f.ids[n]);}
  f.dive('alice','dive-quarters');f.dive('bob','dive-quarters');
  assert.equal(f.snap('alice').duelAllowed,false,'the Quarters are a dungeon Dive');
  assert.throws(()=>f.act('alice','duel_challenge',{target:f.ids.bob}),/not inside a dungeon Dive/);
 }finally{f.close();}
});
