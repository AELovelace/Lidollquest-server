import {randomUUID} from 'node:crypto';
import {walkable,pathTo} from './dive-generation.mjs';
export function storyFoe(floor,c,position,monster,receipt){
 const old=floor.enemies.find(v=>v.flowReceipt===receipt);if(old)return old;
 const fail=message=>{throw Object.assign(Error(message),{status:409,code:'flow_encounter_unavailable'});};
 if(!monster||floor.enemies.length>=1024)fail('There is no room for another story encounter.');
 const occupied=[...floor.enemies,...(floor.fixtures??[]),...(floor.managedOccupancy??[]),floor.entrance].filter(Boolean);
 let spot;
 for(let radius=1;radius<=5&&!spot;radius++)for(let dy=-radius;dy<=radius&&!spot;dy++)for(let dx=-radius;dx<=radius&&!spot;dx++){
  if(Math.abs(dx)+Math.abs(dy)!==radius)continue;const p={x:position.x+dx,y:position.y+dy};
  if(walkable(floor,p.x,p.y)&&!occupied.some(v=>v.x===p.x&&v.y===p.y)&&pathTo(floor,position,p,10))spot=p;
 }
 if(!spot)fail('Move to an open area before continuing this story.');
 const foe={id:'story-'+randomUUID(),type:monster.id,definition:structuredClone(monster),...spot,spawn:{...spot},manual:true,respawning:false,roaming:false,engaged:null,respawnAt:0,storyOwner:c.id,flowReceipt:receipt};
 floor.enemies.push(foe);return foe;
} // Repeated steps reuse the same enemy; private story foes always occupy a reachable, unoccupied tile.
export function storyFoes(floor,c,position,monsters,receipt){
 const lineup=Array.isArray(monsters)?monsters:[monsters];
 if(!lineup.length||lineup.length>3||lineup.some(m=>!m))throw Object.assign(Error('Choose 1 to 3 monsters for this story battle.'),{status:409,code:'flow_encounter_unavailable'});
 const planned={...floor,enemies:[...floor.enemies]}; // Plan every slot first so a blocked tile cannot leave half a lineup behind.
 const foes=lineup.map((monster,i)=>storyFoe(planned,c,position,monster,i?receipt+':'+i:receipt));
 floor.enemies=planned.enemies;return foes;
} // Slot receipts preserve duplicate monster instances and retry the whole lineup safely.
