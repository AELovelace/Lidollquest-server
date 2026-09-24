import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,hauntedWoodsData,taigaData,highDesertData,HAUNTED_WOODS_ZONE,TAIGA_ZONE,HIGH_DESERT_ZONE,WILDERNESS_LINKS} from '../server/zones.mjs';
import {generateForest} from '../server/forest-generation.mjs';
import {generateDesert,validateDesert} from '../server/desert-generation.mjs';
import {pathTo,walkable} from '../server/dive-generation.mjs';
import {addSideTrail,openExitGaps} from '../server/wilderness-links.mjs';
import {computeTask} from '../server/compute-tasks.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {hubData,wildernessGates} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
import {routeLevelFor} from '../server/scaling.mjs';
import {DEFAULT_TUNING} from '../server/loot.mjs';
import {readFileSync} from 'node:fs';

const HONEYDEW='honeydew-lantern';

test('30 Woods editions reuse the campaign forest: seeded, connected, three crossings, typed clearings and themed scenery',()=>{
 const forest=JSON.parse(readFileSync(new URL('../server/haunted-woods-data.json',import.meta.url),'utf8'));
 assert.equal(forest.config.theme,'forest');assert.equal(forest.config.zone_category,'overworld'); // The native tilemap_paint_forest paints it.
 for(let n=0;n<30;n++){
  const f=generateForest(hauntedWoodsData,'woods-'+n);assert.ok(validateDesert(f));assert.deepEqual(f,generateForest(hauntedWoodsData,'woods-'+n)); // Same week, same woods.
  assert.equal(f.width,80);assert.equal(f.height,80);
  assert.deepEqual(f.exits.map(e=>[e.zone,e.x,e.y]),[[HONEYDEW,40,78],[TAIGA_ZONE,4,40],[HIGH_DESERT_ZONE,75,40]]);
  for(const e of f.exits)assert.ok(pathTo(f,f.entrance,e),'every crossing is reachable from Honeydew');
  const types=f.rooms.map(r=>r.type).filter(Boolean);assert.equal(types.filter(t=>t==='deep_wood').length,1);assert.ok(new Set(types).size>=6); // One deep wood plus a spread of the campaign's clearing identities.
  assert.ok(f.enemies.length>=20&&f.enemies.every(e=>hauntedWoodsData.enemies[e.type]));
  assert.ok(f.decorations.length>=hauntedWoodsData.structure.prop_count_min*0.8);
  const themed=f.rooms.filter(r=>r.type&&f.decorations.some(p=>(hauntedWoodsData.clearing_props[r.type]??[]).includes(p.sprite)&&p.x>=r.x&&p.x<r.x+r.w&&p.y>=r.y&&p.y<r.y+r.h));
  assert.ok(themed.length>=5,'clearings carry their own scenery');
 }
 assert.deepEqual(computeTask('generate',{generator:'forest',data:hauntedWoodsData,edition:'woods-1'}),generateForest(hauntedWoodsData,'woods-1')); // The worker pool runs the same generator.
});

test('Taiga and High Desert gain a side trail to the Woods without rerolling existing content',()=>{
 for(const [data,side,x] of [[taigaData,'right',78],[highDesertData,'left',1]])for(let n=0;n<15;n++){
  const f=generateDesert(data,'old-'+n),before=structuredClone(f);
  assert.equal(addSideTrail(f,{zone_id:HAUNTED_WOODS_ZONE,name:'Haunted Woods',side}),true);assert.equal(addSideTrail(f,{zone_id:HAUNTED_WOODS_ZONE,name:'Haunted Woods',side}),false); // Idempotent across restarts.
  assert.deepEqual(f.chests,before.chests);assert.deepEqual(f.enemies,before.enemies);assert.deepEqual(f.pickups,before.pickups);
  const exit=f.exits.find(e=>e.zone===HAUNTED_WOODS_ZONE);assert.deepEqual([exit.x,exit.y],[x,40]);
  openExitGaps(f);assert.equal(exit.style,'gap');assert.equal(exit.side,side);assert.ok(pathTo(f,f.entrance,f.entries[HAUNTED_WOODS_ZONE]));assert.ok(validateDesert(f));
  for(let yy=0;yy<f.height;yy++)for(let xx=0;xx<f.width;xx++)if(walkable(before,xx,yy))assert.ok(walkable(f,xx,yy));
 }
 assert.ok(WILDERNESS_LINKS.some(([a,b])=>a===HAUNTED_WOODS_ZONE&&b===TAIGA_ZONE));assert.ok(WILDERNESS_LINKS.some(([a,b])=>a===HAUNTED_WOODS_ZONE&&b===HIGH_DESERT_ZONE));
 assert.deepEqual(wildernessGates(HONEYDEW).find(g=>g.target===HAUNTED_WOODS_ZONE),{x:24,y:0,w:2,h:1,name:'Haunted Woods',target:HAUNTED_WOODS_ZONE,style:'gap',side:'top'});
});

test('the Woods level band sits a little above the Taiga and High Desert',()=>{
 const tuning=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8')).loot.tuning,woods=routeLevelFor(tuning,'haunted-woods');
 assert.ok(woods>routeLevelFor(tuning,'frostveil-taiga')&&woods>routeLevelFor(tuning,'dustbreak-high-desert'));assert.ok(woods-routeLevelFor(tuning,'frostveil-taiga')<=6); // Harder, but not by much.
 assert.equal(routeLevelFor(DEFAULT_TUNING,'haunted-woods'),routeLevelFor(DEFAULT_TUNING,'default')); // Unknown to the fallback table; the shipped table carries the band.
});

function fixture({live=null}={}){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-24T12:00:00Z'),api;const ids={};
 const loadout={player_info:{class_id:'mage',playerHealth:500,playerHealthMax:500,str:100,def:20,dex:20,int:20,cha:100,level:50,xp:0,stat_points:0},inventory:[],player_spells:['fireball'],player_mp:100,player_mp_max:100};
 const still=generate=>(...args)=>{const f=generate(...args);f.enemies.forEach(e=>e.roaming=false);return f;}; // Frozen roamers keep crossings deterministic.
 const quiet={log:()=>{},generate:still(generateDesert)};
 api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}},desertOptions:quiet,tundraOptions:quiet,taigaOptions:quiet,highDesertOptions:quiet,hauntedWoodsOptions:{log:()=>{},generate:still(generateForest)}});
 const snap=name=>api.read(name,ids[name]);
 function act(name,action,extra={}){time+=350;const s=snap(name);return api.act(name,{action,controller:'window',request_id:randomUUID(),character_id:ids[name],revision:s.character.revision,...(s.character.dive?{edition:s.dive.edition}:{}),...extra});}
 function player(name){ids[name]=api.act(name,{action:'create',name,controller:'window',request_id:randomUUID()}).character.id;return act(name,'enter',{zone:HONEYDEW,combat_version:3,content_version:1,quest_version:1,loadout});}
 function place(name,p){const row=db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[name]),state=JSON.parse(row.state);if(state.dive){state.dive.position={x:p.x,y:p.y};state.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(state),ids[name]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[name]);}
 const floor=name=>{const s=snap(name);return s.zones.find(z=>z.id===s.zone);};
 function cross(name,zone){const f=floor(name),gate=f.exits.find(e=>e.zone===zone),inward={left:[1,0],right:[-1,0],top:[0,1],bottom:[0,-1]}[gate.side];place(name,{x:gate.x+inward[0],y:gate.y+inward[1]});return act(name,'dive_exit',{zone});}
 return {db,ids,snap,act,player,place,floor,cross,get api(){return api;},advance:ms=>{time+=ms;},close(){api.close();db.close();}};
}

test('a character walks Honeydew -> Woods -> Taiga -> Woods -> High Desert -> Woods -> Honeydew keeping their bag',()=>{const f=fixture();try{
 f.player('alice');
 f.place('alice',{x:24,y:1});f.act('alice','move',{direction:'north',world_step:true});
 assert.equal(f.snap('alice').zone,HAUNTED_WOODS_ZONE);
 const woods=f.floor('alice');assert.equal(woods.theme,'forest');assert.deepEqual(woods.exits.map(e=>[e.zone,e.side,e.style]),[[HONEYDEW,'bottom','gap'],[TAIGA_ZONE,'left','gap'],[HIGH_DESERT_ZONE,'right','gap'],['dive-spooky-mansion',undefined,'warp']]); // Plus the haunted house's warp pad in the middle.
 f.cross('alice',TAIGA_ZONE);assert.equal(f.snap('alice').zone,TAIGA_ZONE);
 const taiga=f.floor('alice');assert.ok(taiga.exits.some(e=>e.zone===HAUNTED_WOODS_ZONE&&e.side==='right'));
 f.cross('alice',HAUNTED_WOODS_ZONE);assert.equal(f.snap('alice').zone,HAUNTED_WOODS_ZONE);
 f.cross('alice',HIGH_DESERT_ZONE);assert.equal(f.snap('alice').zone,HIGH_DESERT_ZONE);
 assert.ok(f.floor('alice').exits.some(e=>e.zone===HAUNTED_WOODS_ZONE&&e.side==='left'));
 f.cross('alice',HAUNTED_WOODS_ZONE);assert.equal(f.snap('alice').zone,HAUNTED_WOODS_ZONE);
 const home=f.cross('alice',HONEYDEW);assert.equal(home.zone,HONEYDEW);assert.deepEqual(home.position,{x:24,y:1}); // Back one tile inside Honeydew's north gate.
}finally{f.close();}});

function orbFixture(){
 const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment});let time=Date.parse('2026-09-24T12:00:00Z'),c;
 const api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 const act=(action,extra={})=>{time+=350;const r=api.act('',{action,controller:'control',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});c=r.character;return r;};
 const publish=entry=>live.change({action:'content_publish',kind:'orb',id:entry.id,revision:live.view().orbs.find(r=>r.id===entry.id)?.revision??0,entry},'dm');
 act('create',{name:'Alice'});act('enter',{zone:HONEYDEW,content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{cha:2,playerHealth:20,playerHealthMax:20,level:1,xp:0},inventory:[],player_spells:[]}});
 const at=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=?,seen=? WHERE character_id=?').run(x,y,time,c.id);
 return {db,live,api,act,publish,at,read:()=>api.read('',c.id),close(){api.close();db.close();}};
}
const orb=(id,extra={})=>({id,title:'Vial '+id,colour:'#ff66cc',bg_color:[10,14,8],type_speed:3,repeatable:false,requires:'',pages:[{id:'p1',text:'A cracked glass vial.',next:'p2'},{id:'p2',text:'It smells sweet.',next:'close'}],...extra});

test('story orbs: publish, place, glow, read once, chains wake in order, and quests hear the read',()=>{const f=orbFixture();try{
 assert.throws(()=>f.publish(orb('bad',{colour:'pink'})),/#rrggbb/);assert.throws(()=>f.publish(orb('empty',{pages:[]})),/at least one page/);
 assert.throws(()=>f.publish(orb('second',{requires:'first'})),/Publish the orb this one waits for/);
 f.publish(orb('first'));f.publish(orb('second',{requires:'first',colour:'#66ccff'}));
 let map=f.api.world.map(HONEYDEW);const spots=[];
 for(let y=2;y<map.floor.height-2&&spots.length<2;y++)for(let x=2;x<map.floor.width-2&&spots.length<2;x++){try{const key=spots.length?'second':'first';map=f.api.world.act({action:'world_place_content',zone:HONEYDEW,edition:map.edition,revision:map.revision,placement_kind:'orb',content:key,x,y});spots.push(map.placements.find(p=>p.content===key));x+=6;}catch(e){if(!/reachable tile|away from/.test(e.message))throw e;}}
 assert.equal(spots.length,2);assert.equal(spots[0].name,'Vial first');
 let seen=f.read().worldPlacements.filter(p=>p.kind==='orb').sort((a,b)=>a.content.localeCompare(b.content)); // Rows come back in placement-ID order.assert.deepEqual(seen.map(p=>[p.content,p.colour,p.dormant]),[['first','#ff66cc',false],['second','#66ccff',true]]);
 f.at(spots[1].x+1,spots[1].y);assert.throws(()=>f.act('orb_read',{placement:spots[1].id,edition:map.edition}),/still dark/);
 f.at(spots[0].x+5,spots[0].y);assert.throws(()=>f.act('orb_read',{placement:spots[0].id,edition:map.edition}),/beside the orb/);
 f.at(spots[0].x,spots[0].y);const read=f.act('orb_read',{placement:spots[0].id,edition:map.edition});
 assert.equal(read.orbScene.orb,'first');assert.deepEqual(read.orbScene.pages.map(p=>p.text),['A cracked glass vial.','It smells sweet.']);assert.deepEqual(read.orbScene.bg,[10,14,8]);
 seen=f.read().worldPlacements.filter(p=>p.kind==='orb');assert.deepEqual(seen.map(p=>[p.content,p.dormant]),[['second',false]]); // Spent orbs vanish; the next in the chain lights up.
 f.act('orb_close',{scene:read.orbScene.id});assert.equal(f.read().orbScene,null);
 f.at(spots[0].x,spots[0].y);assert.throws(()=>f.act('orb_read',{placement:spots[0].id,edition:map.edition}),/already know/);
 f.at(spots[1].x,spots[1].y);assert.throws(()=>f.act('quest_interact',{placement:spots[1].id,edition:map.edition}),/Touch the orb/); // Orbs are read, not used as quest objects.
 assert.throws(()=>f.publish(orb('first',{retired:true})),/wait for this one/); // A retired orb cannot strand its chain.
 f.publish(orb('second',{requires:'first',colour:'#66ccff',retired:true}));assert.deepEqual(f.read().worldPlacements.filter(p=>p.kind==='orb'),[]);
}finally{f.close();}});

test('the orb generator scatters a chain from shallow to deep, spaced apart, and refuses unpublished orbs',()=>{const f=orbFixture();try{
 for(const [i,id] of ['o1','o2','o3','o4'].entries())f.publish(orb(id,{requires:i?'o'+i:'',repeatable:true}));
 const zone='honeydew-lantern';let map=f.api.world.map(zone);
 assert.throws(()=>f.api.world.act({action:'world_scatter_orbs',zone,edition:map.edition,revision:map.revision,orbs:['o1','nope']}),/Publish every orb/);
 map=f.api.world.act({action:'world_scatter_orbs',zone,edition:map.edition,revision:map.revision,orbs:['o1','o2','o3','o4']});
 const placed=['o1','o2','o3','o4'].map(id=>map.placements.find(p=>p.content===id)),start=map.floor.spawn??map.floor.entrance;
 assert.ok(placed.every(Boolean));
 const far=placed.map(p=>pathTo({...map.floor,walls:map.floor.walls.map((r,y)=>r.map((v,x)=>v||(map.floor.fixtures??[]).some(q=>q.solid!==false&&x>=q.x&&x<q.x+(q.span_w??1)&&y>=q.y&&y<q.y+(q.span_h??1))?1:0))},start,p)?.length??Infinity);
 assert.ok(far[0]<far[3],'the first orb sits nearer the entrance than the last');
 for(let i=0;i<placed.length;i++)for(let j=i+1;j<placed.length;j++)assert.ok(Math.abs(placed[i].x-placed[j].x)+Math.abs(placed[i].y-placed[j].y)>=3);
}finally{f.close();}});
