import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {createCloudSaves} from '../server/cloud-saves.mjs';
import {createCharacterManagement} from '../server/character-management.mjs';
import {createQuestService} from '../server/service.mjs';
const appearance={gender:'Male',hair_style:2,hair_color:'Pink',has_breasts:false,nipple_style:0,penis_style:0,pubes_style:0};
function fixture(){
 const db=new DatabaseSync(':memory:');let time=1000000,stars=20,lost=false;const payments=new Map();
 const zones=createQuestZones(db,{grant:()=>({owner:'owner',id:'grant',client:'lidollquest'}),wallet:()=>({coins:50}),adjust:()=>{},now:()=>time,diveOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 const cloud=createCloudSaves(db),walletClient={stars:async(token,body)=>{if(!payments.has(body.request_id)){if(stars<body.amount)throw Object.assign(Error('Insufficient'),{code:'insufficient_balance'});stars-=body.amount;payments.set(body.request_id,{balance:stars});}if(lost){lost=false;throw Error('Lost debit response');}return payments.get(body.request_id);}};
 const create=()=>zones.act('token',{action:'create',name:'Doll',request_id:randomUUID(),controller:'window'}).character;
 const manager=()=>createCharacterManagement(db,{cloud,walletClient,now:()=>time,log:()=>{}});
 const act=(c,action,extra={})=>{time+=500;return zones.act('token',{action,character_id:c.id,revision:c.revision,request_id:randomUUID(),controller:'window',...extra}).character;};
 return {db,zones,cloud,manager,create,act,payments,get stars(){return stars;},lose(){lost=true;},empty(){stars=0;}};
}
test('paid names and paperdolls charge once, survive lost responses, preserve gameplay and keep NPC sprites free',async()=>{
 const f=fixture();try{
  let c=f.create();c=f.act(c,'enter',{zone:'honeydew-lantern',loadout:{player_info:{name:'Campaign',class_id:'mage',level:4,str:11,gender:'Female',hair_color:'Brown'},inventory:[]}});c=f.act(c,'leave');
  const input={action:'rename',character_id:c.id,revision:c.revision,name:'New Name',request_id:'rename'};f.lose();
  await assert.rejects(()=>f.manager().act('owner','token',input),e=>e.status===503);assert.equal(f.stars,15);
  assert.throws(()=>f.act(c,'enter',{zone:'honeydew-lantern'}),e=>e.code==='character_change_pending');
  await f.manager().recover('owner','new-token');const renamed=await f.manager().act('owner','token',input);assert.equal(renamed.name,'New Name');assert.equal(f.stars,15);assert.equal(f.payments.size,1);
  await assert.rejects(()=>f.manager().act('owner','token',{...input,name:'Another'}),/request ID/);
  const changed=await f.manager().act('owner','token',{action:'appearance',character_id:c.id,revision:renamed.revision,appearance,request_id:'look'});assert.equal(f.stars,14);
  c=f.zones.read('token',c.id).character;assert.equal(c.loadout.player_info.str,11);assert.equal(c.loadout.player_info.class_id,'mage');assert.equal(c.loadout.player_info.gender,'Male');
  c=f.act(c,'enter',{zone:'honeydew-lantern',loadout:{player_info:{name:'Old name',gender:'Female',hair_color:'Brown'},inventory:[]}});assert.equal(c.name,'New Name');assert.equal(c.loadout.player_info.gender,'Male');
  const sprite=f.zones.read('token').avatars.find(a=>a.id!=='player').id;c=f.act(c,'appearance',{avatar:sprite});assert.equal(c.avatar,sprite);assert.equal(f.stars,14);
  assert.equal(changed.cost,1);
 }finally{f.db.close();}
});
test('management rejects wrong owners, stale revisions, class edits, insufficient stars and active visits',async()=>{
 const f=fixture();try{
  const c=f.create(),m=f.manager(),input={action:'rename',character_id:c.id,revision:c.revision,name:'Paid',request_id:'change'};
  await assert.rejects(()=>m.act('other','token',input),e=>e.status===404);
  await assert.rejects(()=>m.act('owner','token',{...input,revision:9}),e=>e.status===409);
  await assert.rejects(()=>m.act('owner','token',{...input,action:'appearance',appearance:{...appearance,class_id:'mage'}}),e=>e.status===400);
  f.empty();await assert.rejects(()=>m.act('owner','token',input),e=>e.code==='insufficient_balance');assert.equal(f.db.prepare('SELECT name FROM quest_characters WHERE id=?').get(c.id).name,'Doll');
  const online=f.act(c,'enter',{zone:'honeydew-lantern'});await assert.rejects(()=>m.act('owner','token',{...input,request_id:'active',revision:online.revision}),/Leave online rooms/);
 }finally{f.db.close();}
});
test('character deletion removes owned saves and bank, frees roster capacity, keeps account caps and blocks resurrection',async()=>{
 const f=fixture();try{
  const c=f.create();for(let n=0;n<4;n++)f.create();assert.throws(()=>f.create(),/five/);
  f.db.prepare('INSERT INTO quest_bank VALUES (?,?)').run(c.id,'["item"]');f.db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?)').run('owner',0,250);
  const createId=f.db.prepare('SELECT creation_id FROM quest_characters WHERE id=?').get(c.id).creation_id;
  const input={action:'delete',character_id:c.id,revision:c.revision,request_id:'delete',confirm:'wrong'};
  await assert.rejects(()=>f.manager().act('owner','token',input),/Type the character name/);input.confirm=c.name;
  assert.equal((await f.manager().act('owner','token',input)).deleted,true);assert.equal((await f.manager().act('owner','token',input)).deleted,true);
  assert.equal(f.db.prepare('SELECT * FROM quest_bank WHERE character_id=?').get(c.id),undefined);assert.equal(f.db.prepare('SELECT coins FROM quest_reward_days WHERE owner=?').get('owner').coins,250);
  assert.throws(()=>f.cloud.read('owner',{character_id:c.id}),/not found/);assert.throws(()=>f.zones.act('token',{action:'create',name:'Doll',request_id:createId,controller:'window'}),e=>e.status===410);
  assert.ok(f.create().id);assert.equal(f.stars,20);
 }finally{f.db.close();}
});
test('cloud labels and deletion preserve monotonic revisions, pause cleared histories and invalidate older device transfers',()=>{
 const f=fixture();try{
  const c=f.create(),cloud=f.cloud;
  const upload=(request,base)=>{const data=Buffer.from(JSON.stringify({online_character:c.id,online_account:'owner',version:33,player_info:{name:'Doll'},inventory:[],room_data:{},current_room:'Room5_Town'}));const input={request_id:request,character_id:c.id,base_revision:base,bytes:data.length,checksum:createHash('sha1').update(data).digest('hex')};cloud.act('owner',{...input,action:'begin'});cloud.act('owner',{...input,action:'chunk',part:0,data:data.toString('base64')});return cloud.act('owner',{...input,action:'commit'});};
  upload('one',0);upload('two',1);
  const rename={action:'rename',request_id:'label',character_id:c.id,revision:2,base_revision:2,label:'Before the boss'};
  assert.equal(cloud.act('owner',rename).revision,3);assert.equal(cloud.act('owner',rename).revision,3);assert.equal(cloud.read('owner',{character_id:c.id}).preview.label,'Before the boss');
  assert.throws(()=>cloud.act('other',rename),e=>e.status===404);assert.throws(()=>cloud.act('owner',{...rename,request_id:'stale'}),e=>e.code==='cloud_management_conflict');
  cloud.act('owner',{action:'delete',request_id:'remove-top',character_id:c.id,revision:2,base_revision:3});assert.equal(cloud.read('owner',{character_id:c.id}).revision,1);assert.equal(cloud.read('owner',{character_id:c.id}).head_revision,4);
  assert.throws(()=>upload('stale-device',2),e=>e.code==='cloud_conflict');upload('new',4);
  const cleared=cloud.act('owner',{action:'clear',request_id:'clear',character_id:c.id,base_revision:5});assert.equal(cleared.paused,true);assert.equal(cloud.read('owner',{character_id:c.id}).empty,true);
  assert.throws(()=>upload('paused',6),e=>e.code==='cloud_paused');assert.equal(cloud.act('owner',{action:'commit',request_id:'two',character_id:c.id}).revision,2);assert.equal(cloud.read('owner',{}).saves.length,0);
  cloud.act('owner',{action:'resume',request_id:'resume',character_id:c.id,base_revision:6});assert.equal(upload('after-resume',7).revision,8);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM quest_characters').get().n,1);
 }finally{f.db.close();}
});
test('HTTP management requires save consent and star consent for purchases, rejects browser origins and wrong verbs',async()=>{
 const token='a'.repeat(43);let scope='wallet:read wallet:write saves:write';const service=createQuestService({walletClient:{authenticate:async()=>({owner:'owner',id:'grant',client:'lidollquest',coins:50,scope})},log:()=>{}});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+service.server.address().port;
 const post=(route,input,headers={})=>fetch(url+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
 try{
  const created=await (await post('/zones/action',{action:'create',name:'Doll',request_id:'new-character',controller:'window'})).json(),c=created.character;
  const input={action:'rename',request_id:'paid',character_id:c.id,revision:c.revision,name:'New'};
  assert.equal((await post('/characters/action',input)).status,403);assert.equal((await post('/characters/action',input,{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await fetch(url+'/characters/action',{headers:{Authorization:'Bearer '+token}})).status,404);
  scope='wallet:read wallet:write stars:write';assert.equal((await post('/characters/action',input)).status,403);
  scope='wallet:read wallet:write saves:write';const deleted=await post('/characters/action',{...input,action:'delete',confirm:'Doll'});assert.equal(deleted.status,200);assert.equal((await deleted.json()).deleted,true);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
