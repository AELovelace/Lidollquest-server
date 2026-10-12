import test from 'node:test';
import assert from 'node:assert/strict';
import {importLoadout,MAX_LOADOUT_BYTES} from '../server/loadout.mjs';
import {expandLoadoutDelta} from '../server/loadout-delta.mjs';

const base=inventory=>({player_info:{level:1,playerHealth:100,playerHealthMax:100},inventory}); // Smallest loadout importLoadout accepts.

test('importLoadout keeps gold as a pigment colour but still strips currency keys everywhere else',()=>{
 const nectar={item_id:'honeydew_nectar',category:'ingredient',alchemy:{role:'liquid',tier:2,pigments:{gold:3,yellow:1},traits:{}}}; // Honeydew Nectar brews gold (dive-data.json alchemy.ingredients).
 const result=importLoadout({...base([nectar,{item_id:'purse',gold:999,coins:5,nested:{diamonds:2,pigments:{gold:1,coins:4}}}]),gold:50,player_info:{level:1,playerHealth:100,playerHealthMax:100,coins:12,wallet:{balance:9}}});
 assert.deepEqual(result.inventory[0].alchemy.pigments,{gold:3,yellow:1}); // Regression (2026-10-07 deploy): the currency filter used to delete the gold colour, so the item changed on every enter/world_turn.
 assert.deepEqual(result.inventory[1],{item_id:'purse',nested:{pigments:{gold:1,coins:4}}}); // Item-level gold/coins and nested diamonds are still dropped; only a pigments map's own keys are exempt.
 assert.equal(result.player_info.coins,undefined);assert.equal(result.player_info.wallet,undefined);assert.equal(result.gold,undefined); // Stats never carry currency.
});

test('legitimate large inventories fit stored character limits without weakening the final bound',()=>{
 const input=base(Array.from({length:99},(_,i)=>({item_id:'gear-'+i,desc:'x'.repeat(2200)})));
 assert.equal(MAX_LOADOUT_BYTES,256*1024);assert.ok(Buffer.byteLength(JSON.stringify(input))>192*1024);
 assert.deepEqual(importLoadout(input).inventory,input.inventory);
 const boundary=base([]);boundary.player_info.note='x'.repeat(MAX_LOADOUT_BYTES-Buffer.byteLength(JSON.stringify(boundary))-10); // The note property adds ten JSON bytes.
 assert.equal(Buffer.byteLength(JSON.stringify(boundary)),MAX_LOADOUT_BYTES);assert.doesNotThrow(()=>importLoadout(boundary));
 boundary.player_info.note+='x';assert.throws(()=>importLoadout(boundary),/too large/);
 assert.throws(()=>importLoadout({...base([]),player_info:{note:'x'.repeat(MAX_LOADOUT_BYTES)}}),/too large/);
});

test('compact changes retain a large bag, remove expired fields, and splice only the used item',()=>{
 const input=base(Array.from({length:99},(_,i)=>({item_id:'gear-'+i,desc:'x'.repeat(2200)})));input.player_info.buff=3;
 const patch=[{path:['player_info','playerHealth'],before:100,after:99},{path:['player_info','buff'],before:3,remove:true},{path:['inventory'],index:2,before:[input.inventory[2]],after:[]}];
 const output=importLoadout(expandLoadoutDelta(input,patch));
 assert.equal(output.player_info.playerHealth,99);assert.equal(output.player_info.buff,undefined);assert.equal(input.player_info.buff,3);
 assert.deepEqual(output.inventory,[...input.inventory.slice(0,2),...input.inventory.slice(3)]);assert.ok(Buffer.byteLength(JSON.stringify(patch))<4000);
});

test('item field changes preserve descriptions while adding runtime defaults and removing expired modifiers',()=>{
 const input=base([{item_id:'boots',desc:'x'.repeat(3000),temporary:2}]);
 const output=importLoadout(expandLoadoutDelta(input,[{path:['inventory'],index:0,fields:{quantity:{before:null,after:1},temporary:{before:2,remove:true}}}]));
 assert.equal(output.inventory[0].desc,input.inventory[0].desc);assert.equal(output.inventory[0].quantity,1);assert.equal(output.inventory[0].temporary,undefined);
 assert.throws(()=>expandLoadoutDelta(input,[{path:['inventory'],index:0,fields:{temporary:{before:3,after:4}}}]),/changed/);
 assert.throws(()=>expandLoadoutDelta(input,[{path:['inventory'],index:0,fields:JSON.parse('{"__proto__":{"before":null,"after":{}}}')}]),/changed/);
});

test('compact changes reject stale fields, bad inventory offsets, pollution, and excessive data',()=>{
 const input=base([{item_id:'boots'}]);
 for(const patch of [
  [{path:['player_info','playerHealth'],before:99,after:98}],
  [{path:['inventory'],index:2,before:[],after:[]}],
  [{path:['inventory'],index:0,before:[{item_id:'hat'}],after:[]}],
  [{path:['player_info','__proto__','bad'],before:null,after:true}],
  [{path:['wallet'],before:null,after:999}],
  [{path:['player_info','note'],before:null,after:'x'.repeat(192*1024)}],
 ])assert.throws(()=>expandLoadoutDelta(input,patch),e=>e.code==='loadout_conflict');
 assert.equal({}.bad,undefined);assert.deepEqual(input,base([{item_id:'boots'}]));
});
