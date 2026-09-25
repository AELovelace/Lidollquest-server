import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createQuestZones,autumnalPlainsData,AUTUMNAL_PLAINS_ZONE,tundraData,highDesertData} from '../server/zones.mjs';
import {combatData} from '../server/combat.mjs';
import {defaultScenes,compiledArtwork} from '../server/defeat-scenes.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {openExitGaps,addLandmark} from '../server/wilderness-links.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {TOWN_PORTALS,wildernessGates} from '../server/hubs.mjs';
import {routeLevelFor} from '../server/scaling.mjs';

const HONEYDEW='honeydew-lantern';

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),api;const ids={};
 const loadout={player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:10,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const still=(...args)=>{const f=generateDesert(...args);f.enemies.forEach(e=>e.roaming=false);return f;}; // Frozen roamers keep crossings deterministic.
 const quiet={log:()=>{},generate:still};
 api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:quiet,tundraOptions:quiet,taigaOptions:quiet,highDesertOptions:quiet,autumnalPlainsOptions:quiet});
 const snap=name=>api.read(name,ids[name]);
 function act(name,action,extra={}){time+=350;const s=snap(name);return api.act(name,{action,controller:'window',request_id:randomUUID(),character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra});}
 function player(name){ids[name]=api.act(name,{action:'create',name,controller:'window',request_id:randomUUID()}).character.id;return act(name,'enter',{zone:HONEYDEW,combat_version:3,content_version:1,quest_version:1,loadout});}
 function place(name,p){const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]),state=JSON.parse(row.state);if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids[name]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[name]);}
 const floor=name=>{const s=snap(name);return s.zones.find(z=>z.id===s.zone);};
 return {db,snap,act,player,place,floor,close(){api.close();db.close();}};
}

test('60 Autumnal Plains editions: seeded, connected, one north trailhead, open fields and whole-tile autumn scenery',()=>{
 const roster=new Set(autumnalPlainsData.enemy_types.map(e=>e.enemy_id));
 for(let n=0;n<60;n++){
  const f=generateDesert(autumnalPlainsData,'plains-'+n);assert.ok(validateDesert(f));assert.deepEqual(f,generateDesert(autumnalPlainsData,'plains-'+n)); // Same edition, same map.
  assert.equal(f.width,80);assert.equal(f.height,80);assert.equal(f.theme,'autumn_plains');
  assert.deepEqual(f.exits,[{x:40,y:1,zone:HONEYDEW,name:'Honeydew Village'}]);assert.deepEqual(f.entrance,{x:40,y:2}); // Trailhead just under the top wall.
  assert.ok(f.enemies.every(e=>roster.has(e.type)));assert.ok(f.decorations.some(p=>p.sprite.startsWith('sprPlainsEnv')));
  let open=0;for(const row of f.walls)for(const c of row)if(!c)open++;assert.ok(open/(80*80)>0.65); // Plains stay wide open: little cover.
  const cells=new Set();for(const p of f.decorations)for(let dy=0;dy<p.span_h;dy++)for(let dx=0;dx<p.span_w;dx++){
   const x=p.x+dx,y=p.y+dy;assert.equal(f.walls[y][x],0);assert.equal(f.props[y][x],1);assert.ok(!cells.has(x+','+y));cells.add(x+','+y); // Props never overlap walls or each other.
  }
  assert.equal(openExitGaps(f),true);assert.deepEqual(f.exits[0],{x:40,y:0,zone:HONEYDEW,name:'Honeydew Village',w:2,h:1,style:'gap',side:'top'});assert.ok(validateDesert(f)); // The trailhead becomes a top-wall gap.
 }
});

test('the worker pool builds the same Plains floor as the main thread',()=>{
 assert.deepEqual(computeTask('generate',{generator:'desert',data:autumnalPlainsData,edition:'2026-09-21'}),generateDesert(autumnalPlainsData,'2026-09-21'));
});

test('existing single-trailhead routes keep their south trailhead',()=>{
 const south={...autumnalPlainsData,config:{...autumnalPlainsData.config,endpoints:[{zone:HONEYDEW,name:'Honeydew Village',side:'south'}]}};
 const f=generateDesert(south,'south-1');assert.deepEqual(f.exits,[{x:40,y:78,zone:HONEYDEW,name:'Honeydew Village'}]);assert.deepEqual(f.entrance,{x:40,y:77}); // The High Desert's shape is unchanged.
});

test("Honeydew's south wall opens onto the Plains, and the band is a gentle starter",()=>{
 assert.ok(TOWN_PORTALS.some(p=>p.target===AUTUMNAL_PLAINS_ZONE&&p.side==='bottom'&&p.style==='gap'&&p.x===24&&p.y===49&&p.w===2&&p.h===1));
 assert.ok(wildernessGates(HONEYDEW).some(g=>g.target===AUTUMNAL_PLAINS_ZONE));
 const tuning=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8')).loot.tuning,plains=routeLevelFor(tuning,'autumnal-plains');
 assert.ok(plains<routeLevelFor(tuning,'dustbreak-crossing')&&plains<routeLevelFor(tuning,'frostveil-crossing')); // Easier than every other Honeydew gate.
 assert.ok(plains>routeLevelFor(tuning,'honeydew-lantern'));
});

test('a character walks from the village square out the south gate into the Plains and back',()=>{const f=fixture();try{
 f.player('alice');
 const town=f.floor('alice'),key=(x,y)=>x+','+y,seen=new Set([key(town.spawn.x,town.spawn.y)]),queue=[town.spawn];
 for(let i=0;i<queue.length;i++)for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const x=queue[i].x+dx,y=queue[i].y+dy;if(x<0||y<0||x>=town.width||y>=town.height||town.walls[y][x]||seen.has(key(x,y)))continue;seen.add(key(x,y));queue.push({x,y});}
 assert.ok(seen.has(key(24,49))&&seen.has(key(25,49))&&seen.has(key(24,48))); // The gate and its strip join the square this month (no scenery in the way of the walls).
 f.place('alice',{x:24,y:48});const out=f.act('alice','move',{direction:'south',world_step:true});
 assert.equal(out.zone,AUTUMNAL_PLAINS_ZONE);
 const plains=f.floor('alice');assert.equal(plains.theme,'autumn_plains');assert.deepEqual(plains.exits.map(e=>[e.zone,e.side,e.style]),[[HONEYDEW,'top','gap'],['overworld-farmstead',undefined,'warp'],['overworld-seafoam-coast','right','gap'],['overworld-emberfall-caldera','left','gap'],['arcadia-foundry','bottom','gap']]); // Plus the barn door's warp pad, the east trail to the Seafoam Coast, the west trail to Emberfall Caldera and the south road to Arcadia.
 assert.deepEqual(out.position,{x:40,y:1}); // Arrive just inside the Plains' top gap.
 f.place('alice',{x:40,y:1});const home=f.act('alice','move',{direction:'north',world_step:true});
 assert.equal(home.zone,HONEYDEW);assert.deepEqual(home.position,{x:24,y:48}); // Back one tile inside Honeydew's south gate.
}finally{f.close();}});

const NATIVES=['puddle_toad','dandelion_sprite','bumble_nanny','scarecrow_sitter','harvest_matron'];

test('Plains natives roam the fields; Scarecrow Sitters stay on their posts; other routes still roam',()=>{
 let seen=new Set(),sitters=0;
 for(let n=0;n<40;n++){const f=generateDesert(autumnalPlainsData,'natives-'+n);
  for(const e of f.enemies){seen.add(e.type);if(e.type==='scarecrow_sitter'){sitters++;assert.equal(e.roaming,false);}else assert.equal(e.roaming,true);}}
 for(const id of NATIVES.filter(id=>id!=='harvest_matron'))assert.ok(seen.has(id),id+' appears'); // The rare mini-boss may skip a small sample.
 assert.ok(sitters>0);
 for(const data of [tundraData,highDesertData])assert.ok(generateDesert(data,'roam-1').enemies.every(e=>e.roaming===true)); // Exported roaming:true keeps every older wilderness foe walking.
});

test('each native ships stats, art, an enemy-only signature move, a defeat scene with effects and its outfit kit',()=>{
 for(const id of NATIVES){
  const e=autumnalPlainsData.enemies[id];assert.ok(e&&e.hp>0&&e.enemy_spells.length);
  for(const s of e.enemy_spells)assert.equal(combatData.spells[s]?.enemy_only,true,s);
  assert.ok(compiledArtwork[e.sprite]&&compiledArtwork[e.battle_sprite],id+' artwork');
  const aftermaths=defaultScenes[id].first.aftermaths;assert.equal(aftermaths.length,3);
  assert.ok(aftermaths.every(a=>a.pages.some(p=>p.effects)),id+' aftermaths carry effects');
  assert.ok(combatData.charms[id]);
 }
 for(const id of ['dandelion_sprite','bumble_nanny','scarecrow_sitter','harvest_matron'])assert.ok(combatData.defeat_equipment[id].first.length); // The toad only soaks you.
 assert.deepEqual(combatData.spells.diuretic_pollen.combo_effects,[{type:'wet',amount:25},{type:'excitement',amount:10}]);
});

// ── Phase 3: nowhere to hide (plains-features.mjs) ──
import {addPlainsFeatures,weatherAt,drinkFromWell,inCover,COVER} from '../server/plains-features.mjs';
import {dignityTuning} from '../server/dignity.mjs';
import {DEFAULT_TUNING} from '../server/loot.mjs';
const FEATURES=autumnalPlainsData.config.features;

test('30 editions gain tall grass, shelter and three drinkable wells without moving content or sealing anything',()=>{
 for(let n=0;n<30;n++){
  const f=generateDesert(autumnalPlainsData,'cover-'+n),before=structuredClone(f);
  assert.equal(addPlainsFeatures(f,FEATURES),true);assert.equal(addPlainsFeatures(f,FEATURES),false); // Idempotent across restarts and live editions.
  assert.ok(validateDesert(f));assert.deepEqual(f.enemies,before.enemies);assert.deepEqual(f.chests,before.chests);assert.deepEqual(f.pickups,before.pickups);assert.deepEqual(f.exits,before.exits);
  const again=generateDesert(autumnalPlainsData,'cover-'+n);addPlainsFeatures(again,FEATURES);assert.deepEqual(again.cover,f.cover); // Seeded per edition.
  assert.equal(f.exposed,true);assert.equal(f.cover.length,80);assert.ok(f.cover.every(r=>r.length===80&&/^[012]+$/.test(r)));
  const wells=f.decorations.filter(d=>d.well);assert.equal(wells.length,3);
  for(const w of wells)for(let dy=-1;dy<=w.span_h;dy++)for(let dx=-1;dx<=w.span_w;dx++){const x=w.x+dx,y=w.y+dy,inside=dx>=0&&dy>=0&&dx<w.span_w&&dy<w.span_h;assert.equal(f.props[y][x],inside?1:0);} // A free ring to stand in.
  let grass=0,shelter=0;
  for(let y=0;y<80;y++)for(let x=0;x<80;x++){const c=f.cover[y][x];if(c===COVER.OPEN)continue;assert.equal(f.walls[y][x],0);assert.equal(f.props[y][x],0);if(c===COVER.GRASS){grass++;assert.ok(!f.exits.some(e=>Math.abs(e.x-x)+Math.abs(e.y-y)<=2));}else shelter++;} // Cover is always walkable, never on a trail mouth.
  assert.ok(grass>100&&shelter>50);
  const open=f.cover.join('').split('').filter(c=>c===COVER.OPEN).length;assert.ok(open>0.8*f.cover.join('').length-(f.walls.flat().filter(Boolean).length)); // Most of the field stays exposed.
 }
});

test('rain showers follow a deterministic schedule shared by everyone',()=>{
 const rain=FEATURES.rain;let wet=0;
 for(let m=0;m<60*24*7;m++){const w=weatherAt('autumnal-plains',rain,m*60000);assert.deepEqual(w,weatherAt('autumnal-plains',rain,m*60000));assert.ok(w.until>m*60000);if(w.rain)wet++;}
 const share=wet/(60*24*7);assert.ok(share>0.04&&share<0.2,'rain '+share); // About chance x duration/slot of the time (35% x 6/20 = ~10%).
 assert.deepEqual(weatherAt('autumnal-plains',null,0),{rain:false,until:0});
});

test('a well drink refills thirst and stamina, fills the bladder and then needs a rest',()=>{
 const f=generateDesert(autumnalPlainsData,'well-1');addPlainsFeatures(f,FEATURES);const w=f.decorations.find(d=>d.well),cool={};
 const loadout={player_info:{thirst:50,wet:10,stamina:40,stamina_max:100}};
 const lines=drinkFromWell(f,{x:w.x-1,y:w.y},loadout,FEATURES,1000,cool);
 assert.deepEqual([loadout.player_info.thirst,loadout.player_info.wet,loadout.player_info.stamina],[170,30,65]);assert.ok(lines.some(l=>l.includes('Bladder +20')));
 assert.throws(()=>drinkFromWell(f,{x:w.x-1,y:w.y},loadout,FEATURES,20000,cool),/more seconds/);
 assert.ok(drinkFromWell(f,{x:w.x-1,y:w.y},loadout,FEATURES,47000,cool).length);assert.equal(loadout.player_info.thirst,250); // Caps at the survival range.
 assert.throws(()=>drinkFromWell(f,{x:w.x-1,y:w.y-1},loadout,FEATURES,99000,cool),/Stand beside a well/); // Diagonal corners do not count.
 assert.ok(inCover(f,w.x-1,w.y)); // Crouching by the well counts as shelter.
});

test('online: the Plains floor ships cover and weather, and dive_well drinks through the service',()=>{const f=fixture();try{
 f.player('alice');f.place('alice',{x:24,y:48});f.act('alice','move',{direction:'south',world_step:true});
 const s=f.snap('alice'),room=s.zones.find(z=>z.id===s.zone);
 assert.equal(room.exposed,true);assert.equal(room.cover.length,80);assert.ok(s.dive.weather&&typeof s.dive.weather.rain==='boolean');
 const w=room.decorations.find(d=>d.well);f.place('alice',{x:w.x-1,y:w.y});
 const before=f.snap('alice').character.loadout.player_info.wet??0;
 const after=f.act('alice','dive_well');
 assert.equal(after.character.loadout.player_info.wet,Math.min(100,before+20));assert.match(after.character.dive.lootNotice,/cold well water/);
 assert.throws(()=>f.act('alice','dive_well'),/more seconds/);
}finally{f.close();}});

test('the Plains Dignity amounts ship in the live tuning',()=>{
 const t=dignityTuning(DEFAULT_TUNING);
 assert.deepEqual([t.exposedWet,t.exposedTum,t.exposedWitnessPct,t.coverWitnessPct,t.rainPct],[8,14,150,50,50]);
 assert.equal(dignityTuning({...DEFAULT_TUNING,rain_dignity_percent:0}).rainPct,0); // 0 switches the rain discount's loss off entirely.
});

// ── Phase 4: the Farmstead (farmstead-generation.mjs) ──
import {generateFarmstead,restInHay,FARMSTEAD_PAD} from '../server/farmstead-generation.mjs';
import {farmsteadData,FARMSTEAD_ZONE,WILDERNESS_LINKS} from '../server/zones.mjs';

test('the Farmstead interior is a fixed, safe farmhouse: pad, pantry, hay beds and the outhouse',()=>{
 const f=generateFarmstead(farmsteadData,'farm-1');assert.ok(validateDesert(f));
 assert.deepEqual(generateFarmstead(farmsteadData,'farm-2').walls,f.walls); // The layout never changes; only pantry rolls do.
 assert.equal(f.width,24);assert.equal(f.height,16);assert.equal(f.theme,'farmstead');assert.equal(f.enemies.length,0);
 assert.deepEqual(f.exits,[{...FARMSTEAD_PAD,zone:AUTUMNAL_PLAINS_ZONE,name:'Autumnal Plains',style:'warp'}]);assert.deepEqual(f.entrance,{x:12,y:13});
 assert.equal(f.decorations.filter(d=>d.rest).length,3);assert.equal(f.decorations.filter(d=>d.toilet).length,1);
 assert.equal(f.chests.length,2);assert.equal(f.pickups.length,3);
 assert.deepEqual(computeTask('generate',{generator:'farmstead',data:farmsteadData,edition:'2026-09-21'}),generateFarmstead(farmsteadData,'2026-09-21')); // Worker pool parity.
 assert.ok(WILDERNESS_LINKS.some(([a,b])=>a===AUTUMNAL_PLAINS_ZONE&&b===FARMSTEAD_ZONE));
});

test('the red barn stands near the middle of the Plains with its warp pad, and the fields keep their cover',()=>{
 for(let n=0;n<15;n++){
  const f=generateDesert(autumnalPlainsData,'barn-'+n),before=structuredClone(f),c=autumnalPlainsData.config;
  addLandmark(f,c.landmark);addPlainsFeatures(f,c.features);openExitGaps(f);assert.ok(validateDesert(f));
  const barn=f.decorations.find(d=>d.landmark===FARMSTEAD_ZONE);assert.equal(barn.sprite,'sprPlainsBarn');
  assert.ok(Math.abs(barn.x+2-40)<=8&&Math.abs(barn.y+2-40)<=8); // Near the centre.
  const pad=f.exits.find(e=>e.zone===FARMSTEAD_ZONE);assert.equal(pad.style,'warp');assert.deepEqual(f.entries[FARMSTEAD_ZONE],{x:pad.x,y:pad.y+1});
  assert.deepEqual(f.chests,before.chests);assert.ok(f.cover&&f.decorations.filter(d=>d.well).length===3);
 }
});

test('a nap on a hay bed restores stamina, wakes you needing the outhouse, then needs a while',()=>{
 const f=generateFarmstead(farmsteadData,'nap-1'),bed=f.decorations.find(d=>d.rest),cool={},features=farmsteadData.config.features;
 const loadout={player_info:{stamina:10,stamina_max:100,wet:50}};
 const lines=restInHay(f,{x:bed.x,y:bed.y+1},loadout,features,1000,cool);
 assert.deepEqual([loadout.player_info.stamina,loadout.player_info.wet],[70,60]);assert.ok(lines.some(l=>l.includes('outhouse')));
 assert.throws(()=>restInHay(f,{x:bed.x,y:bed.y+1},loadout,features,60000,cool),/not sleepy/);
 assert.throws(()=>restInHay(f,{x:12,y:13},loadout,features,999999,cool),/Lie down beside a hay bed/);
});

test('online: walk through the barn door into the Farmstead, nap, and come back out beside the barn',()=>{const f=fixture();try{
 f.player('alice');f.place('alice',{x:24,y:48});f.act('alice','move',{direction:'south',world_step:true});
 const plains=f.floor('alice'),pad=plains.exits.find(e=>e.zone===FARMSTEAD_ZONE);assert.ok(pad);
 f.place('alice',{x:pad.x,y:pad.y+1});const inside=f.act('alice','dive_exit',{zone:FARMSTEAD_ZONE});
 assert.equal(inside.zone,FARMSTEAD_ZONE);assert.deepEqual(inside.position,{x:12,y:13});
 const room=f.floor('alice');assert.equal(room.theme,'farmstead');const bed=room.decorations.find(d=>d.rest);
 f.place('alice',{x:bed.x,y:bed.y+1});const nap=f.act('alice','dive_rest');assert.match(nap.character.dive.lootNotice,/hay/);
 f.place('alice',{x:12,y:13});const out=f.act('alice','dive_exit',{zone:AUTUMNAL_PLAINS_ZONE});
 assert.equal(out.zone,AUTUMNAL_PLAINS_ZONE);assert.deepEqual(out.position,{x:pad.x,y:pad.y+1}); // Just outside the barn door.
}finally{f.close();}});
