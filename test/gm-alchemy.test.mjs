import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createQuestService} from '../server/service.mjs';
import {createAlchemyStore} from '../server/alchemy-store.mjs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';
import {diveData} from '../server/dive.mjs';
import {hubRooms,villageRooms} from '../server/hubs.mjs';
import {districtData,generateDistrict,reachableDistrict,SERVICE_KINDS} from '../server/hub-districts.mjs';

// The /gm Alchemy tab (2026-09-24): chest odds and brewing rules are staff-only, validated as a whole
// table on the way in, audited, reach the next dive chest without a restart, and ride to clients in
// every zone snapshot. Plus the three online hub cauldrons.

const staffToken='s'.repeat(43),staff='a'.repeat(64);
const playerToken='p'.repeat(43),owner='o'.repeat(64);

function harness(){
 const accounts={[staffToken]:{owner:staff,gamemaster:true},[playerToken]:{owner,gamemaster:false}};
 const walletClient={
  async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant-'+a.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};},
  async device(){return {device_code:'dev-'+randomUUID(),user_code:'ABC123-DEF456',verification_uri:'https://lidoll.example/coins/',interval:0,expires_in:600};},
  async deviceToken(){throw Object.assign(Error('Waiting for account approval.'),{status:400,code:'authorization_pending'});},
 };
 const service=createQuestService({gmAllow:'',gmEnabled:true,now:()=>1000000,walletClient});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base=()=>'http://127.0.0.1:'+service.server.address().port;
 const gm=async(path,init={})=>{
  const token=init.token===undefined?staffToken:init.token;
  const headers={...(token?{Authorization:'Bearer '+token}:{}),...(init.body?{'Content-Type':'application/json'}:{})};
  const response=await fetch(base()+path,{method:init.method??'GET',headers,body:init.body?JSON.stringify(init.body):undefined});
  return {status:response.status,body:await response.json().catch(()=>({}))};
 };
 const act=(action,payload={},init={})=>gm('/gm/action',{method:'POST',body:{action,...payload},...init});
 return {started,gm,act,close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('the alchemy tab is staff-only, validates the whole table, audits every write and resets',async()=>{
 const h=harness();await h.started;try{
  assert.equal((await h.gm('/gm/alchemy',{token:playerToken})).status,403);
  assert.equal((await h.gm('/gm/alchemy',{token:null})).status,401);
  const view=await h.gm('/gm/alchemy');
  assert.equal(view.status,200,JSON.stringify(view.body));
  assert.ok(view.body.ingredients.length>=50);
  assert.deepEqual(view.body.overridden,{brewing:[],chest_loot:[]});
  assert.deepEqual(view.body.live.brewing,view.body.shipped.brewing,'nothing changed yet');
  assert.equal(view.body.colours.length,16);

  assert.equal((await h.act('alchemy_save',{section:'chest_loot',patch:{chance:50}},{token:playerToken})).status,403);
  const refusals=[
   [{section:'chest_loot',patch:{chance:500}},/between 0 and 100/],
   [{section:'chest_loot',patch:{made_up:1}},/not an alchemy setting/],
   [{section:'chest_loot',patch:{everywhere:['not_an_herb']}},/not a known ingredient/],
   [{section:'chest_loot',patch:{online_zones:{'overworld-desert':'nowhere'}}},/no ingredient list/],
   [{section:'brewing',patch:{mishap:{base:0.1,per_point:0.01,min:0.5,max:0.1,kit_penalty:0}}},/must not be below/],
   [{section:'brewing',patch:{adjectives:{potent:{name:'Potent',bad:false,weight:5}}}},/must stay an adjective/],
   [{section:'brewing',patch:{secret_recipes:[{ingredients:['dandelion','ghost'],min_rarity:'rare'}]}},/not a known ingredient/],
   [{section:'brewing',patch:{colours:{red:{effects:{hp_restore:9999}}}}},/between/],
   [{section:'nope',patch:{x:1}},/brewing or chest_loot/],
  ];
  for(const [payload,message] of refusals){const r=await h.act('alchemy_save',payload);assert.equal(r.status,400,JSON.stringify(payload));assert.match(r.body.error_description,message);}

  const saved=await h.act('alchemy_save',{section:'chest_loot',patch:{chance:100},reason:'Herb festival'});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const mishap={...view.body.shipped.brewing.mishap,base:0.2};
  assert.equal((await h.act('alchemy_save',{section:'brewing',patch:{mishap}})).status,200);
  const after=(await h.gm('/gm/alchemy')).body;
  assert.equal(after.live.chest_loot.chance,100);
  assert.equal(after.live.brewing.mishap.base,0.2);
  assert.deepEqual(after.overridden,{brewing:['mishap'],chest_loot:['chance']});

  assert.equal((await h.act('alchemy_reset',{scope:'brewing',key:'mishap'})).status,200);
  assert.deepEqual((await h.gm('/gm/alchemy')).body.overridden,{brewing:[],chest_loot:['chance']});
  assert.equal((await h.act('alchemy_reset',{scope:'all'})).status,200);
  assert.deepEqual((await h.gm('/gm/alchemy')).body.overridden,{brewing:[],chest_loot:[]});
  assert.equal((await h.act('alchemy_reset',{scope:'sideways'})).status,400);

  const audit=(await h.gm('/gm/overview')).body.audit;
  for(const action of ['alchemy_save','alchemy_reset'])assert.ok(audit.some(row=>row.action===action),action+' is audited');
 }finally{await h.close();}
});

test('live chest odds reach the next dive chest and brewing overrides reach the client view',()=>{
 const db=new DatabaseSync(':memory:'),store=createAlchemyStore(db,{now:()=>5});
 const base=diveData.alchemy,roll=createDiveLootRoller(diveData,{lootTable:diveData.loot,alchemy:base,alchemyStore:store,alchemyZone:'overworld-desert'});
 let hits=0;for(let n=0;n<200;n++)if(roll.ingredient('ed','alice',{id:'chest-'+n}))hits++;
 assert.ok(hits>20&&hits<120,'shipped odds first ('+hits+'/200)');
 store.save('chest_loot',{chance:100},base,'gm');
 for(let n=0;n<200;n++)assert.ok(roll.ingredient('ed','alice',{id:'chest-'+n}),'every chest after the retune, no restart');
 store.save('chest_loot',{zones:{...base.chest_loot.zones,desert:['prune']},everywhere:[]},base,'gm');
 assert.equal(roll.ingredient('ed','alice',{id:'chest-1'}).item_id,'prune','zone lists are live too');

 assert.deepEqual(store.clientView().brewing,{},'clients get nothing extra until brewing changes');
 store.save('brewing',{muddy_share:0.5},base,'gm');
 const view=store.clientView();
 assert.deepEqual(view.brewing,{muddy_share:0.5},'only the overridden brewing keys ride in the snapshot');
 assert.match(view.revision,/^\d+:\d+$/);
});

test('cauldrons stand in the Community Hall, the LittleBig Inn and the Castle dormitory, reachable',()=>{
 assert.ok(SERVICE_KINDS.includes('cauldron'),'residents never box a cauldron in');
 const hall=villageRooms.dives.fixtures.find(f=>f.kind==='cauldron');
 assert.deepEqual([hall.x,hall.y],[14,2]);
 assert.ok(hubRooms.find(z=>z.id==='honeydew-lantern-dives').fixtures.some(f=>f.kind==='cauldron'),'Honeydew Community Hall');
 const inn=hubRooms.find(z=>z.id==='littlebig-clockwork-beds'),pot=inn.fixtures.find(f=>f.kind==='cauldron');
 assert.ok(pot,'LittleBig Inn');
 const blocked=new Set(inn.fixtures.map(f=>f.x+','+f.y)),seen=new Set(),queue=[inn.spawn];
 for(let n=0;n<queue.length;n++){const p=queue[n],key=p.x+','+p.y;if(seen.has(key)||p.x<1||p.y<1||p.x>=inn.width-1||p.y>=inn.height-1||blocked.has(key))continue;seen.add(key);queue.push({x:p.x+1,y:p.y},{x:p.x-1,y:p.y},{x:p.x,y:p.y+1},{x:p.x,y:p.y-1});}
 assert.ok([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen.has((pot.x+dx)+','+(pot.y+dy))),'someone can stand beside the Inn cauldron');
 assert.deepEqual(hubRooms.filter(z=>z.fixtures?.some(f=>f.kind==='cauldron')).map(z=>z.id),['honeydew-lantern-dives','littlebig-clockwork-beds','utopia-arcanum-tower','arcadia-foundry-tower'],'the Community Hall, LittleBig Inn, Arcanum Tower and Clockmakers Guildhall annexes (Rose keeps hers in the Castle)');
 const castle=districtData.districts.find(d=>d.hub==='princess-rose');
 for(const edition of ['2026-09','2026-12']){
  const f=generateDistrict(castle,{edition,ends:0}),c=f.fixtures.find(x=>x.kind==='cauldron'),reach=reachableDistrict(f);
  assert.deepEqual([c.x,c.y],[47,16],'the castle dormitory, every month');
  assert.ok([[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>reach.has((c.x+dx)+','+(c.y+dy))));
 }
});
