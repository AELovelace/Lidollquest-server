import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateQuestContent} from '../server/quest-content.mjs';
import {hubData,hubCatalog,hubRooms} from '../server/hubs.mjs';
import {districtData,districtZone} from '../server/hub-districts.mjs';
import {combatData} from '../server/combat.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {loadQuestPack} from '../server/service.mjs';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {createQuestZones} from '../server/zones.mjs';
import {randomUUID} from 'node:crypto';

// content/weekly_quests.json goes live either by being named in LIDOLLQUEST_QUEST_PACK, which
// loads it at boot, or by scripts/upload-weekly-quests.mjs. Both run the same validation the
// GM console does, so every reference is checked here instead of failing on a live server.
const pack=JSON.parse(readFileSync(new URL('../content/weekly_quests.json',import.meta.url),'utf8'));
const equipment={...hubData.equipment,...combatData.defeat_items}; // Exactly what service.mjs hands the validator.
const assetRef=value=>String(value??''); // Quests carry no artwork of their own; only NPCs do.
const validate=quest=>validateQuestContent('quest',quest,{assetRef,spells:combatData.spells,equipment});

const zones=new Set([...hubCatalog.map(h=>h.id),...hubRooms.map(z=>z.id),'dive-quarters','overworld-desert','overworld-tundra']);
const residents=new Set(districtData.districts.flatMap(d=>d.npcs.filter(n=>n.roaming&&n.id).map(n=>districtZone(d)+':'+n.id))); // Honeydew's residents live in the lobby town itself. // Only roaming residents keep an authored, stable fixture ID; static greeters are npc-<index>.
const stocked=new Set(hubData.shops.flatMap(s=>s.pool));

test('the weekly quest pack is a quest pack with unique IDs',()=>{
 assert.equal(pack.kind,'quest');
 assert.ok(Array.isArray(pack.quests)&&pack.quests.length,'The pack needs quests.');
 assert.equal(new Set(pack.quests.map(q=>q.id)).size,pack.quests.length,'Quest IDs must be unique.');
});

test('every quest passes the server schema and repeats weekly',()=>{
 for(const quest of pack.quests){
  const body=validate(quest);
  assert.equal(body.repeat,'weekly',quest.id+' must repeat weekly.');
  assert.ok(body.name.trim(),quest.id+' needs a published name.');
  assert.ok(body.stages.length,quest.id+' needs stages.');
  for(const stage of body.stages)assert.ok(stage.objectives.length,quest.id+'/'+stage.id+' needs an objective.');
 }
});

test('givers and turn-ins are existing roaming district residents',()=>{
 for(const quest of pack.quests){
  const body=validate(quest);
  assert.ok(body.givers.length,quest.id+' needs a giver.');
  for(const key of [...body.givers,body.turn_in.npc])assert.ok(residents.has(key),quest.id+' references an unknown resident: '+key);
 }
}); // A published NPC would have to be uploaded first; a resident key works against the live map as it stands.

test('the pack needs no published monsters and no Zones placements',()=>{
 for(const quest of pack.quests)for(const stage of validate(quest).stages)for(const o of stage.objectives){
  assert.ok(!['kill','interact'].includes(o.type),quest.id+'/'+o.id+' uses '+o.type+', which needs a published monster or a Zones placement.');
  assert.ok(!o.token,quest.id+'/'+o.id+' expects a placed token.');
 }
}); // Placement-backed objectives would have to be re-made whenever a monthly district layout is replaced.

test('objective targets resolve to real zones, residents and purchasable items',()=>{
 let checked=0;
 for(const quest of pack.quests)for(const stage of validate(quest).stages)for(const o of stage.objectives){
  const at=quest.id+'/'+stage.id+'/'+o.id;
  if(o.type==='visit')assert.ok(zones.has(o.target),at+' visits an unknown zone: '+o.target);
  if(o.type==='talk')assert.ok(residents.has(o.target),at+' talks to an unknown resident: '+o.target);
  if(['collect','deliver','equipment'].includes(o.type)){
   assert.ok(Object.hasOwn(equipment,o.target),at+' references an unknown item: '+o.target);
   assert.ok(stocked.has(o.target),at+' asks for '+o.target+', which no merchant stocks.'); // Market stock rotates daily and is seeded per zone, but an item outside every pool can never be obtained.
  }
  if(o.type==='equipment'&&o.slot)assert.equal(equipment[o.target].category,o.slot,at+' equips '+o.target+' into slot '+o.slot+', but its category is '+equipment[o.target].category);
  checked++;
 }
 assert.ok(checked>0,'The pack has no objectives.');
});

test('rewards reference real items and stay within the daily coin cap',()=>{
 for(const quest of pack.quests){
  const r=validate(quest).rewards;
  for(const item of [...r.items.map(i=>i.id),...r.equipment])assert.ok(Object.hasOwn(equipment,item),quest.id+' rewards an unknown item: '+item); // Rewards are granted, not bought, so they need only exist.
  assert.ok(r.coins<=hubData.config.daily_coin_cap,quest.id+' alone exceeds the daily coin cap.');
 }
});

test('the pack is spread across all three hubs',()=>{
 const perHub=new Map(hubCatalog.map(h=>[h.id,0]));
 for(const quest of pack.quests){
  const hub=quest.givers[0].split(':')[0].replace(/-garden$/,'');
  perHub.set(hub,perHub.get(hub)+1);
 }
 for(const [hub,n] of perHub)assert.ok(n>0,hub+' has no weekly quests.');
});

test('the pack loads as boot content without any upload',()=>{
 const db=new DatabaseSync(':memory:');
 const live=createWorldContent(db,{spells:combatData.spells,equipment,defeatEquipment:combatData.defeat_equipment,questPack:pack.quests});
 const published=live.published().quests;
 assert.equal(Object.keys(published).length,pack.quests.length,'Every quest in the pack should be live on boot.');
 for(const quest of pack.quests)assert.equal(published[quest.id].name,quest.name);
 assert.ok(live.view().quests.length>=pack.quests.length,'The panel should list shipped quests alongside saved ones.');
 assert.equal(live.published().enabled,false,'Shipped quests must not flip the published-world-content gate for Dives.');
}); // No GM sign-in, no address allowlist and no HTTP call: the deployed file is the content.

test('loadQuestPack accepts the shipped file and refuses a malformed one',()=>{
 assert.deepEqual(loadQuestPack(''),[],'An unset variable means no live quests, exactly as before.');
 assert.equal(loadQuestPack(fileURLToPath(new URL('../content/weekly_quests.json',import.meta.url))).length,pack.quests.length);
 assert.throws(()=>loadQuestPack(fileURLToPath(new URL('../package.json',import.meta.url))),/kind "quest"/);
 assert.throws(()=>loadQuestPack('no/such/pack.json'),/could not be read/);
});

test('a saved row overlays a shipped quest, so the panel can still retire one',()=>{
 const db=new DatabaseSync(':memory:');
 const live=createWorldContent(db,{spells:combatData.spells,equipment,defeatEquipment:combatData.defeat_equipment,questPack:pack.quests});
 const target=pack.quests[0];
 const entry=live.entry('quest',target.id);
 assert.equal(entry.revision,0,'A shipped quest starts at revision 0 until it is edited.');
 live.once({action:'content_publish',kind:'quest',id:target.id,revision:0,entry:{...target,retired:true},request_id:'retire-one-quest'},'tester',
  ()=>live.change({action:'content_publish',kind:'quest',id:target.id,revision:0,entry:{...target,retired:true}},'tester'));
 assert.equal(live.published().quests[target.id].retired,true,'The saved row must win over the shipped baseline.');
 assert.equal(Object.keys(live.published().quests).length,pack.quests.length,'Retiring one must not drop the rest.');
}); // Same override model the shipped monster baselines already use.

test('the release ships the directories the pack and this test need',()=>{
 const installer=readFileSync(new URL('../deploy/fedora.mjs',import.meta.url),'utf8');
 const listed=installer.match(/for \(const name of \[([^\]]+)\]\)/)?.[1]??'';
 const names=[...listed.matchAll(/'([^']+)'/g)].map(m=>m[1]);
 assert.ok(names.includes('content'),"deploy/fedora.mjs must copy 'content' into each release, or LIDOLLQUEST_QUEST_PACK has no file to read and this test cannot run on the server.");
 assert.ok(names.includes('test'),"deploy/fedora.mjs must copy 'test', which is how the installer verifies a candidate.");
}); // The installer runs this suite from the staged release as nobody, so anything the tests read has to be staged too.

test('a relative pack path resolves against the package root, not the working directory',()=>{
 const cwd=process.cwd();
 try{
  process.chdir(fileURLToPath(new URL('../test',import.meta.url))); // The service runs with its release directory as cwd; a test runner does not.
  assert.equal(loadQuestPack('content/weekly_quests.json').length,pack.quests.length);
 }finally{process.chdir(cwd);}
});

test('a shipped quest is offered by, and accepted at, its roaming district resident',()=>{
 const db=new DatabaseSync(':memory:');
 const live=createWorldContent(db,{spells:combatData.spells,equipment,defeatEquipment:combatData.defeat_equipment,questPack:pack.quests});
 let time=Date.parse('2026-09-20T12:00:00Z');
 const api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 try{
  let c=null,last=null;
  const act=(action,extra={})=>{last=api.act('',{action,controller:'control',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=last.character;return last;};
  act('create',{name:'Alice'});
  act('enter',{zone:'princess-rose-garden',content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{cha:2,playerHealth:20,playerHealthMax:20,level:1,xp:0},inventory:[],player_spells:[]}});

  const quest=pack.quests.find(q=>q.givers[0]==='princess-rose-garden:castle-page');
  assert.deepEqual(api.read('',c.id).onlineQuests.available,[],'The journal must not list unaccepted quests.');

  const map=api.world.map('princess-rose-garden');
  const resident=map.floor.fixtures.find(f=>f.kind==='npc'&&f.id==='castle-page');
  assert.ok(resident,'The roaming resident must exist as a map fixture.');
  db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(resident.x+1,resident.y,c.id);

  assert.throws(()=>act('quest_accept',{quest:quest.id,quest_revision:'not-a-conversation-choice'}),/designated NPC/,'Accepting away from the giver must be refused.');

  act('npc_talk',{placement:resident.id,edition:map.edition});
  const talk=last.onlineQuests.conversation;
  assert.equal(talk.npc,quest.givers[0],'Talking to a resident must identify it by its zone-qualified key.');
  const choose=label=>{const t=last.onlineQuests.conversation,choice=t.choices.find(c=>c.label===label);assert.ok(choice,'Missing '+label);act('npc_choice',{conversation:t.id,page:t.page,choice:choice.index});};
  choose('Ask about quests');choose(quest.name);choose('Accept quest');
  assert.equal(last.onlineQuests.instances[0].quest,quest.id,'The quest must accept from an open conversation with its giver.');
 }finally{api.close();db.close();}
}); // Resident services stay intact; generated quest-offer pages use the same server-validated conversation actions as managed NPCs.
