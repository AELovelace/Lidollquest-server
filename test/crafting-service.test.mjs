import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCraftingService,resourceNodes,validBusinessTile} from '../server/crafting-service.mjs';
import {createItemOrigins} from '../server/item-origins.mjs';
import {craftCatalog,resolveCraftItem,planCraft,craftingData} from '../server/crafting.mjs';
import {createCraftingStore} from '../server/crafting-store.mjs';
import {addToInventory,stackTokens} from '../server/loadout.mjs';
import {weaponEffects,tickMeal,mealMultiplier} from '../server/crafting-combat.mjs';

function fixture(saved=[]){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE quest_characters(id TEXT PRIMARY KEY,state TEXT NOT NULL);CREATE TABLE quest_bank(character_id TEXT PRIMARY KEY,items TEXT);');
 const c={id:'alice',owner:'alice'},s={loadout:{player_info:{level:17,playerHealth:30,playerHealthMax:100,stamina:10,stamina_max:100},inventory:structuredClone(saved)}};
 db.prepare('INSERT INTO quest_characters VALUES (?,?)').run(c.id,JSON.stringify(s));const origins=createItemOrigins(db);let time=1000;
 const service=createCraftingService(db,{origins,now:()=>time,loot:{apply:d=>d},alchemyStore:{apply:d=>d}});
 const floor={edition:'test',width:30,height:30,entrance:{x:1,y:1},walls:Array.from({length:30},()=>Array(30).fill(0)),fixtures:[]};
 function act(input,p,z=null){db.exec('BEGIN');const copy=structuredClone(s);try{service.act(c,s,{request_id:String(++time),...input},p,z,floor);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');Object.assign(s,copy);throw e;}}
 return {db,c,s,origins,service,floor,act,advance:n=>time+=n,mint:(id,n=1)=>{for(let i=0;i<n;i++)addToInventory(s.loadout.inventory,origins.mint(c.id,structuredClone(craftCatalog[id])));}};
}
test('harvesting is personal, daily and refuses remote or repeated claims',()=>{
 const f=fixture();try{const n=resourceNodes('overworld-taiga',f.floor).find(n=>!n.kind),p={zone:'overworld-taiga',x:n.x,y:n.y};
  assert.throws(()=>f.act({action:'craft_harvest',fixture:n.id},{...p,x:29,y:29}),/Stand next/);f.act({action:'craft_harvest',fixture:n.id},p);const quantity=f.s.loadout.inventory[0].quantity;
  assert.equal(stackTokens(f.s.loadout.inventory[0]).length,quantity);assert.throws(()=>f.act({action:'craft_harvest',fixture:n.id},p),/today/);f.advance(86400000);f.act({action:'craft_harvest',fixture:n.id},p);assert.ok(f.s.loadout.inventory[0].quantity>quantity);
 }finally{f.db.close();}
});
test('crafting consumes verified units across mixed stacks and preserves untracked copies',()=>{
 const f=fixture();try{f.mint('wood');f.mint('steel');f.s.loadout.inventory.push({...craftCatalog.steel,quantity:5});
  f.act({action:'craft_make',discipline:'smithing',station:'forge',fixture:'forge',materials:{wood:1,steel:1}},{x:5,y:4,zone:'town'},{fixtures:[{id:'forge',kind:'forge',x:5,y:5}]});
  assert.equal(f.s.loadout.inventory.find(i=>i.item_id==='steel').quantity,5);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM quest_item_origins WHERE status='spent'").get().n,2);assert.equal(f.s.loadout.inventory.find(i=>i.crafted).loot.ilvl,17);
 }finally{f.db.close();}
});
test('legacy migration captures old goods once and never accepts newly imported stock',()=>{
 const f=fixture([{...craftCatalog.grain,quantity:2,value:999999}]);try{f.s.loadout.inventory.push({...craftCatalog.steel,quantity:5});f.service.migrate(f.c,f.s);const grain=f.s.loadout.inventory[0];assert.equal(stackTokens(grain).length,2);assert.equal(grain.online_sell_price,Math.floor(craftCatalog.grain.value/2));assert.equal(stackTokens(f.s.loadout.inventory[1]).length,0);f.service.migrate(f.c,f.s);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM quest_item_origins').get().n,2);
 }finally{f.db.close();}
});
test('meals consume exactly one resale right and unbuffed food preserves the current meal',()=>{
 const f=fixture();try{const food=resolveCraftItem('cooked__berry_tart__3');for(let i=0;i<2;i++)addToInventory(f.s.loadout.inventory,f.origins.mint(f.c.id,structuredClone(food)));f.act({action:'craft_eat',index:0},{zone:'town',x:1,y:1});assert.equal(f.s.loadout.inventory[0].quantity,1);assert.ok(f.origins.sale(f.c,f.s.loadout.inventory[0]));assert.equal(f.s.loadout.player_info.meal_buff.kind,'gather');assert.equal(f.s.loadout.player_info.meal_buff.turns,175);
  addToInventory(f.s.loadout.inventory,f.origins.mint(f.c.id,resolveCraftItem('cooked__mixed_meal__0')));f.act({action:'craft_eat',index:1},{zone:'town',x:1,y:1});assert.equal(f.s.loadout.player_info.meal_buff.kind,'gather');
 }finally{f.db.close();}
});
test('live editor rejects stale revisions and ambiguous recipes without losing the valid settings',()=>{
 const f=fixture();try{const store=createCraftingStore(f.db),before=store.view();const tuning={...before.data.tuning,burn_base:20};assert.equal(store.save('tuning',tuning,0).revision,1);assert.throws(()=>store.save('tuning',tuning,0),/changed/);assert.throws(()=>store.save('recipes',[...before.data.recipes,{...before.data.recipes[0],id:'duplicate'}],1),/Ambiguous/);assert.equal(store.view().data.tuning.burn_base,20);
 }finally{f.db.close();}
});
test('guaranteed effects use actual damage, refresh burns, and never recurse on chain hits',()=>{
 const enemy={hp:80,name:'Target'},other={hp:70,def:2,name:'Other'},s={run:{enemy,hp:98,maxHp:100,dots:[],log:[]}};
 const hit=actual=>weaponEffects(s,{weapon:{weapon_properties:['burn','lifesteal','chain_lightning']},actual,raw:30,roll:()=>0,mitigate:(n,d)=>n-d,enemies:[enemy,other]});hit(20);assert.equal(s.run.hp,100);assert.deepEqual(s.run.dots,[{spell_id:'crafted_burn',damage:4,turns_left:2}]);assert.equal(other.hp,57);s.run.dots[0].turns_left=1;hit(5);assert.equal(s.run.dots[0].damage,4);assert.equal(s.run.dots[0].turns_left,2);
 const l={player_info:{meal_buff:{kind:'weapon',amount:10,turns:2}}};assert.equal(mealMultiplier(l,'weapon'),1.1);tickMeal(l);assert.equal(l.player_info.meal_buff.turns,1);tickMeal(l);assert.equal(mealMultiplier(l,'weapon'),1);
});
test('hat and sash signatures reconstruct and narrow passages cannot host shops',()=>{
 assert.equal(resolveCraftItem('gen_plain_hat').category,'head');assert.equal(resolveCraftItem('gen_plain_sash').category,'accessory');
 const walls=Array.from({length:10},()=>Array(10).fill(1));for(let y=1;y<9;y++)walls[y][5]=0;
 assert.equal(validBusinessTile({width:10,height:10,walls,spawn:{x:5,y:1},fixtures:[]},5,5),false);
});
