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
