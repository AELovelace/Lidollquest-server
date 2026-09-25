import test from 'node:test';
import assert from 'node:assert/strict';
import {createDungeonRules,campaignChoice,campaignDialogue,applyDungeonEffects} from '../server/full-dungeon-rules.mjs';
import {fullDungeons} from '../server/full-dungeons.mjs';

test('functional furniture effects commit with a page, reject stale choices and survive a serialized reconnect',()=>{
 const data=fullDungeons.find(d=>d.config.theme==='dungeon'),c={id:'alice'},personal={},record={edition:'week',floor:{fixtures:[{id:'table',x:3,y:3,kind:'detail',name:'Changing Table',narrative:'detail_bsp_changing_table'}]}};
 let state={loadout:{player_info:{shame:500},inventory:[]}};
 const make=()=>createDungeonRules({data,db:{},now:()=>0,roll:()=>0,progress:()=>personal,saveProgress:()=>{},saveFloor:()=>{}}),rules=make();
 rules.act(c,state,record,{action:'dungeon_interact',fixture:'table'},{x:3,y:4});const scene=rules.scene(state);assert.equal(state.loadout.player_info.shame,500);assert.ok(scene.text.includes('changing table'));
 state=JSON.parse(JSON.stringify(state));const choice={action:'dungeon_scene_choice',scene:scene.id,page:scene.page,mechanism_revision:scene.revision,choice:-1};make().act(c,state,record,choice,{x:3,y:4});assert.equal(state.loadout.player_info.shame,502);assert.equal(state.dungeonScene,null);assert.throws(()=>make().act(c,state,record,choice,{x:3,y:4}),/scene page changed/);
});

test('trap struggle gates, page effects, and pending scenes remain independent per character',()=>{
 const original=fullDungeons[0],data={...original,traps:{cage:original.traps.tq_cage_trap}},mem=new Map(),c={id:'alice'},b={id:'bob'},record={edition:'week',floor:{}},state=()=>({loadout:{player_info:{playerHealth:100,playerHealthMax:100,shame:500},inventory:[],world:{}}});
 const progress=c=>structuredClone(mem.get(c.id)??{}),rules=createDungeonRules({data,db:{},now:()=>0,roll:()=>0,progress,saveProgress:(c,e,p)=>mem.set(c.id,p),saveFloor:()=>{}}),a=state(),other=state();
 rules.trap(c,a,record,'trap-1');const hp=a.loadout.player_info.playerHealth;rules.trap(c,a,record,'trap-1');assert.equal(a.loadout.player_info.playerHealth,hp);assert.equal(other.dungeonScene,undefined);
 for(let n=0;n<4;n++){const v=rules.scene(a);rules.act(c,a,record,{action:'dungeon_scene_choice',scene:v.id,page:v.page,mechanism_revision:v.revision,choice:0},{x:0,y:0});}
 assert.equal(rules.scene(a).page,'freed_struggle');const v=rules.scene(a);rules.act(c,a,record,{action:'dungeon_scene_choice',scene:v.id,page:v.page,mechanism_revision:v.revision,choice:-1},{});assert.equal(a.dungeonScene,null);
 rules.trap(b,other,record,'trap-1');assert.ok(other.dungeonScene);assert.equal(other.loadout.player_info.playerHealth,hp);
});

test('quest services grant the letter once and force vaccine continence with a restorable baseline',()=>{
 const data=fullDungeons.find(d=>d.config.theme==='nursery'),c={id:'alice'},s={loadout:{player_info:{incontinence:123},inventory:[],world:{}}},context={data,roll:()=>0},service=data.adaptations.npc_services.Basil[0];
 campaignChoice(service,c,s,context);campaignChoice(service,c,s,context);assert.equal(s.loadout.inventory.filter(i=>i.item_id==='basils_letter').length,1);
 applyDungeonEffects([{type:'forced_inco',amount:1000,turns:30}],c,s,context);assert.equal(s.loadout.player_info.incontinence,1000);assert.equal(s.loadout.player_info.forced_inco_old_inco,123);assert.equal(s.loadout.player_info.forced_inco_turns,30);
});

test('all authored NPC reaction trees normalize string pages and keep close-on-continue terminal',()=>{
 for(const data of fullDungeons)for(const npc of Object.values(data.npcs))for(const childish of [0,5,9]){
  const pages=campaignDialogue(npc,{loadout:{player_info:{},world:{},childish}});assert.ok(pages.length);for(const p of pages){assert.equal(typeof p.text,'string');if(p.close_on_continue)assert.equal(p.next,'close');}
 }
});

test('friendly binding removal restores equipment bonuses once and never creates a reusable cursed item',()=>{
 const data=fullDungeons[0],item=data.items.cursed_teddy,s={loadout:{player_info:{equipped_weapon:'cursed_teddy',str:20,shame:500},inventory:[],world:{}}},context={data,roll:()=>0};
 applyDungeonEffects([{type:'release_campaign_curse',slot:'weapon'}],{id:'a'},s,context);assert.equal(s.loadout.player_info.equipped_weapon,'');assert.equal(s.loadout.player_info.str,20-item.atk);assert.equal(s.loadout.inventory.length,0);assert.throws(()=>applyDungeonEffects([{type:'release_campaign_curse',slot:'weapon'}],{id:'a'},s,context),/no longer equipped/);
});

test('adult care follows source eligibility, with no requested changing service inside the Nursery',()=>{
 const nursery=fullDungeons.find(d=>d.config.theme==='nursery');assert.ok(Object.values(nursery.npcs).every(n=>!n.diaper_change));
 for(const d of fullDungeons.filter(d=>d!==nursery))for(const n of Object.values(d.npcs))if(!n.childish)assert.ok(n.diaper_change.diaper_pool.length);
});
