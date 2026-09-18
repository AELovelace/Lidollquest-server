import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {DAILY_COIN_CAP} from '../server/hubs.mjs';
import {diveData,DIVE_ZONE} from '../server/dive.mjs';
import {generateFloor,validateFloor,weeklyWindow,pathTo,walkable,dressFloor} from '../server/dive-generation.mjs';

function fixture(options={}){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-16T12:00:00Z'),owner='alice',zones;
 const awards=[];
 const setup=()=>zones=createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:(o,asset,n,id)=>awards.push({o,n,id}),diveOptions:{log:()=>{},...options}});
 setup();const loadout={player_info:{class_id:'fighter',playerHealth:500,playerHealthMax:500,str:100,def:8,dex:8,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const snap=id=>zones.read('',id);
 function command(id,action,extra={}){const s=snap(id);return {action,request_id:randomUUID(),controller:'window',character_id:id,revision:s.character?.revision,...(s.zone===DIVE_ZONE?{edition:s.dive.edition}:{}),...extra};}
 function act(id,action,extra={}){time+=350;return zones.act('',command(id,action,extra));}
 function player(name='alice',hub='princess-rose'){owner=name;const c=zones.act('',{action:'create',name,request_id:randomUUID(),controller:'window'}).character;act(c.id,'enter',{zone:hub,loadout,combat_version:2});return act(c.id,'dive_enter',{loadout}).character.id;}
 function place(id,target){const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id),s=JSON.parse(row.state);s.dive.position={x:target.x,y:target.y};s.dive.safeUntil=time+600000;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),id);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(target.x,target.y,time,id);}
 function near(id,entity){const s=snap(id),f=s.zones.find(z=>z.id===DIVE_ZONE);const path=pathTo(f,f.entrance,entity);place(id,path.length>1?path.at(-2):f.entrance);}
 function engage(id,foe='iris'){const e=snap(id).dive.enemies.find(e=>e.id===foe);near(id,e);return act(id,'dive_engage',{encounter:foe});}
 function win(id){let s=snap(id);for(let n=0;n<10&&s.character.run;n++){if(!s.character.run.turnReady)s=act(id,'turn_ready',{loadout:s.character.loadout,forfeit:false});s=act(id,s.character.loadout.player_info.class_id==='diplomat'?'allure':s.character.loadout.player_info.class_id==='mage'?'cast':'attack',{spell:'fireball'});}return s;}
 return {db,awards,loadout,player,place,near,engage,win,act,command,snap,as:n=>owner=n,advance:ms=>time+=ms,setTime:t=>time=Date.parse(t),restart:setup,raw:input=>zones.act('',input),tick:()=>zones.tick(),close:()=>db.close()};
}

test('area chat follows individual rooms and corridors, survives reconnect and excludes previous editions',()=>{
 const f=fixture();try{
  const a=f.player(),b=f.player('bob');f.as('alice');
  const floor=f.snap(a).zones.find(z=>z.id===DIVE_ZONE),room=floor.rooms[1];
  f.place(a,room);f.act(a,'chat',{text:'Room one'});
  const area=f.snap(a).chatArea.id;
  f.as('bob');assert.equal(f.snap(b).chat.length,0);
  f.place(b,room);assert.equal(f.snap(b).chat[0].text,'Room one');assert.equal(f.snap(b).chatArea.id,area);
  f.place(b,floor.rooms[2]);assert.equal(f.snap(b).chat.length,0);f.act(b,'chat',{text:'Room two'});
  f.as('alice');assert.equal(f.snap(a).chat.length,1);assert.equal(f.snap(a).chat[0].text,'Room one');
  f.restart();assert.equal(f.snap(a).chat[0].text,'Room one');
  const corridor=pathTo(floor,floor.entrance,room).find(p=>!floor.rooms.some(r=>p.x>=r.x&&p.x<r.x+r.w&&p.y>=r.y&&p.y<r.y+r.h));
  assert.ok(corridor);f.place(a,corridor);assert.equal(f.snap(a).chat.length,0);assert.match(f.snap(a).chatArea.name,/corridors/);
  f.act(a,'chat',{text:'Hallway'});f.as('bob');f.place(b,corridor);assert.equal(f.snap(b).chat[0].text,'Hallway');
  f.as('alice');f.setTime('2026-09-21T11:00:01Z');f.tick();f.act(a,'enter',{zone:'princess-rose'});f.act(a,'dive_enter',{loadout:f.loadout});
  const next=f.snap(a).zones.find(z=>z.id===DIVE_ZONE);f.place(a,next.rooms[1]);assert.notEqual(f.snap(a).chatArea.id,area);assert.equal(f.snap(a).chat.length,0);
 }finally{f.close();}
});

test('weekly boundaries remain Monday 04:00 Pacific across both DST transitions',()=>{
 assert.deepEqual(weeklyWindow(Date.parse('2026-03-09T10:59:59Z')),{edition:'2026-03-02',start:Date.parse('2026-03-02T12:00:00Z'),ends:Date.parse('2026-03-09T11:00:00Z')});
 assert.equal(weeklyWindow(Date.parse('2026-03-09T11:00:00Z')).edition,'2026-03-09');
 assert.equal(weeklyWindow(Date.parse('2026-11-02T11:59:59Z')).edition,'2026-10-26');
 assert.equal(weeklyWindow(Date.parse('2026-11-02T12:00:00Z')).edition,'2026-11-02');
});

test('explicit dungeon takeover retains personal loot and a reserved fight',()=>{
 const f=fixture();try{
  const id=f.player(),chest=f.snap(id).dive.chests[0];f.near(id,chest);f.act(id,'dive_claim',{chest:chest.id});
  const fighting=f.engage(id);
  assert.throws(()=>f.act(id,'enter',{zone:DIVE_ZONE,controller:'replacement'}),e=>e.code==='zone_controller_conflict');
  const command=f.command(id,'enter',{zone:DIVE_ZONE,controller:'replacement',takeover:true,loadout:{...f.loadout,inventory:[]}});
  const resumed=f.raw(command);
  assert.deepEqual(resumed.character.run,fighting.character.run);
  assert.deepEqual(resumed.character.loadout,fighting.character.loadout);
  assert.equal(resumed.dive.claimed,1);
  assert.equal(resumed.dive.enemies.find(e=>e.id==='iris').engaged,id);
  assert.deepEqual(f.raw(command).receipt,resumed.receipt);
  assert.throws(()=>f.act(id,'heartbeat'),e=>e.status===409);
  assert.throws(()=>f.act(id,'enter',{zone:DIVE_ZONE}),e=>e.code==='zone_controller_conflict');
 }finally{f.close();}
});
test('one hundred deterministic floors have reachable loot, safe entrances and the configured density',()=>{
 for(let i=0;i<100;i++){
  const f=generateFloor(diveData,'seed-'+i);assert.ok(validateFloor(f));assert.deepEqual(f,generateFloor(diveData,'seed-'+i));assert.equal(f.enemies.length,(f.rooms.length-1)*2+1);assert.equal(f.chests.length,f.rooms.length-1);
  assert.equal(f.pickups.filter(p=>p.kind==='potion').length,(f.rooms.length-1)*diveData.config.potions_per_room);
  assert.equal(f.pickups.filter(p=>p.kind==='treasure').length,(f.rooms.length-1)*diveData.config.treasures_per_room);
  assert.ok(f.decorations.some(p=>p.span_w>1||p.span_h>1));
  for(const p of f.decorations)for(let dy=0;dy<p.span_h;dy++)for(let dx=0;dx<p.span_w;dx++)assert.equal(walkable(f,p.x+dx,p.y+dy),!p.solid);
  assert.equal(dressFloor(diveData,f),false,'already dressed floors must not move loot or furniture');
 }
});

test('a pending Dive movement-needs turn resumes with its collected loot and settles once',()=>{
 const f=fixture();try{
  const id=f.player(),ch=f.snap(id).dive.chests[0];f.near(id,ch);
  const p=f.snap(id).position,direction=ch.x>p.x?'east':ch.x<p.x?'west':ch.y>p.y?'south':'north';
  let s=f.act(id,'move',{direction,world_step:true});assert.equal(s.character.loadout.inventory.length,1);assert.ok(s.character.worldTurnDue);
  const due=s.character.worldTurnDue.id,item=s.character.loadout.inventory[0];
  f.restart();s=f.act(id,'enter',{zone:DIVE_ZONE,loadout:f.loadout});assert.equal(s.character.worldTurnDue.id,due);assert.deepEqual(s.character.loadout.inventory,[item]);
  const next=structuredClone(s.character.loadout);next.player_info.hunger=123;
  const command=f.command(id,'world_turn',{world_turn_id:due,loadout:next});s=f.raw(command);
  assert.equal(s.character.worldTurnDue,undefined);assert.deepEqual(s.character.loadout.inventory,[item]);assert.equal(s.character.loadout.player_info.hunger,123);
  assert.deepEqual(f.raw(command).character.loadout.inventory,[item]);assert.equal(f.snap(id).dive.claimed,1);
 }finally{f.close();}
});

test('room chests collect on contact once per character and stay unclaimed when inventory is full',()=>{
 const f=fixture();try{
  const a=f.player(),ch=f.snap(a).dive.chests[0];f.near(a,ch);
  const pos=f.snap(a).position,direction=ch.x>pos.x?'east':ch.x<pos.x?'west':ch.y>pos.y?'south':'north';
  const full=structuredClone(f.loadout);full.inventory=Array.from({length:99},()=>({item_id:'hair_bow'}));f.act(a,'loadout',{loadout:full});
  let s=f.act(a,'move',{direction});assert.equal(s.dive.claimed,0);assert.equal(s.character.loadout.inventory.length,99);assert.match(s.character.dive.lootNotice,/Inventory full/);
  f.act(a,'loadout',{loadout:f.loadout});f.place(a,pos);f.advance(350);
  const input=f.command(a,'move',{direction});s=f.raw(input);assert.equal(s.dive.claimed,1);assert.equal(s.character.loadout.inventory.length,1);
  const item=s.character.loadout.inventory[0];assert.deepEqual(f.raw(input).character.loadout.inventory,[item]);
  f.place(a,pos);assert.deepEqual(f.act(a,'move',{direction}).character.loadout.inventory,[item]);
  f.restart();assert.equal(f.snap(a).dive.claimed,1);
  const b=f.player('bob');f.near(b,ch);const bp=f.snap(b).position;
  assert.equal(f.act(b,'move',{direction:ch.x>bp.x?'east':ch.x<bp.x?'west':ch.y>bp.y?'south':'north'}).dive.claimed,1);
 }finally{f.close();}
});

test('potions and treasure are personal, persistent, replay-safe and remain available with full inventory',()=>{
 const f=fixture();try{
  const a=f.player(),p=f.snap(a).dive.pickups.find(p=>p.kind==='potion');
  assert.throws(()=>f.act(a,'dive_claim',{chest:p.id}),/Stand next/);
  f.near(a,p);const full=structuredClone(f.loadout);full.inventory=Array.from({length:99},()=>({item_id:'hair_bow'}));f.act(a,'loadout',{loadout:full});
  const pos=f.snap(a).position,direction=p.x>pos.x?'east':p.x<pos.x?'west':p.y>pos.y?'south':'north';
  const moved=f.act(a,'move',{direction});assert.deepEqual(moved.position,{x:p.x,y:p.y});assert.equal(moved.dive.pickupsClaimed,0);assert.match(moved.character.dive.lootNotice,/Inventory full/);
  assert.throws(()=>f.act(a,'dive_claim',{chest:p.id}),/Inventory full/);
  f.act(a,'loadout',{loadout:f.loadout});const input=f.command(a,'dive_claim',{chest:p.id}),s=f.raw(input),item=s.character.loadout.inventory[0];
  assert.ok(diveData.potion_pool.includes(item.item_id));assert.equal(s.dive.pickupsClaimed,1);assert.equal(s.dive.claimed,0);
  assert.ok(item.online_item);assert.ok(item.online_sell_price>0); // Actual dungeon grants, not only shop purchases, receive durable provenance.
  assert.deepEqual(f.raw(input).character.loadout.inventory,[item]);f.restart();assert.deepEqual(f.snap(a).character.loadout.inventory,[item]);
  const b=f.player('bob','princess-rose');assert.equal(f.snap(b).dive.pickupsClaimed,0);f.near(b,p);const bp=f.snap(b).position;
  const walked=f.act(b,'move',{direction:p.x>bp.x?'east':p.x<bp.x?'west':p.y>bp.y?'south':'north'});assert.equal(walked.dive.pickupsClaimed,1);assert.ok(diveData.potion_pool.includes(walked.character.loadout.inventory[0].item_id));
  const treasure=walked.dive.pickups.find(p=>p.kind==='treasure');f.near(b,treasure);assert.equal(f.act(b,'dive_claim',{chest:treasure.id}).dive.pickupsClaimed,2);assert.equal(f.awards.length,0);
 }finally{f.close();}
});

test('live dressing upgrade preserves walls, claims, inventory, fights and player positions exactly once',()=>{
 const f=fixture();try{
  const a=f.player(),ch=f.snap(a).dive.chests[0];f.near(a,ch);f.act(a,'dive_claim',{chest:ch.id});const fighting=f.engage(a);
  const row=f.db.prepare('SELECT * FROM dive_editions').get(),floor=JSON.parse(row.content);
  delete floor.dressingVersion;delete floor.pickups;delete floor.props;floor.decorations=[];
  f.db.prepare('UPDATE dive_editions SET content=?').run(JSON.stringify(floor));f.restart();f.tick();
  const s=f.snap(a),upgraded=JSON.parse(f.db.prepare('SELECT content FROM dive_editions').get().content);
  assert.deepEqual(s.character.run,fighting.character.run);assert.deepEqual(s.character.loadout,fighting.character.loadout);assert.deepEqual(s.position,fighting.position);
  assert.deepEqual(upgraded.walls,floor.walls);assert.deepEqual(upgraded.chests,floor.chests);assert.equal(s.dive.claimed,1);assert.equal(s.dive.completed,false);
  assert.ok(walkable(upgraded,s.position.x,s.position.y));assert.ok(s.dive.pickupsTotal>0);assert.equal(s.dive.enemies.find(e=>e.id==='iris').engaged,a);
  f.restart();f.tick();assert.deepEqual(JSON.parse(f.db.prepare('SELECT content FROM dive_editions').get().content),upgraded);
 }finally{f.close();}
});
test('both lobbies share a floor; personal chest claims survive replay, inventory limits and reconnects',()=>{
 const f=fixture();try{const a=f.player(),first=f.snap(a),ch=first.dive.chests[0];f.near(a,ch);
  const input=f.command(a,'dive_claim',{chest:ch.id}),claimed=f.raw(input);assert.equal(claimed.character.loadout.inventory.length,1);assert.equal(f.raw(input).character.loadout.inventory.length,1);
  f.advance(31000);let resumed=f.act(a,'enter',{zone:DIVE_ZONE,loadout:{...f.loadout,inventory:[]}});assert.equal(resumed.character.loadout.inventory.length,1);assert.equal(resumed.dive.claimed,1);
  const second=resumed.dive.chests[1];f.near(a,second);const full=structuredClone(resumed.character.loadout);full.inventory=Array.from({length:99},()=>({item_id:'hair_bow'}));f.act(a,'loadout',{loadout:full});assert.throws(()=>f.act(a,'dive_claim',{chest:second.id}),/Inventory full/);assert.equal(f.snap(a).dive.claimed,1);
  f.act(a,'dive_exit');assert.equal(f.snap(a).zone,'princess-rose');
  const b=f.player('bob','princess-rose'),bs=f.snap(b);assert.equal(bs.dive.edition,first.dive.edition);assert.equal(bs.dive.claimed,0);assert.deepEqual(bs.zones.at(-1).walls,first.zones.at(-1).walls);f.near(b,ch);assert.equal(f.act(b,'dive_claim',{chest:ch.id}).dive.claimed,1);assert.equal(f.act(b,'dive_exit').zone,'princess-rose');
 }finally{f.close();}
});
test('shared encounter locks, authored stats, class combat, respawns and weekly reward cap',()=>{
 const f=fixture();try{const a=f.player(),b=f.player('bob');f.as('alice');let s=f.engage(a);assert.equal(s.character.run.enemy.hp,100);assert.equal(s.character.run.enemy.str,8);
  f.as('bob');f.near(b,f.snap(b).dive.enemies.find(e=>e.id==='iris'));assert.throws(()=>f.act(b,'dive_engage',{encounter:'iris'}),/not available/);
  f.as('alice');const day=Math.floor(Date.parse('2026-09-16T12:00:00Z')/86400000);f.db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?)').run('alice',day,DAILY_COIN_CAP-10); // Ten coins left, so the 50-coin boss payout is partially capped.
  s=f.win(a);assert.equal(s.character.run,null);assert.equal(s.dive.completed,true);assert.equal(s.dive.claimableCoins,40);assert.equal(f.awards.reduce((n,a)=>n+a.n,0),10);assert.equal(f.act(a,'dive_claim_reward').dive.claimableCoins,40);
  f.setTime('2026-09-17T12:00:00Z');f.act(a,'enter',{zone:DIVE_ZONE});assert.equal(f.act(a,'dive_claim_reward').dive.claimableCoins,0);assert.equal(f.awards.reduce((n,a)=>n+a.n,0),50);
  for(const cls of ['mage','diplomat']){let l=f.snap(a).character.loadout;l.player_info.class_id=cls;f.act(a,'loadout',{loadout:l});f.engage(a);s=f.win(a);assert.equal(s.character.run,null);assert.equal(f.awards.reduce((n,a)=>n+a.n,0),50);f.advance(301000);f.act(a,'enter',{zone:DIVE_ZONE});}
 }finally{f.close();}
});
test('encounter expiry restores enemies and keeps committed inventory; restart preserves floor and claims',()=>{
 const f=fixture();try{const a=f.player();const before=f.snap(a).zones.at(-1).walls;f.engage(a);f.advance(121000);f.tick();let s=f.snap(a);assert.equal(s.character.run,null);assert.equal(s.character.lastResult.outcome,'abandoned');f.act(a,'enter',{zone:DIVE_ZONE});f.restart();s=f.snap(a);assert.deepEqual(s.zones.at(-1).walls,before);assert.equal(s.dive.enemies.find(e=>e.id==='iris').engaged,null);
  f.engage(a);for(let i=0;i<11;i++){f.advance(29000);f.act(a,'heartbeat');}assert.equal(f.snap(a).character.run,null,'heartbeats cannot reserve an idle encounter indefinitely');
 }finally{f.close();}
});
test('weekly reset returns idle visitors, grants active fights grace and rejects stale editions',()=>{
 const f=fixture();try{const a=f.player();f.setTime('2026-09-21T10:59:50Z');f.act(a,'enter',{zone:DIVE_ZONE});f.engage(a);const old=f.snap(a).dive.edition;
  f.setTime('2026-09-21T11:00:01Z');let s=f.act(a,'heartbeat');assert.equal(s.zone,DIVE_ZONE);assert.equal(s.dive.edition,old);s=f.win(a);assert.equal(s.zone,'princess-rose');assert.equal(f.awards.reduce((n,a)=>n+a.n,0),50);
  s=f.act(a,'dive_enter');assert.notEqual(s.dive.edition,old);assert.equal(s.dive.claimed,0);assert.throws(()=>f.act(a,'move',{direction:'east',edition:old}),/edition changed/);
  f.setTime('2026-10-05T11:00:01Z');f.tick();assert.equal(f.snap(a).character.dive,null);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM dive_editions WHERE route='quarters-pilot'").get().n,3,'downtime creates only the currently due edition');
 }finally{f.close();}
});
test('failed generation retains the last valid edition and claims',()=>{
 let broken=false;const f=fixture({generate:(...args)=>{if(broken)throw Error('fixture failure');return generateFloor(...args);}});try{const a=f.player(),old=f.snap(a).dive.edition;broken=true;f.setTime('2026-09-21T11:00:01Z');f.tick();f.act(a,'enter',{zone:DIVE_ZONE});assert.equal(f.snap(a).dive.edition,old);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM dive_editions WHERE route='quarters-pilot'").get().n,1);}finally{f.close();}
});

test('server clock pursues players, starts only one shared fight and respects the safe entrance',()=>{
 const f=fixture();try{const a=f.player(),s=f.snap(a),row=f.db.prepare('SELECT * FROM dive_editions').get(),floor=JSON.parse(row.content),fairy=floor.enemies.find(e=>e.type==='diaper_fairy');
  const target={x:fairy.x,y:fairy.y},steps=pathTo(floor,floor.entrance,target),position=steps.at(-3);f.place(a,position);
  const c=f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(a),state=JSON.parse(c.state);state.dive.safeUntil=0;f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),a);
  for(let i=0;i<4&&!f.snap(a).character.run;i++){f.advance(1100);f.tick();}
  assert.equal(f.snap(a).character.run.kind,'dive');assert.equal(f.snap(a).dive.enemies.filter(e=>e.engaged===a).length,1);
  f.act(a,'flee');assert.deepEqual(f.snap(a).position,s.zones.at(-1).entrance);
  for(let i=0;i<20;i++){f.advance(1100);f.act(a,'heartbeat');}assert.equal(f.snap(a).character.run,null);
 }finally{f.close();}
});

test('defeat preserves chest items, restores quarter HP and respawns the opponent',()=>{
 const f=fixture({roll:n=>n-1});try{const a=f.player(),ch=f.snap(a).dive.chests[0];f.near(a,ch);f.act(a,'dive_claim',{chest:ch.id});const loadout=f.snap(a).character.loadout;loadout.player_info.playerHealth=1;loadout.player_info.str=1;f.act(a,'loadout',{loadout});f.engage(a);let s=f.snap(a);s=f.act(a,'turn_ready',{loadout:s.character.loadout,forfeit:false});s=f.act(a,'attack');assert.equal(s.character.run,null);assert.equal(s.character.lastResult.outcome,'defeat');assert.equal(s.character.loadout.player_info.playerHealth,125);assert.equal(s.character.loadout.inventory.length,1);assert.equal(s.dive.enemies.find(e=>e.id==='iris').engaged,null);
 }finally{f.close();}
});

test('ten-minute reset grace ends even an active encounter and suspended clients resume at their lobby',()=>{
 const f=fixture();try{const a=f.player();f.setTime('2026-09-21T10:59:59Z');f.act(a,'enter',{zone:DIVE_ZONE});f.engage(a);f.setTime('2026-09-21T11:09:59Z');
  // Keep the combat activity/lease current to isolate the hard reset deadline from idle expiry.
  const c=f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(a),state=JSON.parse(c.state);state.run.acted=Date.parse('2026-09-21T11:09:59Z');f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),a);f.db.prepare('UPDATE quest_presence SET seen=? WHERE character_id=?').run(Date.parse('2026-09-21T11:09:59Z'),a);
  f.tick();assert.ok(f.snap(a).character.run);f.setTime('2026-09-21T11:10:01Z');f.tick();assert.equal(f.snap(a).character.run,null);assert.equal(f.snap(a).zone,'princess-rose');assert.equal(f.awards.length,0);
  f.advance(31000);assert.equal(f.act(a,'enter',{zone:DIVE_ZONE}).zone,'princess-rose');
 }finally{f.close();}
});


test('defeat scenes retain the authored opponent across duplicate commands, reconnects and service restarts',()=>{
 let charmAttempt=false;const f=fixture({roll:n=>charmAttempt?0:n-1});try{
  const id=f.player(),foe=f.snap(id).dive.enemies.find(e=>e.type==='diaper_fairy');assert.ok(foe);
  f.act(id,'enter',{zone:DIVE_ZONE,combat_version:2,defeat_version:1});
  for(const outcome of ['defeat','submit','charm_backfire','flee']){
   let loadout=structuredClone(f.snap(id).character.loadout);
   Object.assign(loadout.player_info,{playerHealth:1,str:1,cha:0,stat_points:0});f.act(id,'loadout',{loadout});
   f.engage(id,foe.id);let s=f.snap(id),run=structuredClone(s.character.run),position=structuredClone(s.position);
   if(outcome==='defeat'||outcome==='charm_backfire')s=f.act(id,'turn_ready',{loadout:s.character.loadout,forfeit:false});
   if(outcome==='charm_backfire'){
    const row=f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id),state=JSON.parse(row.state);
    charmAttempt=true;state.run.charmLimit=1;f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),id);
   } // Force only the random failure threshold; the real command still resolves charm and settlement.
   f.advance(350);const command=f.command(id,outcome==='defeat'?'attack':outcome==='charm_backfire'?'charm':outcome);
   s=f.raw(command);assert.equal(s.character.run,null);assert.equal(s.character.lastResult.outcome,outcome);
   const result=structuredClone(s.character.lastResult),settled=structuredClone(s.character.loadout);
   if(outcome==='flee')assert.equal(result.defeatScene,undefined);
   else assert.deepEqual(result.defeatScene,{id:run.id,enemy_id:'diaper_fairy',name:run.enemy.name});
   assert.deepEqual(f.raw(command).character.lastResult,result);assert.deepEqual(f.snap(id).character.loadout,settled);
   f.restart();s=f.act(id,'enter',{zone:DIVE_ZONE,combat_version:2,defeat_version:1});assert.deepEqual(s.character.lastResult,result);assert.deepEqual(s.character.loadout,settled);
   if(outcome!=='flee'){
    assert.deepEqual(s.position,position,'settlement and reconnect retain the fight location');
    assert.equal(s.character.pendingDefeat.id,run.id);
    for(const action of ['move','dive_exit','dive_engage','loadout','companion_equip'])assert.throws(()=>f.act(id,action),/defeat dialogue/);
    assert.throws(()=>f.act(id,'defeat_complete',{scene:'wrong'}),/no longer pending/);
    f.advance(11000);f.tick();assert.equal(f.snap(id).character.run,null,'recovered player cannot be attacked while reading');
    const done=f.command(id,'defeat_complete',{scene:run.id}),returned=f.raw(done);
    assert.deepEqual(returned.position,s.character.pendingDefeat.position);
    assert.equal(returned.character.pendingDefeat,undefined);
    assert.deepEqual(returned.character.loadout,settled);
    assert.deepEqual(f.raw(done).receipt,returned.receipt,'duplicate completion does not move or settle twice');
   }
  }
 }finally{f.close();}
});


test('mist upgrades preserve editions and combat; reserved exposure survives reconnect and duplicate needs commits',()=>{
 const f=fixture();try{
  const id=f.player(),ch=f.snap(id).dive.chests[0];f.near(id,ch);f.act(id,'dive_claim',{chest:ch.id});f.engage(id);
  const before=f.snap(id),visit=before.character.dive,record=f.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(visit.route,visit.edition),floor=JSON.parse(record.content);
  delete floor.mist;for(const foe of floor.enemies)foe.roaming=false;
  f.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=?').run(JSON.stringify(floor),visit.route,visit.edition);
  f.advance(1100);f.tick();let s=f.snap(id);
  assert.ok(s.zones.at(-1).mist);assert.deepEqual(s.character.run,before.character.run);assert.deepEqual(s.character.loadout,before.character.loadout);assert.equal(s.dive.claimed,1);
  const upgraded=JSON.parse(f.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(visit.route,visit.edition).content);
  delete upgraded.mist;assert.deepEqual(upgraded,floor,'the additive layer preserves the entire locked encounter and existing floor');
  f.act(id,'flee');
  const destination=floor.chests.find(c=>c.id!==ch.id);f.near(id,destination);s=f.snap(id);
  const pos=s.position,dx=Math.sign(destination.x-pos.x),dy=Math.sign(destination.y-pos.y),direction=dx>0?'east':dx<0?'west':dy>0?'south':'north';
  const target={x:pos.x+dx,y:pos.y+dy};
  const current=JSON.parse(f.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(visit.route,visit.edition).content);
  const row=current.mist.rows[target.y].split('');row[target.x]='1';current.mist.rows[target.y]=row.join('');
  f.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=?').run(JSON.stringify(current),visit.route,visit.edition);
  s=f.act(id,'move',{direction,world_step:true});assert.equal(s.character.worldTurnDue.mist,true);const due=s.character.worldTurnDue.id;
  f.restart();s=f.act(id,'enter',{zone:DIVE_ZONE});assert.equal(s.character.worldTurnDue.id,due);assert.equal(s.character.worldTurnDue.mist,true);
  const next=structuredClone(s.character.loadout);next.player_info.wet=32;next.player_info.tum=22;next.player_info.excitement=12;
  const command=f.command(id,'world_turn',{world_turn_id:due,loadout:next});s=f.raw(command);const committed=structuredClone(s.character.loadout);
  assert.equal(s.character.worldTurnDue,undefined);assert.deepEqual(f.raw(command).character.loadout,committed);
  assert.deepEqual(f.snap(id).zones.at(-1).mist,current.mist,'restart and replay preserve the shared mist layer');
  assert.ok(Buffer.byteLength(JSON.stringify(s))<262144,'a fully populated mist snapshot fits the gateway response budget');
 }finally{f.close();}
});
