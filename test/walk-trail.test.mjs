import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {extendTrail,trailView,TRAIL_STEPS,TRAIL_WINDOW} from '../server/crawl.mjs';

// Walking trails: queued walking moves a player several tiles per 500 ms poll, so other players
// only ever saw the end tile and slid (or, at corners, snapped) straight to it. Each presence row
// now keeps its recent paced steps, and snapshots share them so peers replay the real path.

const loadout=marker=>({player_info:{playerHealth:100,playerHealthMax:100,stat_points:0,walk_marker:marker},inventory:[]});

test('extendTrail continues from the standing tile and restarts after a teleport or room change',()=>{
 const p={zone:'a',x:1,y:1,moved:100,trail:''};
 let t=JSON.parse(extendTrail(p,[{x:2,y:1,t:300},{x:2,y:2,t:500}]));
 assert.deepEqual(t,{z:'a',s:[[1,1,100],[2,1,300],[2,2,500]]},'a fresh trail starts with the tile walked from');
 t=JSON.parse(extendTrail({...p,x:2,y:2,trail:JSON.stringify(t)},[{x:3,y:2,t:700}]));
 assert.equal(t.s.length,4,'continuing from the trail end appends');
 t=JSON.parse(extendTrail({...p,x:9,y:9,moved:800,trail:JSON.stringify(t)},[{x:10,y:9,t:900}]));
 assert.deepEqual(t.s,[[9,9,800],[10,9,900]],'a teleport since the last step restarts the trail');
 t=JSON.parse(extendTrail({...p,zone:'b',x:10,y:9,trail:JSON.stringify(t)},[{x:11,y:9,t:1000}]));
 assert.equal(t.z,'b');assert.equal(t.s.length,2,'another room restarts too');
 t=JSON.parse(extendTrail({...p,trail:'{broken'},Array.from({length:40},(_,i)=>({x:2+i,y:1,t:200+i}))));
 assert.equal(t.s.length,TRAIL_STEPS,'malformed history restarts and the trail stays bounded');
});

test('trailView shares only a current, recent trail as flat steps relative to the newest',()=>{
 const trail=JSON.stringify({z:'a',s:[[1,1,0],[2,1,5000],[3,1,9000],[3,2,9200]]});
 assert.deepEqual(trailView({x:3,y:2,trail},'a',10000),{trailAt:9200,trail:[2,1,4200,3,1,200,3,2,0]},'one older step anchors the first recent one');
 assert.equal(trailView({x:3,y:2,trail},'a',9200+TRAIL_WINDOW+1),null,'a resting player sends nothing');
 assert.equal(trailView({x:5,y:5,trail},'a',10000),null,'a teleport invalidates the trail');
 assert.equal(trailView({x:3,y:2,trail},'b',10000),null,'so does another room');
 assert.equal(trailView({x:3,y:2,trail:''},'a',10000),null);
});

test('a hub walk reaches other players as a timed trail of the real tiles, corners included',()=>{
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-08T12:00:00Z');const chars={};
 const api=createQuestZones(db,{now:()=>time,roll:()=>0,grant:secret=>({owner:secret,id:secret,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{}});
 const act=(who,action,extra={},advance=350)=>{time+=advance;const c=chars[who];if(c)chars[who]=api.read(who,c.id).character;const s=api.act(who,{action,request_id:randomUUID(),controller:who,character_id:chars[who]?.id,revision:chars[who]?.revision,...extra});chars[who]=s.character;return s;};
 act('alice','create',{name:'Walker'});act('bob','create',{name:'Watcher'});
 let s=act('alice','enter',{zone:'princess-rose',loadout:loadout('entry')});act('bob','enter',{zone:'princess-rose',loadout:loadout('entry')});
 const z=s.zones.find(v=>v.id===s.zone),solid=(x,y)=>z.walls[y]?.[x]!==0||(z.fixtures??[]).some(f=>f.solid!==false&&x>=f.x&&y>=f.y&&x<f.x+(f.span_w??1)&&y<f.y+(f.span_h??1))||(z.portals??[]).some(p=>p.x===x&&p.y===y);
 let start=null;for(let y=1;y<z.height-2&&!start;y++)for(let x=1;x+3<z.width-1&&!start;x++)if([0,1,2].every(i=>!solid(x+i,y))&&!solid(x+2,y+1))start={x,y}; // East, east, then a corner south.
 assert.ok(start,'Rose Court has an L to walk');
 db.prepare('UPDATE quest_presence SET x=?,y=?,moved=0 WHERE character_id=?').run(start.x,start.y,chars.alice.id);
 act('alice','walk',{steps:['east','east','south'],loadout:loadout('three')},2000);
 time+=100;const seen=api.read('bob',chars.bob.id).peers.find(p=>p.id===chars.alice.id);
 assert.deepEqual([seen.x,seen.y],[start.x+2,start.y+1]);
 const tiles=[];for(let i=0;i<seen.trail.length;i+=3)tiles.push([seen.trail[i],seen.trail[i+1]]);
 assert.deepEqual(tiles,[[start.x,start.y],[start.x+1,start.y],[start.x+2,start.y],[start.x+2,start.y+1]],'the watcher gets every tile, so the corner is walked instead of snapped');
 assert.ok(seen.trail[5]>seen.trail[8]&&seen.trail[8]>seen.trail[11]&&seen.trail[11]===0,'steps carry their paced spacing, newest last');
 time+=TRAIL_WINDOW+500;
 assert.equal(api.read('bob',chars.bob.id).peers.find(p=>p.id===chars.alice.id).trail,undefined,'a resting walker costs no trail bytes');
});
