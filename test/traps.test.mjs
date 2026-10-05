import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createTrapStore,validateTrap,shippedTraps,trapZoneKeys} from '../server/trap-store.mjs';
import {createDungeonRules} from '../server/full-dungeon-rules.mjs';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestService} from '../server/service.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';

const shipped=shippedTraps(),vocab={zoneKeys:shipped.zone_keys,triggerStyles:shipped.trigger_styles,narratives:shipped.narratives};
const custom={trap_id:'gm_test_splash',name:'Test Splash',type:'wet',weight:3,zones:['any'],amount:5,message:'Cold water! Wet +{value}.'};

test('the shipped trap registry is whole, clean and passes the same validation as GM edits',()=>{
 assert.ok(Object.keys(shipped.traps).length>=80);
 assert.ok(!Object.keys(shipped.traps).some(id=>id.startsWith('tq_')),'campaign tq_ traps were removed from the client');
 for(const [id,trap] of Object.entries(shipped.traps)){assert.equal(trap.trap_id,id);assert.deepEqual(validateTrap(trap,vocab).trap_id,id);if(trap.narrative_chunk)assert.ok(shipped.narratives[trap.narrative_chunk],id+' narrative ships');}
});

test('trap validation refuses malformed entries before they can reach a floor',()=>{
 const bad=(patch,pattern)=>assert.throws(()=>validateTrap({...custom,...patch},vocab),pattern);
 bad({trap_id:'Bad Id'},/Trap id/);bad({type:'explode'},/Type must be/);bad({weight:0},/Weight/);bad({weight:1.5},/whole number/);
 bad({zones:[]},/at least one zone/);bad({zones:['moon']},/not a trap zone/);bad({name:''},/name/);bad({message:' '},/message/);
 bad({amount:undefined,min:9,max:2},/Min cannot be above max/);bad({min:2},/both min and max/);bad({trigger_style:'laser'},/Trigger style/);
 bad({narrative_chunk:'trap_nope'},/shipped trap narratives/);bad({surprise:true},/Unknown trap fields/);bad({lingering_wet:2},/lingering_turns/);
 bad({avoid_check:{label:'Dodge',stat:'LUCK',difficulty:10}},/stat must be/);bad({avoid_check:{label:'Dodge',stat:'DEX',difficulty:99}},/difficulty/);
 bad({resist_check:{label:'Hold',stat:'DEF',difficulty:10,state_modifiers:[{bonus:2}]}},/needs a state/);bad({enemy_id:'slime'},/spawn_enemy/);
 const ok=validateTrap({...custom,avoid_check:{label:'Hop',stat:'dex',difficulty:'11',state_modifiers:[{state:'crawling',bonus:3}],success_text:'Clear!'}},vocab);
 assert.equal(ok.avoid_check.stat,'DEX');assert.equal(ok.avoid_check.difficulty,11);assert.deepEqual(ok.avoid_check.state_modifiers,[{state:'crawling',bonus:3}]);
});

test('the store layers edits, custom traps, retirement and restore over the shipped registry with a moving revision',()=>{
 const db=new DatabaseSync(':memory:'),store=createTrapStore(db,{now:()=>5});
 try{
  const base=Object.keys(shipped.traps),r0=store.revision();assert.deepEqual(Object.keys(store.registry()),base);assert.ok(store.list().every(e=>e.status==='shipped'));
  store.save(custom,'gm');const r1=store.revision();assert.ok(r1>r0);assert.deepEqual(Object.keys(store.registry()),[...base,custom.trap_id],'custom traps follow the shipped order');assert.equal(store.status(custom.trap_id),'custom');
  assert.ok(store.pool(['any','nursery']).some(t=>t.trap_id===custom.trap_id),"an 'any' trap joins every pool");assert.ok(!store.pool(['town']).some(t=>t.trap_id==='nursery_'+'x'));
  const spike={...shipped.traps.spike_damage,min:1,max:2};store.save(spike);assert.equal(store.status('spike_damage'),'edited');assert.equal(store.registry().spike_damage.max,2);assert.deepEqual(Object.keys(store.registry()).indexOf('spike_damage'),base.indexOf('spike_damage'),'an edit keeps its pool position');
  store.retire('spike_damage');assert.equal(store.status('spike_damage'),'retired');assert.equal(store.registry().spike_damage,undefined);assert.ok(!store.pool(['any']).some(t=>t.trap_id==='spike_damage'));
  store.restore('spike_damage');assert.equal(store.registry().spike_damage.max,2,'restoring a retirement keeps the edit');
  store.restore('spike_damage');assert.deepEqual(store.registry().spike_damage,shipped.traps.spike_damage,'restoring an edit returns the shipped trap');assert.equal(store.status('spike_damage'),'shipped');
  assert.throws(()=>store.restore('spike_damage'),/already matches/);
  store.retire('healing_rune');store.restore('healing_rune');assert.deepEqual(store.registry().healing_rune,shipped.traps.healing_rune);
  store.retire(custom.trap_id);assert.equal(store.registry()[custom.trap_id],undefined);store.restore(custom.trap_id);assert.equal(store.registry()[custom.trap_id].amount,5);
  assert.throws(()=>store.retire('no_such_trap'),/does not exist/);
  const file=store.clientFile();assert.equal(file._zone_keys,shipped._zone_keys);assert.equal(file.traps[custom.trap_id].name,'Test Splash');
  const other=createTrapStore(db);assert.equal(other.revision(),store.revision(),'a second store on the same database sees the same revision');
  const before=store.revision();store.reset();assert.ok(store.revision()>before);assert.deepEqual(Object.keys(store.registry()),base);
 }finally{db.close();}
});

test('with no overrides every full-dungeon route draws exactly its old exported trap pool, and the store reaches floors live',()=>{
 const db=new DatabaseSync(':memory:'),store=createTrapStore(db);
 try{
  const routes=fullDungeons.filter(d=>d.trap_zones);assert.ok(routes.length>=4);
  for(const d of fullDungeons){
   const keys=trapZoneKeys(d.config.zone_id,{fullDungeons});assert.deepEqual(store.pool(keys).map(t=>t.trap_id),Object.keys(d.traps??{}),d.config.route);
   assert.deepEqual(store.pool(keys),Object.values(d.traps??{}));
  }
  const data=routes[0],c={id:'alice'},record={edition:'week',floor:{}},state=()=>({loadout:{player_info:{playerHealth:100,playerHealthMax:100,shame:500,str:5},inventory:[],world:{}}});
  const run=traps=>{const mem=new Map(),rolls=[3,1,4,1,5,9,2,6,5,3,5,8,9,7,9];let n=0;const rules=createDungeonRules({data,db:{},now:()=>0,roll:max=>rolls[n++%rolls.length]%Math.max(1,max),progress:c=>structuredClone(mem.get(c.id)??{}),saveProgress:(c,e,p)=>mem.set(c.id,p),saveFloor:()=>{},traps}),s=state();rules.trap(c,s,record,'trap-1');return {s,scene:rules.scene(s)};};
  const old=run(null),live=run(store);assert.deepEqual(live.s.loadout,old.s.loadout);assert.equal(live.scene.title,old.scene.title);
  for(const t of Object.values(store.registry()))if(t.zones.some(z=>['any',data.config.event_zone].includes(z)))store.retire(t.trap_id);
  store.save({...custom,trap_id:'gm_only_trap',zones:[data.config.event_zone]});
  const edited=run(store);assert.equal(edited.s.loadout.player_info.wet,5,'the only live trap in the pool springs');
 }finally{db.close();}
});

function boot(db,{gm}){
 const live=createWorldContent(db,{equipment:hubData.equipment,spells:combatData.spells});let now=Date.parse('2026-09-20T12:00:00Z');
 const api=createQuestZones(db,{live,now:()=>now,roll:()=>0,grant:()=>({owner:'walker',id:'grant',client:'lidollquest',gamemaster:gm.value}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 return {api,tick:ms=>{now+=ms;}};
}

test('Map Editor trap placements validate, stay hidden from players and spring once per character per edition on walk-on',()=>{
 const db=new DatabaseSync(':memory:'),gm={value:true},{api,tick}=boot(db,{gm}),store=createTrapStore(db);let c;
 const act=(action,extra={})=>{tick(1000);const r=api.act('',{action,controller:'controller',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 const read=()=>{const r=api.read('',c.id);c=r.character;return r;};
 try{
  store.save(custom);
  act('create',{name:'Walker'});act('enter',{zone:'honeydew-lantern',flow_version:1,quest_version:1,content_version:1,combat_version:3,loadout:{player_info:{playerHealth:20,playerHealthMax:20,level:1,wet:0},inventory:[],player_spells:[]}});
  let map=api.world.map('honeydew-lantern');const place=(content,extra={})=>{for(let y=3;y<map.floor.height-3;y++)for(let x=3;x<map.floor.width-3;x++)try{map=api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'trap',content,x,y,...extra});return map.placements.at(-1);}catch(e){if(!/reachable tile|away from/.test(e.message))throw e;}throw Error('no tile');};
  assert.throws(()=>api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'trap',content:'no_such_trap',x:5,y:5}),/live trap/);
  const random=place('');assert.equal(random.kind,'trap');assert.equal(random.content,'');assert.equal(random.name,'Random trap');
  map=api.world.act({action:'world_remove_content',zone:map.id,edition:map.edition,revision:map.revision,placement:random.id});
  const trap=place(custom.trap_id);assert.equal(trap.name,'Test Splash');assert.equal(trap.sprite,'');
  assert.ok(read().worldPlacements.some(p=>p.id===trap.id),'gamemasters see trap placements');
  gm.value=false;assert.ok(!read().worldPlacements.some(p=>p.kind==='trap'),'players receive no trap placement or position');
  // Walk onto it from a neighbouring floor tile.
  let from=null;const floor=api.world.map('honeydew-lantern').floor;
  for(const [dx,dy,dir] of [[-1,0,'east'],[1,0,'west'],[0,-1,'south'],[0,1,'north']]){const x=trap.x+dx,y=trap.y+dy;if(floor.walls?.[y]?.[x]===0){from={x,y,dir,back:{east:'west',west:'east',south:'north',north:'south'}[dir]};break;}}
  assert.ok(from,'a walkable neighbour');
  db.prepare('UPDATE quest_presence SET x=?,y=?,moved=0 WHERE character_id=?').run(from.x,from.y,c.id);
  let r=act('move',{direction:from.dir});assert.deepEqual(r.position,{x:trap.x,y:trap.y},'traps never block movement');
  assert.equal(r.character.loadout?.player_info?.wet??JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state).loadout.player_info.wet,5);
  assert.equal(r.trapScene.title,'Test Splash');assert.match(r.trapScene.text,/Wet \+5/);assert.equal(r.trapScene.actions.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM placed_trap_triggers WHERE character_id=?').get(c.id).n,1);
  r=act('trap_scene_choice',{scene:r.trapScene.id,page:r.trapScene.page,mechanism_revision:r.trapScene.revision,choice:-1});assert.equal(r.trapScene,null);
  act('move',{direction:from.back});r=act('move',{direction:from.dir});assert.deepEqual(r.position,{x:trap.x,y:trap.y});
  const wet=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state).loadout.player_info.wet;assert.equal(wet,5,'springs once per character per edition');assert.equal(r.trapScene,null);
  store.retire(custom.trap_id);assert.equal(store.registry()[custom.trap_id],undefined);
 }finally{api.close();db.close();}
});

test('the /gm Traps tab routes and actions require staff, validate and audit, and export the client file',async()=>{
 const staffToken='s'.repeat(43),playerToken='p'.repeat(43),accounts={[staffToken]:{owner:'a'.repeat(64),gamemaster:true},[playerToken]:{owner:'o'.repeat(64),gamemaster:false}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant',client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};},async device(){throw Error('unused');},async deviceToken(){throw Error('unused');}};
 const service=createQuestService({gmEnabled:true,now:()=>1000000,walletClient});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+service.server.address().port;
 const gm=async(path,{token=staffToken,body}={})=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,headers:response.headers,text:await response.text()};};
 const json=r=>JSON.parse(r.text),act=(action,payload,token)=>gm('/gm/action',{token,body:{action,...payload}});
 try{
  assert.equal((await gm('/gm/traps',{token:playerToken})).status,403);assert.equal((await gm('/gm/traps',{token:null})).status,401);
  const view=json(await gm('/gm/traps'));assert.equal(view.counts.overrides,0);assert.ok(view.entries.every(e=>e.status==='shipped'&&e.baseline));assert.deepEqual(Object.keys(view.effective),Object.keys(shipped.traps));assert.ok(view.zoneKeys.includes('town'));assert.ok(view.types.includes('civic_reward'));
  assert.equal((await act('trap_save',{trap:custom},playerToken)).status,403);
  const refused=await act('trap_save',{trap:{...custom,zones:['moon']}});assert.equal(refused.status,400);assert.match(json(refused).error_description,/not a trap zone/);
  const saved=json(await act('trap_save',{trap:custom,reason:'Event trap.'}));assert.equal(saved.result.status,'custom');assert.ok(saved.result.revision>view.revision);
  assert.equal(json(await act('trap_retire',{id:'spike_damage',reason:'Too harsh.'})).result.status,'retired');
  let after=json(await gm('/gm/traps'));assert.equal(after.entries.find(e=>e.id==='spike_damage').status,'retired');assert.equal(after.effective.spike_damage,undefined);assert.equal(after.counts.retired,1);
  assert.equal(json(await act('trap_restore',{id:'spike_damage'})).result.status,'shipped');
  const file=await gm('/gm/traps.json');assert.equal(file.status,200);assert.match(file.headers.get('content-disposition'),/traps\.json/);const client=JSON.parse(file.text);assert.equal(client.traps[custom.trap_id].name,'Test Splash');assert.ok(client._zone_keys);assert.ok(client.traps.spike_damage);
  assert.equal((await gm('/gm/traps.json',{token:playerToken})).status,403);
  const content=json(await gm('/gm/content'));assert.ok(content.traps.some(t=>t.id===custom.trap_id));
  assert.equal((await act('trap_reset',{})).status,400);assert.equal((await act('trap_reset',{confirm:true})).status,200);
  const audit=json(await gm('/gm/overview')).audit.map(a=>a.action);for(const a of ['trap_save','trap_retire','trap_restore','trap_reset'])assert.ok(audit.includes(a),a+' is audited');
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));service.close?.();}
});
