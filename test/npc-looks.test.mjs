// GM-authored NPCs can wear a Sprite Lab look (gm-sprite-lab.js designer): validated on save, sent to players by content
// hash in the snapshot looks map, and shown in conversations when no portrait is chosen.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
import {lookCatalog} from '../server/sprite-looks.mjs';
import {npcPlacementFacing} from '../server/quest-placements.mjs';
import {createTutor,TUTOR_FIXTURE_ID} from '../server/tutor.mjs';
import {followerData} from '../server/followers.mjs';
import {nativeNpcSource,fullDungeonNpc} from '../server/full-dungeon-quests.mjs';

const zone='honeydew-lantern';
const look={version:1,slots:{base:'piko_woman',hair:'mohawk',torso:'maid_dress',shoes:'sneakers',head:'crown'},colors:{hair:[[205,86,44]]},enabled:{hair:[true]},facing:0};
const npc=(extra={})=>({id:'tailor_npc',name:'Tailor',description:'',dialogue:[{id:'hello',text:'Welcome!',next:'close',actions:[]}],quests:[],...extra});
function fixture(){
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment});let time=Date.parse('2026-10-03T12:00:00Z'),c;
 const api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const act=(action,extra={})=>{const r=api.act('',{action,controller:'control',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 const publish=entry=>live.change({action:'content_publish',kind:'npc',id:entry.id,revision:live.view().npcs.find(r=>r.id===entry.id)?.revision??0,entry},'dm');
 act('create',{name:'Alice'});act('enter',{zone,content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{cha:2,playerHealth:20,playerHealthMax:20,level:1,xp:0},inventory:[],player_spells:[]}});
 function place(content){const map=api.world.map(zone);for(let y=2;y<map.floor.height-2;y++)for(let x=2;x<map.floor.width-2;x++)try{return api.world.act({action:'world_place_content',zone,edition:map.edition,revision:map.revision,placement_kind:'npc',content,x,y,lifetime:'persistent'});}catch(e){if(!/reachable tile/.test(e.message))throw e;}throw Error('No placement');}
 return {db,live,api,act,publish,place,read:()=>api.read('',c.id),beside(p){db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(p.x+1,p.y,c.id);},close(){api.close();db.close();}};
}

test('a published NPC look is validated, normalised and optional',()=>{
 const f=fixture();
 try{
  const saved=f.publish(npc({look})).published.look;
  assert.equal(saved.slots.torso,'maid_dress','staff may use premium layers without unlocking them');
  assert.deepEqual(saved.colors.hair,[[205,86,44]]);assert.deepEqual(saved.enabled.hair,[true]);
  assert.equal(saved.slots.legs,'','every catalog slot is filled in');
  assert.throws(()=>f.publish(npc({look:{...look,slots:{...look.slots,hair:'not_a_layer'}}})),/Unsupported look layer/);
  assert.throws(()=>f.publish(npc({look:{...look,slots:{...look.slots,face:'sunglasses',neck:'bow_tie',back:'cape'}}})),/up to 3 accessories/);
  assert.ok(!('look' in f.publish(npc()).published),'removing the look drops the field, as on every older definition');
 }finally{f.close();}
});

test('stationary NPC direction is published to existing placements for plain sprites and looks',()=>{
 const f=fixture();
 try{
  f.publish(npc({look,facing:3}));f.place('tailor_npc');
  let seen=f.read().worldPlacements.find(p=>p.content==='tailor_npc');assert.equal(seen.facing,3);assert.ok(seen.lookKey);
  const position={x:seen.x,y:seen.y};
  for(const facing of [0,1,2,3]){
   f.publish(npc({facing}));seen=f.read().worldPlacements.find(p=>p.content==='tailor_npc');
   assert.equal(seen.facing,facing);assert.deepEqual({x:seen.x,y:seen.y},position);assert.ok(!seen.lookKey);
  }
  f.publish(npc({look:{...look,facing:1}}));assert.equal(f.read().worldPlacements.find(p=>p.content==='tailor_npc').facing,1,'older looks supply a default');
  const old=f.publish(npc()).published;assert.ok(!Object.hasOwn(old,'facing'),'old definitions keep their shape');
  assert.equal(f.read().worldPlacements.find(p=>p.content==='tailor_npc').facing,0);
  for(const facing of [-1,4,0.5,'1'])assert.throws(()=>f.publish(npc({facing})),/whole number between 0 and 3/);
  assert.equal(npcPlacementFacing({wander_radius:2,facing:1},{facing:2}),2,'a wanderer retains its last actual step');
  assert.equal(npcPlacementFacing({wander_radius:0,facing:1},{facing:2}),1,'stopping wandering restores the authored default');
 }finally{f.close();}
});

test('players receive a placed NPC look by content hash, and see it in conversation',()=>{
 const f=fixture();
 try{
  f.publish(npc({look}));f.publish({...npc(),id:'plain_npc',name:'Plain'});
  const map=f.place('tailor_npc'),spot=map.placements.find(p=>p.content==='tailor_npc');f.place('plain_npc');
  const snap=f.read(),seen=snap.worldPlacements.find(p=>p.content==='tailor_npc'),plain=snap.worldPlacements.find(p=>p.content==='plain_npc');
  assert.match(seen.lookKey,/^[0-9a-f]{16}$/);assert.ok(!('look' in seen),'the placement carries only the key');
  assert.equal(snap.looks[seen.lookKey].slots.hair,'mohawk');
  assert.ok(!('lookKey' in plain),'NPCs without a look are unchanged');
  f.beside(spot);const talk=f.act('npc_talk',{placement:spot.id,edition:map.edition}).onlineQuests.conversation;
  assert.equal(talk.look.slots.head,'crown','no portrait: the look fills the portrait column');
  f.publish(npc({look:{...look,slots:{...look.slots,hair:'low_bun'}}}));
  const next=f.read(),again=next.worldPlacements.find(p=>p.content==='tailor_npc');
  assert.notEqual(again.lookKey,seen.lookKey,'republishing changes the key, so clients fetch the new look');assert.equal(next.looks[again.lookKey].slots.hair,'low_bun');
 }finally{f.close();}
});

test('the server ships a sheet for every catalog layer',()=>{
 const sheets=JSON.parse(readFileSync(new URL('../server/sprite-lab-sheets.json',import.meta.url),'utf8')).sheets;
 for(const asset of lookCatalog().assets){
  const png=Buffer.from(sheets[asset.sprite]??'','base64');
  assert.ok(png.subarray(1,4).toString()==='PNG'&&png.readUInt32BE(16)===128&&png.readUInt32BE(20)===128,asset.id+' has a 128x128 sheet for the workshop preview');
 }
});

test('a hub resident wears the look published on its story sheet',()=>{
 const f=fixture();
 try{
  const sheetOf=()=>f.live.view().sheets.find(r=>r.draft.category==='fixture'&&r.draft.zone===zone&&r.draft.key==='npc-2');
  const save=(body,publish=true)=>f.live.change({action:publish?'content_publish':'content_save',kind:'sheet',id:sheetOf().id,revision:sheetOf().revision,entry:{...sheetOf().draft,body}},'dm');
  const resident=()=>{const snap=f.read();return {snap,npc:snap.zones.find(z=>z.id===zone).fixtures.find(n=>n.id==='npc-2')};};
  assert.ok(f.live.view().sheetSchemas.fixture.fields.look,'resident sheets accept a look');
  assert.ok(!('lookKey' in resident().npc),'shipped residents keep their catalog avatar');
  const body=sheetOf().draft.body;
  assert.throws(()=>save({...body,look:{...look,slots:{...look.slots,hair:'not_a_layer'}}}),/Unsupported look layer/);
  save({...body,look},false);assert.ok(!('lookKey' in resident().npc),'a draft changes nothing for players');
  save({...body,look});
  const {snap,npc}=resident();
  assert.equal(snap.looks[npc.lookKey].slots.torso,'maid_dress');assert.ok(!('look' in npc),'the fixture carries only the key');assert.ok(npc.avatar,'older clients still have the avatar');
  assert.equal(JSON.stringify(snap).split('"maid_dress"').length-1,1,'the look is sent exactly once');
  save(body);assert.ok(!('lookKey' in resident().npc),'removing the look restores the avatar');
 }finally{f.close();}
});

test('Pip, Astra and shopkeeper sheets publish validated looks without changing service behavior',()=>{
 const f=fixture();try{
  const tutor=createTutor(f.db,{live:f.live,url:'http://unused.test',log:()=>{}});f.api.setTutor(tutor);
  const rows=()=>f.live.view().sheets;
  const pip=rows().find(r=>r.draft.category==='tutor');
  const astra=rows().find(r=>r.draft.category==='follower'&&r.draft.key==='sorceress_arcana');
  const shop=rows().find(r=>r.draft.category==='fixture'&&r.draft.zone===zone&&hubData.shops.some(s=>s.id===r.draft.key));
  assert.ok(pip&&astra&&shop,'all three NPC types are discoverable before visiting their rooms');
  const save=(row,body,publish=true)=>f.live.change({action:publish?'content_publish':'content_save',kind:'sheet',id:row.id,revision:f.live.entry('sheet',row.id).revision,entry:{...row.draft,body}},'dm');
  for(const row of [pip,astra,shop]){
   assert.ok(f.live.view().sheetSchemas[row.draft.category].fields.look);
   assert.throws(()=>save(row,{...row.draft.body,look:{...look,slots:{...look.slots,base:'unknown'}}}),/Unsupported look layer/);
   save(row,{...row.draft.body,look},false);
   assert.equal(f.live.sheet(row.draft.category,row.draft.zone,row.draft.key).look,undefined,'drafts never change the live character');
   save(row,{...row.draft.body,look});
  }
  const snap=f.read(),p=snap.zones.find(z=>z.id===zone).fixtures.find(n=>n.id===TUTOR_FIXTURE_ID);
  assert.equal(snap.looks[p.lookKey].slots.hair,'mohawk');assert.equal(p.service,'tutor');
  assert.equal(tutor.decorate({id:'arcadia-foundry',width:20,height:12,spawn:{x:10,y:9},fixtures:[]}).fixtures.find(n=>n.id===TUTOR_FIXTURE_ID).look.slots.hair,'mohawk','all Pip copies share the published look');
  const shops=f.read(),keeper=shops.zones.find(z=>z.id===shop.draft.zone).fixtures.find(n=>n.id===shop.draft.key);
  assert.equal(keeper.kind,'shop');assert.ok(keeper.offers.length);assert.equal(shops.looks[keeper.lookKey].slots.hair,'mohawk');
  const def=followerData.sorceress_arcana,geometry={width:20,height:12,spawn:{x:10,y:9},fixtures:[]};
  const available=f.api.followers.view(null,{zone:def.online.home_zone},geometry,{}).entities.find(n=>n.npc==='sorceress_arcana');
  assert.equal(available.look.slots.hair,'mohawk');assert.equal(available.hireText,def.online.hire_text);assert.equal(available.sprite,def.overworld_sprite);
  const player=f.read().character;
  f.db.prepare("INSERT INTO quest_follower_hires(id,npc,character_id,owner,request_id,status,created,expires,zone,x,y) VALUES ('look-hire','sorceress_arcana',?,'alice','look-hire','active',0,9999999999999,?,10,8)").run(player.id,shop.draft.zone);
  const hired=f.read(),entity=hired.followers.entities.find(n=>n.npc==='sorceress_arcana');
  assert.equal(entity.available,false);assert.equal(hired.looks[entity.lookKey].slots.hair,'mohawk');assert.equal(entity.look,undefined,'companion looks use the shared snapshot cache');
  for(const row of [pip,astra,shop])save(row,row.draft.body);
  assert.equal(tutor.settings().look,undefined);assert.equal(f.read().followers.entities.find(n=>n.npc==='sorceress_arcana').lookKey,undefined,'removing the look restores original artwork');
 }finally{f.close();}
});

test('dungeon native NPCs and merchants receive published looks without changing their floor fixtures',()=>{
 const f=fixture();try{
  f.act('enter',{zone:'princess-rose',content_version:1,quest_version:1,combat_version:3,full_dungeon_version:1});
  const room=()=>{const s=f.read();return s.zones.find(z=>z.id===s.zone);};
  f.beside(room().portals.find(p=>p.target==='princess-rose-garden'));f.act('move',{direction:'west'});
  const dungeon='dungeon-castle-dungeon';f.beside(room().portals.find(p=>p.target===dungeon));f.act('dive_enter',{zone:dungeon});
  const native=room().fixtures.find(n=>n.kind==='npc'),merchant=room().fixtures.find(n=>n.kind==='shop');
  assert.ok(native&&merchant);
  const rows=[['native_npc',native.content],['fixture',merchant.id]].map(([category,key])=>f.live.view().sheets.find(r=>r.draft.category===category&&r.draft.zone===dungeon&&r.draft.key===key));
  const save=(row,look)=>f.live.change({action:'content_publish',kind:'sheet',id:row.id,revision:f.live.entry('sheet',row.id).revision,entry:{...row.draft,body:{...row.draft.body,look}}},'dm');
  for(const row of rows)save(row,look);
  const snap=f.read(),fixtures=snap.zones.find(z=>z.id===dungeon).fixtures;
  for(const original of [native,merchant]){
   const npc=fixtures.find(n=>n.id===original.id);assert.equal(snap.looks[npc.lookKey].slots.hair,'mohawk');assert.equal(npc.look,undefined);
   for(const key of ['id','kind','x','y','sprite','offers'])assert.deepEqual(npc[key],original[key],key+' stays engine-owned');
  }
  const ref=dungeon+':'+native.id,source=nativeNpcSource(native,ref,f.live);
  assert.equal(fullDungeonNpc(native,ref,{loadout:{player_info:{}}},source,f.live).look.slots.hair,'mohawk','native conversation retains the published look');
  for(const row of rows)save(row,null);
  for(const npc of room().fixtures.filter(n=>[native.id,merchant.id].includes(n.id)))assert.equal(npc.lookKey,undefined,'explicit null restores shipped artwork');
 }finally{f.close();}
});
