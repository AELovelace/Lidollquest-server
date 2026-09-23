import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {createWorldJobs} from '../server/world-jobs.mjs';
import {createQuestService} from '../server/service.mjs';
import {combatData} from '../server/combat.mjs';
import {hubData} from '../server/hubs.mjs';
import {walkable} from '../server/dive-generation.mjs';
import {applyDefeatEquipment} from '../server/defeat-equipment.mjs';
const tiny='iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAN0lEQVR4nO3QQREAMAgDQYofTCKxhspUBZ+NgcvsudUvFpebcQcIECBAgAABAgQIECBAgACBTzBf6ALAS4QDIwAAAABJRU5ErkJggg==';
const monster={id:'test_monster',enemy_id:'test_monster',name:'Test monster',hp:20,str:1,def:0,dex:1,exp:12,spell_cast_chance:0,enemy_spells:[],sprite:'sprItem',battle_sprite:'',roaming:false};
function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-16T12:00:00Z'),owner='alice';
 const live=createWorldContent(db,{now:()=>time,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment});
 const options={now:()=>time,roll:()=>0,live,grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}};let zones=createQuestZones(db,options);
 const loadout={player_info:{class_id:'fighter',playerHealth:500,playerHealthMax:500,str:100,def:8,dex:8,int:20,cha:100,level:30,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const read=id=>zones.read('',id);
 const act=(id,action,extra={})=>{time+=350;const s=id?read(id):null;return zones.act('',{action,request_id:randomUUID(),controller:'window',character_id:id,revision:s?.character.revision,...(s?.character.dive?{edition:s.dive.edition}:{}),...extra});};
 function player(name='alice',dive=true){owner=name;const c=act(null,'create',{name}).character;act(c.id,'enter',{zone:'princess-rose',loadout,combat_version:3,content_version:1,defeat_version:1});if(dive)act(c.id,'dive_enter',{loadout});return c.id;}
 function state(id,change){const row=db.prepare('SELECT * FROM quest_characters WHERE id=?').get(id),s=JSON.parse(row.state);change(s);db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),id);}
 function position(id,x,y){state(id,s=>{if(s.dive){s.dive.position={x,y};s.dive.safeUntil=time+999999;}});db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(x,y,time,id);}
 function map(zone='dive-quarters'){return zones.world.map(zone);}
 function free(m){for(let y=2;y<m.floor.height-2;y++)for(let x=2;x<m.floor.width-2;x++)if(walkable(m.floor,x,y)&&![m.floor.entrance,...m.floor.enemies,...(m.floor.chests??[]),...(m.floor.pickups??[]),...(m.floor.fixtures??[]),...m.players].some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<3))return {x,y};throw Error('No test placement');}
 function world(action,zone,extra={}){const m=map(zone);return zones.world.act({action,zone,edition:m.edition,revision:m.revision,...extra});}
 function publish(kind,entry){let revision=0;try{revision=live.entry(kind,entry.id).revision;}catch{}return live.change({action:'content_publish',kind,id:entry.id,revision,entry},'dm');}
 return {db,live,read,act,player,state,position,map,free,world,publish,as:name=>owner=name,advance:ms=>time+=ms,tick:()=>{time+=1001;zones.tick();},restart(){zones.close();zones=createQuestZones(db,options);},close(){zones.close();db.close();}};
}

test('drafts, publication, conflicts, reference validation, retirement and rollback',()=>{
 const f=fixture();try{
  const saved=f.live.change({action:'content_save',kind:'monster',id:monster.id,revision:0,entry:monster},'dm');assert.equal(f.live.published().monsters[monster.id],undefined);assert.equal(f.live.published().revision,0);
  assert.throws(()=>f.publish('zone',{...f.live.entry('zone','dive-quarters').draft,pool:[{enemy_id:monster.id,weight:1}]}),/Publish every/);
  assert.throws(()=>f.live.change({action:'content_publish',kind:'monster',id:monster.id,revision:0,entry:monster},'dm'),/changed/);
  f.publish('monster',monster);assert.equal(f.live.published().monsters.test_monster.hp,20);
  f.publish('zone',{...f.live.entry('zone','dive-quarters').draft,pool:[{enemy_id:monster.id,weight:1}]});
  assert.throws(()=>f.publish('monster',{...monster,retired:true}),/Remove this monster/);
  f.publish('monster',{...monster,hp:99});const row=f.live.entry('monster',monster.id);f.live.change({action:'content_rollback',kind:'monster',id:monster.id,revision:row.revision,target_revision:saved.revision+1},'dm');assert.equal(f.live.published().monsters.test_monster.hp,20);
  assert.throws(()=>f.publish('monster',{...monster,enemy_spells:['unknown_spell']}),/existing spells/);
  assert.throws(()=>f.publish('monster',{...monster,defeat:{first:{dialogue:[{id:'a',text:'Hello',actions:[{label:'Missing',next:'b'}]}]}}}),/unknown page/);
  f.restart();assert.equal(f.live.published().monsters.test_monster.hp,20);
 }finally{f.close();}
});

test('live pools reconcile without terrain changes; manual placements preserve definitions and reject stale commands',()=>{
 const f=fixture();try{f.player();f.publish('monster',monster);const before=f.map();f.publish('zone',{...f.live.entry('zone',before.id).draft,enemies_per_room:1,pool:[{enemy_id:monster.id,weight:1}]});f.tick();const after=f.map();assert.deepEqual(after.floor.walls,before.floor.walls);
  const point=f.free(after),placed=f.world('world_place',after.id,{monster:monster.id,...point});const foe=placed.floor.enemies.find(e=>e.manual);assert.equal(foe.definition.hp,20);
  f.publish('monster',{...monster,hp:80});f.tick();assert.equal(f.map().floor.enemies.find(e=>e.id===foe.id).definition.hp,20);
  assert.throws(()=>f.world('world_place',after.id,{monster:monster.id,x:-1,y:-1}),/free tile/);
  assert.throws(()=>f.world('world_remove',after.id,{monster:foe.id,revision:before.revision}),/map changed/);
  f.publish('zone',{...f.live.entry('zone',after.id).draft,spawning:false});f.tick();assert.ok(f.map().floor.enemies.every(e=>e.manual));
 }finally{f.close();}
});

test('regeneration drains battles and defeat scenes, relocates disconnected visitors and resets claims',async()=>{
 const f=fixture();try{const id=f.player();const old=f.map();f.db.prepare('INSERT OR REPLACE INTO dive_progress VALUES (?,?,?,1,?)').run(id,old.floor.route,old.edition,JSON.stringify({claimed:['chest-1'],rolls:{},explored:[1],completed:true,coinsPaid:50}));
  f.state(id,s=>{s.pendingDefeat={id:'scene',readyAt:0,sceneComplete:false};});
  f.world('world_regenerate',old.id,{confirm_reset_rewards:true});f.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.map().job.status,'draining');f.tick();assert.equal(f.map().edition,old.edition);
  f.state(id,s=>{delete s.pendingDefeat;});f.db.prepare('DELETE FROM quest_presence WHERE character_id=?').run(id);f.tick();const next=f.map();assert.notEqual(next.edition,old.edition);assert.notDeepEqual(next.floor.walls,old.floor.walls);
  const state=JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id).state);assert.equal(state.dive.edition,next.edition);assert.deepEqual(state.dive.position,next.floor.entrance);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dive_progress WHERE edition=?').get(next.edition).n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM dive_progress WHERE edition=?').get(old.edition).n,1);
  f.restart();assert.equal(f.map().edition,next.edition);
  assert.throws(()=>f.world('world_place',old.id,{edition:old.edition,revision:old.revision,monster:'diaper_fairy',x:3,y:3}),/map changed/);
 }finally{f.close();}
});

test('regeneration cancellation preserves the active map, including a late worker result',async()=>{
 const f=fixture();try{f.player();const old=f.map();const queued=f.world('world_regenerate',old.id,{confirm_reset_rewards:true});f.tick();f.world('world_cancel',old.id,{job:queued.job.id});await new Promise(resolve=>setImmediate(resolve));f.tick();assert.equal(f.map().edition,old.edition);assert.equal(f.map().job,undefined);}finally{f.close();}
});

test('hub encounters use shared combat and pinned scenes; one-off monsters cannot respawn or award boss coins',()=>{
 const f=fixture();try{const id=f.player('alice',false);f.publish('monster',{...monster,defeat:{first:{dialogue:[{id:'a',text:'Original scene',next:'close'}],aftermath:[]}}});const zone='princess-rose',m=f.map(zone),point=f.free(m);f.world('world_place',zone,{monster:monster.id,...point});const foe=f.map(zone).floor.enemies[0];f.position(id,point.x,point.y);let s=f.act(id,'hub_encounter',{encounter:foe.id});assert.equal(s.character.run.kind,'hub_event');assert.equal(s.encounter.enemies[0].hp,20);
  f.publish('monster',{...monster,hp:80});s=f.read(id);assert.equal(s.encounter.enemies[0].hp,20);assert.throws(()=>f.world('world_remove',zone,{monster:foe.id}),/outside combat/);
  s=f.act(id,'submit',{battle:s.encounter.id,cycle:s.encounter.players[0].cycle});assert.equal(s.character.lastResult.defeatScene.content.first.dialogue[0].text,'Original scene');assert.equal(s.character.lastResult.coins,0);assert.ok(s.character.pendingDefeat);
  const scene=s.character.pendingDefeat.id;f.advance(61000);f.position(id,point.x,point.y);s=f.act(id,'defeat_complete',{scene});assert.equal(s.character.pendingDefeat,undefined);
 }finally{f.close();}
});

test('generation keeps completed walking art after portrait failure and retries without repeating it',async()=>{
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db);let walks=0,posts=0,failPortrait=true;
 const jobs=createWorldJobs(db,{live,token:'test-token',walkProvider:async()=>{walks++;return {png:tiny,reference:tiny};},fetcher:async(url,options)=>{if(options.method==='POST'){posts++;return {ok:true,json:async()=>({background_job_id:'portrait-job'})};}return {ok:true,json:async()=>({status:failPortrait?'failed':'completed',last_response:{images:[{base64:tiny}]}})};}});
 // The workflow test injects an asset encoder; dimensions are validated separately by upload tests.
 const put=live.putAsset;live.putAsset=input=>put({...input,frames:1});
 try{jobs.act({action:'art_generate',prompt:'Test creature'});await jobs.pump();let row=jobs.list()[0];assert.equal(row.status,'failed');assert.ok(row.walking);assert.equal(walks,1);assert.equal(posts,1);failPortrait=false;jobs.act({action:'art_retry',id:row.id});await jobs.pump();row=jobs.list()[0];assert.equal(row.status,'complete');assert.equal(walks,1);assert.equal(posts,2);}finally{jobs.close();db.close();}
});

test('GM world endpoints enforce staff access and replay mutation receipts',async()=>{
 const staff='s'.repeat(43),player='p'.repeat(43),service=createQuestService({walletClient:{authenticate:async token=>({owner:token===staff?'staff':'player',gamemaster:token===staff,client:'lidollquest',coins:0,scope:'social:read'})}});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
 try{assert.equal((await fetch(base+'/gm/content',{headers:{Authorization:'Bearer '+player}})).status,403);const body={action:'content_save',kind:'monster',id:monster.id,revision:0,entry:monster,request_id:randomUUID()};const send=()=>fetch(base+'/gm/action',{method:'POST',headers:{Authorization:'Bearer '+staff,'Content-Type':'application/json'},body:JSON.stringify(body)});const a=await send(),b=await send();assert.equal(a.status,200);assert.deepEqual(await a.json(),await b.json());assert.equal(service.db.prepare('SELECT COUNT(*) n FROM gm_audit WHERE action=?').get('content_save').n,1);const page=await (await fetch(base+'/gm')).text();assert.match(page,/Generation Jobs/);assert.match(page,/function editMonster/);const script=page.match(/<script>([\s\S]*?)<\/script>/)[1];new Function(script);assert.doesNotMatch(script,/\/\/.*(const|let|var)\s+\w+\s*=/,'a line comment swallowed code on the same line');assert.match(script,/const pools=el\('div'\)/);}finally{await new Promise(resolve=>service.server.close(resolve));}
});

test('managed PNGs are immutable, bounded and survive store reconstruction',()=>{
 const db=new DatabaseSync(':memory:');try{const live=createWorldContent(db),asset=live.putAsset({png:tiny});assert.deepEqual(live.putAsset({png:tiny}),asset);assert.equal(createWorldContent(db).asset(asset.id).png,tiny);assert.throws(()=>live.putAsset({png:tiny,frames:36}),/strip/);assert.throws(()=>live.putAsset({png:Buffer.from('not a PNG').toString('base64')}),/PNG/);assert.throws(()=>live.putAsset({png:Buffer.from(tiny,'base64').subarray(0,40).toString('base64')}),/valid PNG/);}finally{db.close();}
});

test('published definitions replace defeated monsters at respawn, not living monsters',()=>{
 const f=fixture();try{f.player();const old=f.map(),foe=old.floor.enemies.find(e=>e.id!=='iris'),original=foe.definition.hp;const definition=f.live.entry('monster',foe.type).draft;f.publish('monster',{...definition,hp:original+100});f.tick();assert.equal(f.map().floor.enemies.find(e=>e.id===foe.id).definition.hp,original);
  const record=f.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(old.floor.route,old.edition),floor=JSON.parse(record.content),target=floor.enemies.find(e=>e.id===foe.id);target.dead=true;target.respawnAt=0;
  f.publish('zone',{...f.live.entry('zone',old.id).draft,pool:[{enemy_id:foe.type,weight:1}]});f.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=?').run(JSON.stringify(floor),old.floor.route,old.edition);f.tick();assert.equal(f.map().floor.enemies.find(e=>e.id===foe.id).definition.hp,original+100);
 }finally{f.close();}
});

test('regeneration waits for real shared combat, then resumes after restart and preserves daily caps',async()=>{
 const f=fixture();try{const id=f.player();const m=f.map(),foe=m.floor.enemies[0];f.position(id,foe.x,foe.y);let s=f.act(id,'dive_engage',{encounter:foe.id});assert.ok(s.encounter);f.db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?)').run('alice',Math.floor(s.serverTime/86400000),499);
  f.world('world_regenerate',m.id,{confirm_reset_rewards:true});f.tick();await new Promise(resolve=>setImmediate(resolve));f.tick();assert.equal(f.map().edition,m.edition);assert.equal(f.map().blockers[0].id,id);
  s=f.read(id);f.act(id,'flee',{battle:s.encounter.id,cycle:s.encounter.players[0].cycle});f.restart();f.tick();assert.notEqual(f.map().edition,m.edition);assert.equal(f.db.prepare('SELECT coins FROM quest_reward_days WHERE owner=?').get('alice').coins,499);
 }finally{f.close();}
});

test('hub automatic aggression requires opt-in and respects active encounters',()=>{
 const f=fixture();try{const id=f.player('alice',false),zone='princess-rose';f.publish('monster',monster);const point=f.free(f.map(zone));f.world('world_place',zone,{monster:monster.id,...point,aggressive:false});f.position(id,point.x,point.y);f.tick();assert.equal(f.read(id).character.run,null);
  const foe=f.map(zone).floor.enemies[0];f.world('world_remove',zone,{monster:foe.id});f.position(id,1,1);f.world('world_place',zone,{monster:monster.id,...point,aggressive:true});f.position(id,point.x,point.y);f.tick();assert.equal(f.read(id).character.run.kind,'hub_event');assert.equal(f.map(zone).floor.enemies.filter(e=>e.engaged).length,1);
 }finally{f.close();}
});

test('hub parties share encounters and retain individual defeat receipts',()=>{
 const f=fixture();try{const alice=f.player('alice',false),bob=f.player('bob',false);f.as('alice');f.act(alice,'party_invite',{member:bob});f.as('bob');f.act(bob,'party_accept',{invitation:f.read(bob).partyInvitations[0].id});f.publish('monster',monster);const zone='princess-rose',point=f.free(f.map(zone));f.world('world_place',zone,{monster:monster.id,...point});f.position(alice,point.x,point.y);f.position(bob,point.x,point.y);f.as('alice');let s=f.act(alice,'hub_encounter',{encounter:f.map(zone).floor.enemies[0].id});assert.equal(s.encounter.players.length,2);const encounter=s.encounter.id;
  f.act(alice,'flee',{battle:encounter,cycle:s.encounter.players.find(p=>p.id===alice).cycle});f.as('bob');s=f.read(bob);assert.equal(s.encounter.id,encounter);f.act(bob,'flee',{battle:encounter,cycle:s.encounter.players.find(p=>p.id===bob).cycle});assert.equal(f.read(bob).character.run,null);f.as('alice');assert.equal(f.read(alice).character.run,null);assert.equal(f.read(alice).party.members.length,2);
 }finally{f.close();}
});

test('custom first/repeat equipment consequences settle once per encounter',()=>{
 const f=fixture();try{const id=f.player('alice',false),state=f.read(id).character,run={kind:'hub_event',id:randomUUID(),enemy:{...monster,defeat:{first:{dialogue:[]}},defeat_equipment:combatData.defeat_equipment.goblin},log:[]};
  const first=applyDefeatEquipment(state,run,'submit');assert.equal(first.variant,'first');const after=JSON.stringify(state);assert.equal(applyDefeatEquipment(state,run,'submit'),undefined);assert.equal(JSON.stringify(state),after);run.id=randomUUID();assert.equal(applyDefeatEquipment(state,run,'defeat').variant,'repeat');
 }finally{f.close();}
});

test('publishing requires compatible entry while retirement and restoration preserve history',()=>{
 const f=fixture();try{const id=f.player('alice',false);f.publish('monster',monster);assert.throws(()=>f.act(id,'enter',{zone:'princess-rose',combat_version:3}),error=>error.code==='client_update_required');assert.equal(f.read(id).character.contentVersion,1);f.publish('monster',{...monster,retired:true});assert.ok(f.live.published().monsters.test_monster.retired);f.publish('monster',monster);assert.equal(f.live.published().monsters.test_monster.retired,false);assert.equal(f.live.entry('monster',monster.id).history.length,3);}finally{f.close();}
});
