import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-12T20:00:00Z'),api;const ids={};
 const start=()=>api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:100}),adjust:()=>{},diveOptions:{log:()=>{}}});start();
 const snap=(who='a')=>api.read(who,ids[who]);
 const command=(who,action,extra={})=>{const r=snap(who);return {action,controller:who,character_id:ids[who],revision:r.character.revision,request_id:randomUUID(),...(r.character.dive?{edition:r.dive.edition}:{}),...extra};};
 const send=(who,input)=>{time+=700;return api.act(who,input);},act=(who,action,extra)=>send(who,command(who,action,extra));
 const place=(who,p)=>{const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(ids[who]).state);if(s.dive){s.dive.position={x:p.x,y:p.y};s.dive.safeUntil=time+600000;}db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),ids[who]);db.prepare('UPDATE quest_presence SET x=?,y=?,seen=?,moved=0 WHERE character_id=?').run(p.x,p.y,time,ids[who]);};
 const create=(who,zone,version=1)=>{ids[who]=api.act(who,{action:'create',name:who,controller:who,request_id:randomUUID()}).character.id;act(who,'enter',{zone,catacombs_version:1,sewer_version:version,full_dungeon_version:1,content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{playerHealth:1000,playerHealthMax:1000,stamina:100,stamina_max:100,str:20,def:20,dex:20,cha:10,level:5,equipped_socks:'knee_socks',equipped_shoes:'boots'},inventory:[],player_spells:[],world:{crawling:false}}});};
 const map=(who='a')=>{const r=snap(who);return r.zones.find(z=>z.id===r.zone);};
 const enter=(who,host)=>{create(who,host);place(who,map(who).portals.find(p=>p.target==='dungeon-littlebig-sewers'));act(who,'dive_enter',{zone:'dungeon-littlebig-sewers'});};
 return {db,snap,command,send,act,place,create,map,enter,ids,advance(ms){time+=ms;api.tick();},restart(){api.close();start();},close(){api.close();db.close();}};
}
const adjacent=(map,p)=>[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>({x:p.x+dx,y:p.y+dy})).find(p=>map.walls[p.y]?.[p.x]===0&&!map.props[p.y]?.[p.x]);
test('city manholes, shared valve receipts, independent claims and persistence',()=>{
 const f=fixture();try{
  f.enter('a','littlebig-clockwork');f.enter('b','littlebig-clockwork');assert.equal(f.snap().zone,'dungeon-littlebig-sewers');
  const map=f.map(),valve=map.fixtures.find(v=>v.kind==='sluice');f.place('a',adjacent(map,valve));
  const request=f.command('a','dungeon_interact',{fixture:valve.id,mechanism_revision:0});f.send('a',request);f.send('a',request);
  assert.equal(f.map().mechanismRevision,1);assert.equal(f.map('b').mechanismRevision,1);
  let scene=f.snap().dive.scene;f.act('a','dungeon_scene_choice',{scene:scene.id,page:scene.page,mechanism_revision:scene.revision,choice:-1});
  assert.throws(()=>f.act('a','dungeon_interact',{fixture:valve.id,mechanism_revision:0}),/changed/);
  const chest=f.snap().dive.chests[0];f.place('a',chest);const claim=f.command('a','dive_claim',{chest:chest.id});f.send('a',claim);f.send('a',claim);
  assert.equal(f.snap().dive.chests.find(c=>c.id===chest.id).claimed,true);assert.equal(f.snap('b').dive.chests.find(c=>c.id===chest.id).claimed,false);
  f.restart();assert.equal(f.map().mechanismRevision,1);assert.equal(f.snap().dive.chests.find(c=>c.id===chest.id).claimed,true);
  const exit=f.map().exits.find(e=>e.zone==='dungeon-honeydew-catacombs-1');f.place('a',{x:exit.x,y:exit.y+1});assert.equal(f.act('a','move',{direction:'north'}).zone,'dungeon-honeydew-catacombs-1');
  assert.equal(f.act('b','dive_exit').zone,'littlebig-clockwork');
 }finally{f.close();}
});
test('older clients cannot enter the sewer and incoming pipe steps enforce clearance',()=>{
 const f=fixture();try{
  f.create('old','littlebig-clockwork',0);f.place('old',f.map('old').portals.find(p=>p.target==='dungeon-littlebig-sewers'));assert.throws(()=>f.act('old','dive_enter',{zone:'dungeon-littlebig-sewers'}),/Update/);
  f.enter('a','littlebig-clockwork');const map=f.map();let at;
  const occupied=[...f.snap().dive.enemies,...f.snap().dive.chests,...f.snap().dive.pickups,...map.fixtures];
  for(let y=1;y<95&&!at;y++)for(let x=1;x<127&&!at;x++)if(map.sewer.low[y][x]==='1'&&map.sewer.low[y][x-1]==='0'&&!map.walls[y][x-1]&&!map.props[y][x-1]&&!occupied.some(p=>p.x===x&&p.y===y))at={x,y};
  assert.ok(at);f.place('a',{x:at.x-1,y:at.y});let r=f.act('a','move',{direction:'east',world_step:true});
  assert.equal(r.character.loadout.world.environment_crawl,true);assert.equal(r.character.loadout.world.crawling,false);
  assert.equal(r.character.loadout.player_info.slot_wet_shoes,true);
  const before=r.character.loadout.player_info.str;
  r=f.act('a','world_turn',{world_turn_id:r.character.worldTurnDue.id,loadout:r.character.loadout});assert.equal(r.character.loadout.world.environment_crawl,true);assert.equal(r.character.loadout.player_info.str,before);
  assert.throws(()=>f.act('a','stand'),/pipes/);
  f.restart();assert.equal(f.snap().character.loadout.world.environment_crawl,true);
  r=f.act('a','move',{direction:'west'});assert.equal(r.character.loadout.world.environment_crawl,false);assert.equal(r.character.loadout.world.crawling,false);
  assert.equal(f.act('a','dive_exit').character.loadout.world.environment_crawl,false);
 }finally{f.close();}
});

test('party capability gates roll back the entire transfer and weekly rollover releases clearance',()=>{
 const f=fixture();try{
  f.create('a','littlebig-clockwork');f.create('b','littlebig-clockwork',0);
  const portal=f.map().portals.find(p=>p.target==='dungeon-littlebig-sewers');f.place('a',portal);f.place('b',portal);
  f.act('a','party_invite',{member:f.ids.b});f.act('b','party_accept',{invitation:f.snap('b').partyInvitations[0].id});
  assert.throws(()=>f.act('a','dive_enter',{zone:'dungeon-littlebig-sewers'}),/update/);
  assert.equal(f.snap().zone,'littlebig-clockwork');assert.equal(f.snap('b').zone,'littlebig-clockwork');
  f.act('b','enter',{zone:'littlebig-clockwork',sewer_version:1,full_dungeon_version:1,quest_version:1,content_version:1,combat_version:3});
  f.place('a',portal);f.place('b',portal);f.act('a','dive_enter',{zone:'dungeon-littlebig-sewers'});
  assert.equal(f.snap('b').zone,'dungeon-littlebig-sewers');
  const edition=f.snap().dive.edition,low=f.map().sewer.branches[0].paths[1].find(p=>f.map().sewer.low[p.y][p.x]==='1');
  f.place('a',low);f.act('a','loadout',{loadout:f.snap().character.loadout});
  assert.equal(f.snap().character.loadout.world.environment_crawl,true);
  f.advance(8*86400000);assert.equal(f.snap().character.dive,null);assert.equal(f.snap().character.diveReturned,'littlebig-clockwork');assert.equal(f.snap().character.loadout.world.environment_crawl,false); // Eight idle days expire presence; the durable return survives reconnect.
  f.act('a','enter',{zone:'littlebig-clockwork',sewer_version:1,full_dungeon_version:1,quest_version:1,content_version:1,combat_version:3});
  f.place('a',f.map().portals.find(p=>p.target==='dungeon-littlebig-sewers'));f.act('a','dive_enter',{zone:'dungeon-littlebig-sewers'});
  assert.notEqual(f.snap().dive.edition,edition);assert.equal(f.map().mechanismRevision,0);
 }finally{f.close();}
});

test('queued pipe movement restores voluntary stance and rejected steps never wet clothing',()=>{
 const f=fixture();try{
  f.enter('a','littlebig-clockwork');const map=f.map(),branch=map.sewer.branches[0],low=branch.paths[1].filter(p=>map.sewer.low[p.y][p.x]==='1'),occupied=[...f.snap().dive.chests,...f.snap().dive.pickups,...f.snap().dive.enemies];
  const lane=[...new Set(low.map(p=>p.y))].map(y=>({y,x:Math.min(...low.filter(p=>p.y===y).map(p=>p.x))})).find(p=>!occupied.some(q=>q.y===p.y&&q.x>=p.x-1&&q.x<=p.x+1));assert.ok(lane);const {x,y}=lane;
  f.place('a',{x:x-1,y});let r=f.act('a','walk',{steps:['east','east'],loadout:f.snap().character.loadout});
  assert.equal(r.character.walkReceipt.walked,2);assert.equal(r.character.loadout.world.environment_crawl,true);assert.equal(r.character.loadout.world.crawling,false);
  const trail=JSON.parse(f.db.prepare('SELECT trail FROM quest_presence WHERE character_id=?').get(f.ids.a).trail).s;
  assert.equal(trail.at(-1)[2]-trail.at(-2)[2],475,'queue uses crawl pace plus sewer water');
  const before=structuredClone(r.character.loadout);assert.throws(()=>f.act('a','move',{direction:y===Math.max(...low.map(p=>p.y))?'south':'north'}),/blocked/);assert.deepEqual(f.snap().character.loadout,before);
  r=f.act('a','walk',{steps:['west','west'],loadout:before});assert.equal(r.character.loadout.world.environment_crawl,false);assert.equal(r.character.loadout.player_info.slot_wet_shoes,true);
  const voluntary=structuredClone(r.character.loadout);voluntary.world.crawling=true;
  f.act('a','walk',{steps:['east','east'],loadout:voluntary});r=f.act('a','walk',{steps:['west','west'],loadout:f.snap().character.loadout});
  assert.equal(r.character.loadout.world.environment_crawl,false);assert.equal(r.character.loadout.world.crawling,true);
 }finally{f.close();}
});
