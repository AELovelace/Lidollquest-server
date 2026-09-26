import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {paceStep} from '../server/crawl.mjs';
import {campaignDives} from '../server/hubs.mjs';
import {walkable} from '../server/dive-generation.mjs';

// Queued walking (action "walk"): a laggy client walks ahead locally and sends its steps in one batch,
// with the needs turns it already ran for them. The server commits the steps in order on a burst
// step clock (never faster than move_delay_ms on average), stops before anything that is not plain
// floor, and refuses an empty batch so its needs turns roll back.

const loadout=marker=>({player_info:{playerHealth:100,playerHealthMax:100,stat_points:0,walk_marker:marker},inventory:[]}); // walk_marker shows which needs-turn result was committed.

function harness(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-17T12:00:00Z'),c;
 const api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'a',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{}});
 const read=()=>{const s=api.read('',c.id);c=s.character;return s;};
 const act=(action,extra={},advance=350)=>{time+=advance;if(c)read();const s=api.act('',{action,request_id:randomUUID(),controller:'a',character_id:c?.id,revision:c?.revision,...(c?.dive?{edition:c.dive.edition}:{}),...extra});c=s.character;return s;};
 const place=(x,y)=>db.prepare('UPDATE quest_presence SET x=?,y=?,moved=0 WHERE character_id=?').run(x,y,c.id);
 const presence=()=>db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);
 return {db,api,read,act,place,presence,tick:ms=>{time+=ms;},get c(){return c;}};
}

const refused=(fn,pattern)=>assert.throws(fn,error=>pattern.test(error.message));

test('the burst step clock keeps the old one-step rule at burst 1 and never beats the average pace',()=>{
 assert.equal(paceStep(0,1000,150,1),1000,'an idle player steps at once');
 assert.equal(paceStep(900,1000,150,1),null,'burst 1 is exactly now - moved >= delay');
 assert.equal(paceStep(850,1000,150,1),1000);
 let clock=0,count=0;for(let i=0;i<20;i++){const next=paceStep(clock,1000,150,6);if(next===null)break;clock=next;count++;}
 assert.equal(count,6,'six queued steps may arrive together');
 assert.equal(clock,1000+5*150,'and they still occupy five further delay slots');
});

test('hub walks commit plain floor in order with their needs turns, and stop at the burst, walls and travel tiles',()=>{
 const h=harness();try{
  h.act('create',{name:'Walker'});
  let s=h.act('enter',{zone:'princess-rose',loadout:loadout('entry')});
  assert.equal(s.walkVersion,1);assert.equal(s.moveBurstSteps,6);
  const z=s.zones.find(v=>v.id===s.zone),solid=(x,y)=>z.walls[y]?.[x]!==0||(z.fixtures??[]).some(f=>f.solid!==false&&x>=f.x&&y>=f.y&&x<f.x+(f.span_w??1)&&y<f.y+(f.span_h??1))||(z.portals??[]).some(p=>p.x===x&&p.y===y);
  let start=null;for(let y=1;y<z.height-1&&!start;y++)for(let x=1;x+8<z.width-1&&!start;x++)if([...Array(9).keys()].every(i=>!solid(x+i,y)))start={x,y}; // Nine clear tiles east.
  assert.ok(start,'Rose Court has a clear strip to walk');h.place(start.x,start.y);

  const revision=h.c.revision;s=h.act('walk',{steps:['east','east','east'],loadout:loadout('three')},2000);
  assert.deepEqual(s.position,{x:start.x+3,y:start.y});
  assert.deepEqual(h.c.walkReceipt,{request:h.c.walkReceipt.request,walked:3,stop:''});
  assert.equal(h.c.loadout.player_info.walk_marker,'three','the batch commits its needs turns');
  assert.equal(h.c.revision,revision+1,'one command, one revision');
  assert.equal(h.presence().facing,2,'the avatar faces its last step');

  h.place(start.x,start.y);s=h.act('walk',{steps:Array(7).fill('east'),loadout:loadout('seven')},2000);
  assert.equal(h.c.walkReceipt.walked,6);assert.equal(h.c.walkReceipt.stop,'too_fast','the seventh queued step exceeds the burst');
  assert.deepEqual(s.position,{x:start.x+6,y:start.y});

  const early=h.act('walk',{steps:['east'],loadout:loadout('early')},0);
  assert.deepEqual(early.position,{x:start.x+6,y:start.y},'a batch that arrives early moves nobody');
  assert.equal(h.c.walkReceipt.walked,0);assert.equal(h.c.walkReceipt.stop,'too_fast');
  assert.equal(h.c.loadout.player_info.walk_marker,'early','but keeps its needs turns so the client can resend the step without re-rolling them');

  h.place(start.x,start.y);let wall=null;for(let y=0;y<z.height&&!wall;y++)for(let x=1;x<z.width&&!wall;x++)if(z.walls[y][x]!==0&&z.walls[y][x-1]===0&&!solid(x-1,y))wall={x:x-1,y};
  h.place(wall.x,wall.y);const before=h.c.revision;refused(()=>h.act('walk',{steps:['east'],loadout:loadout('wall')},2000),/blocked/);
  assert.equal(h.read().character.revision,before);assert.equal(h.c.loadout.player_info.walk_marker,'early','an empty batch into a wall rolls its needs turns back');

  refused(()=>h.act('walk',{steps:['up'],loadout:loadout('bad')}),/one to twelve walking steps/);
  refused(()=>h.act('walk',{steps:Array(13).fill('east'),loadout:loadout('bad')}),/one to twelve walking steps/);

  const gap=(z.portals??[]).find(p=>!solid(p.x-1,p.y)&&z.walls[p.y]?.[p.x-1]===0)??null; // A glowing pad or wall opening keeps the single-step path.
  if(gap){h.place(gap.x-1,gap.y);refused(()=>h.act('walk',{steps:['east'],loadout:loadout('pad')},2000),/on its own/);}
 }finally{h.db.close();}
});

test('a pending single-step needs turn must settle before walking',()=>{
 const h=harness();try{
  h.act('create',{name:'Walker'});const s=h.act('enter',{zone:'princess-rose',loadout:loadout('entry')});
  h.place(s.position.x,s.position.y);
  const z=s.zones.find(v=>v.id===s.zone),dir=[['east',1,0],['west',-1,0],['north',0,-1],['south',0,1]].find(([,dx,dy])=>z.walls[s.position.y+dy]?.[s.position.x+dx]===0);
  h.act('move',{direction:dir[0],world_step:true},2000);assert.ok(h.c.worldTurnDue);
  refused(()=>h.act('walk',{steps:[dir[0]],loadout:loadout('queued')},2000),/pending exploration turn/);
 }finally{h.db.close();}
});

test('dungeon walks reveal each tile, count room events, and stop before loot and exits',()=>{
 const h=harness();try{
  h.act('create',{name:'Diver'});
  h.act('enter',{zone:'princess-rose',loadout:loadout('entry')});
  const data=campaignDives[0],zone=data.config.zone_id;h.place(9,0);
  const hall=h.act('hub_visit',{zone:'princess-rose-dives'}),pad=hall.zones.find(v=>v.id===hall.zone).portals.find(p=>p.target===zone);
  h.place(pad.x,pad.y);h.act('dive_enter',{zone});
  const visit=h.c.dive,record=()=>JSON.parse(h.db.prepare('SELECT content FROM dive_editions WHERE route=? AND edition=?').get(visit.route,visit.edition).content);
  const f=record(),busy=new Set([...f.enemies,...f.chests,...(f.pickups??[]),...(f.exits??[]),f.entrance].map(p=>p.x+','+p.y));
  let start=null;for(let y=1;y<f.height-1&&!start;y++)for(let x=1;x+4<f.width-1&&!start;x++)if([...Array(4).keys()].every(i=>walkable(f,x+i,y)&&!busy.has((x+i)+','+y)))start={x,y};
  assert.ok(start);
  const s=JSON.parse(h.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(h.c.id).state);s.dive.position={...start};s.dive.safeUntil=0;
  h.db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),h.c.id);h.place(start.x,start.y);
  const out=h.act('walk',{steps:['east','east','east'],loadout:loadout('dive')},2000);
  assert.deepEqual(out.position,{x:start.x+3,y:start.y});assert.equal(h.c.walkReceipt.walked,3);
  assert.deepEqual(h.c.dive.position,{x:start.x+3,y:start.y},'reveal keeps the visit position in step');
  assert.equal(h.c.loadout.player_info.walk_marker,'dive');assert.equal(h.c.worldTurnDue,undefined,'walk turns are already committed');

  const floor=record();(floor.pickups??=[]).push({id:'walk-test-pickup',x:start.x+1,y:start.y,item:{item_id:'water_bottle'}});
  h.db.prepare('UPDATE dive_editions SET content=? WHERE route=? AND edition=?').run(JSON.stringify(floor),visit.route,visit.edition);
  const stopped=h.act('walk',{steps:['west','west','west'],loadout:loadout('loot')},2000);
  assert.equal(h.c.walkReceipt.walked,1);assert.equal(h.c.walkReceipt.stop,'special','loot waits for its own single step');
  assert.deepEqual(stopped.position,{x:start.x+2,y:start.y});
  refused(()=>h.act('walk',{steps:['west'],loadout:loadout('loot2')},2000),/on its own/);
 }finally{h.db.close();}
});
