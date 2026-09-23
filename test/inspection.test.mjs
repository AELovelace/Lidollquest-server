import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
test('inspection isolates committed appearance, validates live area and never exports raw inventory or survival state',()=>{
 const db=new DatabaseSync(':memory:');let now=1000000;const chars={};
 const api=createQuestZones(db,{now:()=>now,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 const act=(owner,action,extra={})=>{now+=500;const s=api.act(owner,{action,controller:owner,request_id:randomUUID(),character_id:chars[owner]?.id,revision:chars[owner]?.revision,...extra});chars[owner]=s.character;return s;};
 try{
  for(const who of ['alice','bob']){act(who,'create',{name:who});act(who,'enter',{zone:'honeydew-lantern',loadout:{player_info:{name:who+' campaign',gender:'Male',hair_color:'Pink',diaper_wet_absorbed:2,hunger:200,shame:400,companions:{secret:1},equipped_weapon:'iron_dagger'},inventory:[{item_id:'adult_food'}]}});}
  const p=api.inspect('alice',chars.alice.id,chars.bob.id,'alice');assert.equal(p.name,'bob campaign');assert.equal(p.player_info.diaper_wet_absorbed,2);assert.equal(p.player_info.hunger,undefined);assert.equal(p.player_info.shame,undefined);assert.equal(p.player_info.companions,undefined);assert.equal(p.inventory,undefined);
  assert.throws(()=>api.inspect('alice',chars.bob.id,chars.alice.id,'alice'),/not found/);
  act('bob','enter',{zone:'littlebig-clockwork'});assert.throws(()=>api.inspect('alice',chars.alice.id,chars.bob.id,'alice'),/no longer/);
  for(const who of ['alice','bob'])act(who,'enter',{zone:'princess-rose'}); // Quarters is shared through Rose Court alone.
  act('alice','dive_enter');const entered=act('bob','dive_enter');
  assert.equal(api.inspect('alice',chars.alice.id,chars.bob.id,'alice').character_id,chars.bob.id);
  const room=entered.zones.find(z=>z.id==='dive-quarters').rooms[1];
  db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(room.x,room.y,chars.bob.id);
  const aliceView=api.read('alice',chars.alice.id),bobView=api.read('bob',chars.bob.id);
  assert.equal(aliceView.chatArea.id,bobView.chatArea.id,'one chat stream per floor; distance decides who hears whom');
  assert.ok(aliceView.peers.some(peer=>peer.id===chars.bob.id),'the other room player is displayed on this floor');
  assert.equal(api.inspect('alice',chars.alice.id,chars.bob.id,'alice').character_id,chars.bob.id,'displayed dive players remain inspectable across room boundaries');
  const same=db.prepare('SELECT x,y FROM quest_presence WHERE character_id=?').get(chars.alice.id);db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(same.x,same.y,chars.bob.id);
  const state=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(chars.bob.id).state);
  for(const [key,value] of [['route','other-route'],['depth',2]]){
   const original=state.dive[key];state.dive[key]=value;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),chars.bob.id);
   assert.throws(()=>api.inspect('alice',chars.alice.id,chars.bob.id,'alice'),/no longer/,'another '+key+' cannot be inspected');state.dive[key]=original;
  }
  state.dive.edition='retired-edition';db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),chars.bob.id);
  assert.throws(()=>api.inspect('alice',chars.alice.id,chars.bob.id,'alice'),/no longer/,'different editions deny inspection even at matching coordinates');
  now+=31000;assert.throws(()=>api.inspect('alice',chars.alice.id,chars.bob.id,'alice'),/connection/);
 }finally{db.close();}
});
