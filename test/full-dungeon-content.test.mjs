import test from 'node:test';
import assert from 'node:assert/strict';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {generateFullDungeon,fullDungeonAmbientPool,repairFullDungeonContent} from '../server/full-dungeon-generation.mjs';
const dungeon=fullDungeons.find(d=>d.config.route==='castle-dungeon');

test('Dungeon generation ignores unrelated monsters in the live catalogue and rejects unresolved campaign objects',()=>{
 const data=structuredClone(dungeon);data.enemies.hypnotist_master={enemy_id:'hypnotist_master',name:'Master Hypnotist',hp:100};
 const allowed=new Set([...fullDungeonAmbientPool(data),...data.config.bosses.map(b=>b.enemy_id)]);
 for(let seed=0;seed<20;seed++){const floor=generateFullDungeon(data,'live-roster-'+seed);assert.ok(floor.enemies.every(e=>allowed.has(e.type)));}
 delete data.campaign.enemy_types[0].enemy_id;assert.throws(()=>generateFullDungeon(data,'unmapped'),/Unresolved campaign enemy/);
});

test('saved-floor repair updates NPC artwork and misplaced monsters without altering geometry, loot, timers or active fights',()=>{
 const floor=generateFullDungeon(dungeon,'repair'),foe=floor.enemies.find(e=>e.id.startsWith('enemy-'));
 foe.type='hypnotist_master';foe.respawnAt=12345;foe.dead=true;
 floor.enemies.push({...structuredClone(foe),id:'enemy-active',engaged:'fight-1'}, {...structuredClone(foe),id:'dm-manual',manual:true});
 const npc=floor.fixtures.find(f=>f.content==='objFriendlyTest');npc.sprite='sprFriendly';const before=structuredClone(floor);
 assert.equal(repairFullDungeonContent(floor,dungeon),true);
 assert.equal(npc.sprite,'sprNPCHalfwayHero');assert.ok(fullDungeonAmbientPool(dungeon).includes(foe.type));assert.equal(foe.respawnAt,12345);assert.equal(foe.dead,true);
 for(const field of ['walls','props','rooms','chests','pickups','puzzles','exits','entries'])assert.deepEqual(floor[field],before[field],field);
 assert.deepEqual(floor.enemies.filter(e=>e.id==='enemy-active'||e.manual),before.enemies.filter(e=>e.id==='enemy-active'||e.manual));
 assert.equal(repairFullDungeonContent(floor,dungeon),false,'repair is idempotent');
 floor.enemies.find(e=>e.id==='enemy-active').engaged=null;assert.equal(repairFullDungeonContent(floor,dungeon),true,'finished encounters can be repaired on the next tick');
});
