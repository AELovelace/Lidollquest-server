import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {consumeFromBag,hungerRestore,thirstRestore,wetTargetGain,tumTargetGain} from '../server/companion-consume.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {createCloudSaves} from '../server/cloud-saves.mjs';
import {hubData} from '../server/hubs.mjs';
import {DEFAULT_TUNING} from '../server/loot.mjs';

const E=hubData.equipment;
const tuning={...DEFAULT_TUNING,heal_reference_hp:100,mana_reference_mp:100,shame_mult_low:0.5,shame_mult_high:2};
const person=(extra={})=>({player_info:{playerHealth:50,playerHealthMax:300,hunger:10,thirst:10,wet:10,tum:10,stamina:5,stamina_max:40,shame:1024,shame_level:0,incontinence:100,...extra},inventory:[],player_mp:0,player_mp_max:200,world:{wet_only_mode:false}});

test('a Milk Bottle feeds, hydrates, heals to the HP bar and queues digestion exactly like the game',()=>{
 const l=person();l.inventory=[{...E.bottle,quantity:3,online_items:['a','b','c'],online_item:'a',online_sell_price:4}];
 const lines=consumeFromBag(l,0,'bottle',E,{tuning});
 const p=l.player_info;
 assert.equal(p.playerHealth,95,'15 HP x heal scale 3 (a 300 HP bar)');
 assert.equal(p.hunger,30);assert.equal(p.thirst,177);assert.equal(p.wet,13);assert.equal(p.tum,12);
 const d=p.active_effects.at(-1);assert.equal(d.duration_remaining,4);assert.equal(d.wet_per_turn,5);assert.equal(d.wet_target_gain,20);assert.equal(d.tum_target_gain,4);assert.equal(d.suppress_proc_popup,true);
 assert.equal(l.inventory[0].quantity,2);assert.deepEqual(l.inventory[0].online_items,['a','b']);assert.equal(l.inventory[0].online_item,'a');assert.equal(l.inventory[0].online_sell_price,4); // Newest right leaves first; the front unit stays sellable.
 assert.ok(lines[0].startsWith('Used Milk Bottle. Restored 45 HP.'));assert.ok(lines.includes('Hunger +20, Thirst +167, Wet +3, Tum +2.'));
 consumeFromBag(l,0,'bottle',E,{tuning});consumeFromBag(l,0,'bottle',E,{tuning});assert.equal(l.inventory.length,0,'the entry disappears at zero');
});

test('tier floors, wet-only mode and meter caps match the survival system',()=>{
 assert.equal(hungerRestore({category:'food',item_id:'x'}),167);assert.equal(hungerRestore({category:'food',is_snack:true}),125);
 assert.equal(hungerRestore(E.baby_wipes),0,'wipes are not a meal');assert.equal(thirstRestore({category:'drink',item_id:'blue_potion'}),125);
 assert.equal(thirstRestore({category:'food',is_drink:true}),167);assert.equal(wetTargetGain({category:'drink'}),20);assert.equal(tumTargetGain({category:'food',is_snack:true}),12);
 const l=person({hunger:240,tum:99});l.world.wet_only_mode=true;l.inventory=[{item_id:'stew',category:'food',name:'Stew'}];
 consumeFromBag(l,0,'stew',{},{tuning});assert.equal(l.player_info.hunger,250);assert.equal(l.player_info.tum,99,'easy mode never adds tummy pressure');
 const cloud=person({tum:5});cloud.world.wet_only_mode=false;cloud.inventory=[{item_id:'stew',category:'food',name:'Stew'}];
 consumeFromBag(cloud,0,'stew',{},{tuning,wetOnly:true});assert.equal(cloud.player_info.tum,5,'a cloud save passes its own easy-mode flag');
});

test('Dignity changes use the Shame multiplier for losses only',()=>{
 const low=person({shame_level:0});low.inventory=[{...E.cursed_lollipop}];
 assert.ok(consumeFromBag(low,0,'cursed_lollipop',E,{tuning}).some(line=>line.includes('Dignity -24')));assert.equal(low.player_info.shame,1000);
 const high=person({shame_level:100});high.inventory=[{...E.cursed_lollipop}];consumeFromBag(high,0,'cursed_lollipop',E,{tuning});assert.equal(high.player_info.shame,1024-96);
 const gain=person({shame:500,shame_level:100});gain.inventory=[{...E.baby_wipes}];consumeFromBag(gain,0,'baby_wipes',E,{tuning});assert.equal(gain.player_info.shame,532,'gains are never scaled');
});

test('Baby Wipes clean up accidents, dry the underwear, return wet-clothing stats and settle unnoticed accidents',()=>{
 const l=person({accident_bulk:2,panties_bulk:5,had_wet_accident:1,had_tum_accident:1,diaper_wet_absorbed:1,grossout_chance:30,wet_hold_attempts:2,
  equipped_panties:'plain_panties',equipped_socks:'socks',equipped_shoes:'shoes',equipped_pants:'pants',slot_wet_panties:true,slot_wet_socks:true,slot_wet_shoes:true,slot_wet_pants:true,
  wet_clothing_penalty:2,str:8,def:8,dex:8,int:8,cha:8,clothing_water:{socks:'socks'},unnoticed_wet:1,unnoticed_turns:10});
 l.world.pending_popup_turns=5;l.inventory=[{...E.baby_wipes}];
 const lines=consumeFromBag(l,0,'baby_wipes',E,{tuning,zone:'honeydew-lantern'}),p=l.player_info;
 for(const key of ['accident_bulk','had_wet_accident','had_tum_accident','diaper_wet_absorbed','grossout_chance','wet_hold_attempts'])assert.equal(p[key],0,key);
 assert.equal(p.panties_bulk,3);assert.equal(p.slot_wet_socks,false);assert.equal(p.slot_wet_pants,true,'only underwear, socks and shoes dry');assert.deepEqual(p.clothing_water,{});
 assert.equal(p.wet_clothing_penalty,0);assert.equal(p.str,10,'one wet garment left is under the penalty threshold');
 assert.equal(l.world.pending_popup_turns,0);assert.equal(p.unnoticed_wet,0);
 assert.ok(lines.some(line=>line.includes('without even noticing')));assert.ok(lines.includes('You cleaned up. Feeling fresh again.'));
 assert.ok(lines.some(line=>line.includes('Dignity -15')),'unnoticed loss (20 + 10 turns) x 0.5 Shame multiplier');assert.equal(p.shame,1024,'then +32 back, capped');assert.equal(p.incontinence,101);
 const utopia=person({accident_bulk:1,unnoticed_tum:1});utopia.inventory=[{...E.baby_wipes}];
 assert.ok(consumeFromBag(utopia,0,'baby_wipes',E,{tuning,zone:'utopia-arcanum-beds'}).some(line=>line.includes('nobody minds')));assert.equal(utopia.player_info.shame,1024);
 const clean=person({grossout_chance:0});clean.inventory=[{...E.baby_wipes}];assert.ok(consumeFromBag(clean,0,'baby_wipes',E,{tuning}).includes('The shame melts away completely.'));
});

test('continence potions, mystery effects, MP scaling and brewed relief follow the game',()=>{
 const l=person({continence_effects:[{item_id:'temporary_incontinence_potion',name:'Old',delta:0,target:1000,turns:40}],active_effects:[{inco_restore:300}]});
 l.inventory=[{...E.temporary_continence_potion},{...E.permanent_incontinence_potion},{...E.mystery_potion},{...E.mana_tonic},{item_id:'brew_1',category:'drink',name:'Relief Brew',wet_relief:8,stamina_drain:3,brewed:{rarity:'rare',potency:12}}];
 consumeFromBag(l,0,'temporary_continence_potion',E,{tuning});
 assert.deepEqual(l.player_info.continence_effects.map(e=>[e.item_id,e.target,e.turns]),[['temporary_continence_potion',0,250]],'the newest full-control potion replaces the old one');
 consumeFromBag(l,0,'permanent_incontinence_potion',E,{tuning});assert.equal(l.player_info.incontinence,300);assert.equal(l.player_info.active_effects[0].inco_restore,500,'older hexes restore onto the new baseline');
 consumeFromBag(l,0,'mystery_potion',E,{tuning});const e=l.player_info.active_effects.at(-1);assert.equal(e.inco_set,1000);assert.equal(e.inco_restore,300);assert.equal(e.turns_until_start,5);
 assert.equal(l.player_info.playerHealth,300,'-1 heals to full');
 consumeFromBag(l,0,'mana_tonic',E,{tuning});assert.equal(l.player_mp,100,'50 MP x mana scale 2 (a 200 MP bar)');
 const lines=consumeFromBag(l,0,'brew_1',E,{tuning});assert.ok(lines.some(line=>line.startsWith('The pressure in your bladder eases.')));assert.equal(l.player_info.stamina,2,'Drowsy: stamina 5 - 3');
 assert.equal(l.inventory.length,0);
});

test('only food and drink, and only the item the page showed',()=>{
 const l=person();l.inventory=[{...E.iron_dagger},{...E.bottle}];
 assert.throws(()=>consumeFromBag(l,0,'iron_dagger',E,{tuning}),/Only food and drinks/);
 assert.throws(()=>consumeFromBag(l,1,'water_bottle',E,{tuning}),/changed/);
 assert.throws(()=>consumeFromBag(l,7,'bottle',E,{tuning}),/changed/);
});

test('online: companion_use edits the live loadout, shows details and the result, blocks combat, and writes cloud saves with MP',()=>{
 const db=new DatabaseSync(':memory:');let now=Date.parse('2026-09-29T12:00:00Z');
 const zones=createQuestZones(db,{now:()=>now,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:50}),adjust:()=>{}});createCloudSaves(db,{now:()=>now});
 let c;const act=(action,extra={})=>{now+=500;const result=zones.act('token',{action,controller:'game',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=result.character;return result;};
 const sheet=()=>zones.read('token',c.id,{companion:true}).sheet;
 try{
  act('create',{name:'Alice'});
  act('enter',{zone:'honeydew-lantern',loadout:{player_info:{playerHealth:40,playerHealthMax:100,hunger:20,thirst:20,wet:0,tum:0,stamina:10,stamina_max:30},inventory:[{...E.bottle,quantity:2},{...E.iron_dagger}],player_mp:0,player_mp_max:100,world:{wet_only_mode:false}}});
  let s=sheet();const row=s.inventory.find(i=>i.item_id==='bottle');
  assert.equal(row.consumable,true);assert.equal(row.use_label,'Drink');assert.ok(row.details.stats.some(r=>r.label==='Thirst'&&r.value==='+167'));assert.ok(row.details.desc.length>0);
  assert.equal(s.inventory.find(i=>i.item_id==='iron_dagger').consumable,undefined);
  act('companion_use',{slot:row.index,item_id:'bottle',equipment_version:s.equipment_version,controller:'companion'});
  assert.equal(c.loadout.player_info.hunger,40);assert.equal(c.loadout.player_info.playerHealth,55);assert.equal(c.loadout.inventory.find(i=>i.item_id==='bottle').quantity,1);
  s=sheet();assert.ok(s.last_use.lines.some(line=>line.startsWith('Used Milk Bottle.')));
  assert.throws(()=>act('companion_use',{slot:row.index,item_id:'bottle',equipment_version:'stale',controller:'companion'}),/changed/);
  act('start');assert.throws(()=>act('companion_use',{slot:0,item_id:'bottle',equipment_version:sheet().equipment_version,controller:'companion'}),/combat/);
  act('submit');act('leave');
  const save={version:1,online_revision:c.revision,wet_only_mode:true,player_info:{hunger:5,thirst:5,tum:3,wet:0,playerHealth:10,playerHealthMax:100},inventory:[{...E.mana_drop,quantity:1},{item_id:'stew',category:'food',name:'Stew'}],player_mp:10,player_mp_max:100,room_data:{kept:true}};
  db.prepare('INSERT INTO quest_cloud_versions VALUES (?,?,?,?,?,?,?,?)').run(c.id,1,'alice','original','0'.repeat(40),'{}',now,Buffer.from(JSON.stringify(save)));
  db.prepare('DELETE FROM quest_presence').run();
  s=sheet();assert.equal(s.source,'cloud');
  act('companion_use',{slot:0,item_id:'mana_drop',equipment_version:s.equipment_version,controller:'companion'});
  const head=db.prepare('SELECT data FROM quest_cloud_versions WHERE character_id=? ORDER BY revision DESC LIMIT 1').get(c.id),written=JSON.parse(Buffer.from(head.data).toString('utf8'));
  assert.equal(written.player_mp,35,'the MP potion is saved with the cloud copy');assert.deepEqual(written.room_data,{kept:true},'the rest of the campaign is preserved');
  s=sheet();act('companion_use',{slot:0,item_id:'stew',equipment_version:s.equipment_version,controller:'companion'});
  const latest=JSON.parse(Buffer.from(db.prepare('SELECT data FROM quest_cloud_versions WHERE character_id=? ORDER BY revision DESC LIMIT 1').get(c.id).data).toString('utf8'));
  assert.equal(latest.player_info.hunger,172);assert.equal(latest.player_info.tum,3,'the cloud save is in easy mode');assert.equal(latest.inventory.length,0);
 }finally{zones.close?.();db.close();}
});
