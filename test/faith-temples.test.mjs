import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {hubRooms,hubCatalog,hubData} from '../server/hubs.mjs';
import {districtData,generateDistrict,reachableDistrict} from '../server/hub-districts.mjs';
import {FAITH_SETTINGS,wouldBreakUniform} from '../server/faith.mjs';

// Temples, dedication, prayer, Orin's break-free and discount, Sable's sanctum as a changing room, Orin's duel piety
// check and starting hubs (FAITH_DESIGN.md). Uniforms and piety ticks are covered by faith.test.mjs.
const items=hubData.equipment;

function world(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,grant:()=>({owner:'alice',id:'a',client:'lidollquest',gamemaster:true}),wallet:()=>({coins:1000}),adjust:()=>{},diveOptions:{log:()=>{}},tundraOptions:{log:()=>{}},desertOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=400;const s=api.act('',{action,controller:'a',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 const edit=fn=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(c.id).state);fn(s);db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),c.id);};
 const zoneOf=s=>s.zones.find(z=>z.id===s.zone);
 return {db,api,act,place,edit,zoneOf,get c(){return c;},refresh:()=>{c=api.read('',c.id).character;return c;},close:()=>{api.close();db.close();}};
}
const beside=(f)=>({x:f.x,y:f.y+(f.span_h??1)}); // The tile just below a fixture.

test('every hub has its god\'s temple: four annexes on the town squares and Sable\'s sanctum in The Castle',()=>{
 assert.deepEqual(hubRooms.filter(r=>r.kind==='temple').map(r=>[r.parent,r.temple]),[['honeydew-lantern','orin'],['littlebig-clockwork','nyx'],['utopia-arcanum','sula'],['arcadia-foundry','orthain']]);
 for(const r of hubRooms.filter(r=>r.kind==='temple')){assert.ok(r.fixtures.some(f=>f.kind==='altar'&&f.god===r.temple));assert.ok(r.fixtures.some(f=>f.service==='dedicate'&&f.god===r.temple));}
 const castle=districtData.districts.find(d=>d.hub==='princess-rose');
 for(const edition of ['2026-09','2026-12','2027-03']){
  const f=generateDistrict(castle,{edition,ends:0});assert.ok(reachableDistrict(f));
  assert.deepEqual(f.fixtures.filter(x=>x.kind==='altar'||x.service==='dedicate').map(x=>x.god),['sable','sable']);
  const room=f.rooms.find(r=>r.kind==='temple');assert.deepEqual([room.x,room.y,room.w,room.h],[castle.temple.x,castle.temple.y,castle.temple.w,castle.temple.h]);
  assert.ok(!f.fixtures.some(x=>x.kind==='scenery'&&!x.id.startsWith('temple-')&&x.x>=room.x&&x.y>=room.y&&x.x<room.x+room.w&&x.y<room.y+room.h),'no stray scenery inside the sanctum');
 }
});

test('dedication: the first vow is free, a switch costs 1 diamond or 5 stars and resets piety, declined tributes change nothing; prayer tells your standing',()=>{
 const w=world();try{
  w.act('create',{name:'Alice'});w.act('enter',{zone:'honeydew-lantern',loadout:{player_info:{level:5,def:10},inventory:[]}});
  const door=w.zoneOf(w.api.read('',w.c.id)).portals.find(p=>p.target==='honeydew-lantern-temple');w.place(door.x,door.y);
  const temple=w.zoneOf(w.act('hub_visit',{zone:'honeydew-lantern-temple'}));assert.equal(temple.name,"Orin's Unbound Hearth");
  const priest=temple.fixtures.find(f=>f.service==='dedicate'),altar=temple.fixtures.find(f=>f.kind==='altar');
  w.place(altar.x+1,altar.y+1);w.act('faith_pray',{fixture:altar.id});assert.match(w.c.faithNotice,/The altar of Orin, god of Freedom/);
  assert.throws(()=>w.act('faith_dedicate',{fixture:priest.id}),/Stand next to that npc/);
  w.place(...Object.values(beside(priest)));w.act('faith_dedicate',{fixture:priest.id});
  assert.equal(w.c.faith.god,'orin');assert.equal(w.c.faith.piety,0);assert.equal(w.c.pendingPurchase,undefined,'the first vow is free');assert.match(w.c.faithNotice,/costs nothing/);
  assert.throws(()=>w.act('faith_dedicate',{fixture:priest.id}),/already sworn to Orin/);
  w.place(altar.x+1,altar.y+1);w.act('faith_pray',{fixture:altar.id});assert.match(w.c.faithNotice,/Piety 0\/100/); // Back beside the altar.
  w.act('gm_faith_set',{key:'orin',amount:60});
  w.act('leave');w.act('enter',{zone:'princess-rose-garden'});const castle=w.zoneOf(w.api.read('',w.c.id)),sable=castle.fixtures.find(f=>f.service==='dedicate');
  w.place(...Object.values(beside(sable)));
  assert.throws(()=>w.act('faith_dedicate',{fixture:sable.id}),/costs a tribute: 1 diamond or 5 stars/);
  w.act('faith_dedicate',{fixture:sable.id,mode:'diamond'});
  let row=w.db.prepare('SELECT * FROM hub_purchases WHERE id=?').get(w.c.pendingPurchase);assert.deepEqual([JSON.parse(row.item).currency,row.price],['diamonds',1]);
  w.api.completePurchase(w.c.pendingPurchase,false);w.refresh();assert.equal(w.c.faith.god,'orin');assert.equal(w.c.faith.piety,60);assert.match(w.c.hubNotice,/Not enough diamonds/);
  w.act('faith_dedicate',{fixture:sable.id,mode:'stars'});
  row=w.db.prepare('SELECT * FROM hub_purchases WHERE id=?').get(w.c.pendingPurchase);assert.deepEqual([JSON.parse(row.item).currency,row.price],['stars',FAITH_SETTINGS.tribute_stars]);
  w.api.completePurchase(w.c.pendingPurchase,true);w.refresh();
  assert.equal(w.c.faith.god,'sable');assert.equal(w.c.faith.piety,0,'a new god starts from nothing');assert.equal(w.c.faithSworn,2);assert.deepEqual(w.c.loadout.faith,{god:'sable',piety:0,locked:false});
 }finally{w.close();}
});

test('Orin: break free of cursed gear up to 3 times a day at full piety, fewer when less devout; the Cursebreaker charges half',()=>{
 const w=world();try{
  w.act('create',{name:'Alice'});w.act('enter',{zone:'honeydew-lantern',loadout:{player_info:{level:5,def:10,equipped_head:'sensor_cap'},inventory:[]}});
  assert.throws(()=>w.act('faith_break_free',{slot:'head',item_id:'sensor_cap'}),/Only Orin's followers/);
  w.act('gm_faith_set',{key:'orin',amount:40});
  w.act('faith_break_free',{slot:'head',item_id:'sensor_cap'});assert.equal(w.c.loadout.player_info.equipped_head,'');assert.match(w.c.faithNotice,/tear free of the .*\(0 left today\)/); // 40 piety: one break a day.
  const recurse=()=>w.edit(s=>{s.loadout.player_info.equipped_head='sensor_cap';s.loadout.inventory=[];});
  recurse();assert.throws(()=>w.act('faith_break_free',{slot:'head',item_id:'sensor_cap'}),/as often as Orin allows today/);
  w.act('gm_faith_set',{key:'orin',amount:100});
  for(let n=0;n<2;n++){recurse();w.act('faith_break_free',{slot:'head',item_id:'sensor_cap'});} // 3 a day at full piety, one already spent
  recurse();assert.throws(()=>w.act('faith_break_free',{slot:'head',item_id:'sensor_cap'}),/as often as Orin allows today/);
  const curser=w.zoneOf(w.api.read('',w.c.id)).fixtures.find(f=>f.service==='curse_remove');w.place(curser.x,curser.y+1);
  w.act('curse_remove',{fixture:curser.id,slot:'head',item_id:'sensor_cap'});
  assert.equal(w.db.prepare('SELECT price FROM hub_purchases WHERE id=?').get(w.c.pendingPurchase).price,Math.ceil(hubData.config.curse_removal_price/2));
 }finally{w.close();}
});

test('Sable\'s sanctum counts as a changing room; wouldBreakUniform spots anathema before it is worn; creation picks a starting hub and a free patron',()=>{
 const w=world();try{
  w.act('create',{name:'Alice',creation:{start_hub:'arcadia-foundry',patron:'sable'}});
  assert.equal(w.c.homeHub,'arcadia-foundry');assert.equal(w.c.faith.god,'sable');assert.equal(w.c.faithSworn,1,'the patron was the free vow');
  const dressed={player_info:{level:5,def:10,equipped_torso:'leather_vest',equipped_pants:'blue_jeans',equipped_panties:'cotton_panties'},inventory:[]};
  w.act('enter',{zone:'princess-rose-garden',loadout:dressed});
  const room=w.zoneOf(w.api.read('',w.c.id)).rooms?.find(r=>r.kind==='temple')??districtData.districts.find(d=>d.hub==='princess-rose').temple;
  w.place(room.x+1,room.y+1);w.act('loadout',{loadout:{...dressed,player_info:{...dressed.player_info,equipped_panties:'lace_panties'}}});
  assert.equal(w.c.faith.piety,0);assert.ok(!/changed out in the open/.test(w.c.faithNotice??''),'changing inside the sanctum is proper');
  w.act('gm_faith_set',{key:'sable',amount:40});w.place(room.x+4,room.y-5);w.act('loadout',{loadout:dressed}); // Out on the street.
  assert.match(w.c.faithNotice,/changed out in the open/);assert.equal(w.c.faith.piety,40-FAITH_SETTINGS.sable_change_penalty);
 }finally{w.close();}
 const w2=world();try{assert.throws(()=>w2.act('create',{name:'Bob',creation:{start_hub:'atlantis'}}),/five hubs/);}finally{w2.close();}
 const vest={player_info:{equipped_torso:'leather_vest',equipped_pants:'blue_jeans',equipped_panties:'cotton_panties',incontinence:0},inventory:[]};
 assert.equal(wouldBreakUniform('orthain',vest,items.diaper,items),true,'a diaper would break Orthain\'s uniform');
 assert.equal(wouldBreakUniform('orthain',vest,items.blue_jeans,items),false);
 assert.equal(wouldBreakUniform('sable',vest,items.overalls,items),false,'covered either way');
 assert.equal(wouldBreakUniform('orin',vest,items.diaper,items),false,'Orin has no uniform to break');
 assert.ok(hubCatalog.length===5);
});
