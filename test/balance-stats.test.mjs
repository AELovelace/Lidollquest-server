import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createQuestService} from '../server/service.mjs';
import {createBalanceStats,attachBalanceStats,bindBalance,logBalance,logCommit,clientBalanceEvents} from '../server/balance-stats.mjs';

const staffToken='s'.repeat(43),staff='a'.repeat(64);
const playerToken='p'.repeat(43),owner='o'.repeat(64);
const info=(extra={})=>({playerHealth:50,playerHealthMax:50,level:2,str:10,def:10,dex:10,int:10,wet:10,tum:5,hunger:100,thirst:100,shame:1024,...extra});

test('events are written only when the game transaction commits',()=>{
 let now=5000;const game=new DatabaseSync(':memory:'),stats=attachBalanceStats(game,createBalanceStats({now:()=>now}));
 const c={owner,id:'char-1',name:'Tester'},state=bindBalance(game,{loadout:{player_info:info()}},c);
 game.exec('BEGIN IMMEDIATE');logBalance('chest',state,{value:1});game.exec('ROLLBACK');
 assert.equal(stats.query().events.length,0,'a rolled-back command logs nothing');
 game.exec('BEGIN IMMEDIATE');logBalance('chest',state,{value:1,chest:'c1'});assert.equal(stats.query().events.length,0,'nothing is visible before the commit');game.exec('COMMIT');
 const [row]=stats.query().events;
 assert.equal(row.kind,'chest');assert.equal(row.character_id,'char-1');assert.equal(row.level,2);assert.equal(row.wet,10);assert.equal(row.data.chest,'c1');assert.equal(row.staff,0);
 logBalance('chest',{loadout:{player_info:info()}},{value:1}); // An unbound state (a hired companion, a test world) is skipped.
 stats.flush();assert.equal(stats.query().events.length,1);
 stats.close();game.close();
});

test('a command diff yields turns, accidents, meals and level-ups with turns-since tracking',()=>{
 const game=new DatabaseSync(':memory:'),stats=attachBalanceStats(game,createBalanceStats({now:()=>1000})),c={owner,id:'char-2',name:'Needs'};
 const step=(before,after,action,extra={})=>{logCommit(game,{c,before:{loadout:{player_info:before}},state:{loadout:{player_info:after}},action,...extra});stats.flush();return after;};
 let p=info();
 p=step(p,info({wet:22,tum:8,hunger:96,thirst:94}),'walk',{walked:4});
 p=step(p,info({wet:22,tum:8,hunger:126,thirst:94}),'use_item'); // The first meal has nothing to measure from.
 p=step(p,info({wet:30,tum:10,hunger:124,thirst:92}),'walk',{walked:6});
 p=step(p,info({wet:30,tum:10,hunger:150,thirst:92}),'use_item');
 p=step(p,info({wet:0,tum:10,hunger:150,thirst:92,had_wet_accident:1,online_accident_seq:1}),'world_turn',{fired:['online_accident_seq']});
 p=step(p,info({wet:0,tum:0,hunger:150,thirst:92,had_wet_accident:1,online_accident_seq:2,diaper_tum_absorbed:1,level:3}),'world_turn',{fired:['online_accident_seq']});
 step(info(),info({wet:99,hunger:250}),'enter'); // An imported campaign save is not play: no turn, meal or accident.
 const events=stats.query({limit:100}).events.reverse(),of=kind=>events.filter(e=>e.kind===kind);
 assert.deepEqual(of('turn').map(e=>[e.value,e.data.d_wet,e.turn]),[[4,12,4],[6,8,10],[1,-30,11],[1,0,12]]);
 assert.deepEqual(of('eat').map(e=>[e.value,e.data.turns_since]),[[30,null],[26,6]]);
 assert.deepEqual(of('accident').map(e=>[e.data.type,e.data.where]),[['wet','clothes'],['mess','diaper']]);
 assert.deepEqual(of('level_up').map(e=>[e.data.from,e.data.to]),[[2,3]]);
 const summary=stats.summary({}),tile=label=>summary.tiles.find(t=>t.label===label).value;
 assert.equal(tile('Turns played'),12);assert.equal(tile('Accidents'),2);assert.equal(tile('Messes'),1);assert.equal(tile('Avg turns between meals'),6);
 assert.equal(tile('Bladder fill / turn'),Math.round(20/12*100)/100,'only gains count: the accident reset is not negative fill');
 assert.ok(summary.charts.every(chart=>chart.plot.every(name=>chart.columns.includes(name))));
 assert.equal(stats.query({kinds:['eat']}).events.length,2);assert.equal(stats.query({character:'someone-else'}).events.length,0);
 stats.close();game.close();
});

test('client roll details are sanitized, never trusted',()=>{
 assert.deepEqual(clientBalanceEvents('nope'),[]);
 const events=clientBalanceEvents([{kind:'hold',attempt:2,fail_pct:75,ok:true,meter:'wet','bad key':1,nested:{a:1},huge:1e99},{kind:'drop_tables'},null,...Array(40).fill({kind:'eat',item:'x'.repeat(200)})]);
 assert.equal(events.length,30,'unknown kinds are dropped and only the first 32 inputs are read');
 assert.deepEqual(events[0],{kind:'client_hold',data:{attempt:2,fail_pct:75,ok:1,meter:'wet',huge:1000000}});
 assert.equal(events[1].data.item.length,48);
});

function harness(){
 let now=1000000;
 const accounts={[staffToken]:{owner:staff,gamemaster:true},[playerToken]:{owner,gamemaster:false}};
 const walletClient={async authenticate(secret){const account=accounts[secret];if(!account)throw Object.assign(Error('No account'),{status:401});return {owner:account.owner,id:'grant-'+account.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:account.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({now:()=>now,walletClient});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve)),base=()=>'http://127.0.0.1:'+service.server.address().port,characters={};
 async function play(secret,action,extra={}){
  now+=500;const held=characters[secret];
  const response=await fetch(base()+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({action,character_id:held?.id,revision:held?.revision,request_id:randomUUID(),controller:'window',...extra})});
  const result=await response.json();if(result.character)characters[secret]=result.character;return {status:response.status,result};
 }
 async function ok(secret,action,extra={}){const r=await play(secret,action,extra);assert.equal(r.status,200,JSON.stringify(r.result).slice(0,400));return r.result;}
 const gm=async(path,token=staffToken)=>{const response=await fetch(base()+path,{headers:token?{Authorization:'Bearer '+token}:{}});return {status:response.status,type:response.headers.get('content-type'),body:await (response.headers.get('content-type')?.includes('json')?response.json():response.text())};};
 return {service,started,play,ok,gm,characters,close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('online play is logged, staff are flagged and only gamemasters can read the statistics',async()=>{
 const h=harness();await h.started;try{
  const loadout=extra=>({player_info:info(extra),inventory:[]});
  for(const token of [playerToken,staffToken]){await h.ok(token,'create',{name:token===staffToken?'Warden':'Player'});await h.ok(token,'enter',{zone:'honeydew-lantern',loadout:loadout()});}
  assert.equal(h.service.balance.query({staff:true}).events.length,0,'creating and importing a character is not play');
  await h.ok(playerToken,'loadout',{loadout:loadout({wet:0,hunger:130,had_wet_accident:1,online_accident_seq:1}),balance_events:[{kind:'hold',meter:'wet',attempt:1,fail_pct:50,ok:false},{kind:'nonsense'}]});
  await h.ok(staffToken,'loadout',{loadout:loadout({hunger:140})});
  const stale=await h.play(playerToken,'loadout',{revision:0,loadout:loadout({hunger:250})});assert.equal(stale.status,409);
  const mine=h.service.balance.query({}).events,kinds=mine.map(e=>e.kind).sort();
  assert.deepEqual(kinds,['accident','client_hold','eat'],'the rejected command and the staff account add nothing here');
  assert.ok(mine.every(e=>e.staff===0&&e.owner===owner&&e.name==='Player'&&e.zone==='honeydew-lantern'));
  assert.equal(mine.find(e=>e.kind==='client_hold').data.fail_pct,50);
  const everyone=h.service.balance.query({staff:true}).events;
  assert.equal(everyone.filter(e=>e.staff===1).length,1);assert.equal(everyone.find(e=>e.staff===1).kind,'eat');

  const page=await h.gm('/gm/balance',null);assert.equal(page.status,200);assert.match(page.type,/text\/html/);assert.match(page.body,/Balance Metrics/);assert.doesNotMatch(page.body,/\/\* BALANCE \*\//);
  for(const path of ['/gm/balance/summary','/gm/balance/events','/gm/balance/filters']){
   assert.equal((await h.gm(path,null)).status,401);assert.equal((await h.gm(path,playerToken)).status,403);
  }
  const summary=(await h.gm('/gm/balance/summary?interval=week')).body;
  assert.equal(summary.tiles.find(t=>t.label==='Accidents').value,1);assert.equal(summary.tiles.find(t=>t.label==='Players').value,1);
  assert.equal((await h.gm('/gm/balance/summary?staff=1')).body.tiles.find(t=>t.label==='Players').value,2);
  const events=(await h.gm('/gm/balance/events?kind=eat,accident&limit=1')).body;
  assert.equal(events.events.length,1);assert.ok(events.nextBefore);
  assert.equal((await h.gm('/gm/balance/events?kind=eat,accident&limit=1&before='+events.nextBefore)).body.events.length,1);
  const lists=(await h.gm('/gm/balance/filters')).body;
  assert.ok(lists.kinds.includes('accident'));assert.ok(lists.characters.some(c=>c.name==='Player'));
 }finally{await h.close();}
});

test('an arena fight logs its start, every hit, the result and the level-up',async()=>{
 const {createQuestZones,questZones}=await import('../server/zones.mjs'),{importLoadout}=await import('../server/loadout.mjs'),{playerSpells}=await import('../server/combat.mjs');
 const db=new DatabaseSync(':memory:'),stats=attachBalanceStats(db,createBalanceStats({now:()=>1}));let time=100000,c;
 const api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{}});
 const act=(action,extra={})=>{time+=500;c=api.act('token',{action,request_id:randomUUID(),controller:'window',character_id:c?.id,revision:c?.revision,...extra}).character;};
 try{
  const hero=importLoadout({player_info:{class_id:'mage',playerHealth:80,playerHealthMax:140,str:9,def:4,dex:6,int:8,cha:2,level:7,xp:348,shame:512,wet:70,tum:60,stamina:10,stamina_max:100},inventory:[],player_spells:playerSpells,player_mp:200,player_mp_max:200,childish:5});
  act('create',{name:'Hero'});act('enter',{zone:questZones[0].id,loadout:hero,combat_version:2});act('start',{combat_version:2});
  act('turn_ready',{loadout:c.loadout,forfeit:false});act('cast',{spell:'fireball'});
  const events=stats.query({limit:100}).events.reverse(),kinds=events.map(e=>e.kind),one=kind=>events.find(e=>e.kind===kind);
  for(const kind of ['encounter_start','turn','player_hit','encounter_end','level_up'])assert.ok(kinds.includes(kind),kind+' in '+kinds.join(','));
  assert.equal(one('encounter_start').data.enemy_level,7);assert.ok(one('encounter_start').data.enemy_hp>0);assert.equal(one('encounter_start').hp_max,140);
  assert.equal(one('player_hit').data.spell,'fireball');assert.ok(one('player_hit').value>0);assert.equal(one('player_hit').data.encounter,one('encounter_start').data.encounter);
  assert.equal(one('encounter_end').data.outcome,'win');assert.equal(one('encounter_end').data.turns,1);assert.equal(one('level_up').data.to,8);
  assert.equal(stats.summary({}).tiles.find(t=>t.label==='Win rate %').value,100);
  const before=events.length;assert.throws(()=>act('cast',{spell:'fireball'}));assert.equal(stats.query({limit:100}).events.length,before,'a rejected action logs nothing');
 }finally{api.close?.();stats.close();db.close();}
});
