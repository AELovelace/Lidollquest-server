import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createLootStore,validateLootItem} from '../server/loot-store.mjs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';
import {createQuestService} from '../server/service.mjs';

// /gm Loot tab base item pool (2026-10-02): GMs add items (copied from a template) and remove items from every loot pool.
const diveData=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8'));
const shipped={
 frilly_top:{item_id:'frilly_top',category:'torso',name:'Frilly Top',desc:'Lacy.',def:2,value:10,childish:4},
 diaper:{item_id:'diaper',category:'panties',name:'Fluffy Diaper',desc:'Thick.',def:0,value:8,childish:10,bulk:3,is_diaper:true},
 pull_up:{item_id:'pull_up',category:'panties',name:'Pull-up',desc:'Thin.',def:0,value:6,childish:6,bulk:1,is_diaper:true},
};
const store=()=>{let now=1000;const db=new DatabaseSync(':memory:');return createLootStore(db,{now:()=>now++});};

test('a GM item copies its template, applies the panel fields and can never shadow a shipped id',()=>{
 const item=validateLootItem({id:'star_bonnet',template:'frilly_top',name:'Star Bonnet',category:'torso',def:5,childish:'',is_diaper:false},{shipped});
 assert.equal(item.item_id,'star_bonnet');assert.equal(item.def,5);assert.equal(item.value,10,'unsent fields keep the template value');
 assert.equal(item.childish,undefined,'a blank field removes the stat');assert.equal(item.gm_custom,true);assert.equal(item.pool_template,undefined);
 assert.throws(()=>validateLootItem({id:'diaper',template:'frilly_top',name:'X',category:'torso'},{shipped}),/already a shipped item/);
 assert.throws(()=>validateLootItem({id:'mystery',template:'frilly_top',name:'X',category:'torso'},{shipped,catalog:{mystery:{}}}),/already a shipped item/,'client-only items count too');
 assert.throws(()=>validateLootItem({id:'gen_maid_top',template:'frilly_top',name:'X',category:'torso'},{shipped}),/gen_/);
 assert.throws(()=>validateLootItem({id:'new_thing',name:'X',category:'torso'},{shipped}),/copy from/);
 assert.throws(()=>validateLootItem({id:'new_thing',template:'frilly_top',name:'X',category:'quest'},{shipped}),/not a loot category/);
 assert.throws(()=>validateLootItem({id:'new_thing',template:'frilly_top',name:'X',category:'torso',is_diaper:true},{shipped}),/Only a panties item/);
 assert.throws(()=>validateLootItem({id:'new_thing',template:'frilly_top',name:'X',category:'torso',def:5000},{shipped}),/def/);
});

test('removing and adding items changes the pool; the last diaper is protected; restore undoes it',()=>{
 const s=store();
 s.saveItem({id:'star_bonnet',template:'frilly_top',name:'Star Bonnet',category:'torso'},{shipped});
 assert.deepEqual(s.itemPool(['frilly_top','diaper','pull_up']),['frilly_top','diaper','pull_up','star_bonnet']);
 s.removeItem('frilly_top',shipped);s.removeItem('pull_up',shipped);
 assert.deepEqual(s.itemPool(['frilly_top','diaper','pull_up']),['diaper','star_bonnet']);
 assert.throws(()=>s.removeItem('diaper',shipped),/at least one diaper/);
 s.removeItem('star_bonnet',shipped);
 assert.ok(s.customItems().star_bonnet,'a removed GM item keeps its definition for copies already owned');
 assert.deepEqual(s.itemPool(['frilly_top','diaper']),['diaper']);
 const roster=s.listItems(shipped);
 assert.deepEqual(roster.map(r=>[r.id,r.source,r.removed]),[['diaper','shipped',false],['frilly_top','shipped',true],['pull_up','shipped',true],['star_bonnet','custom',true]]);
 s.restoreItem('frilly_top');s.restoreItem('star_bonnet');
 assert.deepEqual(s.itemPool(['frilly_top','diaper','pull_up']),['frilly_top','diaper','star_bonnet']);
 assert.throws(()=>s.restoreItem('diaper'),/not removed/);
 s.reset('bases');assert.ok(s.customItems().star_bonnet,'resetting garments and styles leaves the item pool alone');
 s.reset('items');assert.deepEqual(s.customItems(),{});assert.deepEqual(s.itemPool(['frilly_top','pull_up']),['frilly_top','pull_up']);
});

test('chests on every route stop dropping removed items and start dropping GM items',()=>{
 const s=store();
 const data={config:{route:'test-route',zone_id:'test-route'},items:structuredClone(shipped),loot:diveData.loot,bases:diveData.bases,enchantments:diveData.enchantments};
 const roll=createDiveLootRoller(data,{loot:s});
 const drops=()=>new Set(Array.from({length:120},(_,i)=>roll('ed1','char',{id:'chest-'+i},{}).item_id));
 assert.ok(drops().has('frilly_top'));
 s.removeItem('frilly_top',shipped);
 s.saveItem({id:'star_bonnet',template:'frilly_top',name:'Star Bonnet',category:'torso'},{shipped});
 const after=drops();
 assert.equal(after.has('frilly_top'),false,'a removed item never drops');
 assert.ok(after.has('star_bonnet'),'a GM item drops without a restart');
 assert.equal(roll('ed1','char',{id:'placed',item_id:'frilly_top'},{}).item_id,'frilly_top','a chest a GM placed with a set item keeps it');
});

test('GM items reach the Loot tab and every game snapshot',async()=>{
 const staffToken='s'.repeat(43),playerToken='p'.repeat(43);
 const accounts={[staffToken]:{owner:'a'.repeat(64),gamemaster:true},[playerToken]:{owner:'o'.repeat(64),gamemaster:false}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant',client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({walletClient,now:()=>1000000,log:()=>{}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+service.server.address().port;
 const call=async(path,{token=staffToken,body}={})=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 try{
  const template=Object.keys(diveData.items).find(id=>diveData.items[id].category==='torso');
  let r=await call('/gm/action',{body:{action:'loot_item_save',item:{id:'gm_star_top',template,name:'Star Top',category:'torso',def:3},reason:'Test'}});
  assert.equal(r.status,200,JSON.stringify(r.body));
  r=await call('/gm/loot');
  const row=r.body.poolItems.find(i=>i.id==='gm_star_top');assert.equal(row.source,'custom');assert.ok(r.body.items.includes('gm_star_top'),'the preview picker lists it');
  assert.equal((await call('/gm/action',{body:{action:'loot_item_delete',id:template}})).status,200);
  assert.equal((await call('/gm/loot')).body.poolItems.find(i=>i.id===template).removed,true);
  assert.equal((await call('/gm/action',{token:playerToken,body:{action:'loot_item_save',item:{id:'nope_top',template,name:'Nope',category:'torso'}}})).status,403);
  r=await call('/zones/action',{token:playerToken,body:{action:'create',name:'Tester',request_id:randomUUID(),controller:'window'}});
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.customItems?.gm_star_top?.name,'Star Top','the game client learns the definition from the snapshot');
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
