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

  // Garments and styles are editable the same way; styles are words only.
  assert.ok(view.body.garments.length>=25&&view.body.styles.length>=30);
  assert.ok(view.body.generatedCategories.includes('panties')&&view.body.garmentStatKeys.includes('wet_resist'));
  const garment={id:'panel_diaper',name:'Panel Diaper',category:'panties',weight:3,desc:'A {style_lower} test diaper.',value:8,childish:9,wet_resist:-3,bulk:4,is_diaper:true};
  assert.equal((await h.act('loot_garment_save',{garment},{token:playerToken})).status,403);
  const savedGarment=await h.act('loot_garment_save',{garment,reason:'Event tier.'});
  assert.equal(savedGarment.status,200,JSON.stringify(savedGarment.body));
  assert.equal((await h.gm('/gm/loot')).body.counts.garments,view.body.counts.garments+1);
  assert.match((await h.act('loot_garment_save',{garment:{...garment,id:'bad_cat',category:'weapon'}})).body.error_description,/not a category the generator dresses/);
  const style={id:'panel_style',name:'Panel',weight:2,desc:'Written from the panel.',garments:['panel_diaper','*']};
  const savedStyle=await h.act('loot_style_save',{style,reason:'Event look.'});
  assert.equal(savedStyle.status,200,JSON.stringify(savedStyle.body));
  assert.deepEqual(savedStyle.body.result.style.garments,['*']);
  assert.match((await h.act('loot_style_save',{style:{...style,id:'sneaky',def:3}})).body.error_description,/words only/);
  assert.match((await h.act('loot_style_save',{style:{...style,id:'lost',garments:['nothing_here']}})).body.error_description,/not a garment/);
  const dressed=await h.act('loot_style_save',{style:{id:'only_panel',name:'Only',weight:1,desc:'x',garments:['panel_diaper']}});
  assert.equal(dressed.status,200);
  assert.match((await h.act('loot_garment_delete',{id:'panel_diaper'})).body.error_description,/Styles still dress that garment/);
  assert.equal((await h.act('loot_style_delete',{id:'only_panel'})).status,200);
  assert.equal((await h.act('loot_garment_delete',{id:'panel_diaper'})).body.result.source,'custom');
  const namedByAStyle=new Set(view.body.styles.flatMap(s=>s.garments||[]));
  const shippedGarment=view.body.garments.find(g=>g.source==='shipped'&&g.category==='dress'&&!namedByAStyle.has(g.id)); // a garment a style names by id cannot retire
  const retiredGarment=await h.act('loot_garment_delete',{id:shippedGarment.id});
  assert.equal(retiredGarment.status,200,JSON.stringify(retiredGarment.body));
  assert.equal(retiredGarment.body.result.retired,true);
  const named=view.body.garments.find(g=>g.source==='shipped'&&namedByAStyle.has(g.id));
  assert.match((await h.act('loot_garment_delete',{id:named.id})).body.error_description,/Styles still dress that garment/);
  assert.equal((await h.act('loot_garment_restore',{id:shippedGarment.id})).status,200);
  const preview2=await h.act('loot_preview',{item_id:view.body.items.find(id=>id.startsWith('latex_dress_')),level:20,luck:'chest',seed:'gen'});
  assert.equal(preview2.status,200,JSON.stringify(preview2.body));
  assert.ok(preview2.body.result.item.item_id.startsWith('gen_'),'the preview shows the generated base');

  // Reset returns to the shipped content, and every write left an audit line.
  assert.equal((await h.act('loot_reset',{scope:'nonsense'})).status,400);
  assert.equal((await h.act('loot_reset',{scope:'all',reason:'Event over.'})).status,200);
  const reset=await h.gm('/gm/loot');
  assert.equal(reset.body.tuning.level_growth,view.body.tuning.level_growth);
  assert.equal(reset.body.counts.affixes,view.body.counts.affixes);
  assert.equal(reset.body.counts.garments,view.body.counts.garments);
  assert.equal(reset.body.counts.styles,view.body.counts.styles);
  const audit=(await h.gm('/gm/overview')).body.audit;
  for(const action of ['loot_tune','loot_save','loot_delete','loot_restore','loot_reset','loot_garment_save','loot_garment_delete','loot_garment_restore','loot_style_save','loot_style_delete'])assert.ok(audit.some(row=>row.action===action&&row.actor===staff),action+' recorded');
  assert.ok(!audit.some(row=>row.action==='loot_preview'),'previews are not audited');
 }finally{await h.close();}
});
