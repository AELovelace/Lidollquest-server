import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

// The /gm Loot tab: rarity weights, the level curve, luck profiles and the affix pool are
// staff-only, validated on the way in, recorded in the audit log, and reach the next chest
// without a restart. The preview rolls a sample with the live table and touches nothing.

const staffToken='s'.repeat(43),staff='a'.repeat(64);
const playerToken='p'.repeat(43),owner='o'.repeat(64);

function harness(){
 let now=1000000;
 const accounts={[staffToken]:{owner:staff,gamemaster:true},[playerToken]:{owner,gamemaster:false}};
 const walletClient={
  async authenticate(secret){
   const account=accounts[secret];
   if(!account)throw Object.assign(Error('No account'),{status:401});
   return {owner:account.owner,id:'grant-'+account.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:account.gamemaster,blockedAccounts:[]};
  },
  async device(){return {device_code:'dev-'+randomUUID(),user_code:'ABC123-DEF456',verification_uri:'https://lidoll.example/coins/',interval:0,expires_in:600};},
  async deviceToken(){throw Object.assign(Error('Waiting for account approval.'),{status:400,code:'authorization_pending'});},
 };
 const service=createQuestService({gmAllow:'',gmEnabled:true,now:()=>now,walletClient});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const base=()=>'http://127.0.0.1:'+service.server.address().port;
 const gm=async(path,init={})=>{
  const token=init.token===undefined?staffToken:init.token;
  const headers={...(token?{Authorization:'Bearer '+token}:{}),...(init.body?{'Content-Type':'application/json'}:{})};
  const response=await fetch(base()+path,{method:init.method??'GET',headers,body:init.body?JSON.stringify(init.body):undefined});
  return {status:response.status,body:await response.json().catch(()=>({}))};
 };
 const act=(action,payload={},init={})=>gm('/gm/action',{method:'POST',body:{action,...payload},...init});
 return {service,started,gm,act,close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('loot tuning, affix authoring and preview require staff authorization and are recorded',async()=>{
 const h=harness();await h.started;try{
  assert.equal((await h.gm('/gm/loot',{token:playerToken})).status,403);
  assert.equal((await h.gm('/gm/loot',{token:null})).status,401);

  const view=await h.gm('/gm/loot');
  assert.equal(view.status,200,JSON.stringify(view.body));
  assert.ok(view.body.counts.affixes>=20);
  assert.ok(view.body.counts.titles>=5);
  assert.deepEqual(view.body.rarityOrder,['common','uncommon','rare','epic','legendary']);
  assert.ok(view.body.slots.includes('panties'));
  assert.ok(view.body.statKeys.includes('wet_resist')&&!view.body.statKeys.includes('is_diaper'));
  assert.ok(view.body.items.length>100,'the dive catalog feeds the preview picker');
  assert.equal(view.body.affixes.every(a=>a.source==='shipped'),true);

  // A player cannot retune the game, and a bad value is refused with its reason.
  assert.equal((await h.act('loot_tune',{tuning:{level_growth:0.1}},{token:playerToken})).status,403);
  const tooHigh=await h.act('loot_tune',{tuning:{level_growth:5}});
  assert.equal(tooHigh.status,400);
  assert.match(tooHigh.body.error_description,/between 0 and 0.25/);
  assert.equal((await h.act('loot_tune',{tuning:{made_up:1}})).status,400);
  const tuned=await h.act('loot_tune',{tuning:{level_growth:0.1},reason:'Steeper climb for the event.'});
  assert.equal(tuned.status,200,JSON.stringify(tuned.body));
  assert.equal(tuned.body.result.tuning.level_growth,0.1);
  assert.equal((await h.gm('/gm/loot')).body.tuning.level_growth,0.1);

  // Writing a new affix.
  const affix={id:'panel_soggy',adjective:'Soggy',suffix_title:'of the Puddle',slots:['panties'],weight:12,min_rarity:'uncommon',tags:['wet'],
   stats:[{key:'wet_resist',min:1,max:2,per_level_min:0,per_level_max:0.05}],flavour:'A gamemaster wrote this one.'};
  assert.equal((await h.act('loot_save',{affix},{token:playerToken})).status,403);
  const saved=await h.act('loot_save',{affix,reason:'New content for the event.'});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal(saved.body.result.affix.id,'panel_soggy');
  const withCustom=await h.gm('/gm/loot');
  assert.equal(withCustom.body.counts.affixes,view.body.counts.affixes+1);
  assert.equal(withCustom.body.affixes.find(a=>a.id==='panel_soggy').source,'custom');

  // Malformed authoring is refused at the panel rather than reaching the roller.
  assert.match((await h.act('loot_save',{affix:{...affix,id:'bad_slots',slots:['dress']}})).body.error_description,/torso and pants/);
  assert.match((await h.act('loot_save',{affix:{...affix,id:'bad_stat',stats:[{key:'is_diaper',min:1,max:1}]}})).body.error_description,/identity/);

  // Retiring a shipped affix keeps a tombstone; restoring drops it.
  const shipped=withCustom.body.affixes.find(a=>a.source==='shipped');
  const retired=await h.act('loot_delete',{id:shipped.id,reason:'Too strong for the event.'});
  assert.equal(retired.status,200,JSON.stringify(retired.body));
  assert.equal(retired.body.result.retired,true);
  assert.equal((await h.gm('/gm/loot')).body.counts.affixes,view.body.counts.affixes);
  assert.equal((await h.act('loot_restore',{id:shipped.id})).status,200);
  assert.equal((await h.gm('/gm/loot')).body.counts.affixes,view.body.counts.affixes+1);

  // The preview rolls a sample with the live table.
  const item=view.body.items.find(id=>id.includes('diaper'))??view.body.items[0];
  const preview=await h.act('loot_preview',{item_id:item,level:40,luck:'boss',seed:'demo'});
  assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal(preview.body.result.item.item_id,item);
  const again=await h.act('loot_preview',{item_id:item,level:40,luck:'boss',seed:'demo'});
  assert.deepEqual(again.body.result.item,preview.body.result.item,'same seed, same sample');
  assert.equal((await h.act('loot_preview',{item_id:'not_a_real_item'})).status,400);

  // Reset returns to the shipped content, and every write left an audit line.
  assert.equal((await h.act('loot_reset',{scope:'nonsense'})).status,400);
  assert.equal((await h.act('loot_reset',{scope:'all',reason:'Event over.'})).status,200);
  const reset=await h.gm('/gm/loot');
  assert.equal(reset.body.tuning.level_growth,view.body.tuning.level_growth);
  assert.equal(reset.body.counts.affixes,view.body.counts.affixes);
  const audit=(await h.gm('/gm/overview')).body.audit;
  for(const action of ['loot_tune','loot_save','loot_delete','loot_restore','loot_reset'])assert.ok(audit.some(row=>row.action===action&&row.actor===staff),action+' recorded');
  assert.ok(!audit.some(row=>row.action==='loot_preview'),'previews are not audited');
 }finally{await h.close();}
});
