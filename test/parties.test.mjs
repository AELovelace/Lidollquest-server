import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {diveData} from '../server/dive.mjs';
import {generateFloor,seeded,pathTo} from '../server/dive-generation.mjs';
import {selectReinforcements,selectEncounterEnemies,actionDelay,applyCombatPatch} from '../server/dive-encounters.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),zones;const ids={},awards=[];
 const setup=()=>zones=createQuestZones(db,{now:()=>time,roll:()=>0,grant:secret=>({id:secret,owner:secret,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:(owner,asset,n)=>awards.push({owner,n}),diveOptions:{log:()=>{}}});setup();
 const loadout=(klass='fighter')=>({player_info:{class_id:klass,playerHealth:500,playerHealthMax:500,str:100,def:8,dex:8,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:['fireball','heal'],player_mp:100,player_mp_max:100});
 const snap=name=>zones.read(name,ids[name]);
 function command(name,action,extra={}){const s=snap(name);return {action,request_id:randomUUID(),controller:'window',character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...(s.encounter?{battle:s.encounter.id,cycle:s.character.run.cycle}:{}),...extra};}
 function act(name,action,extra={}){time++;return zones.act(name,command(name,action,extra));}
 function player(name,klass='fighter',hub='princess-rose'){const s=zones.act(name,{action:'create',name,controller:'window',request_id:randomUUID()});ids[name]=s.character.id;return act(name,'enter',{zone:hub,combat_version:3,loadout:loadout(klass)});}
 function join(name){act('alice','party_invite',{member:ids[name]});return act(name,'party_accept',{invitation:snap(name).partyInvitations[0].id});}
 function place(name,x,y){const id=ids[name],s=snap(name).character;delete s.id;delete s.name;delete s.revision;if(s.dive){s.dive.position={x,y};s.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),id);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(x,y,time,id);}
 function engage(name='alice',encounter='iris'){const s=snap(name),foe=s.dive.enemies.find(e=>e.id===encounter),f=s.zones.find(z=>z.id===s.zone),path=pathTo(f,f.entrance,foe),p=path.at(-2);place(name,p.x,p.y);return act(name,'dive_engage',{encounter:foe.id});}
 function advance(ms){time+=ms;zones.tick();}
 function win(name='alice'){for(let n=0;n<12;n++){let s=snap(name);if(!s.encounter)return s;advance(Math.max(0,s.character.run.readyAt-time));s=act(name,'turn_ready',{patch:[],forfeit:false});if(!s.encounter)return s;s=act(name,s.character.loadout.player_info.class_id==='diplomat'?'allure':'attack',{target:s.encounter.enemies.find(e=>e.hp>0).id});if(!s.encounter)return s;}throw Error('Fight did not finish');}
 return {db,ids,awards,loadout,player,join,snap,act,command,place,engage,advance,win,raw:(name,input)=>zones.act(name,input),restart:setup,close:()=>db.close()};
}

test('one party member finishing defeat cannot move or re-engage another reader',()=>{
 const f=fixture();try{
  for(const name of ['alice','bob']){f.player(name);f.act(name,'enter',{zone:'princess-rose',combat_version:3,defeat_version:1});}
  f.join('bob');f.act('alice','dive_enter',{zone:'dive-quarters'});f.engage();
  const bob=f.snap('bob').position;
  f.act('alice','submit');f.act('bob','submit');
  const pending=f.snap('alice').character.pendingDefeat;
  assert.deepEqual(f.act('alice','defeat_complete',{scene:pending.id}).position,pending.position);
  assert.deepEqual(f.snap('bob').position,bob);assert.ok(f.snap('bob').character.pendingDefeat);
  assert.throws(()=>f.act('alice','dive_exit'),/bob must finish/);
  assert.throws(()=>f.engage(),/bob must finish their defeat scene/);
  assert.equal(f.snap('alice').character.run,null);
  const visit=f.snap('alice').character.dive;
  const record=f.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(visit.route,visit.edition),floor=JSON.parse(record.content);
  const roaming=floor.enemies.find(e=>e.id!=='iris'),position={x:roaming.x,y:roaming.y};
  f.place('alice',position.x,position.y);
  const aliceState=JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.ids.alice).state);
  aliceState.dive.safeUntil=0;f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(aliceState),f.ids.alice);
  function approach(){ // Put a live roaming enemy on the ready member's tile; only the unread scene should prevent group aggro.
   const current=JSON.parse(f.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(visit.route,visit.edition).content);
   for(const enemy of current.enemies)enemy.roaming=false;
   Object.assign(current.enemies.find(e=>e.id===roaming.id),position,{roaming:true,respawnAt:0});
   f.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=?').run(JSON.stringify(current),visit.route,visit.edition);
  }
  approach();f.advance(11000);
  assert.equal(f.snap('alice').character.run,null,'roaming contact cannot pull the party into combat during the scene');
  assert.equal(f.snap('bob').character.run,null);
  const bobPending=f.snap('bob').character.pendingDefeat;
  assert.deepEqual(f.act('bob','defeat_complete',{scene:bobPending.id}).position,bobPending.position);
  assert.equal(f.snap('alice').party.members.length,2);
  approach();f.advance(1001);
  const next=f.snap('alice');assert.ok(next.encounter,'the same roaming contact works after the final acknowledgement');
  assert.deepEqual(new Set(next.encounter.players.map(p=>p.id)),new Set([f.ids.alice,f.ids.bob]));
  assert.equal(f.snap('bob').character.run.sharedEncounter,next.encounter.id,'the reader rejoins only after finishing');
 }finally{f.close();}
});

test('party defeat holds each reader through restart and weekly reset until their own acknowledgement',()=>{
 const f=fixture();try{
  for(const name of ['alice','bob']){f.player(name);f.act(name,'enter',{zone:'princess-rose',combat_version:3,defeat_version:1});}
  f.join('bob');f.act('alice','dive_enter',{zone:'dive-quarters'});f.engage();
  const before=Object.fromEntries(['alice','bob'].map(n=>[n,f.snap(n).position]));
  f.act('alice','submit');f.act('bob','submit');
  for(const name of ['alice','bob']){assert.deepEqual(f.snap(name).position,before[name]);assert.ok(f.snap(name).character.pendingDefeat);}
  assert.throws(()=>f.act('alice','dive_exit'),/defeat dialogue/);
  f.restart();f.advance(7*86400000);
  for(const name of ['alice','bob']){
   const s=f.act(name,'enter',{zone:'dive-quarters',combat_version:3,defeat_version:1});
   assert.deepEqual(s.position,before[name]);assert.equal(s.zone,'dive-quarters');
  }
  const pending=f.snap('alice').character.pendingDefeat;
  const done=f.act('alice','defeat_complete',{scene:pending.id});assert.equal(done.zone,'princess-rose');
  assert.deepEqual(f.snap('bob').position,before.bob);assert.ok(f.snap('bob').character.pendingDefeat);
  assert.equal(f.act('bob','defeat_complete',{scene:f.snap('bob').character.pendingDefeat.id}).zone,'princess-rose');
 }finally{f.close();}
});

test('shared Stand Up needs no enemy target, spends one gauge cycle and retries cannot repeat it',()=>{
 const f=fixture();try{
  f.player('alice');f.player('bob');f.join('bob');
  f.act('alice','loadout',{loadout:{...f.loadout(),world:{crawling:true}}});
  f.act('alice','dive_enter',{zone:'dive-quarters'});f.engage();f.advance(2000);
  f.act('alice','turn_ready',{patch:[],forfeit:false});
  const before=f.snap('alice'),req=f.command('alice','stand'),after=f.raw('alice',req);
  assert.equal(after.character.loadout.world.crawling,false);
  assert.equal(after.character.run.cycle,before.character.run.cycle+1);
  assert.equal(after.character.run.turnReady,false);
  assert.deepEqual(after.encounter.enemies.map(e=>e.hp),before.encounter.enemies.map(e=>e.hp));
  assert.equal(f.snap('bob').character.run.cycle,1,'standing only spends the acting player gauge');
  assert.deepEqual(f.raw('alice',req).receipt,after.receipt);
  assert.equal(f.snap('alice').character.run.cycle,after.character.run.cycle);
 }finally{f.close();}
});

test('reinforcements reproduce the HP gate and conditional chances across 100 deterministic floors',()=>{
 for(let i=0;i<100;i++){const floor=generateFloor(diveData,'party-'+i),foe=floor.enemies.find(e=>e.id==='iris'),selected=selectReinforcements(floor,foe,diveData,seeded('selection-'+i),0);assert.ok(selected.length>=1&&selected.length<=3);assert.equal(new Set(selected.map(e=>e.id)).size,selected.length);assert.ok(selected.every(e=>diveData.enemies[e.type].hp<=diveData.enemies[foe.type].hp));assert.deepEqual(selected,selectReinforcements(floor,foe,diveData,seeded('selection-'+i),0));}
 const floor=generateFloor(diveData,'chance'),foe=floor.enemies[0];let one=0,two=0,three=0;for(let i=0;i<10000;i++){const n=selectReinforcements(floor,foe,diveData,seeded('chance-'+i),0).length;if(n===1)one++;else if(n===2)two++;else three++;}assert.ok(one>4700&&one<5300);assert.ok(two>3400&&two<4100);assert.ok(three>1000&&three<1500);
});

test('authored boss escorts replace random reinforcements without reserving floor residents',()=>{
 for(const [boss,guard] of [['matron_rosalind_boss','nanny_sentinel'],['slime_queen_boss','bottle_slime'],['school_nurse','teachers_pet']]){
  const foe={id:'boss',type:boss},resident={id:'resident',type:guard,engaged:null,respawnAt:0};
  const data={enemies:{[boss]:{enemy_id:boss,hp:100},[guard]:{enemy_id:guard,hp:20}}};
  const selected=selectEncounterEnemies({enemies:[foe,resident]},foe,data,()=>{throw Error('Authored escorts must not roll random selection');},0);
  assert.deepEqual(selected.map(e=>e.type),[boss,guard,guard]);assert.equal(new Set(selected.map(e=>e.id)).size,3);assert.equal(resident.engaged,null);
 }
});

test('three-person invitations enforce capacity, leadership, expiry and same-area acceptance',()=>{
 const f=fixture();try{for(const n of ['alice','bob','cara','dana'])f.player(n);f.join('bob');f.join('cara');assert.equal(f.snap('alice').party.members.length,3);assert.throws(()=>f.act('alice','party_invite',{member:f.ids.dana}),/three/);assert.throws(()=>f.act('bob','party_kick',{member:f.ids.cara}),/leader/);f.act('cara','party_leave');f.act('alice','party_invite',{member:f.ids.dana});const invitation=f.snap('dana').partyInvitations[0].id;f.advance(61000);f.act('dana','enter',{zone:'princess-rose',combat_version:3});assert.throws(()=>f.act('dana','party_accept',{invitation}),/expired/);}finally{f.close();}
});

test('group portals commit together; pending needs roll back everyone; campaign exit removes only its caller',()=>{
 const f=fixture();try{f.player('alice');f.player('bob');f.player('cara');f.join('bob');f.join('cara');f.act('alice','dive_enter',{zone:'dive-quarters'});for(const n of ['alice','bob','cara'])assert.equal(f.snap(n).zone,'dive-quarters');
  f.act('bob','dive_exit');for(const n of ['alice','bob','cara'])assert.equal(f.snap(n).zone,'princess-rose');
  const s=f.snap('cara').character;s.worldTurnDue={id:'pending'};f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),f.ids.cara);assert.throws(()=>f.act('alice','dive_enter',{zone:'dive-quarters'}),/cara/);assert.equal(f.snap('alice').zone,'princess-rose');f.act('cara','world_turn',{world_turn_id:'pending',loadout:s.loadout});f.act('bob','leave');assert.equal(f.snap('alice').party.members.length,2);assert.equal(f.snap('bob').party,null);
 }finally{f.close();}
});

test('shared live battle locks three enemies, preserves independent cycles and settles full personal XP once',()=>{
 const f=fixture();try{f.player('alice');f.player('bob','mage');f.player('cara','diplomat');f.join('bob');f.join('cara');f.act('alice','dive_enter',{zone:'dive-quarters'});const start=f.engage();assert.equal(start.encounter.players.length,3);assert.equal(start.encounter.enemies.length,3);const xp=start.encounter.enemies.reduce((n,e)=>n+e.exp,0);assert.ok(start.dive.enemies.filter(e=>e.engaged===start.encounter.id).length===3);
  assert.throws(()=>f.act('alice','turn_ready',{patch:[],forfeit:false}),/gauge/);f.advance(2000);const prepared=f.act('bob','turn_ready',{patch:[],forfeit:false});const pending=f.command('bob','cast',{spell:'fireball',target:prepared.encounter.enemies[1].id});f.act('cara','turn_ready',{patch:[],forfeit:false});f.raw('bob',pending);assert.deepEqual(f.raw('bob',pending).receipt,f.raw('bob',pending).receipt);assert.equal(f.snap('cara').character.run.cycle,1);
  f.act('cara','flee');const end=f.win();assert.equal(end.encounter,null);for(const n of ['alice','bob','cara'])assert.equal(f.snap(n).character.loadout.player_info.xp,xp);assert.equal(f.awards.length,3);
 }finally{f.close();}
});

test('scoped needs changes preserve damage received while a popup is open',()=>{
 const l={player_info:{playerHealth:70,playerHealthMax:100,wet:40},inventory:[],player_spells:[]};const merged=applyCombatPatch(l,[{path:['player_info','wet'],before:20,after:25},{path:['player_info','playerHealth'],before:100,after:95}]);assert.equal(merged.player_info.playerHealth,65);assert.equal(merged.player_info.wet,45);assert.throws(()=>applyCombatPatch(l,[{path:['player_info','xp'],before:0,after:100}]),/Unsupported/);assert.equal(actionDelay(0),4000);assert.equal(actionDelay(999),1500);assert.equal(actionDelay(-99),6000);
});

test('disconnected party members retain transfers and encounter state survives restart without a burst',()=>{
 const f=fixture();try{f.player('alice');f.player('bob');f.join('bob');f.advance(31000);f.act('alice','enter',{zone:'princess-rose',combat_version:3});f.act('alice','dive_enter',{zone:'dive-quarters'});f.act('bob','enter',{zone:'princess-rose',combat_version:3});assert.equal(f.snap('bob').zone,'dive-quarters');const s=f.engage();f.restart();const resumed=f.snap('alice');assert.equal(resumed.encounter.id,s.encounter.id);assert.equal(resumed.character.loadout.player_info.playerHealth,s.character.loadout.player_info.playerHealth);}finally{f.close();}
});

test('ally healing uses caster MP, live attacks continue during unprepared cycles, and submission waits for settlement',()=>{
 const f=fixture();try{f.player('alice');f.player('bob','mage');f.join('bob');f.act('alice','dive_enter',{zone:'dive-quarters'});const start=f.engage();
  const battle=JSON.parse(f.db.prepare('SELECT state FROM quest_dive_encounters WHERE id=?').get(start.encounter.id).state);for(const enemy of battle.enemies)enemy.data.enemy_spells=[];f.db.prepare('UPDATE quest_dive_encounters SET state=? WHERE id=?').run(JSON.stringify(battle),battle.id);f.advance(5000); // Force physical attacks here; separate combat tests exercise the authored spells.
  const hurt=f.snap('alice');assert.ok(hurt.character.loadout.player_info.playerHealth<500);assert.equal(hurt.character.run.turnReady,false);
  f.act('bob','turn_ready',{patch:[],forfeit:false});const mp=f.snap('bob').character.loadout.player_mp;const before=f.snap('alice').character.loadout.player_info.playerHealth;
  // Use an exported spell the campaign actually teaches, preserving caster costs and target HP.
  const c=f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.ids.bob),s=JSON.parse(c.state);s.loadout.player_spells.push('heal_light');f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),f.ids.bob);
  f.act('bob','cast',{spell:'heal_light',target:f.ids.alice});assert.ok(f.snap('alice').character.loadout.player_info.playerHealth>before);assert.ok(f.snap('bob').character.loadout.player_mp<mp);
  f.act('bob','submit');assert.equal(f.snap('bob').character.run.status,'submit');assert.throws(()=>f.act('bob','party_leave'),/finish/);assert.ok(f.snap('alice').encounter);
  const result=f.win();assert.equal(result.encounter,null);assert.equal(f.snap('bob').character.lastResult.outcome,'submit');assert.ok(f.snap('bob').character.lastResult.defeatScene.id);
 }finally{f.close();}
});

test('needs forfeits and stale action tokens cannot duplicate cycles or overwrite intervening HP',()=>{
 const f=fixture();try{f.player('alice');f.act('alice','dive_enter',{zone:'dive-quarters'});f.engage();f.advance(2000);
  const first=f.command('alice','turn_ready',{patch:[],forfeit:true}),s=f.raw('alice',first);assert.equal(s.character.run.cycle,2);assert.deepEqual(f.raw('alice',first).receipt,s.receipt);assert.throws(()=>f.raw('alice',{...first,request_id:randomUUID()}),/cycle/);
  f.advance(5000);const current=f.snap('alice'),hp=current.character.loadout.player_info.playerHealth;
  f.act('alice','turn_ready',{forfeit:false,patch:[{path:['player_info','playerHealth'],before:500,after:499}]});assert.equal(f.snap('alice').character.loadout.player_info.playerHealth,hp-1);
  f.act('alice','submit');assert.equal(f.snap('alice').encounter,null);assert.ok(f.snap('alice').dive.enemies.every(e=>!e.engaged));
 }finally{f.close();}
});

test('expired disconnected membership changes leader and weekly grace releases every shared lock',()=>{
 const f=fixture();try{f.player('alice');f.player('bob');f.join('bob');f.advance(31000);f.act('bob','enter',{zone:'princess-rose',combat_version:3});assert.equal(f.snap('bob').party.leader,f.ids.bob);f.advance(120000);f.act('bob','enter',{zone:'princess-rose',combat_version:3});assert.equal(f.snap('bob').party.members.length,1);
  f.act('bob','dive_enter',{zone:'dive-quarters'});const s=f.engage('bob');const row=f.db.prepare('SELECT ends FROM dive_editions WHERE route=? AND edition=?').get('quarters-pilot',s.dive.edition);
  f.advance(row.ends+600001-s.serverTime);const persisted=JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.ids.bob).state);assert.equal(persisted.run,null);assert.equal(persisted.dive,null);
  const floor=JSON.parse(f.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get('quarters-pilot',s.dive.edition).content);assert.ok(floor.enemies.every(e=>!e.engaged));
 }finally{f.close();}
});

test('all nine routes support shared fights while claims and chat stay personal and route-scoped',()=>{
 for(const [hub,zone] of [['princess-rose','dive-quarters'],['princess-rose','dive-dungeon'],['princess-rose','dive-tundra'],['honeydew-lantern','dive-desert'],['honeydew-lantern','dive-nursery'],['honeydew-lantern','dive-school'],['honeydew-lantern','dive-forest'],['littlebig-clockwork','dive-mansion'],['littlebig-clockwork','dive-hospital']]){
  const f=fixture();try{f.player('alice','fighter',hub);f.player('bob','mage',hub);f.join('bob');f.act('alice','dive_enter',{zone});const s=f.snap('alice'),foe=s.dive.enemies.find(e=>e.id!==s.dive.boss);const e=f.engage('alice',foe.id);assert.equal(e.encounter.players.length,2,zone);assert.equal(f.snap('bob').encounter.id,e.encounter.id);f.act('bob','flee');f.win();assert.equal(f.snap('bob').encounter,null);assert.equal(f.snap('alice').dive.claimed,0);assert.equal(f.snap('bob').dive.claimed,0);f.act('alice','chat',{text:zone});assert.ok(f.snap('alice').chatArea.id.includes(zone));
  }finally{f.close();}
 }
});

test('large inventories and six actors fit the gateway, and old clients cannot take over party battles',()=>{
 const f=fixture();try{f.player('alice');f.player('bob');f.player('cara');f.join('bob');f.join('cara');f.act('alice','dive_enter',{zone:'dive-quarters'});
  const row=f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.ids.alice),s=JSON.parse(row.state);s.loadout.inventory=Array.from({length:512},()=>({item_id:'adult_food',name:'Supply',desc:'x'.repeat(290)}));f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),f.ids.alice);
  const initial=f.snap('alice'),chest=initial.dive.chests[0];f.place('alice',chest.x,chest.y);assert.throws(()=>f.act('alice','dive_claim',{chest:chest.id}),/full/);assert.equal(f.snap('alice').dive.claimed,0);
  const battle=f.engage();assert.ok(Buffer.byteLength(JSON.stringify(battle))<=262144);assert.equal(battle.encounter.players.length,3);assert.throws(()=>f.act('alice','enter',{zone:'dive-quarters',combat_version:2,takeover:true}),/Update the game/);
  f.advance(2000);f.act('alice','turn_ready',{forfeit:false,patch:[]});const patch=[{path:['inventory'],index:0,before:[s.loadout.inventory[0]],after:[]}];assert.ok(Buffer.byteLength(JSON.stringify(patch))<1024);const used=f.act('alice','use_item',{patch,target:battle.encounter.enemies[0].id});assert.equal(used.character.loadout.inventory.length,511);assert.ok(Buffer.byteLength(JSON.stringify(used))<=262144);
 }finally{f.close();}
});
