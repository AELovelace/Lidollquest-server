import test from 'node:test';
import assert from 'node:assert/strict';
import {taigaData,hauntedWoodsData} from '../server/zones.mjs';
import {generateForest} from '../server/forest-generation.mjs';
import {generateDesert} from '../server/desert-generation.mjs';
import {resourceNodes} from '../server/crafting-service.mjs';
import {pathTo} from '../server/dive-generation.mjs';

test('generated Woods and Taiga have accessible wood beside every arrival over five editions',()=>{
 for(const [data,generate] of [[hauntedWoodsData,generateForest],[taigaData,generateDesert]])for(let seed=0;seed<5;seed++){
  const floor=generate(data,'wood-regression-'+seed),nodes=resourceNodes(data.config.zone_id,floor);
  for(const [gate,entry] of Object.entries(floor.entries)){
   const node=nodes.find(n=>n.id==='resource_wood_gate_'+gate);assert.ok(node,data.config.zone_id+' '+gate);
   const path=pathTo(floor,entry,node);assert.ok(path?.length<=6,'wood is within five walkable steps of '+gate);
   assert.ok(nodes.every(other=>other===node||other.x!==node.x||other.y!==node.y));
  }
 }
});
