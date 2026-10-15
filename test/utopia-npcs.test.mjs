import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createQuestService} from '../server/service.mjs';
import {hubRooms} from '../server/hubs.mjs';
import {UTOPIA_RESIDENTS,UTOPIA_TOWER_ZONE,UTOPIA_TOWER_PLACEMENTS} from '../server/utopia-npcs.mjs';
import {validateAiPersona} from '../server/quest-content.mjs';
import {personaText,participationProfile,PERSONA_MAX} from '../server/ambient-persona.mjs';

// AMBIENT_NPC_LIFE_PLAN.md Phase 0: Padma, Wren, Felix and Brittany ship once as editable GM NPCs in the 20x20 Arcanum Tower.
const ids=UTOPIA_RESIDENTS.map(n=>n.id);

test('the Arcanum Tower is 20x20 with the commons below the archive, and the four residents stand inside it',()=>{
 const tower=hubRooms.find(r=>r.id===UTOPIA_TOWER_ZONE);
 assert.equal(tower.width,20);assert.equal(tower.height,20);assert.equal(tower.walls.length,20);assert.ok(tower.walls.every(row=>row.length===20));
 assert.deepEqual(tower.exit,{x:0,y:6,w:1,h:2,style:'gap',side:'left'},'the way out is unchanged');assert.deepEqual(tower.spawn,{x:1,y:7});
 for(const id of ['archivist','registrar','tower-changer','cauldron','bar-counter','padma-stall','toy-shelf'])assert.ok(tower.fixtures.some(f=>f.id===id||f.kind===id),id);
 assert.deepEqual(tower.authoredPlacements.map(p=>p.content).sort(),[...ids].sort());
 for(const p of tower.authoredPlacements){assert.equal(p.kind,'npc');assert.equal(p.lifetime,'persistent');assert.ok(p.y>=14&&p.y<=18,p.content+' stands in the commons');}
});

test('every resident record validates, carries Doll\'s template and builds a bounded persona',()=>{
 const names=Object.fromEntries(UTOPIA_RESIDENTS.map(n=>[n.id,n.name]));
 for(const npc of UTOPIA_RESIDENTS){
  const p=validateAiPersona(npc.ai_persona);
  assert.equal(p.enabled,true);assert.ok(p.occupation);assert.ok(p.desires.length===3,npc.id);assert.ok(p.traits.length>=3);assert.ok(p.background.length>40);
  assert.ok(p.interests.length>=1&&p.interests.length<=4);assert.ok(p.voice.length>=1&&p.voice.length<=5);assert.equal(p.draft,true,'Lumi drafted the voice lines');
  const text=personaText(npc.name,p,{names});assert.ok(text.length<=PERSONA_MAX);assert.ok(text.startsWith(npc.name+' ('+p.pronouns+') is '),text.slice(0,60));
  assert.deepEqual(participationProfile(p),{role:p.occupation,interests:p.interests});
 }
 const wren=personaText('Wren',validateAiPersona(UTOPIA_RESIDENTS.find(n=>n.id==='utopia_wren').ai_persona),{names});
 assert.match(wren,/Felix: Her baby/);assert.match(wren,/Aunt Greta/);assert.match(wren,/Personality: Sociable - /);
 assert.throws(()=>validateAiPersona({enabled:true}),/occupation/);assert.throws(()=>validateAiPersona({talks_to:'everyone'}));
 assert.throws(()=>validateAiPersona({interests:['a','b','c','d','e']}),/at most 4/);assert.throws(()=>validateAiPersona({chattiness:101}));
 const long=personaText('Long',validateAiPersona({occupation:'baker',background:'x '.repeat(450),desires:Array(6).fill('y'.repeat(150)),traits:Array(6).fill({name:'Kind',note:'z'.repeat(190)})}));
 assert.ok(long.length<=PERSONA_MAX,'long personas are cut at a word');
});

test('the residents ship once as built-in GM NPCs, survive a restart and never overwrite a GM edit',()=>{
 const dir=mkdtempSync(join(tmpdir(),'utopia-npcs-')),filename=join(dir,'quest.sqlite'),now=()=>Date.parse('2026-10-14T12:00:00Z');let service=createQuestService({filename,now,log:()=>{}});
 try{
  for(const id of ids){const e=service.live.entry('npc',id);assert.ok(e.published,id+' is published');assert.equal(e.published.ai_persona.enabled,true);assert.equal(e.authorship?.builtin,true,id+' shows as built-in');}
  const map=service.zones.world.map(UTOPIA_TOWER_ZONE);assert.equal(map.floor.width,20);assert.equal(map.floor.height,20);
  const placed=map.placements.filter(p=>p.kind==='npc');assert.deepEqual(placed.map(p=>p.content).sort(),[...ids].sort(),'blank-canvas keeps them: they are GM NPCs, not room fixtures');
  for(const p of placed){const want=UTOPIA_TOWER_PLACEMENTS.find(v=>v.content===p.content);assert.ok(Math.abs(p.x-want.x)+Math.abs(p.y-want.y)<=2,p.content+' stays near its corner');assert.ok(p.y>=13,p.content+' stays in the commons');}
  const wren=service.live.entry('npc','utopia_wren'),edited={...wren.published,name:'Wren the Brave'};
  service.live.change({action:'content_publish',kind:'npc',id:'utopia_wren',revision:wren.revision,entry:edited},'Doll');
  service.server.emit('close');service=createQuestService({filename,now,log:()=>{}});
  assert.equal(service.live.entry('npc','utopia_wren').published.name,'Wren the Brave','a GM edit survives the next boot');
  assert.equal(service.db.prepare("SELECT COUNT(*) n FROM world_content_history WHERE kind='npc' AND id LIKE 'utopia_%' AND actor='shipped-utopia'").get().n,4,'shipped exactly once');
 }finally{service?.server.emit('close');rmSync(dir,{recursive:true,force:true});}
});
