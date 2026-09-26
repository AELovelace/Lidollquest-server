import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDungeonEffects} from '../server/full-dungeon-rules.mjs';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {publicCombatState} from '../server/defeat-scenes.mjs';
import {importLoadout} from '../server/loadout.mjs';

test('dungeon XP preserves an explicit idle run through saving, including level-up',()=>{
 const state={run:null,loadout:importLoadout({player_info:{level:1,xp:0,playerHealth:100,playerHealthMax:100},inventory:[]})};
 for(const amount of [5,500]){
  applyDungeonEffects([{type:'xp',amount}],{id:'alice'},state,{data:fullDungeons[0],roll:()=>0});
  assert.equal(state.run,null);assert.equal(JSON.parse(JSON.stringify(state)).run,null);
 }
 assert.ok(state.loadout.player_info.level>1);
});

test('legacy saved characters missing run serialize as idle without changing the stored object',()=>{
 const saved={wins:0,lastResult:null},view=JSON.parse(JSON.stringify(publicCombatState(saved)));
 assert.equal(view.run,null);assert.equal(Object.hasOwn(saved,'run'),false);
 const fighting={run:{id:'fight',enemy:{name:'Monster',hp:10,defeat:{private:'scene'}}}};
 const combat=publicCombatState(fighting);assert.equal(combat.run.id,'fight');assert.equal(combat.run.enemy.hp,10);assert.equal(combat.run.enemy.defeat,undefined);
 assert.ok(fighting.run.enemy.defeat); // Normalization never mutates saved battles or their private defeat content.
});
