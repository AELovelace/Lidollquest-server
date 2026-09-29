import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {smokeConfig,smokeClouds,smokeDensity,smokeCovers,smokeAt,smokeView,SMOKE_FORM,SMOKE_FADE} from '../server/pink-smoke.mjs';
import {mistData} from '../server/dive-mist.mjs';
import {generateDesert} from '../server/desert-generation.mjs';
import {walkable} from '../server/dive-generation.mjs';
import {createQuestZones,autumnalPlainsData,desertData} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {combatData} from '../server/combat.mjs';
import {hubData} from '../server/hubs.mjs';

const T0=Date.parse('2026-09-29T12:00:00Z'),MIN=60000;
const woods=smokeConfig('overworld-haunted-woods');
const plainsFloor=generateDesert(autumnalPlainsData,'smoke-1');
const centre=(c,t)=>{const age=(t-c.born)/MIN;return {x:c.x+c.vx*age,y:c.y+c.vy*age};};

test('shipped tuning covers the overworlds only: campaign Dives, hubs and safe rooms stay clear',()=>{
 for(const id of ['overworld-autumnal-plains','overworld-seafoam-coast','overworld-haunted-woods','overworld-tundra','overworld-taiga','overworld-desert','overworld-high-desert','overworld-emberfall-caldera','overworld-echo-gulch'])assert.ok(smokeConfig(id)?.enabled,id);
 for(const id of ['dive-forest','dive-quarters','overworld-farmstead','overworld-obsidian-spa','overworld-spooky-mansion','honeydew-lantern'])assert.equal(smokeConfig(id),null,id);
 assert.equal(smokeConfig('overworld-tundra',{...mistData,smoke:{...mistData.smoke,enabled:false}}).enabled,false); // The export master switch turns every zone off.
 assert.deepEqual(smokeClouds('r',plainsFloor,{...woods,enabled:false},T0),[]);assert.deepEqual(smokeClouds('r',plainsFloor,{...woods,clouds:0},T0),[]);
});

test('clouds are the same for every caller, drift over time, and every slot always has a cloud ahead',()=>{
 for(let m=0;m<120;m+=7){
  const t=T0+m*MIN,a=smokeClouds('haunted-woods',plainsFloor,woods,t,'e1'),b=smokeClouds('haunted-woods',structuredClone(plainsFloor),{...woods},t,'e1-copy');
  assert.deepEqual(a,b,'same answer on every worker, whatever the memo holds');
  const slots=new Set(a.map(c=>c.id.split(':')[0]));assert.equal(slots.size,woods.clouds); // Current or upcoming cloud for each slot.
  for(const c of a){
   assert.ok(c.dies>t&&c.dies-c.born===woods.life_minutes*MIN);assert.ok(c.lobes.length>=3&&c.lobes.length<=5);
   const speed=Math.hypot(c.vx,c.vy);assert.ok(speed>=woods.speed_min-0.02&&speed<=woods.speed_max+0.02,'speed '+speed);
  }
 }
 const [c]=smokeClouds('haunted-woods',plainsFloor,woods,T0,'e1'),mid=(c.born+c.dies)/2;
 assert.notDeepEqual(centre(c,mid),centre(c,mid+MIN),'clouds glide instead of sitting still');
});

test('clouds gather, hold, then swell and thin away; nothing exists outside their life',()=>{
 const c={born:0,dies:100000,x:10,y:10,vx:0,vy:0,lobes:[[0,0,3]]};
 assert.equal(smokeDensity(c,-1).density,0);assert.equal(smokeDensity(c,100001).density,0);
 assert.ok(smokeDensity(c,SMOKE_FORM*50000).density>0&&smokeDensity(c,SMOKE_FORM*50000).size<1); // Still gathering.
 assert.deepEqual(smokeDensity(c,50000),{density:1,size:1});
 const late=smokeDensity(c,100000-SMOKE_FADE*30000);assert.ok(late.density<1&&late.size>1); // Thinning out while it spreads.
 const cfg={cover_threshold:0.35};
 assert.equal(smokeCovers(c,cfg,50000,10,12),true);assert.equal(smokeCovers(c,cfg,50000,10,14),false);
 assert.equal(smokeCovers(c,cfg,1000,10,10),false,'a wisp that is only starting to form cannot be breathed');
 assert.equal(smokeCovers(c,cfg,99500,10,10),false,'nor one that has nearly gone');
});

test('smokeAt agrees with the snapshot geometry, and spawns keep clear of the trailheads',()=>{
 let hits=0;
 for(let m=0;m<60;m+=3){
  const t=T0+m*MIN,view=smokeView('autumnal-plains',plainsFloor,woods,t,'e2');
  for(let y=0;y<plainsFloor.height;y+=2)for(let x=0;x<plainsFloor.width;x+=2){
   const expected=view.clouds.some(c=>smokeCovers(c,woods,t,x,y));assert.equal(smokeAt('autumnal-plains',plainsFloor,woods,t,x,y,'e2'),expected);if(expected)hits++;
  }
  for(const c of view.clouds)if(c.born>T0-woods.life_minutes*MIN)assert.ok(![plainsFloor.entrance,...plainsFloor.exits].some(p=>Math.abs(p.x-c.x)+Math.abs(p.y-c.y)<=woods.entrance_radius)||plainsFloor.walls[c.y][c.x]!==0);
 }
 assert.ok(hits>0,'the Plains actually get some smoke');
});

function fixture(){ // Same service harness as the Plains tests, with a clock the test can move.
 const db=new DatabaseSync(':memory:'),clock={time:T0},ids={};
 const loadout={player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:10,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const still=(...args)=>{const f=generateDesert(...args);f.enemies.length=0;return f;}; // No monsters in the way of the smoke walk.
 const quiet={log:()=>{},generate:still};
 const api=createQuestZones(db,{now:()=>clock.time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:quiet,tundraOptions:quiet,taigaOptions:quiet,highDesertOptions:quiet,autumnalPlainsOptions:quiet});
 const snap=name=>api.read(name,ids[name]);
 function act(name,action,extra={}){clock.time+=350;const s=snap(name);return api.act(name,{action,controller:'window',request_id:randomUUID(),character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra});}
 function player(name){ids[name]=api.act(name,{action:'create',name,controller:'window',request_id:randomUUID()}).character.id;return act(name,'enter',{zone:'honeydew-lantern',combat_version:3,content_version:1,quest_version:1,loadout});}
 function place(name,p){const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]),state=JSON.parse(row.state);if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=clock.time+600000;}delete state.worldTurnDue;db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids[name]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,clock.time,ids[name]);}
 const state=name=>JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]).state);
 return {db,clock,snap,act,player,place,state,close(){api.close();db.close();}};
}

test('online: the Plains snapshot ships the clouds, and stepping into a dense one is a Pink Mist turn',()=>{const f=fixture();try{
 f.player('alice');f.place('alice',{x:24,y:48});f.act('alice','move',{direction:'south',world_step:true});
 let s=f.snap('alice');assert.ok(Array.isArray(s.dive.smoke?.clouds)&&s.dive.smoke.clouds.length>0);assert.equal(s.dive.smoke.threshold,0.35);
 const room=s.zones.find(z=>z.id===s.zone),floor={width:room.width,height:room.height,walls:room.walls,props:room.props??[]};
 const cfg=smokeConfig('overworld-autumnal-plains');let target=null,from=null;
 for(let step=0;step<240&&!target;step++){ // Walk the shared clock forward until some cloud sits dense over open ground.
  f.clock.time+=15000;const t=f.clock.time+700;s=f.snap('alice');
  for(const c of s.dive.smoke.clouds){
   if(smokeDensity(c,t).density<0.6)continue;const p=centre(c,t),x=Math.round(p.x),y=Math.round(p.y);
   if(!walkable(floor,x,y)||!smokeCovers(c,cfg,t,x,y))continue;
   for(const [dx,dy,dir] of [[0,1,'north'],[0,-1,'south'],[1,0,'west'],[-1,0,'east']])if(walkable(floor,x+dx,y+dy)){target={x,y};from={x:x+dx,y:y+dy,dir};break;}
   if(target)break;
  }
 }
 assert.ok(target,'some cloud drifted over open Plains ground within the hour');
 f.place('alice',from);f.act('alice','move',{direction:from.dir,world_step:true});
 assert.equal(f.state('alice').worldTurnDue?.mist,true,'the needs turn carries the mist flag');
 f.place('alice',{x:from.x,y:from.y});
 assert.equal(smokeAt('autumnal-plains',floor,{...cfg,enabled:false},f.clock.time,target.x,target.y),false);
}finally{f.close();}});

test('the GM Zones tab edits Pink Smoke per overworld, validates it, and resolves it onto the engine config',()=>{
 const db=new DatabaseSync(':memory:');try{
  const live=createWorldContent(db,{now:()=>T0,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment});
  createQuestZones(db,{now:()=>T0,roll:()=>0,live,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}}); // Registers every route's baseline.
  const draft=live.entry('zone','overworld-desert').draft;assert.deepEqual(draft.pink_smoke,smokeConfig('overworld-desert'));
  assert.equal(live.entry('zone','dive-quarters').draft.pink_smoke,undefined,'Dives never show smoke fields');
  const publish=pink_smoke=>live.change({action:'content_publish',kind:'zone',id:'overworld-desert',revision:live.entry('zone','overworld-desert').revision,entry:{...live.entry('zone','overworld-desert').draft,pink_smoke}},'dm');
  assert.throws(()=>publish({...draft.pink_smoke,speed_min:9,speed_max:2}),/minimums/);
  assert.throws(()=>publish({...draft.pink_smoke,clouds:99}),/between/);
  publish({...draft.pink_smoke,clouds:2,enabled:false});
  const cfg=live.resolve(desertData).config.features.pink_smoke;assert.equal(cfg.clouds,2);assert.equal(cfg.enabled,false);
  assert.deepEqual(smokeClouds('dustbreak-crossing',plainsFloor,cfg,T0),[],'switched off from the panel');
 }finally{db.close();}
});
