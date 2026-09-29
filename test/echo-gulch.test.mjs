import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createQuestZones,gulchData,GULCH_ZONE,PROSPECTOR_CAMP_EXIT,desertData,DESERT_ZONE,autumnalPlainsData,AUTUMNAL_PLAINS_ZONE,coastData,COAST_ZONE,WILDERNESS_LINKS} from '../server/zones.mjs';
import {generateDesert,validateDesert,washBand} from '../server/desert-generation.mjs';
import {addSideTrail,addSouthTrail,addLandmark,openExitGaps,retargetExit} from '../server/wilderness-links.mjs';
import {addGulchFeatures,floodAt,echoReading,noticeAccident,listenAtStone,inWash,accidentMark} from '../server/gulch-features.mjs';
import {PROSPECTOR_CAMP_ROOM_ID,prospectorCampRoom} from '../server/prospector-camp.mjs';
import {hubData,hubRooms,findShop} from '../server/hubs.mjs';
import {withGenerated} from '../server/generated-items.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {combatData} from '../server/combat.mjs';
import {defaultScenes,compiledArtwork} from '../server/defeat-scenes.mjs';
import {routeLevelFor} from '../server/scaling.mjs';

const FEATURES=gulchData.config.features,S=gulchData.structure,items=withGenerated(hubData.equipment);
const upgraded=edition=>{const f=generateDesert(gulchData,edition);addSideTrail(f,{zone_id:AUTUMNAL_PLAINS_ZONE,name:'Autumnal Plains',side:'left'});addSideTrail(f,{zone_id:COAST_ZONE,name:'Seafoam Coast',side:'right'});addLandmark(f,gulchData.config.landmark);addGulchFeatures(f,FEATURES);openExitGaps(f);return f;}; // What the live engine's upgradeFloor does.

test('30 Echo Gulch editions: Dustbreak north, the Plains west, the Coast east, a dry wash across the middle, slot canyons, whisper stones and the mine head',()=>{
 let mazes=0;
 for(let n=0;n<30;n++){
  const raw=generateDesert(gulchData,'gulch-'+n);assert.deepEqual(raw,generateDesert(gulchData,'gulch-'+n));assert.ok(validateDesert(raw));
  assert.equal(raw.theme,'gulch');assert.deepEqual(raw.exits,[{x:40,y:1,zone:DESERT_ZONE,name:'Dustbreak Desert'}]);
  const band=washBand(80,80,S.wash);
  assert.equal(raw.wash.length,80);assert.ok(raw.wash.every(row=>row.length===80));
  for(let y=0;y<80;y++)for(let x=0;x<80;x++)assert.equal(raw.wash[y][x]==='1',band(x,y)); // The rows the client floods are exactly the carved riverbed.
  for(let x=1;x<79;x++)assert.ok([...Array(80).keys()].some(y=>band(x,y)&&raw.walls[y][x]===0),'the wash runs the whole width'); // Open floor at every column.
  for(const r of raw.rooms.filter(r=>r.slot)){ // Slot canyons: 1-wide passages, so every inner pillar (even offsets) stays rock.
   mazes++;const cw=Math.floor((r.w-1)/2),ch=Math.floor((r.h-1)/2);
   for(let j=1;j<ch;j++)for(let i=1;i<cw;i++)assert.equal(raw.walls[r.y+2*j][r.x+2*i],1,'maze pillar');
   assert.ok(![...Array(r.h).keys()].some(dy=>band(r.x,r.y+dy)),'slot canyons never sit in the wash');
  }
  const f=upgraded('gulch-'+n);assert.ok(validateDesert(f));
  assert.deepEqual(f.exits.map(e=>[e.zone,e.side??e.style]),[[DESERT_ZONE,'top'],[AUTUMNAL_PLAINS_ZONE,'left'],[COAST_ZONE,'right'],[PROSPECTOR_CAMP_EXIT,'warp']]);
  const mine=f.decorations.find(d=>d.landmark===PROSPECTOR_CAMP_EXIT);assert.equal(mine.sprite,'sprGulchMineHead');assert.ok(mine.y+mine.span_h<32,'the mine head stands north of the wash');
  const stones=f.decorations.filter(d=>d.whisper);assert.ok(stones.length>=4,'whisper stones '+stones.length);
  for(const s of stones){assert.equal(s.sprite,'sprGulchWhisperStone');for(let dy=-1;dy<=s.span_h;dy++)for(let dx=-1;dx<=s.span_w;dx++)assert.ok(!inWash(f,s.x+dx,s.y+dy),'stones stand on the banks');}
  assert.equal(addGulchFeatures(f,FEATURES),false);
 }
 assert.ok(mazes>=30,'slot canyons across 30 editions: '+mazes); // About half the basins become mazes.
 assert.deepEqual(computeTask('generate',{generator:'desert',data:gulchData,edition:'2026-09-28'}),generateDesert(gulchData,'2026-09-28'));
});

test('flash floods: dry, then a 30 s roar, then 45 s of flood every 10 minutes, the same for everyone',()=>{
 const count={dry:0,warning:0,flooding:0},cfg=FEATURES.flood;
 for(let s=0;s<10*60*10;s++){const e=floodAt('echo-gulch',cfg,s*1000);assert.deepEqual(e,floodAt('echo-gulch',cfg,s*1000));assert.ok(e.until>s*1000);count[e.state]++;}
 assert.deepEqual(count,{dry:(600-75)*10,warning:30*10,flooding:45*10});assert.deepEqual(floodAt('x',null,0),{state:'dry',until:0});
});

test('the echo: padding crinkles, wet sloshes, a mess squelches, an accident rings out for a while, and crawling muffles it all',()=>{
 const echo=FEATURES.echo,base=gulchData.config.pursuit_steps;
 const state=pi=>({loadout:{player_info:{...pi}},dive:{}});
 assert.deepEqual(echoReading(state({}),echo,base,0,items),{reach:base,sounds:[],crawling:false,until:0});
 const padded=state({equipped_panties:'diaper',panties_bulk:3});assert.equal(echoReading(padded,echo,base,0,items).reach,base+echo.crinkle);
 const soggy=state({equipped_panties:'diaper',diaper_wet_absorbed:1});assert.deepEqual(echoReading(soggy,echo,base,0,items).sounds,['crinkling','sloshing']);
 const messy=state({equipped_panties:'diaper',diaper_wet_absorbed:1,diaper_tum_absorbed:1});assert.equal(echoReading(messy,echo,base,0,items).reach,base+echo.crinkle+echo.slosh+echo.squish);
 const s=state({equipped_panties:'diaper'});assert.equal(noticeAccident(s.dive,s.loadout,echo,1000),false);assert.equal(s.dive.echoMark,0); // The first action only records a baseline.
 s.loadout.player_info.diaper_wet_absorbed=1;assert.equal(noticeAccident(s.dive,s.loadout,echo,2000),true);assert.equal(s.dive.echoUntil,2000+echo.accident_seconds*1000);
 const loud=echoReading(s,echo,base,3000,items);assert.equal(loud.reach,base+echo.crinkle+echo.slosh+echo.accident);assert.ok(loud.sounds.includes('echoing'));
 assert.ok(!echoReading(s,echo,base,2000+echo.accident_seconds*1000,items).sounds.includes('echoing'),'the echo fades');
 s.loadout.world={crawling:true};assert.equal(echoReading(s,echo,base,3000,items).reach,Math.round((base+echo.crinkle+echo.slosh+echo.accident)*echo.crawl_percent/100)); // Sneaking halves it.
 assert.equal(echoReading(state({}),{...echo,max_reach:4},base,0,items).reach,4);assert.equal(accidentMark({had_wet_accident:true,had_tum_accident:2}),3); // Capped; old saves used booleans.
 assert.equal(noticeAccident(s.dive,{player_info:{}},echo,9000),false); // A change into clean clothes is silent.
});

test('whisper stones: rumours when you are clean; gossip about you, costing Dignity, when you are visibly wet or smell; one listen per stone per cooldown',()=>{
 const f=upgraded('whisper-1'),stone=f.decorations.find(d=>d.whisper),p={x:stone.x-1,y:stone.y},heard={},w=FEATURES.whisper;
 const clean={player_info:{shame:1024,shame_level:50}};
 const rumour=listenAtStone(f,p,clean,FEATURES,60000,heard,items);assert.equal(clean.player_info.shame,1024);assert.ok(w.rumours.some(r=>rumour.join(' ').includes(r)));
 assert.deepEqual(listenAtStone(f,p,clean,FEATURES,90000,heard,items),['Only the wind hisses through the stone now.']); // Quiet, not an error.
 const soaked={player_info:{shame:1024,shame_level:50,had_wet_accident:1}},lines=listenAtStone(f,p,soaked,FEATURES,999999,heard,items);
 assert.ok(w.about_you.some(r=>lines.join(' ').includes(r)));assert.equal(soaked.player_info.shame,1024-Math.round(w.dignity*1.25));assert.ok(lines.at(-1).includes('Dignity -')); // Shame 50 scales by 1.25.
 assert.throws(()=>listenAtStone(f,{x:stone.x-3,y:stone.y},clean,FEATURES,99999999,heard,items),/whisper stone/);
});

test('links: Dustbreak opens a south trail, the Plains and the Coast now meet the Gulch instead of each other, and live editions are retargeted in place',()=>{
 for(const pair of [[DESERT_ZONE,GULCH_ZONE],[AUTUMNAL_PLAINS_ZONE,GULCH_ZONE],[COAST_ZONE,GULCH_ZONE]])assert.ok(WILDERNESS_LINKS.some(([a,b])=>a===pair[0]&&b===pair[1]));
 assert.ok(!WILDERNESS_LINKS.some(([a,b])=>[a,b].includes(AUTUMNAL_PLAINS_ZONE)&&[a,b].includes(COAST_ZONE)),'the Plains and the Coast no longer touch');
 for(let n=0;n<10;n++){
  const d=generateDesert(desertData,'south-'+n),before=structuredClone(d);assert.equal(addSouthTrail(d,{zone_id:GULCH_ZONE,name:'Echo Gulch'}),true);openExitGaps(d);assert.ok(validateDesert(d));
  assert.deepEqual(d.chests,before.chests);assert.ok(d.exits.some(e=>e.zone===GULCH_ZONE&&e.side==='bottom'));
 }
 const plains=generateDesert(autumnalPlainsData,'old-east');addSideTrail(plains,{zone_id:COAST_ZONE,name:'Seafoam Coast',side:'right'});openExitGaps(plains); // A live edition carved before the Gulch existed.
 const gap=structuredClone(plains.exits.find(e=>e.zone===COAST_ZONE)),arrive=structuredClone(plains.entries[COAST_ZONE]);
 assert.equal(retargetExit(plains,{from:COAST_ZONE,zone_id:GULCH_ZONE,name:'Echo Gulch'}),true);assert.equal(retargetExit(plains,{from:COAST_ZONE,zone_id:GULCH_ZONE,name:'Echo Gulch'}),false);
 const moved=plains.exits.find(e=>e.zone===GULCH_ZONE);assert.deepEqual([moved.x,moved.y,moved.side,moved.style,moved.name],[gap.x,gap.y,gap.side,gap.style,'Echo Gulch']); // Same opening, new destination.
 assert.deepEqual(plains.entries[GULCH_ZONE],arrive);assert.equal(plains.entries[COAST_ZONE],undefined);
 assert.equal(addSideTrail(plains,{zone_id:GULCH_ZONE,name:'Echo Gulch',side:'right'}),false); // No second east trail is carved.
 const coast=generateDesert(coastData,'old-west');addSideTrail(coast,{zone_id:AUTUMNAL_PLAINS_ZONE,name:'Autumnal Plains',side:'left'});openExitGaps(coast);
 assert.equal(retargetExit(coast,{from:AUTUMNAL_PLAINS_ZONE,zone_id:GULCH_ZONE,name:'Echo Gulch'}),true);assert.ok(coast.exits.some(e=>e.zone===GULCH_ZONE&&e.side==='left'));assert.ok(validateDesert(coast));
});

test('band 35 sits between the High Desert and the Caldera; the natives ship complete, and the Hoodoo Sentinel never leaves its post',()=>{
 const tuning=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8')).loot.tuning;
 assert.equal(routeLevelFor(tuning,'echo-gulch'),35);assert.ok(routeLevelFor(tuning,'echo-gulch')>routeLevelFor(tuning,'dustbreak-high-desert'));
 for(const id of ['echo_bat','rattletail','tattler_wren','hoodoo_sentinel','hush_matron']){
  const e=gulchData.enemies[id];assert.ok(e&&e.enemy_spells.length&&e.dex>=1&&e.dex<=14,id);
  for(const s of e.enemy_spells)assert.equal(combatData.spells[s]?.enemy_only,true,s);
  assert.ok(compiledArtwork[e.sprite]&&compiledArtwork[e.battle_sprite],id);assert.equal(defaultScenes[id].first.aftermaths.length,3);assert.ok(combatData.defeat_equipment[id].first.length);
  assert.equal(e.roaming,id!=='hoodoo_sentinel');
 }
});

test("the Prospector's Camp: bunks, Old Gritt's counter, an outhouse and the door out, all reachable",()=>{
 const room=hubRooms.find(r=>r.id===PROSPECTOR_CAMP_ROOM_ID);assert.ok(room);assert.equal(room.parent,'littlebig-clockwork');assert.equal(room.camp,true);
 assert.deepEqual(room.routeExit,{route:GULCH_ZONE,via:PROSPECTOR_CAMP_EXIT});
 assert.equal(room.fixtures.filter(x=>x.kind==='bed').length,3);assert.ok(room.fixtures.some(x=>x.kind==='toilet'&&x.style==='outhouse'));
 const gritt=room.fixtures.find(x=>x.kind==='shop');assert.equal(gritt.name,'Old Gritt');assert.equal(gritt.sprite,'sprNPCProspector');assert.ok(gritt.greetings.length>=3);
 assert.equal(findShop(gritt.id),hubData.prospector_shop);assert.ok(hubData.prospector_shop.pool.every(id=>hubData.items[id]));
 assert.equal(prospectorCampRoom(null).fixtures.some(x=>x.kind==='shop'),false); // An old hub-data.json without his shelf still boots.
});

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-29T12:00:00Z'),api;const ids={};
 const loadout={player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:40,xp:0,stat_points:0,stamina:100,stamina_max:100,incontinence:100,thirst:50,shame:1024,equipped_panties:'diaper'},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const still=(...args)=>{const f=generateDesert(...args);f.enemies.forEach(e=>e.roaming=false);return f;},quiet={log:()=>{},generate:still};
 api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:quiet,tundraOptions:quiet,taigaOptions:quiet,highDesertOptions:quiet,autumnalPlainsOptions:quiet,coastOptions:quiet,calderaOptions:quiet,gulchOptions:quiet});
 const snap=name=>api.read(name,ids[name]);
 function act(name,action,extra={}){time+=350;const s=snap(name);return api.act(name,{action,controller:'window',request_id:randomUUID(),character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra});}
 function player(name){ids[name]=api.act(name,{action:'create',name,controller:'window',request_id:randomUUID()}).character.id;return act(name,'enter',{zone:'honeydew-lantern',combat_version:3,content_version:1,quest_version:1,loadout});}
 function place(name,p){const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]),state=JSON.parse(row.state);if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids[name]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[name]);}
 const floor=name=>{const s=snap(name);return s.zones.find(z=>z.id===s.zone);};
 const cross=(name,zone)=>{const e=floor(name).exits.find(x=>x.zone===zone),inward={left:[1,0],right:[-1,0],top:[0,1],bottom:[0,-1]}[e.side]??[0,1];place(name,{x:e.x+inward[0],y:e.y+inward[1]});return act(name,'dive_exit',{zone});};
 return {snap,act,player,place,floor,cross,close(){api.close();db.close();}};
}

test("online: Honeydew -> Plains -> Gulch (wash, flood, echo) -> whisper stone -> Prospector's Camp -> Gulch -> Coast -> Gulch -> Dustbreak",()=>{const f=fixture();try{
 f.player('alice');f.place('alice',{x:24,y:48});f.act('alice','move',{direction:'south',world_step:true});
 const plains=f.floor('alice');assert.ok(plains.exits.some(e=>e.zone===GULCH_ZONE&&e.side==='right'));assert.ok(!plains.exits.some(e=>e.zone===COAST_ZONE)); // The Plains' east wall now leads into the Gulch.
 assert.equal(f.cross('alice',GULCH_ZONE).zone,GULCH_ZONE);
 const room=f.floor('alice'),s=f.snap('alice');assert.equal(room.theme,'gulch');assert.equal(room.wash.length,80);
 assert.ok(['dry','warning','flooding'].includes(s.dive.flood.state));assert.equal(s.dive.flood.wash_wet,FEATURES.flood.wash_wet);assert.deepEqual(s.dive.flood.soak_slots,['socks','shoes','pants']);
 assert.equal(s.dive.echo.base,6);assert.equal(s.dive.echo.reach,8);assert.deepEqual(s.dive.echo.sounds,['crinkling']); // A diaper crinkles.
 const stone=room.decorations.find(d=>d.whisper);f.place('alice',{x:stone.x-1,y:stone.y});
 const heard=f.act('alice','dive_listen');assert.match(heard.character.dive.lootNotice,/whispers/);
 const pad=room.exits.find(e=>e.zone===PROSPECTOR_CAMP_EXIT);f.place('alice',{x:pad.x,y:pad.y+1});
 const camp=f.act('alice','dive_exit',{zone:PROSPECTOR_CAMP_EXIT});assert.equal(camp.zone,PROSPECTOR_CAMP_ROOM_ID);assert.deepEqual(camp.position,{x:12,y:13});
 assert.equal(camp.character.dive,null);assert.equal(camp.zoneCategory,'safe');const inside=f.floor('alice');assert.equal(inside.camp,true);
 const gritt=inside.fixtures.find(x=>x.kind==='shop');assert.ok(gritt.offers.length>0);
 f.place('alice',{x:12,y:13});const out=f.act('alice','move',{direction:'south'});assert.equal(out.zone,GULCH_ZONE);assert.deepEqual(out.position,{x:pad.x,y:pad.y+1}); // Back out beside the mine head.
 assert.equal(f.cross('alice',COAST_ZONE).zone,COAST_ZONE);assert.ok(f.floor('alice').exits.some(e=>e.zone===GULCH_ZONE&&e.side==='left'));
 assert.equal(f.cross('alice',GULCH_ZONE).zone,GULCH_ZONE);
 assert.equal(f.cross('alice',DESERT_ZONE).zone,DESERT_ZONE);assert.ok(f.floor('alice').exits.some(e=>e.zone===GULCH_ZONE&&e.side==='bottom'));
}finally{f.close();}});
