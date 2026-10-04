import test from 'node:test';
import assert from 'node:assert/strict';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {generateFullDungeon,validateFullDungeon,dungeonReachable} from '../server/full-dungeon-generation.mjs';
import {industrialControl,industrialStep,industrialUnlocked,prepareIndustrialBoss} from '../server/arcadia-industrial.mjs';
import {enemyAction} from '../server/combat.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createWorldContent} from '../server/world-content.mjs';
import {craftingData,planCraft} from '../server/crafting.mjs';

const routes=fullDungeons.filter(d=>d.config.industrial);
test('factory maze keeps compact departments, branching salvage, clear aisles and themed rewards',()=>{
 const data=routes.find(d=>d.config.industrial.kind==='production');
 for(let seed=0;seed<30;seed++){
  const f=generateFullDungeon(data,'factory-dressing-'+seed);
  assert.equal(validateFullDungeon(f),true);
  assert.ok(f.rooms.every(r=>r.w<=12&&r.h<=12),'factory returned to oversized square halls');
  assert.ok(f.walls.flat().filter(v=>v===0).length<f.width*f.height/2,'walls must separate the maintenance passages');
  const distances=new Map(),queue=[{...f.entrance,d:0}];
  for(let n=0;n<queue.length;n++){
   const p=queue[n],key=p.x+','+p.y;if(distances.has(key)||f.walls[p.y]?.[p.x]!==0)continue;
   distances.set(key,p.d);for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]])queue.push({x:p.x+dx,y:p.y+dy,d:p.d+1});
  }
  assert.ok([...distances].some(([key,d])=>{const [x,y]=key.split(',').map(Number);return d>Math.abs(x-f.entrance.x)+Math.abs(y-f.entrance.y)+20;}),'factory needs winding exploration routes'); // Loops may shorten department travel, while optional branches still require turns.
  const branches=f.chests.filter(p=>p.id.startsWith('maintenance-salvage-'));
  assert.ok(branches.length>=3,'maze side branches need discoverable salvage');
  for(const p of branches){
   assert.deepEqual(p.loot_pool,['clockwork_parts']);
   assert.ok(!f.rooms.some(r=>p.x>=r.x&&p.x<r.x+r.w&&p.y>=r.y&&p.y<r.y+r.h));
  }
  for(const [i,r] of f.rooms.entries()){
   const scenery=f.decorations.filter(p=>p.id.startsWith(`scenery-${i}-`));
   // Compact chambers may reject large props, especially beside the reserved push puzzle.
   assert.ok(scenery.length<=data.config.room_dressing[r.type]);
   for(const p of scenery){
    assert.ok(data.detail_profiles.some(v=>v.sprite===p.sprite&&v.room_types.includes(r.type)));
    for(let y=p.y;y<p.y+p.span_h;y++)for(let x=p.x;x<p.x+p.span_w;x++){
     assert.ok(Math.abs(x-r.cx)>1&&Math.abs(y-r.cy)>1,'central aisle covered');
     assert.equal(f.props[y][x],1);
    }
   }
   if(data.room_items[r.type])assert.deepEqual(f.pickups.find(p=>p.kind==='treasure'&&p.room_type===r.type).loot_pool,data.room_items[r.type]);
   for(const enemy of f.enemies.filter(e=>e.id.startsWith(`enemy-${i}-`)))assert.ok(data.room_enemies[r.type].includes(enemy.type));
  }
  for(const fix of f.fixtures.filter(p=>p.hazard))for(let x=fix.hazard.x;x<fix.hazard.x+fix.hazard.w;x++){
   assert.ok(!f.decorations.some(p=>p.id.startsWith('scenery-')&&x>=p.x&&x<p.x+p.span_w&&fix.hazard.y>=p.y&&fix.hazard.y<p.y+p.span_h));
  } // Dressing may surround production lanes, but cannot hide them with solid scenery.
 }
});

test('factory maze remains deterministic and connected with zero extra shortcuts',()=>{
 const data=structuredClone(routes.find(d=>d.config.industrial.kind==='production'));
 data.structure.extra_loops=0;
 const f=generateFullDungeon(data,'factory-tree');
 assert.equal(validateFullDungeon(f),true);
 assert.deepEqual(generateFullDungeon(data,'factory-tree'),f);
});
test('dockyard has compact warehouses, long piers, winding quays and clear cargo aprons',()=>{
 const data=routes.find(d=>d.config.industrial.kind==='cargo');
 for(let seed=0;seed<30;seed++){
  const f=generateFullDungeon(data,'dock-maze-'+seed);
  assert.equal(validateFullDungeon(f),true);
  assert.ok(f.rooms.every(r=>r.w*r.h<=143),'dockyard returned to oversized square platforms');
  for(const type of ['mooring_pier','cargo_hold','outbound_freighter']){
   const r=f.rooms.find(r=>r.type===type);assert.ok(r.h>r.w,'pier decks should be elongated');
  }
  assert.ok(f.walls.flat().filter(v=>v===0).length<f.width*f.height/2,'harbour water must separate the quays');
  const distances=new Map(),queue=[{...f.entrance,d:0}];
  for(let n=0;n<queue.length;n++){
   const p=queue[n],key=p.x+','+p.y;if(distances.has(key)||f.walls[p.y]?.[p.x]!==0)continue;
   distances.set(key,p.d);for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]])queue.push({x:p.x+dx,y:p.y+dy,d:p.d+1});
  }
  assert.ok([...distances].some(([key,d])=>{const [x,y]=key.split(',').map(Number);return d>Math.abs(x-f.entrance.x)+Math.abs(y-f.entrance.y)+20;}),'quays need winding exploration routes');
  const salvage=f.chests.filter(p=>p.id.startsWith('quay-salvage-'));assert.ok(salvage.length>=1);
  for(const p of salvage)assert.deepEqual(p.loot_pool,['dock_fittings']);
  for(const fix of f.fixtures.filter(p=>p.kind==='industrial'))for(const berth of fix.berths){
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(dx===0&&dy===0)continue;
    assert.equal(f.walls[berth.y+dy][berth.x+dx],0);
    assert.equal(f.props[berth.y+dy][berth.x+dx],0,'moving cargo must retain a clear surrounding ring');
   }
  } // A clear ring makes every berth safe regardless of the other cranes' states.
 }
});

test('industrial boss editing preserves phases and crafting consumes both new salvage materials',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const live=createWorldContent(db);live.register(routes[0]);
  const entry=live.entry('monster','superintendent_brassbound');
  const body={...entry.draft,hp:300};delete body.industrial_phases;
  live.change({action:'content_publish',kind:'monster',id:entry.id,revision:entry.revision,entry:body},'gm');
  const published=live.resolve(routes[0]).enemies.superintendent_brassbound;
  assert.equal(published.hp,300);assert.equal(published.industrial_phases.length,3);assert.equal(published.tier,'boss');
 }finally{db.close();}
 for(const recipe of craftingData.recipes.filter(v=>v.id.startsWith('arcadia_'))){
  const loadout={player_info:{level:20,smithing_level:100,tailoring_level:100},inventory:Object.entries(recipe.ingredients).map(([item_id,quantity])=>({item_id,quantity,category:'ingredient'}))};
  const plan=planCraft(loadout,{discipline:recipe.discipline,station:recipe.discipline==='smithing'?'forge':'sewing_table',materials:recipe.ingredients},'arcadia-recipe-'+recipe.id);
  assert.ok(plan.item);assert.deepEqual(plan.consumed,recipe.ingredients);
 }
});
test('both industrial routes have independent IDs, no quest residents, and protected recovery rooms',()=>{
 assert.equal(routes.length,2);
 for(const data of routes){
  assert.deepEqual(data.npcs,{});assert.deepEqual(data.narratives,{});
  const f=generateFullDungeon(data,'industrial-contract'),r=f.rooms.find(r=>r.type===data.config.recovery_room);
  assert.ok(f.safeRooms.some(v=>v.x===r.x&&v.y===r.y&&v.w===r.w));
  assert.ok(f.fixtures.some(v=>v.kind==='bed'&&v.x>=r.x&&v.x<r.x+r.w));
  assert.equal(f.fixtures.filter(v=>v.kind==='industrial').length,3);
  assert.ok(f.chests.some(v=>v.requires_machine));assert.ok(!f.fixtures.some(v=>v.kind==='quest_board'));
  assert.equal(data.config.entrance_side==='north'?f.exits[0].y:f.exits[0].x,1);
 }
});

test('cargo controls reject stale/occupied berths and retain solvability through every state and reload',()=>{
 const data=routes.find(d=>d.config.industrial.kind==='cargo');
 for(let seed=0;seed<30;seed++){
  let f=generateFullDungeon(data,'cargo-states-'+seed);
  for(const original of f.fixtures.filter(v=>v.kind==='industrial')){
   const id=original.id;
   for(let step=0;step<3;step++){
    const fix=f.fixtures.find(v=>v.id===id),at=fix.berths[(fix.state+1)%3],before=JSON.stringify(f);
    assert.throws(()=>industrialControl(f,fix,{mechanism_revision:f.mechanismRevision},[at]),/Clear/);
    assert.equal(JSON.stringify(f),before);
    assert.throws(()=>industrialControl(f,fix,{mechanism_revision:-1}),/changed/);
    industrialControl(f,fix,{mechanism_revision:f.mechanismRevision});
    assert.equal(validateFullDungeon(f),true);assert.ok(dungeonReachable(f).has(f.entrance.x+','+f.entrance.y));
    assert.equal(industrialUnlocked(fix),fix.state===2);
    f=JSON.parse(JSON.stringify(f));
   }
  }
 }
});

test('production cycles warn, damage only active lanes, and stop after an authoritative cutoff',()=>{
 const f=generateFullDungeon(routes.find(d=>d.config.industrial.kind==='production'),'factory-cycle'),fix=f.fixtures.find(v=>v.kind==='industrial'),p={x:fix.hazard.x,y:fix.hazard.y};
 let personal={};const damage=[];
 for(let i=0;i<6;i++){damage.push(industrialStep(f,personal,p));personal=JSON.parse(JSON.stringify(personal));}
 assert.deepEqual(damage,[0,3,3,0,0,0]);
 industrialControl(f,fix,{mechanism_revision:f.mechanismRevision});
 for(let i=0;i<12;i++)assert.equal(industrialStep(f,personal,p),0);
});

test('support advantage is pinned and industrial bosses telegraph before striking',()=>{
 const data=routes[0],f=generateFullDungeon(data,'industrial-boss');
 const enemy=structuredClone(data.enemies.superintendent_brassbound);
 for(const fix of f.fixtures.filter(v=>v.kind==='industrial'))industrialControl(f,fix,{mechanism_revision:f.mechanismRevision});
 prepareIndustrialBoss(enemy,f);assert.equal(enemy.industrialSuppression,3);
 const state={loadout:{world:{},player_info:{playerHealth:100,playerHealthMax:100,stamina:100,stamina_max:100}},run:{enemy:{...enemy,turn:0},hp:100,maxHp:100,log:[],defense:5}};
 assert.equal(enemyAction(state,{theme:data.config.theme},()=>99),'continue');assert.equal(state.run.hp,100);
 enemyAction(state,{theme:data.config.theme},()=>99);assert.ok(state.run.hp<100);
 assert.match(state.run.log.join(' '),/Inspection.*Assembly/s);
});
