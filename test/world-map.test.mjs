import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createQuestService} from '../server/service.mjs';
import {layoutWorld,createWorldPainter,drawText,spriteNames,WORLD_SCALES} from '../server/world-map.mjs';
import {createCanvas,decodePng} from '../server/png-codec.mjs';

const gap=(to,side,x,y)=>({to,side,style:'gap',x,y,w:side==='left'||side==='right'?1:2,h:side==='left'||side==='right'?2:1});
const door=(to,x,y)=>({to,style:'door',x,y,w:1,h:1,side:''});
const overlap=(a,b,g)=>a.x<b.x+b.width+g&&b.x<a.x+a.width+g&&a.y<b.y+b.height+g&&b.y<a.y+a.height+g;

test('borders sit on their side with the gaps lined up; doors tuck their rooms in nearby; nothing overlaps',()=>{
 const zones=[
  {id:'town',name:'Town',width:20,height:20,exits:[gap('east','right',19,9),gap('north','top',9,0),door('inn',5,5)]},
  {id:'east',name:'East',width:30,height:10,exits:[gap('town','left',0,2)]}, // The town's gap is at y 9-10, the field's at y 2-3: the field hangs 7 tiles lower.
  {id:'north',name:'North',width:20,height:20,exits:[gap('town','bottom',3,19)]},
  {id:'inn',name:'Inn',width:8,height:6,exits:[gap('town','left',0,2)]}, // A room's own wall gap back out must not make it a border neighbour.
  {id:'island',name:'Island',width:5,height:5,exits:[door('town',1,1)]}, // Nothing leads here, so it is not on the map.
 ];
 const layout=layoutWorld({root:'town',zones,gutter:4}),at=Object.fromEntries(layout.zones.map(z=>[z.id,z]));
 assert.deepEqual(Object.keys(at).sort(),['east','inn','north','town']);
 assert.equal(at.east.x,at.town.x+20+4,'east of the town, one gutter away');assert.equal(at.east.y,at.town.y+7,'gap centres line up');
 assert.equal(at.north.y,at.town.y-4-20);assert.equal(at.north.x,at.town.x+6,'north gap x 3-4 under the town gap x 9-10');
 for(const a of layout.zones)for(const b of layout.zones)if(a!==b)assert.ok(!overlap(a,b,4),a.id+' and '+b.id+' keep a gutter');
 assert.ok(Math.hypot(at.inn.x-at.town.x,at.inn.y-at.town.y)<40,'the inn sits beside its door');
 for(const z of layout.zones){assert.ok(z.x>=4&&z.y>=4);assert.ok(z.x+z.width<=layout.width-4&&z.y+z.height<=layout.height-4);}
 const inn=layout.links.find(l=>l.to==='inn'||l.from==='inn');assert.equal(inn.style,'door');assert.equal(inn.ax,at.town.x+5.5);assert.equal(inn.ay,at.town.y+5.5);
 assert.equal(layout.links.filter(l=>[l.from,l.to].sort().join()==='east,town').length,1,'one line per connected pair');
 assert.throws(()=>layoutWorld({root:'nowhere',zones}),{code:'world_map_not_ready'});
});

test('labels print capitals, digits and the punctuation zone names use; sprite lookups cover fixtures and avatars',()=>{
 const canvas=drawText(createCanvas(6*4,7),"I'1?",0,0,1,[255,255,255,255]),lit=(x,y)=>canvas.data[(y*canvas.width+x)*4+3]>0;
 assert.ok(lit(1,0)&&lit(2,0)&&lit(3,0)&&lit(2,3),'I');assert.ok(lit(8,0)&&!lit(6,0),'apostrophe');assert.ok(lit(14,0)&&lit(13,1),'1');
 const names=spriteNames({floor:{fixtures:[{kind:'npc',avatar:'av1'},{kind:'scenery',sprite:'sprBench'}],enemies:[{definition:{sprite:'managed-imp'}}]},placements:[{kind:'token',sprite:'sprKey'}]},new Map([['av1','sprResident']]));
 assert.deepEqual([...names].sort(),['managed-imp','sprBench','sprKey','sprResident']);
});

test('the painter runs one worker at a time and reuses a fresh picture for an unchanged world',async()=>{
 let time=0,spawned=0;const workers=[];
 const spawn=input=>{spawned++;const w=new EventEmitter();w.terminate=async()=>{};workers.push({w,input});return w;};
 const painter=createWorldPainter({spawn,now:()=>time,ttl:1000});
 const first=painter.render({n:1},'a'),second=painter.render({n:2},'b');
 await new Promise(setImmediate);assert.equal(spawned,1,'the second waits for the first');
 workers[0].w.emit('message',{png:new Uint8Array([1,2,3])});assert.deepEqual([...await first],[1,2,3]);
 await new Promise(setImmediate);assert.equal(spawned,2);workers[1].w.emit('message',{error:'too big',status:413,code:'world_map_too_large'});
 await assert.rejects(second,{status:413,code:'world_map_too_large'});
 assert.deepEqual([...await painter.render({n:3},'a')],[1,2,3],'a failed paint keeps the last good picture');
 assert.equal(spawned,2,'a fresh unchanged world is not repainted');
 time=5000;const later=painter.render({n:4},'a');await new Promise(setImmediate);assert.equal(spawned,3,'stale pictures are repainted');
 workers[2].w.emit('exit',1);await assert.rejects(later,{code:'world_map_failed'});
});

test('GET /gm/world.png is staff-only and paints the whole reachable world',async()=>{
 const staff='s'.repeat(43),player='p'.repeat(43),service=createQuestService({log:()=>{},walletClient:{authenticate:async token=>({owner:token===staff?'staff':'player',gamemaster:token===staff,client:'lidollquest',coins:0,scope:'social:read'})}});
 await service.prepare();await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
 const get=(path,token)=>fetch(base+path,{headers:token?{Authorization:'Bearer '+token}:{}});
 try{
  assert.equal((await get('/gm/world.png')).status,401);assert.equal((await get('/gm/world.png',player)).status,403);
  assert.equal((await get('/gm/world.png?scale=32',staff)).status,400);assert.deepEqual([...WORLD_SCALES],[4,8]);
  const response=await get('/gm/world.png?scale=4',staff);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'no-store');
  const bytes=Buffer.from(await response.arrayBuffer()),image=decodePng(bytes);assert.equal(Number(response.headers.get('content-length')),bytes.length);
  assert.ok(image.width>=4*(100+50+100)&&image.height>=4*(80+50+80),'Tundra, Honeydew and the Desert side by side; the Woods and the Plains above and below');
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});
