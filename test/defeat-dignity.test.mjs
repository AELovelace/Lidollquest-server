import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDefeatDignity} from '../server/defeat-dignity.mjs';
import {DEFAULT_TUNING} from '../server/loot.mjs';

const state=(dignity=1024,childish=0,shame=100/3)=>({loadout:{player_info:{shame:dignity,shame_level:shame},inventory:[],childish}}); // `shame` stores Dignity; shame_level 33.3 is the x1.0 break-even.
const run=(id='fight-1')=>({id,log:[]});

test('a lost fight costs 64 dignity, or 96 in a childish outfit, at break-even Shame',()=>{
 const plain=state(),r=run();assert.equal(applyDefeatDignity(plain,r,'defeat').length,2);assert.equal(plain.loadout.player_info.shame,960);
 assert.match(r.log.at(-1),/Dignity -64 \(960 \/ 1024\)\./);
 const cute=state(1024,7);applyDefeatDignity(cute,run(),'charm_backfire');assert.equal(cute.loadout.player_info.shame,928);
 for(const outcome of ['submit','submitted']){const s=state();applyDefeatDignity(s,run(),outcome);assert.equal(s.loadout.player_info.shame,960);} // Giving up is still losing.
});

test('Shame multiplies the loss from x0.5 (calm) to x2 (mortified) and the log says so',()=>{
 const calm=state(1024,0,0);applyDefeatDignity(calm,run(),'defeat');assert.equal(calm.loadout.player_info.shame,992);
 const mortified=state(1024,0,100),r=run();applyDefeatDignity(mortified,r,'defeat');assert.equal(mortified.loadout.player_info.shame,896);
 assert.match(r.log.at(-1),/Dignity -128 .* Shame 100 made it x2\.00\./);
 const legacy={loadout:{player_info:{shame:1024},inventory:[]}};applyDefeatDignity(legacy,run(),'defeat');assert.equal(legacy.loadout.player_info.shame,992,'no shame_level yet reads as calm');
});

test('wins, fleeing and forfeits keep dignity; one fight never drains twice; 0 tuning switches it off',()=>{
 for(const outcome of ['win','flee','forfeit','abandoned']){const s=state();assert.deepEqual(applyDefeatDignity(s,run(),outcome),[]);assert.equal(s.loadout.player_info.shame,1024);}
 const s=state(),r=run();applyDefeatDignity(s,r,'defeat');assert.deepEqual(applyDefeatDignity(s,r,'defeat'),[]);assert.equal(s.loadout.player_info.shame,960); // Polling/reconnect replay.
 applyDefeatDignity(s,run('fight-2'),'defeat');assert.equal(s.loadout.player_info.shame,896); // The next fight is a new loss.
 const off=state(),quiet=run();assert.deepEqual(applyDefeatDignity(off,quiet,'defeat',{...DEFAULT_TUNING,defeat_dignity_loss:0}),[]);assert.equal(off.loadout.player_info.shame,1024);assert.deepEqual(quiet.log,[]);
});

test('dignity floors at zero, missing dignity reads as a fresh adult, and deeper tiers get their own lines',()=>{
 const low=state(40);applyDefeatDignity(low,run(),'defeat');assert.equal(low.loadout.player_info.shame,0);
 const fresh={loadout:{player_info:{shame_level:100/3},inventory:[]}};applyDefeatDignity(fresh,run(),'defeat');assert.equal(fresh.loadout.player_info.shame,960);
 assert.match(applyDefeatDignity(state(150),run(),'defeat')[0],/Goo goo ga ga/); // 150 -> 86: under 128.
 assert.match(applyDefeatDignity(state(300),run(),'defeat')[0],/big baby/); // 300 -> 236: under 256.
 assert.match(applyDefeatDignity(state(560),run(),'defeat')[0],/widdle/); // 560 -> 496: under 512.
 assert.match(applyDefeatDignity(state(),run(),'defeat')[0],/a little childish after losing/);
});
