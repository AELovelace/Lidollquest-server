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
