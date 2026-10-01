import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,autumnalPlainsData,AUTUMNAL_PLAINS_ZONE,farmsteadData,spookyMansionData} from '../server/zones.mjs';
import {generateDesert} from '../server/desert-generation.mjs';
import {dietWilderness,WILDERNESS_LOOT_KINDS,WILDERNESS_LOOT_KEEP_PERCENT} from '../server/dive-loot.mjs';
import {wildernessLoot} from '../server/zone-categories.mjs';
import {campaignDives} from '../server/hubs.mjs';

// Wilderness loot diet (2026-09-30): open overworlds keep about half their chests and pickups, and every survivor
// is one of four kinds (ingredient bundle, diaper, food, potion). Dives, full dungeons, the Farmstead pantry, the
// Spa and the Spooky Mansion keep their full loot.

const HONEYDEW='honeydew-lantern';
const spots=f=>[...f.chests,...(f.pickups??[])]; // every loot spot on a floor

test('only open overworld routes are on the wilderness loot diet',()=>{
 assert.equal(wildernessLoot(autumnalPlainsData.config),true);
 assert.equal(wildernessLoot(farmsteadData.config),false,'the Farmstead pantry is authored');
 assert.equal(wildernessLoot(spookyMansionData.config),false,'the mansion is a dungeon in all but id');
 assert.equal(wildernessLoot(campaignDives[0].config),false,'instanced Dives keep their room loot');
 assert.equal(wildernessLoot({zone_category:'overworld',zone_id:'dungeon-castle-dungeon',route:'x'}),false,'full dungeons share the category but not the prefix');
});

test('the diet keeps about half the spots, types every survivor, and is deterministic and idempotent',()=>{
 let before=0,after=0;const kinds=new Set();
 for(let n=0;n<40;n++){
  const raw=generateDesert(autumnalPlainsData,'wild-'+n),f=structuredClone(raw);before+=spots(raw).length;
  assert.equal(dietWilderness(f,autumnalPlainsData.config),true,'a fresh floor changes');
  const again=structuredClone(raw);dietWilderness(again,autumnalPlainsData.config);assert.deepEqual(again,f,'same floor, same diet');
  assert.equal(dietWilderness(f,autumnalPlainsData.config),false,'a dieted floor is left alone');
  for(const s of spots(f)){assert.ok(WILDERNESS_LOOT_KINDS.includes(s.kind),'typed spot');kinds.add(s.kind);}
  assert.ok(spots(f).every(s=>spots(raw).some(r=>r.id===s.id&&r.x===s.x&&r.y===s.y)),'survivors keep their ids and tiles');
  after+=spots(f).length;
 }
 const share=after/before;assert.ok(share>0.42&&share<0.58,`about ${WILDERNESS_LOOT_KEEP_PERCENT}% survive, got ${(share*100).toFixed(1)}%`);
 assert.deepEqual([...kinds].sort(),[...WILDERNESS_LOOT_KINDS].sort(),'all four kinds show up');
 const dive=structuredClone(generateDesert(autumnalPlainsData,'wild-x'));assert.equal(dietWilderness(dive,campaignDives[0].config),false,'a Dive config never thins a floor');
});

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),api;const ids={};
 const loadout={player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:10,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const still=(...args)=>{const f=generateDesert(...args);f.enemies.forEach(e=>e.roaming=false);return f;}; // Frozen roamers keep the crossing deterministic.
 const quiet={log:()=>{},generate:still};
 api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:quiet,tundraOptions:quiet,taigaOptions:quiet,highDesertOptions:quiet,autumnalPlainsOptions:quiet});
 const snap=name=>api.read(name,ids[name]);
 function act(name,action,extra={}){time+=350;const s=snap(name);return api.act(name,{action,controller:'window',request_id:randomUUID(),character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra});}
 function player(name){ids[name]=api.act(name,{action:'create',name,controller:'window',request_id:randomUUID()}).character.id;return act(name,'enter',{zone:HONEYDEW,combat_version:3,content_version:1,quest_version:1,loadout});}
 function place(name,p){const id=ids[name],row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id),state=JSON.parse(row.state);if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),id);db.prepare('UPDATE quest_presence SET x=?,y=?,moved=0 WHERE character_id=?').run(p.x,p.y,id);}
 return {db,snap,act,player,place,close(){api.close();db.close();}};
}

test('a live Plains edition is thinned, and each kind of spot gives only its kind of loot',()=>{
 const f=fixture();try{
  f.player('alice');f.place('alice',{x:24,y:48});const out=f.act('alice','move',{direction:'south',world_step:true});assert.equal(out.zone,AUTUMNAL_PLAINS_ZONE);
  const s=f.snap('alice'),raw=generateDesert(autumnalPlainsData,s.dive.edition),live=spots(s.dive),share=live.length/spots(raw).length;
  assert.ok(share>0.3&&share<0.7,`the served floor keeps about half its loot (${live.length} of ${spots(raw).length})`);
  assert.ok(live.every(sp=>WILDERNESS_LOOT_KINDS.includes(sp.kind)),'every served spot is typed');
  const claim=kind=>{const spot=live.find(sp=>sp.kind===kind);assert.ok(spot,kind+' spot exists');f.place('alice',{x:spot.x,y:spot.y});const r=f.act('alice','dive_claim',{chest:spot.id});return {spot,inventory:r.character.loadout.inventory,notice:r.character.dive?.lootNotice??r.dive?.lootNotice};};
  const diaper=claim('diaper');assert.equal(diaper.inventory.length,1);assert.equal(diaper.inventory[0].category,'panties');assert.equal(diaper.inventory[0].is_diaper,true,'a diaper spot gives a diaper');
  const food=claim('food');assert.equal(food.inventory.length,2);assert.ok(autumnalPlainsData.food_pool.includes(food.inventory[1].item_id),'a food spot draws from the route food pool');
  const potion=claim('potion');assert.equal(potion.inventory.length,3);assert.ok(autumnalPlainsData.potion_pool.includes(potion.inventory[2].item_id),'a potion spot draws from the route potion pool (the Plains author supplies into it)');
  const ingredient=claim('ingredient');assert.equal(ingredient.inventory.length,4);const bundle=ingredient.inventory[3];assert.equal(bundle.category,'ingredient','an ingredient spot gives a bundle and nothing else');assert.ok(bundle.quantity>=1);
  assert.throws(()=>f.act('alice','dive_claim',{chest:ingredient.spot.id}),/already claimed/,'the bundle is a receipt like any other claim');
  const again=f.snap('alice');assert.equal(spots(again.dive).length,live.length,'maintenance passes never thin the floor twice');
 }finally{f.close();}
});
