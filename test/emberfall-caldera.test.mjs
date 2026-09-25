import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createQuestZones,calderaData,CALDERA_ZONE,spaData,SPA_ZONE,tundraData,TUNDRA_ZONE,autumnalPlainsData,AUTUMNAL_PLAINS_ZONE,WILDERNESS_LINKS} from '../server/zones.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {addSideTrail,addSouthTrail,addLandmark,openExitGaps} from '../server/wilderness-links.mjs';
import {addCalderaFeatures,eruptionAt,soakInSpring} from '../server/caldera-features.mjs';
import {generateSpa,coolInBath,SPA_PAD} from '../server/spa-generation.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {combatData} from '../server/combat.mjs';
import {defaultScenes,compiledArtwork} from '../server/defeat-scenes.mjs';
import {routeLevelFor} from '../server/scaling.mjs';

const FEATURES=calderaData.config.features,R=calderaData.structure.crater.radius;
const upgraded=edition=>{const f=generateDesert(calderaData,edition);addSideTrail(f,{zone_id:AUTUMNAL_PLAINS_ZONE,name:'Autumnal Plains',side:'right'});addLandmark(f,{...calderaData.config.landmark,center_dy:-R-12});addCalderaFeatures(f,FEATURES);openExitGaps(f);return f;}; // What the live engine's upgradeFloor does.

test('30 Emberfall Caldera editions: a lava lake in the middle, the Tundra north, the Plains east, the Obsidian Spa north of the crater',()=>{
 for(let n=0;n<30;n++){
  const raw=generateDesert(calderaData,'cal-'+n);assert.deepEqual(raw,generateDesert(calderaData,'cal-'+n));assert.ok(validateDesert(raw));
  assert.equal(raw.theme,'caldera');assert.deepEqual(raw.crater,{x:40,y:40,r:R});
  for(let y=40-R+3;y<=40+R-3;y++)for(let x=40-R+3;x<=40+R-3;x++)if(Math.hypot(x-40,y-40)<=R-3)assert.equal(raw.walls[y][x],1); // The lake is solid lava.
  assert.ok([...raw.enemies,...raw.chests,...raw.pickups].every(p=>Math.hypot(p.x-40,p.y-40)>R-2)); // Nothing spawns in the lava.
  assert.deepEqual(raw.exits,[{x:40,y:1,zone:TUNDRA_ZONE,name:'Frostveil Tundra'}]);
  const f=upgraded('cal-'+n);assert.ok(validateDesert(f));
  assert.deepEqual(f.exits.map(e=>[e.zone,e.side??e.style]),[[TUNDRA_ZONE,'top'],[AUTUMNAL_PLAINS_ZONE,'right'],[SPA_ZONE,'warp']]);
  const spa=f.decorations.find(d=>d.landmark===SPA_ZONE);assert.equal(spa.sprite,'sprCalderaSpa');assert.ok(spa.y+spa.span_h<40-R,'the spa stands north of the lava');
  const vents=f.decorations.filter(d=>d.vent),springs=f.decorations.filter(d=>d.spring);
  assert.ok(vents.length>=6);assert.ok(vents.every(v=>Math.abs(Math.hypot(v.x-40,v.y-40)-R-FEATURES.rim-1.5)<=3.5)); // Round the rim.
  assert.equal(springs.length,FEATURES.springs);assert.ok(springs.every(s=>Math.hypot(s.x-40,s.y-40)>=R+FEATURES.heat_reach-2)); // Out of the worst heat.
  assert.deepEqual(f.heat,{x:40,y:40,radius:R+FEATURES.heat_reach});assert.equal(addCalderaFeatures(f,FEATURES),false);
 }
 assert.deepEqual(computeTask('generate',{generator:'desert',data:calderaData,edition:'2026-09-21'}),generateDesert(calderaData,'2026-09-21'));
});

test('eruptions: calm, then a 40 s rumble, then 30 s of eruption every 8 minutes, the same for everyone',()=>{
 const count={calm:0,rumble:0,erupting:0},cfg=FEATURES.eruption;
 for(let s=0;s<8*60*10;s++){const e=eruptionAt('emberfall-caldera',cfg,s*1000);assert.deepEqual(e,eruptionAt('emberfall-caldera',cfg,s*1000));assert.ok(e.until>s*1000);count[e.state]++;}
 assert.deepEqual(count,{calm:(480-70)*10,rumble:40*10,erupting:30*10});assert.deepEqual(eruptionAt('x',null,0),{state:'calm',until:0});
});

test('a hot spring soak: full stamina, then everything loosens for a while; one soak per spring per cooldown',()=>{
 const f=upgraded('soak-1'),spring=f.decorations.find(d=>d.spring),cool={},p={x:spring.x-1,y:spring.y};
 const loadout={player_info:{stamina:10,stamina_max:120,incontinence:100,forced_inco_turns:0}};
 const lines=soakInSpring(f,p,loadout,FEATURES,1000,cool),i=loadout.player_info;
 assert.deepEqual([i.stamina,i.incontinence,i.forced_inco_old_inco,i.forced_inco_turns,i.forced_inco_source],[120,350,100,30,'spring']);assert.ok(lines.some(l=>l.includes('loose')));
 assert.throws(()=>soakInSpring(f,p,loadout,FEATURES,30000,cool),/more seconds/);
 i.forced_inco_turns=5;soakInSpring(f,p,loadout,FEATURES,200000,cool);assert.equal(i.forced_inco_turns,30);assert.equal(i.forced_inco_old_inco,100); // Already loose: the warmth lasts longer, the saved value stays.
 assert.throws(()=>soakInSpring(f,{x:spring.x-1,y:spring.y-1},loadout,FEATURES,999999,cool),/hot spring/);
});

test('the Obsidian Spa: three private stalls, two cooling baths, a lounge and the pad back out',()=>{
 const f=generateSpa(spaData,'spa-1');assert.ok(validateDesert(f));assert.equal(f.enemies.length,0);
 assert.deepEqual(generateSpa(spaData,'spa-2').walls,f.walls);
 assert.equal(f.decorations.filter(d=>d.toilet&&d.style==='stall').length,3);assert.equal(f.decorations.filter(d=>d.cool).length,2);
 assert.deepEqual(f.exits,[{...SPA_PAD,zone:CALDERA_ZONE,name:'Emberfall Caldera',style:'warp'}]);
 assert.deepEqual(computeTask('generate',{generator:'spa',data:spaData,edition:'2026-09-21'}),generateSpa(spaData,'2026-09-21'));
 const bath=f.decorations.find(d=>d.cool),cool={},loadout={player_info:{thirst:20,stamina:10,stamina_max:100,wet:10}};
 coolInBath(f,{x:bath.x,y:bath.y+bath.span_h},loadout,spaData.config.features,1000,cool);
 assert.deepEqual([loadout.player_info.thirst,loadout.player_info.stamina,loadout.player_info.wet],[120,40,18]);
 assert.throws(()=>coolInBath(f,{x:bath.x,y:bath.y+bath.span_h},loadout,spaData.config.features,5000,cool),/shivering/);
});

test('links: the Tundra opens a south trail, the Plains a west trail; the band sits between the Desert and the Tundra; natives ship complete',()=>{
 for(const pair of [[AUTUMNAL_PLAINS_ZONE,CALDERA_ZONE],[TUNDRA_ZONE,CALDERA_ZONE],[CALDERA_ZONE,SPA_ZONE]])assert.ok(WILDERNESS_LINKS.some(([a,b])=>a===pair[0]&&b===pair[1]));
 for(let n=0;n<10;n++){
  const t=generateDesert(tundraData,'south-'+n),before=structuredClone(t);assert.equal(addSouthTrail(t,{zone_id:CALDERA_ZONE,name:'Emberfall Caldera'}),true);assert.equal(addSouthTrail(t,{zone_id:CALDERA_ZONE,name:'Emberfall Caldera'}),false);
  openExitGaps(t);assert.ok(validateDesert(t));assert.deepEqual(t.chests,before.chests);assert.ok(t.exits.some(e=>e.zone===CALDERA_ZONE&&e.side==='bottom'));
 }
 const plains=generateDesert(autumnalPlainsData,'west-1');assert.equal(addSideTrail(plains,{zone_id:CALDERA_ZONE,name:'Emberfall Caldera',side:'left'}),true);assert.ok(validateDesert(plains));
 const tuning=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8')).loot.tuning,band=routeLevelFor(tuning,'emberfall-caldera');
 assert.ok(band>routeLevelFor(tuning,'dustbreak-crossing')&&band>routeLevelFor(tuning,'frostveil-crossing')+20,'the Caldera is a wall for newbies walking the Tundra road to Honeydew'); // 2026-09-25: Tundra 12 (starter road), Caldera 45.
 for(const id of ['ember_imp','cinder_slime','steam_sprite','obsidian_golem','magma_matron']){
  const e=calderaData.enemies[id];assert.ok(e&&e.enemy_spells.length&&e.dex<=14);
  for(const s of e.enemy_spells)assert.equal(combatData.spells[s]?.enemy_only,true,s);
  assert.ok(compiledArtwork[e.sprite]&&compiledArtwork[e.battle_sprite]);assert.equal(defaultScenes[id].first.aftermaths.length,3);assert.ok(combatData.defeat_equipment[id].first.length);
 }
});

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),api;const ids={};
 const loadout={player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:30,xp:0,stat_points:0,stamina:10,stamina_max:100,incontinence:100,thirst:50},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const still=(...args)=>{const f=generateDesert(...args);f.enemies.forEach(e=>e.roaming=false);return f;},quiet={log:()=>{},generate:still};
 api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:quiet,tundraOptions:quiet,taigaOptions:quiet,highDesertOptions:quiet,autumnalPlainsOptions:quiet,coastOptions:quiet,calderaOptions:quiet});
 const snap=name=>api.read(name,ids[name]);
 function act(name,action,extra={}){time+=350;const s=snap(name);return api.act(name,{action,controller:'window',request_id:randomUUID(),character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra});}
 function player(name){ids[name]=api.act(name,{action:'create',name,controller:'window',request_id:randomUUID()}).character.id;return act(name,'enter',{zone:'honeydew-lantern',combat_version:3,content_version:1,quest_version:1,loadout});}
 function place(name,p){const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]),state=JSON.parse(row.state);if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids[name]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[name]);}
 const floor=name=>{const s=snap(name);return s.zones.find(z=>z.id===s.zone);};
 const cross=(name,zone)=>{const e=floor(name).exits.find(x=>x.zone===zone),inward={left:[1,0],right:[-1,0],top:[0,1],bottom:[0,-1]}[e.side]??[0,1];place(name,{x:e.x+inward[0],y:e.y+inward[1]});return act(name,'dive_exit',{zone});};
 return {snap,act,player,place,floor,cross,close(){api.close();db.close();}};
}

test('online: Honeydew -> Plains -> Caldera -> soak -> Spa -> Caldera -> Tundra, with crater, heat and eruption in the snapshot',()=>{const f=fixture();try{
 f.player('alice');f.place('alice',{x:24,y:48});f.act('alice','move',{direction:'south',world_step:true});
 assert.equal(f.cross('alice',CALDERA_ZONE).zone,CALDERA_ZONE);
 const room=f.floor('alice'),s=f.snap('alice');assert.equal(room.theme,'caldera');assert.deepEqual(room.crater,{x:40,y:40,r:R});
 assert.equal(room.heat.thirst_per_step,FEATURES.heat.thirst_per_step);assert.equal(room.heat.sweat_percent,FEATURES.heat.sweat_percent);
 assert.ok(['calm','rumble','erupting'].includes(s.dive.eruption.state));assert.equal(s.dive.eruption.startle_wet,FEATURES.eruption.startle_wet);
 const spring=room.decorations.find(d=>d.spring);f.place('alice',{x:spring.x-1,y:spring.y});
 const soaked=f.act('alice','dive_soak');assert.equal(soaked.character.loadout.player_info.stamina,100);assert.equal(soaked.character.loadout.player_info.forced_inco_source,'spring');
 const spa=f.cross('alice',SPA_ZONE);assert.equal(spa.zone,SPA_ZONE);assert.equal(f.floor('alice').theme,'spa');
 f.place('alice',{x:SPA_PAD.x,y:SPA_PAD.y-1});assert.equal(f.act('alice','dive_exit',{zone:CALDERA_ZONE}).zone,CALDERA_ZONE);
 assert.equal(f.cross('alice',TUNDRA_ZONE).zone,TUNDRA_ZONE);assert.ok(f.floor('alice').exits.some(e=>e.zone===CALDERA_ZONE&&e.side==='bottom'));
}finally{f.close();}});
