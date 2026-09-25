import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {solveDungeonPuzzle} from '../server/full-dungeon-generation.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment});let time=Date.parse('2026-09-24T12:00:00Z'),api;const ids={};
 const start=()=>api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:100}),adjust:()=>{},diveOptions:{log:()=>{}}});start();
 const snap=(who='a')=>api.read(who,ids[who]);
 const command=(who,action,extra={})=>{const s=snap(who);return {action,controller:who,character_id:ids[who],revision:s.character.revision,request_id:randomUUID(),...(s.character.dive?{edition:s.dive.edition}:{}),...extra};};
 const send=(who,input)=>{time+=350;return api.act(who,input);},act=(who,action,extra)=>send(who,command(who,action,extra));
 const place=(who,p)=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[who]).state);if(s.dive){s.dive.position={x:p.x,y:p.y};s.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),ids[who]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[who]);};
 const create=(who,zone,version=1)=>{ids[who]=api.act(who,{action:'create',name:who==='a'?'Alice':'Bob',controller:who,request_id:randomUUID()}).character.id;act(who,'enter',{zone,full_dungeon_version:version,content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{class_id:'warrior',playerHealth:1000,playerHealthMax:1000,stamina:100,stamina_max:100,str:100,def:100,dex:100,cha:10,level:50,xp:0},inventory:[],player_spells:[]}});};
 const map=(who='a')=>{const s=snap(who);return s.zones.find(z=>z.id===s.zone);};
 return {db,live,ids,snap,act,send,command,place,create,map,get api(){return api;},advance(ms){time+=ms;},restart(){api.close();start();},close(){api.close();db.close();}};
}

test('Castle stairs traverse the full Dungeon to Arcadia; opposite entrances and Escape keep their destinations',()=>{
 const f=fixture();try{
  f.create('a','princess-rose');f.place('a',f.map().portals.find(p=>p.target==='princess-rose-garden'));f.act('a','hub_visit',{zone:'princess-rose-garden'});
  const portal=f.map().portals.find(p=>p.target==='dungeon-castle-dungeon');assert.ok(portal);f.place('a',portal);f.act('a','dive_enter',{zone:portal.target});assert.equal(f.snap().zone,'dungeon-castle-dungeon');
  assert.notDeepEqual(f.snap().position,f.map().exits[0]);
  const arcadia=f.map().exits.find(e=>e.zone==='arcadia-foundry');f.place('a',{x:arcadia.x,y:arcadia.y+1});f.act('a','move',{direction:'north'});assert.equal(f.snap().zone,'arcadia-foundry');
  const returnPortal=f.map().portals.find(p=>p.target==='dungeon-castle-dungeon');assert.ok(returnPortal);f.place('a',returnPortal);f.act('a','dive_enter',{zone:returnPortal.target});assert.equal(f.snap().dive.origin,'arcadia-foundry');
  f.act('a','dive_exit');assert.equal(f.snap().zone,'arcadia-foundry');f.place('a',returnPortal);f.act('a','dive_enter',{zone:returnPortal.target});const castle=f.map().exits.find(e=>e.zone==='princess-rose-garden');f.place('a',{x:castle.x,y:castle.y+1});f.act('a','dive_exit',{zone:castle.zone});assert.equal(f.snap().zone,'princess-rose-garden');
 }finally{f.close();}
});

test('live Dungeon upgrades repair Testicles and misplaced Hypnotists, preserve progress, and leave ordinary enemies attackable',()=>{
 const f=fixture();try{
  f.create('a','princess-rose');f.place('a',f.map().portals.find(p=>p.target==='princess-rose-garden'));f.act('a','hub_visit',{zone:'princess-rose-garden'});
  f.place('a',f.map().portals.find(p=>p.target==='dungeon-castle-dungeon'));f.act('a','dive_enter',{zone:'dungeon-castle-dungeon'});
  const visit=f.snap().character.dive,query=f.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=? AND depth=1'),read=()=>JSON.parse(query.get(visit.route,visit.edition).content);
  const floor=read(),enemy=floor.enemies.find(e=>e.id.startsWith('enemy-'));
  assert.ok(floor.enemies.every(e=>!e.type.startsWith('hypnotist')),'live generation stays in the campaign pool');
  floor.fixtures.find(n=>n.content==='objFriendlyTest').sprite='sprFriendly';enemy.type='hypnotist_master';enemy.definition=structuredClone(f.live.published().monsters.hypnotist_master);
  f.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=? AND depth=1').run(JSON.stringify(floor),visit.route,visit.edition);
  const progress=f.db.prepare('SELECT * FROM dive_progress WHERE character_id=?').all(f.ids.a);f.restart();f.snap();
  const repaired=read();assert.equal(repaired.fixtures.find(n=>n.content==='objFriendlyTest').sprite,'sprNPCHalfwayHero');assert.ok(repaired.enemies.every(e=>!e.type.startsWith('hypnotist')));
  assert.deepEqual(repaired.walls,floor.walls);assert.deepEqual(repaired.chests,floor.chests);assert.deepEqual(f.db.prepare('SELECT * FROM dive_progress WHERE character_id=?').all(f.ids.a),progress);
  const foe=repaired.enemies.find(e=>e.id===enemy.id),neighbor=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>({x:foe.x+dx,y:foe.y+dy})).find(p=>repaired.walls[p.y]?.[p.x]===0&&!repaired.props[p.y][p.x]);assert.ok(neighbor);
  f.place('a',neighbor);let result=f.act('a','dive_engage',{encounter:foe.id});assert.ok(result.encounter);
  const battle=result.encounter.id,cycle=result.encounter.players.find(p=>p.id===f.ids.a).cycle; // Match the client's shared-combat receipt, including its action cycle.
  f.advance(5000);result=f.act('a','turn_ready',{battle,cycle,forfeit:false,patch:[]});const target=result.encounter.enemies.find(e=>e.id===foe.id),hp=target.hp;
  result=f.act('a','attack',{battle,cycle,target:foe.id});assert.ok(!result.encounter||result.encounter.enemies.find(e=>e.id===foe.id).hp<hp,'a normal attack damages the repaired encounter');
 }finally{f.close();}
});

test('publishing live content and respawning keep full dungeon room populations and boss behavior intact',()=>{
 const f=fixture();try{
  f.create('a','princess-rose');
  const before=fullDungeons.map(data=>f.api.world.map(data.config.zone_id));
  const roster=floor=>floor.enemies.map(e=>({id:e.id,type:e.type,roaming:e.roaming}));
  for(const map of before){
   const floor=structuredClone(map.floor);
   for(const foe of floor.enemies){foe.dead=true;foe.diedAt=1;foe.respawnAt=2;} // Expired bosses and ordinary enemies both exercise live reconciliation.
   f.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=? AND depth=1').run(JSON.stringify(floor),floor.route,map.edition);
  }
  const entry=f.live.entry('monster','hypnotist_master');
  f.live.change({action:'content_publish',kind:'monster',id:'hypnotist_master',revision:entry.revision,entry:entry.draft},'dm');
  f.restart();f.api.tick();
  for(const old of before){const after=f.api.world.map(old.id);assert.deepEqual(roster(after.floor),roster(old.floor),old.id);assert.ok(after.floor.enemies.every(e=>!e.dead));assert.deepEqual(after.floor.walls,old.floor.walls);}
 }finally{f.close();}
});

test('named Utopia and LittleBig entrances require the new capability and return beside their own doors',()=>{
 const f=fixture();try{
  for(const data of fullDungeons.filter(d=>d.config.theme!=='dungeon')){
   const host=data.config.endpoints[0].zone;if(!f.ids.a)f.create('a',host,0);else f.act('a','enter',{zone:host,full_dungeon_version:0,content_version:1,quest_version:1,combat_version:3});
   const portal=f.map().portals.find(p=>p.target===data.config.zone_id);assert.ok(portal);f.place('a',portal);assert.throws(()=>f.act('a','dive_enter',{zone:portal.target}),/Update the game/);
   f.act('a','enter',{zone:host,full_dungeon_version:1,content_version:1,quest_version:1,combat_version:3});f.place('a',portal);f.act('a','dive_enter',{zone:portal.target});assert.equal(f.map().fullDungeonVersion,1);assert.equal(f.snap().dive.origin,host);f.act('a','dive_exit');assert.equal(f.snap().zone,host);
   const p=f.snap().position;assert.ok(Math.abs(p.x-portal.x)+Math.abs(p.y-portal.y)>=1); // Arrival never lands on the trigger tile.
  }
 }finally{f.close();}
});

test('two players see serialized blocks, stale resets fail, rewards stay personal, and scenes survive restart',()=>{
 const f=fixture();try{
  for(const who of ['a','b']){f.create(who,'utopia-arcanum');const portal=f.map(who).portals.find(p=>p.target==='dungeon-auto-nursery');f.place(who,portal);f.act(who,'dive_enter',{zone:portal.target});}
  const q=f.map().puzzles[0],moves=solveDungeonPuzzle(f.map(),q);assert.ok(moves.length);f.place('a',moves[0].from);f.place('b',f.map().entrance);
  const push=f.command('a','dungeon_push',{puzzle:q.id,block:moves[0].block,mechanism_revision:0});f.send('a',push);f.send('a',push);assert.equal(f.map().mechanismRevision,1);assert.equal(f.map('b').mechanismRevision,1);
  assert.throws(()=>f.act('b','dungeon_reset',{puzzle:q.id,mechanism_revision:0}),/puzzle changed/);
  for(const move of moves.slice(1)){f.place('a',move.from);f.act('a','dungeon_push',{puzzle:q.id,block:move.block,mechanism_revision:f.map().mechanismRevision});}
  assert.equal(f.map().puzzles[0].solved,true);f.place('b',moves[0].from);assert.throws(()=>f.act('b','dungeon_reset',{puzzle:q.id,mechanism_revision:f.map().mechanismRevision}),/already open/);
  for(const who of ['a','b']){f.place(who,{x:q.x-1,y:q.y});const claim=f.command(who,'dive_claim',{chest:'puzzle-chest'});f.send(who,claim);f.send(who,claim);assert.equal(f.snap(who).dive.claimed,1);}
  const toilet=f.map().fixtures.find(v=>v.kind==='toilet'),floor=f.map();const neighbor=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>({x:toilet.x+dx,y:toilet.y+dy})).find(p=>floor.walls[p.y][p.x]===0&&!floor.props[p.y][p.x]);f.place('a',neighbor);
  const use=f.command('a','dungeon_interact',{fixture:toilet.id});f.send('a',use);const scene=f.snap().dive.scene;f.send('a',use);assert.equal(f.snap().dive.scene.id,scene.id);assert.equal(f.snap('b').dive.scene,null);f.restart();assert.equal(f.snap().dive.scene.id,scene.id);
  f.act('a','dungeon_scene_choice',{scene:scene.id,page:scene.page,mechanism_revision:scene.revision,choice:-1});assert.equal(f.snap().dive.scene,null);
 }finally{f.close();}
});

test('party entry checks every client capability and transfers the whole group through the same door',()=>{
 const f=fixture();try{
  f.create('a','utopia-arcanum');f.create('b','utopia-arcanum',0);f.act('a','party_invite',{member:f.ids.b});const invitation=f.db.prepare('SELECT id FROM quest_party_invites').get().id;f.act('b','party_accept',{invitation});
  const p=f.map().portals.find(p=>p.target==='dungeon-auto-nursery');f.place('a',p);assert.throws(()=>f.act('a','dive_enter',{zone:p.target}),/needs to update/);assert.equal(f.snap().zone,'utopia-arcanum');assert.equal(f.snap('b').zone,'utopia-arcanum');
  f.act('b','enter',{zone:'utopia-arcanum',full_dungeon_version:1,content_version:1,quest_version:1,combat_version:3});f.act('a','dive_enter',{zone:p.target});assert.equal(f.snap('b').zone,p.target);assert.equal(f.snap('b').dive.origin,'utopia-arcanum');f.act('a','dive_exit');assert.equal(f.snap('b').zone,'utopia-arcanum');
 }finally{f.close();}
});

test('weekly expiry and monthly refresh retain old claims and character flags while installing fresh entrances',()=>{
 const f=fixture();try{
  f.create('a','utopia-arcanum');const portal=f.map().portals.find(p=>p.target==='dungeon-auto-nursery');f.place('a',portal);f.act('a','dive_enter',{zone:portal.target});
  const old=f.snap().dive.edition,state=JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.ids.a).state);state.fullDungeon={flags:{test_visit:true},counters:{visits:1},once:{test_gift:true}};f.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),f.ids.a);
  f.act('a','dive_exit');f.advance(10*86400000);f.restart();f.act('a','enter',{zone:'utopia-arcanum',full_dungeon_version:1,content_version:1,quest_version:1,combat_version:3});
  assert.equal(f.map().district.edition,'2026-10');const next=f.map().portals.find(p=>p.target===portal.target);assert.ok(next);f.place('a',next);f.act('a','dive_enter',{zone:next.target});assert.notEqual(f.snap().dive.edition,old);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dive_progress WHERE character_id=? AND route=? AND edition=?').get(f.ids.a,'auto-nursery',old).n,1);
  assert.equal(JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.ids.a).state).fullDungeon.once.test_gift,true);
  assert.throws(()=>f.act('a','dungeon_reset',{edition:old,puzzle:'puzzle-0',mechanism_revision:0}),/edition changed/);
 }finally{f.close();}
});

test('Basil and Nell retain the authored letter quest, personal inventory, completion prose and one reward claim',()=>{
 const f=fixture();try{
  f.create('a','utopia-arcanum');const portal=f.map().portals.find(p=>p.target==='dungeon-auto-nursery');f.place('a',portal);f.act('a','dive_enter',{zone:portal.target});
  const talk=name=>{const floor=f.map(),npc=floor.fixtures.find(n=>n.name===name&&n.kind==='npc');const p=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>({x:npc.x+dx,y:npc.y+dy})).find(p=>floor.walls[p.y][p.x]===0&&!floor.props[p.y][p.x]);f.place('a',p);f.act('a','npc_talk',{placement:npc.id});};
  const choose=label=>{const t=f.snap().onlineQuests.conversation,choice=t.choices.find(c=>c.label.includes(label));assert.ok(choice,'Missing '+label+' on '+t.page);return f.act('a','npc_choice',{conversation:t.id,page:t.page,choice:choice.index});};
  talk('Basil');choose('Ask about quests');choose('Letter');choose('Accept quest');talk('Basil');choose('Collect the letter');assert.equal(f.snap().character.loadout.inventory.filter(i=>i.item_id==='basils_letter').length,1);
  talk('Nell');choose('Deliver:');assert.equal(f.snap().character.loadout.inventory.filter(i=>i.item_id==='basils_letter').length,0);talk('Basil');choose('Turn in:');assert.ok(f.snap().onlineQuests.conversation.text.length>20);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quest_claims WHERE character_id=? AND quest=?').get(f.ids.a,'full-letter_for_nell').n,1);
  talk('Basil');assert.ok(!f.snap().onlineQuests.conversation.choices.some(c=>c.label.startsWith('Turn in:')));
 }finally{f.close();}
});
