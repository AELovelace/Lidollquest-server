import test from 'node:test';
import assert from 'node:assert/strict';
import {importLoadout} from '../server/loadout.mjs';

const base=inventory=>({player_info:{level:1,playerHealth:100,playerHealthMax:100},inventory}); // Smallest loadout importLoadout accepts.

test('importLoadout keeps gold as a pigment colour but still strips currency keys everywhere else',()=>{
 const nectar={item_id:'honeydew_nectar',category:'ingredient',alchemy:{role:'liquid',tier:2,pigments:{gold:3,yellow:1},traits:{}}}; // Honeydew Nectar brews gold (dive-data.json alchemy.ingredients).
 const result=importLoadout({...base([nectar,{item_id:'purse',gold:999,coins:5,nested:{diamonds:2,pigments:{gold:1,coins:4}}}]),gold:50,player_info:{level:1,playerHealth:100,playerHealthMax:100,coins:12,wallet:{balance:9}}});
 assert.deepEqual(result.inventory[0].alchemy.pigments,{gold:3,yellow:1}); // Regression (2026-10-07 deploy): the currency filter used to delete the gold colour, so the item changed on every enter/world_turn.
 assert.deepEqual(result.inventory[1],{item_id:'purse',nested:{pigments:{gold:1,coins:4}}}); // Item-level gold/coins and nested diamonds are still dropped; only a pigments map's own keys are exempt.
 assert.equal(result.player_info.coins,undefined);assert.equal(result.player_info.wallet,undefined);assert.equal(result.gold,undefined); // Stats never carry currency.
});
