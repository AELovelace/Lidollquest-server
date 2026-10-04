import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {elide,cacheKey} from '../server/snapshot-cache.mjs';

const look={version:1,slots:{base:'piko_woman',underwear:'diaper',hair:'twin_tails',torso:'short_sundress',shoes:'mary_janes'},colors:{hair:[[255,150,200]]},enabled:{hair:[true]},facing:0};
const loadout={player_info:{class_id:'fighter',playerHealth:100,playerHealthMax:100,str:5,def:5,dex:5,int:5,cha:5,level:1,xp:0,stat_points:0},inventory:[],player_spells:[],player_mp:0,player_mp_max:0};

function world(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-03T12:00:00Z'),owner='doll';
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const as=(who,fn)=>{const before=owner;owner=who;try{return fn();}finally{owner=before;}};
 const create=(who,extra={})=>as(who,()=>zones.act('',{action:'create',request_id:randomUUID(),controller:'w',name:who,...extra}).character);
 const act=(who,id,action,extra={})=>as(who,()=>{time+=1000;return zones.act('',{action,request_id:randomUUID(),controller:'w',character_id:id,revision:zones.read('',id).character.revision,...extra});});
 const read=(who,id)=>as(who,()=>zones.read('',id));
 const enter=(who,id,zone='honeydew-lantern')=>act(who,id,'enter',{zone,loadout,combat_version:3,content_version:1,quest_version:1});
 const state=id=>JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id).state);
 return {db,zones,create,act,read,enter,state,as,close:()=>{zones.close();db.close();}};
}

test('character creation saves the wardrobe look and wears it; locked or over-limit looks are refused',()=>{
 const w=world();
 try{
  const c=w.create('doll',{creation:{look,start_hub:'honeydew-lantern'}});
  assert.equal(w.state(c.id).avatar,'look','a created look is worn straight away');
  assert.equal(w.state(c.id).look.slots.hair,'twin_tails');
  assert.deepEqual(w.state(c.id).look.colors.hair,[[255,150,200]]);
  assert.throws(()=>w.create('doll',{creation:{look:{...look,slots:{...look.slots,head:'tiara'}}}}),/Unlock Tiara/,'accessories must be unlocked first');
  assert.throws(()=>w.create('doll',{creation:{look:{...look,slots:{...look.slots,base:'nobody'}}}}),/Unsupported/);
  assert.throws(()=>w.create('doll',{avatar:'look'}),/Design a look/,'"look" needs a look');
  assert.throws(()=>w.create('doll',{avatar:'objNPCGuard'}),/no longer player avatars/,'NPC sprites are retired for new characters');
  assert.equal(w.state(w.create('doll',{}).id).avatar,'player','no look: the default sprite');
 }finally{w.close();}
});

test('the lobby exposes committed level, class, location and look without inventory or writes',()=>{
 const w=world();
 try{
  const c=w.create('doll',{creation:{look,start_hub:'honeydew-lantern',class_id:'fighter'}});
  const fresh=w.read('doll').characters.find(row=>row.id===c.id);
  assert.equal(fresh.overview.level,1);assert.equal(fresh.overview.class_id,'fighter');
  assert.equal(fresh.overview.location,w.read('doll').zones.find(z=>z.id==='honeydew-lantern').name);
  w.enter('doll',c.id);
  const state=w.state(c.id);state.loadout.player_info.level=27;state.loadout.player_info.class_id='mage';
  w.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),c.id);
  const before=w.db.prepare('SELECT * FROM quest_characters WHERE id=?').get(c.id);
  const list=w.read('doll'),row=list.characters.find(row=>row.id===c.id),detail=w.read('doll',c.id).character;
  assert.deepEqual(row.overview,detail.overview);assert.equal(row.overview.level,27);assert.equal(row.overview.class_id,'mage');
  assert.deepEqual(row.look,state.look);assert.equal(row.loadout,undefined,'roster must not repeat inventories');
  assert.ok(Array.isArray(list.spriteWorkshop),'preloading metadata is available before entering the world');
  assert.deepEqual(w.db.prepare('SELECT * FROM quest_characters WHERE id=?').get(c.id),before,'preview reads leave character state unchanged');
  assert.equal(w.read('stranger').characters.some(row=>row.id===c.id),false,'character previews remain account scoped');
  assert.throws(()=>w.read('stranger',c.id),/character|Character|found/);
 }finally{w.close();}
});

test('peers see each other\'s looks by content key, and the snapshot cache sends each look only once',()=>{
 const w=world();
 try{
  const a=w.create('doll',{creation:{look}}),b=w.create('handler',{});
  w.enter('doll',a.id);w.enter('handler',b.id);
  const seen=w.read('handler',b.id),peer=seen.peers.find(p=>p.id===a.id);
  assert.equal(peer.avatar,'look');assert.equal(peer.lookKey,cacheKey(w.state(a.id).look));
  assert.deepEqual(seen.looks[peer.lookKey],w.state(a.id).look,'the look rides beside the peers');
  assert.equal(seen.peers.find(p=>p.id===b.id).lookKey,undefined,'the default sprite carries no look');
  const again=elide(w.read('handler',b.id),new Set([peer.lookKey]));
  assert.equal(again.looks[peer.lookKey],1,'a look the client already holds becomes a stub');
  const view=w.as('handler',()=>w.zones.inspect('',b.id,a.id,'w'));
  assert.equal(view.avatar,'look');assert.equal(view.look.slots.torso,'short_sundress','inspecting shows the look');
 }finally{w.close();}
});

test('a character without a saved look gets its first wardrobe save free, including retries',()=>{
 const w=world();
 try{
  const c=w.create('doll',{});w.enter('doll',c.id);
  assert.throws(()=>w.act('doll',c.id,'look',{look:{...look,slots:{...look.slots,head:'tiara'}}}),/Unlock Tiara/,'free setup does not unlock premium accessories');
  assert.equal(w.state(c.id).look,undefined,'a rejected look does not consume the first save');
  const request={request_id:randomUUID(),revision:w.read('doll',c.id).character.revision,look};
  w.act('doll',c.id,'look',request);
  assert.equal(w.state(c.id).avatar,'look');assert.equal(w.state(c.id).look.slots.hair,'twin_tails');
  assert.equal(w.state(c.id).pendingPurchase,undefined,'first save creates no diamond reservation');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM hub_purchases').get().n,0);
  const revision=w.read('doll',c.id).character.revision;
  w.act('doll',c.id,'look',request);
  assert.equal(w.read('doll',c.id).character.revision,revision,'retrying the free receipt is not a second save');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM hub_purchases').get().n,0);
  w.act('doll',c.id,'appearance',{avatar:'player'});
  w.act('doll',c.id,'look',{look:{...look,slots:{...look.slots,hair:'pixie_cut'}}});
  assert.ok(w.state(c.id).pendingPurchase,'switching to the default sprite does not reset the free save');
  w.zones.completePurchase(w.state(c.id).pendingPurchase,false);
  assert.equal(w.state(c.id).look.slots.hair,'twin_tails','declined subsequent changes preserve the first look');
  w.act('doll',c.id,'leave'); // Finish the first character's lease before testing another on the same account.
  const second=w.create('doll',{});w.enter('doll',second.id);w.act('doll',second.id,'look',{look});
  assert.equal(w.state(second.id).pendingPurchase,undefined,'each character gets its own first setup');
  assert.equal(w.state(second.id).look.slots.hair,'twin_tails');
 }finally{w.close();}
});

test('subsequent look saves are free beside a hub mirror and cost one diamond elsewhere',()=>{
 const w=world();
 try{
  const initial={...look,slots:{...look.slots,hair:'piko_hair'}};
  const c=w.create('doll',{creation:{look:initial}});w.enter('doll',c.id);
  w.act('doll',c.id,'look',{look});
  const pending=w.state(c.id).pendingPurchase;assert.ok(pending,'away from a mirror the save waits on a diamond');
  const row=w.db.prepare('SELECT * FROM hub_purchases WHERE id=?').get(pending);
  assert.deepEqual([JSON.parse(row.item).currency,row.price],['diamonds',1]);
  assert.equal(w.state(c.id).look.slots.hair,'piko_hair','nothing changes before the debit lands');
  w.zones.completePurchase(pending,false);assert.equal(w.state(c.id).look.slots.hair,'piko_hair','a declined debit keeps the creation look');
  w.act('doll',c.id,'look',{look});w.zones.completePurchase(w.state(c.id).pendingPurchase,true);
  assert.equal(w.state(c.id).avatar,'look');assert.equal(w.state(c.id).look.slots.torso,'short_sundress');
  // Walk into the Honeydew inn and stand beside its vanity mirror.
  const inn='honeydew-lantern-beds';w.db.prepare('UPDATE quest_presence SET zone=? WHERE character_id=?').run(inn,c.id);
  const mirror=w.read('doll',c.id).zones.find(z=>z.id===inn).fixtures.find(f=>f.kind==='mirror'); // The room you stand in is sent in full.
  assert.ok(mirror,'every bedroom in a hub has a vanity mirror');assert.equal(mirror.sprite,'sprPQDetailVanity');
  w.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(mirror.x-1,mirror.y,c.id);
  const restyled={...look,slots:{...look.slots,hair:'pixie_cut'}};
  w.act('doll',c.id,'look',{look:restyled});
  assert.equal(w.state(c.id).pendingPurchase,undefined,'no purchase beside the mirror');
  assert.equal(w.state(c.id).look.slots.hair,'pixie_cut','the mirror saves straight away, free');
 }finally{w.close();}
});

test('players can wear their saved look but cannot select retired private or NPC sprites',()=>{
 const w=world();
 try{
  const c=w.create('doll',{creation:{look}});w.enter('doll',c.id);
  w.act('doll',c.id,'appearance',{avatar:'player'});assert.equal(w.state(c.id).avatar,'player');
  w.act('doll',c.id,'appearance',{avatar:'look'});assert.equal(w.state(c.id).avatar,'look','"Use my look" switches back for free');
  assert.throws(()=>w.act('doll',c.id,'appearance',{avatar:'objNPCGuard'}),/no longer player avatars/);
  assert.throws(()=>w.act('doll',c.id,'appearance',{avatar:'private-retired'}),e=>e.status===410);
  // Grandfathered: a character already wearing an NPC sprite keeps it.
  const old=w.create('veteran',{});const s=w.state(old.id);s.avatar='objNPCGuard';w.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),old.id);
  w.enter('veteran',old.id);assert.equal(w.read('veteran',old.id).character.avatar,'objNPCGuard','existing NPC avatars stay until the player changes');
 }finally{w.close();}
});
