import test from 'node:test';
import assert from 'node:assert/strict';
import {craftingData,planCraft,applyCraft,resolveCraftItem,validateCrafting,cookingRecipe} from '../server/crafting.mjs';
import {buildPotion,brewPotion,potionFromId} from '../server/alchemy-brew.mjs';

const bag=materials=>Object.entries(materials).map(([item_id,quantity])=>({item_id,quantity,category:'ingredient'}));
const loadout=(materials,level=37)=>({player_info:{level},inventory:bag(materials)});
test('equipment recipes retain quantities, level and minimum rarity',()=>{
 const materials={wood:2,steel:6},l=loadout(materials),r=planCraft(l,{discipline:'smithing',station:'forge',materials},'longsword');
 assert.equal(r.item.loot.ilvl,37);assert.notEqual(r.item.loot.rarity,'common');assert.equal(r.item.crafted.recipe,'smithing_longsword_reinforced');
 assert.deepEqual(l.inventory,bag(materials));applyCraft(l,r);assert.equal(l.inventory.length,1);assert.equal(l.player_info.smithing_level,3);
});
test('validation never consumes ingredients and rejects recipe collisions',()=>{
 const l=loadout({wood:1}),before=structuredClone(l);
 assert.throws(()=>planCraft(l,{discipline:'smithing',station:'forge',materials:{wood:1,steel:1}},'missing'),/Missing/);
 assert.deepEqual(l,before);const d=structuredClone(craftingData);d.recipes.push({...d.recipes[0],id:'duplicate'});assert.throws(()=>validateCrafting(d),/Ambiguous/);
});
test('tailoring retains garment identity, forced style and catalyst',()=>{
 const materials={cloth:4,thread:2,padding:2},l=loadout({...materials,style_plain:1,waterproof_wax:1});
 const r=planCraft(l,{discipline:'tailoring',station:'sewing_table',materials,style:'style_plain',catalysts:['waterproof_wax']},'tailor');
 assert.equal(r.item.generated.garment,'diaper');assert.equal(r.item.generated.style,'plain');assert.equal(r.item.is_diaper,true);assert.equal(r.consumed.style_plain,1);assert.equal(r.item.loot.bonus.filter(b=>b.guaranteed).length,1);
});
test('cooking respects stations, edible whitelist and canonical food signatures',()=>{
 const materials={grain:2,spring_water:1},l=loadout(materials);
 assert.throws(()=>planCraft(l,{discipline:'cooking',station:'campfire',materials},'bread'),/kitchen/);
 assert.throws(()=>planCraft(loadout({iron:1,wood:1}),{discipline:'cooking',station:'kitchen',materials:{iron:1,wood:1}},'bad'),/edible/);
 const row=resolveCraftItem('cooked__berry_tart__3');assert.equal(row.meal_buff.kind,'gather');assert.equal(row.meal_buff.turns,175);
 assert.equal(cookingRecipe(['grain','grain','spring_water']).id,'bread');assert.equal(resolveCraftItem('cooked__unknown__3'),null);
});
test('server alchemy makes canonical sellable potions and preserves forced recipe logic',()=>{
 const data=craftingData,ids=['dandelion','charcoal','slime_core'];
 const r=brewPotion(data.alchemy,data.items,ids,100,()=>.5);
 assert.equal(r.mishap,false);assert.ok(r.item.value>0);assert.deepEqual(potionFromId(data.alchemy,r.item.item_id),r.item);
 assert.throws(()=>buildPotion(data.alchemy,{colour:'yellow',rarity:'rare',potency:9999,adjectives:[],special:null}),/signature/);
});
