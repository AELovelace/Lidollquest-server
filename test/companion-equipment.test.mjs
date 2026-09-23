import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {changeEquipment} from '../server/companion-equipment.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {createCloudSaves} from '../server/cloud-saves.mjs';
import {createItemOrigins} from '../server/item-origins.mjs';
import {hubData,hubCatalog,hubRooms,hubDefinition,hubArrival,routeHome} from '../server/hubs.mjs';

const catalog={blade:{item_id:'blade',category:'weapon',name:'Blade',atk:2},dress:{item_id:'dress',category:'dress',def:4},shirt:{item_id:'shirt',category:'torso',def:2},pants:{item_id:'pants',category:'pants',def:1},curse:{item_id:'curse',name:'Curse',category:'head',cursed:true,def:5},diaper:{item_id:'diaper',category:'panties',cursed:true,is_diaper:true,bulk:3,wet_resist:-2,atk_mod:-1}};
const loadout=()=>({player_info:{str:12,def:5,dex:3,int:3,cha:3,stamina:10,equipped_weapon:'blade',equipped_torso:'shirt',equipped_pants:'pants'},inventory:[]});
test('equipment preserves rolled instances, reverses exact stats, and handles a dress once',()=>{
 let l=loadout();l.inventory=[{...catalog.blade,atk:17,online_item:'same-id-second'}];
 l=changeEquipment(l,{action:'companion_equip',slot:0,item_id:'blade'},catalog,10);
 assert.equal(l.player_info.str,27);assert.equal(l.inventory[0].atk,2);
 l=changeEquipment(l,{action:'companion_unequip',slot:'weapon',item_id:'blade'},catalog,10);
 assert.equal(l.player_info.str,10);assert.equal(l.inventory[1].atk,17);assert.equal(l.inventory[1].online_item,'same-id-second');
 l.inventory.push(catalog.dress);l=changeEquipment(l,{action:'companion_equip',slot:2,item_id:'dress'},catalog,10);
 assert.equal(l.player_info.def,6);assert.equal(l.player_info.equipped_pants,'dress');
 l=changeEquipment(l,{action:'companion_unequip',slot:'pants',item_id:'dress'},catalog,10);
 assert.equal(l.player_info.def,2);assert.equal(l.player_info.equipped_torso,'');assert.equal(l.inventory.filter(i=>i.item_id==='dress').length,1);
});
test('curse, capacity, used diaper and layered-clothing checks are atomic',()=>{
 let l=loadout();l.inventory=[catalog.dress];const before=structuredClone(l);
 assert.throws(()=>changeEquipment(l,{action:'companion_equip',slot:0,item_id:'dress'},catalog,1),/Inventory full/);assert.deepEqual(l,before);
 l.player_info.equipped_head='curse';assert.throws(()=>changeEquipment(l,{action:'companion_unequip',slot:'head',item_id:'curse'},catalog,10),/cursed/);
 l.player_info.equipped_panties='diaper';l.player_info.diaper_wet_absorbed=2;assert.throws(()=>changeEquipment(l,{action:'companion_unequip',slot:'panties',item_id:'diaper'},catalog,1),/cursed/);
 l.player_info.diaper_wet_absorbed=3;const changed=changeEquipment(l,{action:'companion_unequip',slot:'panties',item_id:'diaper'},catalog,1);
 assert.equal(changed.inventory.length,1);assert.equal(changed.player_info.equipped_panties,'');assert.equal(changed.player_info.diaper_wet_absorbed,0);
});
test('all lobby doors, annex exits and dungeon pads arrive on an adjacent interior tile',()=>{
 for(const root of hubCatalog){
  const lobby=hubDefinition(root,0);
  for(const portal of lobby.portals){const child=hubRooms.find(r=>r.id===portal.target),arrival=hubArrival(root,portal.target);
   if(!child){assert.equal(Math.abs(arrival.x-portal.x)+Math.min(...Array.from({length:portal.h??1},(_,i)=>Math.abs(arrival.y-portal.y-i))),1);continue;} // Rose Court's garden-wall Tundra gate: arrivals stand one tile inside it.
   const enter=hubArrival(child,root.id);
   assert.ok(arrival.x>=1&&arrival.y>=1&&arrival.x<lobby.width-1&&arrival.y<lobby.height-1);
   assert.equal(Math.abs(arrival.x-portal.x)+Math.min(...Array.from({length:portal.h??1},(_,i)=>Math.abs(arrival.y-portal.y-i))),1);
   assert.deepEqual(enter,child.spawn);
  }
  const hall=hubRooms.find(r=>r.parent===root.id&&r.kind==='dives');
  for(const pad of hubDefinition(hall,0).portals){const arrival=hubArrival(hall,pad.target);assert.equal(Math.abs(arrival.x-pad.x)+Math.min(...Array.from({length:pad.h??1},(_,i)=>Math.abs(arrival.y-pad.y-i))),1);} // Two-tile wall openings arrive beside either tile.
  assert.deepEqual(lobby.exit,root.id==='princess-rose'?{x:2,y:17,style:'stairs'}:{x:1,y:10,style:'stairs'}); // Campaign stairs sit in the bottom-left corner of every court, including the 20x20 garden.
  assert.deepEqual(hubArrival(root,root.id+'-dives'),{x:9,y:1});
  assert.deepEqual(hubArrival(root,root.id+'-shops'),root.id==='princess-rose'?{x:15,y:17}:{x:15,y:9});
 }
});
test('companion edits use revision receipts, keep the game lease, block combat, and publish cloud equipment safely',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-18T12:00:00Z');
 const zones=createQuestZones(db,{now:()=>now,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:50}),adjust:()=>{}});createCloudSaves(db,{now:()=>now});
 let c;const act=(action,extra={})=>{const result=zones.act('token',{action,controller:'game',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=result.character;return result;};
 const sheet=()=>zones.read('token',c.id,{companion:true}).sheet;
 try{
  act('create',{name:'Alice'});const tracked=createItemOrigins(db).mint(c.id,{...hubData.equipment.iron_dagger,atk:17});
  act('enter',{zone:'honeydew-lantern',loadout:{player_info:{str:10,stamina:100},inventory:[tracked]}});
  const presence={...db.prepare('SELECT * FROM quest_presence').get()};
  const input={revision:c.revision,slot:0,item_id:'iron_dagger',equipment_version:sheet().equipment_version,controller:'companion',request_id:randomUUID()};
  act('companion_equip',input);assert.equal(c.loadout.player_info.str,27);assert.equal(c.loadout.inventory.length,0);
  const revision=c.revision;act('companion_equip',input);assert.equal(c.revision,revision,'duplicate request cannot equip twice');
  assert.deepEqual({...db.prepare('SELECT * FROM quest_presence').get()},presence);
  assert.throws(()=>act('companion_unequip',{slot:'weapon',item_id:'iron_dagger',equipment_version:input.equipment_version}),/changed/);
  act('companion_unequip',{slot:'weapon',item_id:'iron_dagger',equipment_version:sheet().equipment_version});assert.equal(c.loadout.inventory[0].atk,17);
  assert.equal(c.loadout.inventory[0].online_item,tracked.online_item);assert.equal(db.prepare('SELECT status FROM quest_item_origins WHERE id=?').get(tracked.online_item).status,'held');
  act('start');assert.throws(()=>act('companion_equip',{...input,revision:c.revision,request_id:randomUUID(),equipment_version:sheet().equipment_version}),/combat/);
  act('submit');act('leave');
  const save={version:1,current_room:'Room5_Town',room_data:{Room5_Town:{marker:'preserved'}},online_revision:c.revision,player_info:{str:6},inventory:[{...hubData.equipment.iron_dagger,atk:11}],player_mp:9,player_spells:['fireball']};
  db.prepare('INSERT INTO quest_cloud_versions VALUES (?,?,?,?,?,?,?,?)').run(c.id,1,'alice','original','0'.repeat(40),'{}',now,Buffer.from(JSON.stringify(save)));
  assert.equal(sheet().source,'cloud');const cloudToken=sheet().equipment_version;
  db.prepare('INSERT INTO quest_cloud_uploads VALUES (?,?,?,?,?,?,?)').run('alice','pending',c.id,1,'0'.repeat(40),2,now);
  assert.throws(()=>act('companion_equip',{...input,revision:c.revision,request_id:randomUUID(),equipment_version:cloudToken}),/uploading/);
  db.prepare('DELETE FROM quest_cloud_uploads').run();
  act('companion_equip',{...input,revision:c.revision,request_id:randomUUID(),equipment_version:cloudToken});
  const row=db.prepare('SELECT * FROM quest_cloud_versions ORDER BY revision DESC LIMIT 1').get(),updated=JSON.parse(Buffer.from(row.data).toString());
  assert.equal(row.revision,2);assert.equal(updated.player_info.str,17);assert.equal(updated.inventory.length,0);assert.deepEqual(updated.room_data,save.room_data);assert.deepEqual(updated.player_spells,['fireball']);assert.equal(updated.online_revision,c.revision);
  assert.equal(row.checksum,createHash('sha1').update(row.data).digest('hex'));assert.equal(sheet().source,'cloud');
 }finally{db.close();}
});

test('every live hall route returns to its own pad, including crossing exits and reconnects',()=>{
 const db=new DatabaseSync(':memory:'),now=Date.parse('2026-09-18T12:00:00Z');
 const zones=createQuestZones(db,{now:()=>now,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{}});
 let c;const act=(action,extra={})=>{const result=zones.act('token',{action,controller:'game',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=result.character;return result;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(x,y,c.id);
 try{
  act('create',{name:'Alice'});
  for(const root of hubCatalog){
   act('enter',{zone:root.id,loadout:{player_info:{str:10,stamina:100},inventory:[]}});
   const hall=hubRooms.find(r=>r.parent===root.id&&r.kind==='dives');place(9,0);act('hub_visit',{zone:hall.id});
   for(const pad of hubDefinition(hall,0).portals){
    place(pad.x,pad.y+1);const entered=act('dive_enter',{zone:pad.target});
    const exits=entered.zones.find(z=>z.id===pad.target).exits??[];
    const returned=act('dive_exit');assert.equal(returned.zone,hall.id);assert.deepEqual(returned.position,hubArrival(hall,pad.target));
    assert.deepEqual(act('enter',{zone:pad.target}).position,returned.position,'suspended dungeon reconnect retains its return pad');
    assert.deepEqual(act('enter',{zone:hall.id}).position,returned.position,'ordinary reconnect retains the same arrival');
    for(const exit of exits.filter(e=>hubCatalog.some(h=>h.id===e.zone))){ // Wilderness branches have no hall pad; their reciprocal trail is covered by taiga.test.mjs.
     place(pad.x,pad.y+1);act('dive_enter',{zone:pad.target});place(exit.x,exit.y);
     const home=routeHome(exit.zone,pad.target,{returnZone:hall.id}),crossed=act('dive_exit',{zone:exit.zone}),target=[...hubRooms,...hubCatalog].find(r=>r.id===home); // Rose Court receives the Tundra in its garden; the other courts in their halls.
     assert.equal(crossed.zone,target.id);assert.deepEqual(crossed.position,hubArrival(target,pad.target));
     if(target.parent)act('hub_visit',{zone:target.parent});act('leave');act('enter',{zone:root.id});place(9,0);act('hub_visit',{zone:hall.id});
    }
   }
   const returned=act('hub_visit',{zone:root.id});assert.deepEqual(returned.position,{x:9,y:1});
   assert.deepEqual(act('enter',{zone:root.id}).position,returned.position);act('leave');
  }
 }finally{db.close();}
});
