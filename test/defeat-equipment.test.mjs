import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDefeatEquipment} from '../server/defeat-equipment.mjs';
import {changeEquipment} from '../server/companion-equipment.mjs';
import {hubData} from '../server/hubs.mjs';

const state=()=>({loadout:{player_info:{class_id:'fighter',str:10,def:4,dex:8,int:3,cha:2,playerHealth:40,playerHealthMax:100,shame:512,stamina:90},inventory:[],player_mp:0,player_mp_max:0,player_spells:[]}});
const run=(enemy='diaper_fairy',id='first')=>({kind:'dive',id,enemy:{enemy_id:enemy},log:[]});

test('forced defeat kit applies penalties and retains exact displaced items only once',()=>{
 const s=state(),r=run(),rolled={...hubData.equipment.princess_tiara,def:7,online_item:'owned-bow',online_sell_price:3};
 s.loadout.player_info.equipped_head='princess_tiara';s.loadout.player_info.equipped_item_data={head:rolled};s.loadout.player_info.def=11;
 const result=applyDefeatEquipment(s,r,'defeat'),p=s.loadout.player_info;
 assert.equal(result.variant,'first');assert.equal(p.equipped_panties,'printed_diaper');assert.equal(p.str,9);assert.equal(p.dex,6);
 assert.equal(p.equipped_head,'hair_bow');assert.equal(p.equipped_socks,'ruffle_socks');assert.equal(p.equipped_shoes,'mary_janes');
 assert.deepEqual(s.loadout.inventory.find(i=>i.online_item==='owned-bow'),rolled);
 assert.equal(p.panties_bulk,3);assert.equal(p.online_change_seq,1);
 const saved=structuredClone(s);assert.equal(applyDefeatEquipment(s,r,'defeat'),undefined);assert.deepEqual(s,saved);
 assert.equal(s.defeatEquipmentReceipt,'first');
});

test('repeat submission selects its escalated outfit and no-effect outcomes retain inventory',()=>{
 const s=state();applyDefeatEquipment(s,run('nanny_golem'),'submit');
 assert.equal(s.loadout.player_info.equipped_panties,'nighttime_diaper');assert.equal(s.loadout.player_info.equipped_mouth,'pacifier');
 const result=applyDefeatEquipment(s,run('nanny_golem','second'),'submitted');
 assert.equal(result.variant,'repeat');assert.equal(s.loadout.player_info.equipped_torso,'onesie');
 assert.equal(s.loadout.player_info.enemy_loss_effect_turns.nanny_golem,28);
 assert.equal(result.changes.find(c=>c.item==='bonnet').equipped,false,'unavailable headwear does not suppress other pieces');
 for(const outcome of ['win','flee','abandoned']){const before=structuredClone(s);applyDefeatEquipment(s,run('goblin',outcome),outcome);assert.deepEqual(s,before);}
 const before=structuredClone(s);applyDefeatEquipment(s,{...run(),kind:'arena'},'defeat');assert.deepEqual(s,before);
});

test('curses and full inventories preserve the old item while other empty slots still equip',()=>{
 const s=state();s.loadout.player_info.equipped_panties='cursed_pottypants_diaper';
 s.loadout.player_info.equipped_head='hair_bow';s.loadout.inventory=Array.from({length:hubData.config.inventory_capacity},()=>({item_id:'adult_food'}));
 const result=applyDefeatEquipment(s,run(),'charm_backfire');
 assert.equal(s.loadout.player_info.equipped_panties,'cursed_pottypants_diaper');
 assert.match(result.changes.find(c=>c.item==='printed_diaper').reason,/cursed/);
 assert.match(result.changes.find(c=>c.item==='hair_bow').reason,/Inventory full/);
 assert.equal(s.loadout.player_info.equipped_shoes,'mary_janes');assert.equal(s.loadout.inventory.length,hubData.config.inventory_capacity);
});

test('forced dresses displace two physical items, mirror once, and preserve unrelated bag items',()=>{
 const s=state(),p=s.loadout.player_info;p.equipped_torso='knit_sweater';p.equipped_pants='blue_jeans';s.loadout.inventory=[{item_id:'adult_food'}];
 const catalog={...hubData.equipment,fixture_dress:{item_id:'fixture_dress',category:'dress',name:'Fixture dress',def:5}};
 const next=changeEquipment(s.loadout,{action:'defeat_equip',item_id:'fixture_dress'},catalog,99);
 assert.equal(next.player_info.equipped_torso,'fixture_dress');assert.equal(next.player_info.equipped_pants,'fixture_dress');
 assert.equal(next.player_info.def,4-(catalog.knit_sweater.def??0)-(catalog.blue_jeans.def??0)+5);
 assert.deepEqual(next.inventory.map(i=>i.item_id),['adult_food','knit_sweater','blue_jeans']);
 assert.equal(s.loadout.player_info.equipped_torso,'knit_sweater','input loadout remains atomic');
});
