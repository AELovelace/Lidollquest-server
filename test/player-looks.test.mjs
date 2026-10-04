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

test('saving a look is free beside a hub mirror and costs one diamond anywhere else',()=>{
 const w=world();
 try{
  const c=w.create('doll',{});w.enter('doll',c.id);
  w.act('doll',c.id,'look',{look});
  const pending=w.state(c.id).pendingPurchase;assert.ok(pending,'away from a mirror the save waits on a diamond');
  const row=w.db.prepare('SELECT * FROM hub_purchases WHERE id=?').get(pending);
  assert.deepEqual([JSON.parse(row.item).currency,row.price],['diamonds',1]);
  assert.equal(w.state(c.id).avatar,'player','nothing changes before the debit lands');
  w.zones.completePurchase(pending,false);assert.equal(w.state(c.id).look,undefined,'a declined debit keeps the old look');
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
