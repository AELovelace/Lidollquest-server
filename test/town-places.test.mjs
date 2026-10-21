import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createTownPlaces,PLACE_LIMITS} from '../server/town-places.mjs';
import {hubCatalog,hubRooms} from '../server/hubs.mjs';
import {decoratePlaceZone,validatePlaceZone} from '../server/town-place-layout.mjs';
import {createFloorPatches} from '../server/floor-patches.mjs';
import {validateCourtyard} from '../server/hub-garden.mjs';

const entry=(name='Bakery')=>({name,home:'utopia-arcanum',rooms:[{id:'shop',name:'Bakery shop',width:12,height:10}]});
const roomId='utopia-arcanum-place-bakery-shop';
function setup(){const db=new DatabaseSync(':memory:'),places=createTownPlaces(db,{hubs:hubCatalog,shippedRooms:hubRooms,now:()=>123});return {db,places};}
const save=(places,body=entry(),revision=0,id='bakery')=>places.act({action:'world_place_save',id,revision,entry:body},'test');
const publish=(places,revision=1,id='bakery')=>places.act({action:'world_place_publish',id,revision},'test');

test('place drafts round-trip, publish separately, and preserve shipped definitions',()=>{
 const {db,places}=setup();
 try{
  const before=places.all().map(r=>r.id),draft=save(places);
  assert.equal(places.get(roomId),undefined);assert.deepEqual(places.all().map(r=>r.id),before);
  assert.equal(draft.published,null);assert.equal(draft.draft.rooms[0].id,'shop');
  const again=save(places,draft.draft,1);assert.deepEqual(again.draft,draft.draft);
  const result=publish(places,2),room=places.get(roomId);
  assert.equal(result.revision,3);assert.equal(room.parent,'utopia-arcanum');assert.equal(room.kind,'interior');
  assert.equal(room.width,12);assert.equal(room.tilesets.floor,'tileLBCInterior');assert.equal(room.walls[room.spawn.y][room.spawn.x],0);
  assert.deepEqual(places.all().slice(0,before.length).map(r=>r.id),before);
  assert.throws(()=>{room.walls[2][2]=1;},TypeError);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM world_place_history').get().n,3);
 }finally{db.close();}
});

test('publication and catalog caching roll back with the outer transaction',()=>{
 const {db,places}=setup();
 try{
  save(places);const original=places.version();
  db.exec('BEGIN');publish(places);assert.ok(places.get(roomId));const abandoned=places.version();db.exec('ROLLBACK');
  assert.equal(places.version(),original);assert.equal(places.get(roomId),undefined);
  assert.equal(places.view('bakery').revision,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM world_place_history').get().n,1);
  publish(places);assert.notEqual(places.version(),abandoned);assert.ok(places.get(roomId));
 }finally{db.close();}
});

test('stale edits, unsafe geometry, injected fields and oversized rooms are refused without writes',()=>{
 const {db,places}=setup();
 try{
  save(places);const initial=places.view('bakery');
  assert.throws(()=>save(places,entry(),0),/changed/);
  for(const modify of [
   b=>{b.home='unknown';},b=>{b.rooms[0].width=49;},b=>{b.rooms[0].width=6.5;},
   b=>{b.rooms[0].fixtures=[{kind:'shop'}];},b=>{b.rooms[0].spawn={x:0,y:3};},
   b=>{b.rooms[0].exit={side:'left',offset:9};},b=>{b.rooms.push({...b.rooms[0]});},
   b=>{b.rooms[0].floors=[[1]];},b=>{b.rooms[0].id='../escape';}
  ]){const body=entry();modify(body);assert.throws(()=>save(places,body,1));assert.deepEqual(places.view('bakery'),initial);}
  const body=structuredClone(initial.draft);body.rooms[0].walls[0][2]=0;assert.throws(()=>save(places,body,1),/outer wall/);
  body.rooms[0].walls[0][2]=1;body.rooms[0].walls[body.rooms[0].spawn.y][body.rooms[0].spawn.x]=1;
  assert.throws(()=>save(places,body,1),/spawn is blocked/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM world_place_history').get().n,1);
 }finally{db.close();}
});

test('published rooms keep stable IDs and dimensions',()=>{
 const {db,places}=setup();
 try{
  save(places);publish(places);const before=places.get(roomId);
  const body=places.view('bakery').draft;body.rooms[0].id='replacement';save(places,body,2);
  assert.throws(()=>publish(places,3),/IDs and dimensions/);assert.deepEqual(places.get(roomId),before);
  const original=entry('New bakery name');save(places,original,3);publish(places,4);
  assert.equal(places.view('bakery').published.name,'New bakery name');
 }finally{db.close();}
});

test('published room and place quotas are enforced and identifiers cannot collide across places',()=>{
 const {db,places}=setup();
 try{
  save(places,{...entry(),rooms:[{id:'b-shop',name:'First'}]},0,'a');publish(places,1,'a');
  save(places,{...entry(),rooms:[{id:'shop',name:'Collision'}]},0,'a-b');
  assert.throws(()=>publish(places,1,'a-b'),/already belongs/);
  for(let i=0;i<8;i++){
   const id='place-'+i,rooms=Array.from({length:8},(_,n)=>({id:'room-'+n,name:'Room '+n,width:6,height:6}));
   save(places,{...entry(),rooms},0,id);
   if(i===7)assert.throws(()=>publish(places,1,id),/64 published/);else publish(places,1,id);
  }
  for(let i=10;i<PLACE_LIMITS.places;i++)save(places,entry(),0,'place-'+i);
  assert.throws(()=>save(places,entry(),0,'extra'),/32 custom places/);
 }finally{db.close();}
});

test('draft painting compacts hundreds of strokes while retaining furniture identity',()=>{
 const {db,places}=setup();
 try{
  save(places);let revision=1;
  const paint=ops=>places.act({action:'world_place_patch',id:'bakery',room:'shop',revision:revision++,ops},'test');
  paint([{id:'counter',kind:'fixture',op:'add',furniture:'kitchen',to:{x:7,y:3}}]);
  for(let i=0;i<270;i++)paint([{kind:'cells',cells:[{x:4,y:4,floor:i%2?7:9}]}]);
  const draft=places.view('bakery').draft;
  assert.ok(draft.rooms[0].ops.length<5,'applied brush strokes do not consume an ever-growing patch log');
  publish(places,revision);
  assert.equal(places.get(roomId).floors[4][4],7);
  assert.equal(places.get(roomId).fixtures[0].id,'patch-counter');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM world_place_history').get().n,273,'compaction retains revision history');
 }finally{db.close();}
});

test('POIs and walk-in parcels keep authored terrain and reject overlapping reservations',()=>{
 const {db,places}=setup();
 try{
  const floor={id:'utopia-arcanum',name:'Utopia',width:30,height:30,spawn:{x:1,y:1},exit:{x:1,y:1},fixtures:[],walls:Array.from({length:30},(_,y)=>Array.from({length:30},(_,x)=>x===0||y===0||x===29||y===29?1:0)),floors:Array.from({length:30},()=>Array(30).fill(6))};
  const poi=places.normalize('garden',{name:'Garden',home:floor.id,type:'poi',rooms:[],exterior:{x:4,y:4,w:4,h:4,cells:[{x:1,y:1,floor:9}]}});
  const shop=places.normalize('smithy',{name:'Smithy',home:floor.id,type:'walkin',rooms:[],exterior:{x:15,y:10,w:6,h:6}});
  const decorated=decoratePlaceZone(floor,[poi,shop]);validatePlaceZone(decorated);
  assert.equal(decorated.floors[5][5],9);assert.equal(decorated.walls[10][15],1);assert.equal(decorated.walls[15][18],0);
  assert.equal(floor.walls[10][15],0,'preview does not mutate the generated town');
  assert.throws(()=>decoratePlaceZone(floor,[poi,{...poi,id:'overlap'}]),/overlap/);
  assert.throws(()=>decoratePlaceZone({...floor,fixtures:[{id:'arcanum-tower',kind:'scenery',sprite:'sprUtopiaTower',x:4,y:4,span_w:3,span_h:3}]},[poi]),/protected/);
 }finally{db.close();}
});

test('place validation accepts GM scenery on walls without weakening bounds or access checks',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const patches=createFloorPatches(db),floor={id:'utopia-arcanum',name:'Utopia',width:14,height:14,spawn:{x:1,y:1},exit:{x:1,y:1},fixtures:[],walls:Array.from({length:14},(_,y)=>Array.from({length:14},(_,x)=>x===0||y===0||x===13||y===13?1:0))};
  floor.walls[5][5]=1;
  patches.act({action:'world_patch_apply',patch_revision:0,ops:[{id:'532fa432-375b-4e83-8c67-d9506c0e4cbd',kind:'decoration',decoration:{sprite:'sprUtopiaTower',x:5,y:5,span_w:2,span_h:2,solid:true}}]},{zone:floor.id,floor,kind:'hub',actor:'test',commit:()=>{}}); // The existing editor legitimately accepts this wall/scenery arrangement.
  const before=structuredClone(floor);
  assert.doesNotThrow(()=>validatePlaceZone(floor));
  assert.deepEqual(floor,before,'validation preserves saved scenery and collision');
  assert.throws(()=>validateCourtyard(floor,[]),/overlaps a wall/,'shipped courtyard validation remains strict');
  const fixture=floor.fixtures[0];
  assert.throws(()=>validatePlaceZone({...floor,fixtures:[{...fixture,x:12}]}),/boundary/);
  assert.throws(()=>validatePlaceZone({...floor,fixtures:[{...fixture,kind:'toilet'}]}),/overlaps a wall/,'services must remain on open terrain');
  assert.throws(()=>validatePlaceZone({...floor,fixtures:[{...fixture,id:'generated-prop'}]}),/overlaps a wall/);
  assert.throws(()=>validatePlaceZone(floor,[{x:5,y:5,name:'Test door'}]),/opening.*not reachable/);
  const split=structuredClone(floor);for(let y=1;y<13;y++)split.walls[y][7]=1;split.walls[6][7]=0;
  split.fixtures=[{...fixture,x:7,y:6,span_w:1}];
  assert.throws(()=>validatePlaceZone(split),/unreachable/,'wall-mounted scenery still contributes its full solid footprint');
  assert.doesNotThrow(()=>validatePlaceZone({...floor,fixtures:[{...fixture,solid:false}]}),'non-solid wall artwork follows the same placement rule');
 }finally{db.close();}
});

test('interior wall artwork survives draft painting, compaction and publication',()=>{
 const {db,places}=setup();
 try{
  save(places);
  places.act({action:'world_place_patch',id:'bakery',room:'shop',revision:1,ops:[{kind:'cells',cells:[{x:5,y:5,wall:1}]},{id:'wall-art',kind:'decoration',decoration:{sprite:'sprUtopiaTower',x:5,y:5,solid:false}}]},'test');
  publish(places,2);assert.equal(places.get(roomId).walls[5][5],1);assert.equal(places.get(roomId).fixtures[0].id,'patch-wall-art');
 }finally{db.close();}
});

test('portable connections cannot target other places and supported maximum room geometry stays bounded',()=>{
 const {db,places}=setup();
 try{
  assert.throws(()=>save(places,{...entry(),rooms:[{...entry().rooms[0],ops:{bad:true}}]}),/operations must be a list/);
  assert.throws(()=>save(places,{...entry(),connections:[{id:'escape',a:{zone:'shop',x:2,y:2,arrival:{x:2,y:3}},b:{zone:'foreign-room',x:2,y:2,arrival:{x:2,y:3}}}]}),/unknown room/);
  const rooms=Array.from({length:8},(_,n)=>({id:'room-'+n,name:'Large room '+n,width:48,height:48}));
  const body={...entry(),rooms};save(places,body);publish(places);
  assert.equal(places.custom().length,8);assert.ok(Buffer.byteLength(JSON.stringify(places.view('bakery').published))<PLACE_LIMITS.bodyBytes);
 }finally{db.close();}
});
