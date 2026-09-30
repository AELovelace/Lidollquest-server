import {currentCraftingData} from './crafting-store.mjs';
import {regionFor,reachableTiles} from './crafting-service.mjs';
import {seeded} from './dive-generation.mjs';
import {queueCraftingRewards} from './crafting-rewards.mjs';

export function addCraftingWildlife(floor,zone){
 const craftingData=currentCraftingData();
 if(floor.craftingWildlifeVersion===1)return false;
 const region=craftingData.regions[regionFor(zone)];if(!region)return false;
 const rnd=seeded(zone+':wildlife'),tiles=reachableTiles(floor).filter(p=>(floor.enemies??[]).every(e=>Math.abs(e.x-p.x)+Math.abs(e.y-p.y)>2));
 for(let i=0;i<region.animals.length;i++){const species=region.animals[i],definition=structuredClone(craftingData.wildlife[species]),at=tiles.splice(rnd(tiles.length),1)[0];if(!at)break;
  definition.sprite=definition.enemy_id;definition.battle_sprite=definition.enemy_id;definition.defeat={first:{title:'A rough encounter',dialogue:[],aftermath:[{text:'You retreat from the animal and recover somewhere safe.'}]},repeat:{title:'A rough encounter',dialogue:[],aftermath:[{text:'You retreat from the animal and recover somewhere safe.'}]}}; // Wildlife has its own neutral injury aftermath and species-specific client art.
  floor.enemies.push({id:'wildlife_'+i,type:definition.enemy_id,definition,...at,spawn:{...at},roaming:true,dead:false,engaged:null,respawnAt:0});
 }floor.craftingWildlifeVersion=1;return true;
}
export function awardWildlife(c,state,enemy,{origins,key}){
 if(!enemy.wildlife)return;const drops=enemy.resolution==='charmed'?enemy.charm_drops:enemy.defeat_drops;
 state.wildlifeReceipts??=[];if(state.wildlifeReceipts.includes(key))return;
 queueCraftingRewards(c,state,drops??{},origins);
 state.wildlifeReceipts.push(key);if(state.wildlifeReceipts.length>128)state.wildlifeReceipts.shift();
} // The encounter transaction owns rewards; both charm and defeat grant exactly one species-appropriate bundle.
export function awardCraftingDungeon(c,state,zone,{origins,key}){
 state.wildlifeReceipts??=[];if(state.wildlifeReceipts.includes(key))return;
 const craftingData=currentCraftingData();
 const ids=['artisan_relic',/caldera|spa/.test(zone)?'ember_heart':/woods|mansion/.test(zone)?'bloodstone':/coast|cavern/.test(zone)?'storm_crystal':'warding_pearl'];
 const rng=seeded(key);if(rng(2)===0)ids.push('waterproof_wax');const styles=craftingData.bases.styles;ids.push('style_'+styles[rng(styles.length)].id);
 queueCraftingRewards(c,state,Object.fromEntries(ids.map(id=>[id,1])),origins);
 state.wildlifeReceipts.push(key);if(state.wildlifeReceipts.length>128)state.wildlifeReceipts.shift();
}
