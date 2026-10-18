import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorldLife,nightAmount,tileLight} from '../server/world-life.mjs';
import {activeRoutine,normalizeRoutine,createNpcRoutines,BRITTANY_ROUTINE} from '../server/npc-routines.mjs';
import {createQuestService} from '../server/service.mjs';
import {moveDelays} from '../server/crawl.mjs';

test('shared game clock preserves time across speed changes, pauses and reloads; real routines remain UTC',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-15T00:00:00Z');try{let life=createWorldLife(db,{now:()=>time});assert.equal(life.clock().minute,480);time+=60000;assert.equal(life.clock().minute,504);life.setClock({revision:0,dayMinutes:120,paused:false});time+=60000;assert.equal(life.clock().minute,516);life.setClock({revision:1,dayMinutes:120,paused:true});time+=3600000;life=createWorldLife(db,{now:()=>time});assert.equal(life.clock().minute,516);assert.throws(()=>life.setClock({revision:0,dayMinutes:60}),/changed/);assert.throws(()=>life.setClock({revision:2,dayMinutes:0}),/between/);
 const entries=[{id:'game',clock:'game',from:480,to:600,days:[0,1,2,3,4,5,6],priority:0},{id:'real',clock:'real',from:0,to:120,days:[4],priority:10}];assert.equal(activeRoutine(entries,life.clock().gameMs,time).id,'real');assert.equal(activeRoutine(entries,life.clock().gameMs,time+3*3600000).id,'game');assert.equal(nightAmount(360),.5);assert.equal(nightAmount(720),0);assert.equal(nightAmount(1320),1);
 const overnight=[{id:'overnight',clock:'real',from:1320,to:360,days:[6],priority:0}];assert.equal(activeRoutine(overnight,0,Date.parse('2026-10-18T01:00:00Z')).id,'overnight');assert.equal(activeRoutine(overnight,0,Date.parse('2026-10-19T01:00:00Z')),null);
 }finally{db.close();}
});

test('lamp circles use tiled distance, stop at walls, merge by strongest light and persist zone settings',()=>{
 const db=new DatabaseSync(':memory:'),life=createWorldLife(db),f={width:15,height:15,walls:Array.from({length:15},()=>Array(15).fill(0))},source={x:5,y:5,radius:4,strength:1};try{
 assert.equal(tileLight(f,source,5,5),1);assert.equal(tileLight(f,source,9,9),0);assert.ok(tileLight(f,source,9,5)>0);f.walls[5][7]=1;assert.equal(tileLight(f,source,8,5),0);assert.equal(tileLight(f,source,6,5),1);
 const before=structuredClone(f),p=life.profile('utopia-arcanum',f);assert.equal(p.sprite,'sprUtopiaEnvRuneLamp');life.save('utopia-arcanum',{revision:0,profile:{...p,auto:false,sources:[{id:'test',...source,color:[1,2,3],sprite:p.sprite}]}},f);assert.equal(life.lighting('utopia-arcanum',f).sources.length,1);assert.deepEqual(f,before);assert.equal(createWorldLife(db).profile('utopia-arcanum').revision,1);assert.throws(()=>life.save('utopia-arcanum',{revision:0,profile:p},f),/changed/);
 }finally{db.close();}
});

function travelFixture(){const db=new DatabaseSync(':memory:');let time=0,hold=false;const grid=()=>Array.from({length:9},(_,y)=>Array.from({length:9},(_,x)=>x===0||y===0||x===8||y===8?1:0));const maps={a:{id:'a',edition:'a1',floor:{width:9,height:9,walls:grid(),entrance:{x:1,y:4},fixtures:[],portals:[{key:'b',target:'b',x:7,y:4}]},players:[]},b:{id:'b',edition:'b1',floor:{width:9,height:9,walls:grid(),entrance:{x:1,y:4},fixtures:[],portals:[{key:'a',target:'a',x:1,y:4}]},players:[]}};const base={catalog:()=>[{id:'a'},{id:'b'}],map:id=>maps[id]},published=()=>({resident:{name:'Resident',sprite:'sprItem'}}),routine=createNpcRoutines(db,{now:()=>time,base,clock:()=>({gameMs:8*3600000}),published,held:()=>hold});const entry={id:'work',name:'Work',clock:'game',from:420,to:1020,days:[0,1,2,3,4,5,6],priority:0,blocks:[{kind:'travel',destination:{zone:'b',x:4,y:4}},{kind:'stay'}]};routine.save({revision:0,routine:{version:1,enabled:true,name:'Work',entries:[entry]}},{id:'resident1',content:'resident',kind:'npc',lifetime:'persistent',zone:'a',x:3,y:4});return {db,maps,routine,base,published,advance:ms=>{time+=ms;routine.tick();},hold:v=>hold=v};}

test('resident identity crosses zones exactly once, conversation holds and restart preserve its current position',()=>{
 const f=travelFixture();try{f.hold(true);f.advance(60000);assert.equal(f.routine.get('resident1').state.zone,'a');assert.equal(f.routine.get('resident1').state.status,'talking');f.hold(false);f.advance(60000);const r=f.routine.get('resident1');assert.equal(r.state.zone,'b');assert.deepEqual([r.state.x,r.state.y],[4,4]);assert.equal(f.routine.project('a',[{id:'resident1'}]).length,0);assert.equal(f.routine.project('b',[]).length,1);const reloaded=createNpcRoutines(f.db,{now:()=>120000,base:f.base,clock:()=>({gameMs:8*3600000}),published:f.published});assert.equal(reloaded.project('b',[])[0].id,'resident1');assert.equal(reloaded.project('a',[{id:'resident1'}]).length,0);
 }finally{f.db.close();}
});

test('watched journeys walk one tile per slot and blocked destinations never teleport through walls',()=>{
 const f=travelFixture();try{f.maps.a.players=[{online:true}];f.advance(60000);const s=f.routine.get('resident1').state;assert.equal(s.zone,'a');assert.equal(Math.abs(s.x-3)+Math.abs(s.y-4),1);for(let y=1;y<8;y++)f.maps.a.floor.walls[y][5]=1;for(let n=0;n<15;n++)f.advance(2000);assert.equal(f.routine.get('resident1').state.zone,'a');assert.equal(f.routine.get('resident1').state.status,'path blocked');assert.throws(()=>normalizeRoutine({version:1,entries:[{...BRITTANY_ROUTINE.entries[0],clock:'invalid'}]},[{id:'utopia-arcanum'}]),/Choose Game/);
 }finally{f.db.close();}
});

test('routine movement follows live player walking speed without early steps or visible catch-up bursts',()=>{
 const f=travelFixture();let delay=moveDelays().walk;f.base.walkDelay=()=>delay;
 try{f.maps.a.players=[{online:true}];const x=()=>f.routine.get('resident1').state.x;
  assert.equal(delay,187.5);f.advance(delay-1);assert.equal(x(),3);f.advance(1);assert.equal(x(),4);
  f.advance(delay);assert.equal(x(),5);delay=moveDelays({move_delay_ms:400}).walk;
  f.advance(delay-1);assert.equal(x(),5);f.advance(1);assert.equal(x(),6,'live tuning changes affect an existing routine without resaving');
  f.advance(60000);assert.equal(x(),7,'a watched NPC takes one tile after a long stall');f.advance(0);assert.equal(f.routine.get('resident1').state.zone,'a','extra ticks cannot spend old movement debt');
  const view=f.routine.project('a',[])[0];assert.ok(view.trail.length<=48);assert.equal(view.trail.at(-3),7);assert.equal(view.trail.at(-2),4);
 }finally{f.db.close();}
});

test('50 ms coordinator ticks preserve fractional walking intervals and timestamp every tile',()=>{
 const f=travelFixture();try{const floor=f.maps.a.floor;floor.width=80;floor.walls=Array.from({length:9},(_,y)=>Array.from({length:80},(_,x)=>x===0||x===79||y===0||y===8?1:0));floor.portals[0].x=77;f.maps.a.players=[{online:true}];
  for(let i=0;i<80;i++)f.advance(50);
  const state=f.routine.get('resident1').state;assert.equal(state.x,3+Math.floor(4000/moveDelays().walk),'elapsed remainders prevent rounding each step up to 200 ms');
  const points=JSON.parse(state.trail).s;assert.equal(points.length,16);for(let i=1;i<points.length;i++){assert.equal(points[i][0]-points[i-1][0],1);assert.equal(points[i][2]-points[i-1][2],moveDelays().walk);}
 }finally{f.db.close();}
});

test('the service moves routine NPCs before its one-second world timer',async()=>{
 let time=10000;const s=createQuestService({now:()=>time,log:()=>{}});
 try{const id='utopia-tower-brittany',world=s.zones.world;world.act({action:'world_routine_save',zone:'utopia-arcanum-tower',placement:id,revision:0,routine:BRITTANY_ROUTINE});const before=world.routines.get(id).state;time+=200;
  await new Promise(resolve=>setTimeout(resolve,130)); // Real timer integration: only the new movement ticker should have fired.
  const after=world.routines.get(id).state;assert.equal(Math.abs(after.x-before.x)+Math.abs(after.y-before.y),1);assert.ok(world.routines.project(after.zone,[])[0].trail);
 }finally{s.server.emit('close');}
});

test('ambient chatter has a bounded departure grace while direct dialogue remains a hold',()=>{
 const f=travelFixture();try{f.hold('ambient');f.advance(2000);assert.equal(f.routine.get('resident1').state.status,'talking');f.advance(28000);assert.equal(f.routine.get('resident1').state.status,'talking');f.advance(4000);assert.notEqual(f.routine.get('resident1').state.status,'talking');assert.notEqual(f.routine.get('resident1').state.x,3);const before=f.routine.get('resident1').state;f.hold('direct');f.advance(60000);const after=f.routine.get('resident1').state;assert.deepEqual([after.zone,after.x,after.y],[before.zone,before.x,before.y]);assert.equal(after.status,'talking');}finally{f.db.close();}
});

test('automatic lamp sources remain separate from portable custom sources and no-floor zones are safe',()=>{
 const db=new DatabaseSync(':memory:'),life=createWorldLife(db),f={width:20,height:20,walls:Array.from({length:20},()=>Array(20).fill(0))};try{const lights=life.lighting('utopia-arcanum',f);assert.ok(lights.sources.length>0);assert.deepEqual(lights.customSources,[]);assert.equal(life.lighting('not-ready',null),null);const key=lights.key;f.walls[4][4]=1;assert.notEqual(life.lighting('utopia-arcanum',f).key,key);assert.deepEqual(life.profile('utopia-arcanum').sources,[]);}finally{db.close();}
});

test('Brittany example makes a real Utopia round trip, survives restart, and restores home on disable',()=>{
 const dir=mkdtempSync(join(tmpdir(),'routine-example-')),filename=join(dir,'world.sqlite');let time=Date.parse('2026-10-15T12:00:00Z'),s=createQuestService({filename,now:()=>time,log:()=>{}});const id='utopia-tower-brittany';
 try{const world=s.zones.world;world.act({action:'world_routine_save',zone:'utopia-arcanum-tower',placement:id,revision:0,routine:BRITTANY_ROUTINE});const c=world.life.clock();world.act({action:'world_clock_set',revision:c.revision,dayMinutes:60,minute:1080,paused:true});
 for(let n=0;n<20;n++){time+=60000;world.routines.tick();if(world.routines.get(id).state.status==='staying')break;}
 let r=world.routines.get(id);assert.equal(r.state.zone,'utopia-arcanum-dives',JSON.stringify(r.state));assert.equal(world.map('utopia-arcanum-tower').placements.filter(p=>p.id===id).length,0);assert.equal(world.map(r.state.zone).placements.filter(p=>p.id===id).length,1);
 s.server.emit('close');s=createQuestService({filename,now:()=>time,log:()=>{}});assert.equal(s.zones.world.map('utopia-arcanum-dives').placements.filter(p=>p.id===id).length,1);const cc=s.zones.world.life.clock();s.zones.world.act({action:'world_clock_set',revision:cc.revision,dayMinutes:60,minute:600,paused:true});for(let n=0;n<20;n++){time+=60000;s.zones.world.routines.tick();if(s.zones.world.routines.get(id).state.status==='staying')break;}r=s.zones.world.routines.get(id);assert.equal(r.state.zone,'utopia-arcanum-tower');
 s.zones.world.act({action:'world_routine_save',zone:r.state.zone,placement:id,revision:r.revision,routine:{...BRITTANY_ROUTINE,enabled:false}});assert.equal(s.zones.world.map('utopia-arcanum-tower').placements.filter(p=>p.id===id).length,1);
 }finally{s.server.emit('close');rmSync(dir,{recursive:true,force:true});}
});

test('routine workshop uses authenticated APIs, hardened shell and audited idempotent writes',async()=>{
 const token='r'.repeat(43),s=createQuestService({log:()=>{},walletClient:{authenticate:async t=>({owner:'staff',gamemaster:t===token,client:'lidollquest'})}});await new Promise(r=>s.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.server.address().port;
 try{const page=await fetch(base+'/gm/routine-editor');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/default-src 'none'/);const html=await page.text();assert.match(html,/Routine blocks/);for(const [,script]of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Function(script);assert.notEqual((await fetch(base+'/gm/world-life')).status,200);const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'},data=await(await fetch(base+'/gm/world-life',{headers})).json();assert.equal(data.example.entries.length,4);const body=JSON.stringify({action:'world_clock_set',request_id:'clock-regression-1',revision:data.clock.revision,dayMinutes:90,paused:true});for(let i=0;i<2;i++)assert.equal((await fetch(base+'/gm/action',{method:'POST',headers,body})).status,200);assert.equal(s.zones.world.life.clock().revision,1);
 }finally{s.server.closeAllConnections();await new Promise(r=>s.server.close(r));}
});
