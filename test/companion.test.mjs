import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

test('HTTP companion retains the selected private sheet, bank page and active default without taking control',async()=>{
 const token='a'.repeat(43),owner='a'.repeat(64);let now=Date.parse('2026-09-17T12:00:00Z');
 const service=createQuestService({walletClient:{authenticate:async t=>({owner:t===token?owner:'b'.repeat(64),id:'grant',client:'lidollquest',coins:50})},now:()=>now,log:()=>{}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
 async function act(action,c,extra={}){now+=500;const r=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,character_id:c?.id,revision:c?.revision,controller:'game',request_id:randomUUID(),...extra})});const s=await r.json();assert.equal(r.status,200,JSON.stringify(s));return s.character;}
 const get=async(query='',secret=token)=>{const r=await fetch(base+'/zones?view=companion'+query,{headers:{Authorization:'Bearer '+secret}});return {status:r.status,data:await r.json()};};
 try{
  const empty=await get();assert.equal(empty.data.sheet,null);
  let first=await act('create',null,{name:'First'});
  const loadout={player_info:{name:'First',equipped_weapon:'iron_dagger',equipped_panties:'thick_medical_diaper',str:9,def:4,dex:6,int:8,cha:2,playerHealth:83,playerHealthMax:140,wet:42,diaper_wet_absorbed:2,hair_color:'Pink'},inventory:[{item_id:'iron_dagger',atk:17,name:'My rolled dagger'}],player_mp:17,player_mp_max:20};
  first=await act('enter',first,{zone:'honeydew-lantern',loadout});
  const before={...service.db.prepare('SELECT * FROM quest_presence WHERE owner=?').get(owner)};
  let read=await get();assert.equal(read.data.character.id,first.id);assert.equal(read.data.sheet.player_info.str,9);assert.equal(read.data.sheet.inventory[0].atk,17);assert.equal(read.data.sheet.player_mp,17);assert.equal(read.data.sheet.tush.status,'Damp');assert.equal(read.data.sheet.player_info.hair_color,'Pink');
  assert.deepEqual({...service.db.prepare('SELECT * FROM quest_presence WHERE owner=?').get(owner)},before,'read never acquires a controller or renews game presence');
  assert.equal(read.data.character.loadout,undefined);assert.equal(read.data.zones,undefined);
  const bankItems=Array.from({length:33},(_,i)=>({id:'stored-'+i,item:{item_id:'adult_food',name:'Food '+i}}));
  service.db.prepare('INSERT OR REPLACE INTO quest_bank(character_id,items) VALUES (?,?)').run(first.id,JSON.stringify(bankItems));
  read=await get('&character_id='+first.id+'&bank_page=1');assert.equal(read.data.bank.page,1);assert.equal(read.data.bank.items[0].id,'stored-16');assert.ok(read.data.sheet,'the final HTTP re-read must retain the companion view');
  first=await act('leave',first);
  let second=await act('create',null,{name:'Second'});second=await act('enter',second,{zone:'princess-rose',loadout:{player_info:{str:3,equipped_weapon:'wooden_spoon'},inventory:[]}});
  assert.equal((await get()).data.sheet.character_id,second.id);assert.equal((await get('&character_id='+first.id)).data.sheet.inventory.length,1);assert.equal((await get('&character_id='+second.id)).data.sheet.inventory.length,0);
  assert.equal((await get('&character_id='+first.id,'b'.repeat(43))).status,404);
  second=await act('leave',second);
  const saved={online_revision:second.revision,player_info:{str:27,equipped_panties:'cotton_panties'},inventory:[{item_id:'water_bottle'}],player_mp:5,player_mp_max:10};
  service.db.prepare('INSERT INTO quest_cloud_versions VALUES (?,?,?,?,?,?,?,?)').run(second.id,1,owner,'cloud-test','a'.repeat(40),'{}',now,Buffer.from(JSON.stringify(saved)));
  read=await get('&character_id='+second.id);assert.equal(read.data.sheet.source,'cloud');assert.equal(read.data.sheet.player_info.str,27);assert.equal(read.data.sheet.inventory[0].item_id,'water_bottle');
  saved.online_revision=0;service.db.prepare('UPDATE quest_cloud_versions SET data=? WHERE character_id=?').run(Buffer.from(JSON.stringify(saved)),second.id);
  assert.equal((await get('&character_id='+second.id)).data.sheet.source,'online','older cloud inventory cannot replace committed online state');
  const row=service.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(first.id),state=JSON.parse(row.state);
  state.loadout.inventory=Array.from({length:512},()=>({item_id:'iron_dagger',name:'x'.repeat(96),atk:17,custom:'ignored'.repeat(100)}));
  service.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),first.id);
  read=await get('&character_id='+first.id);assert.equal(read.data.sheet.inventory.length,512);assert.equal(read.data.sheet.inventory[0].custom,undefined);assert.ok(Buffer.byteLength(JSON.stringify(read.data))<262144);
 }finally{service.server.closeAllConnections();await new Promise(r=>service.server.close(r));}
});
