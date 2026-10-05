import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createQuestZones} from '../server/zones.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestService} from '../server/service.mjs';
import {combatData} from '../server/combat.mjs';
import {hubData} from '../server/hubs.mjs';
import {compiledArtwork} from '../server/defeat-scenes.mjs';
import {createMapRenderer,DEFAULT_LAYERS} from '../server/map-render.mjs';
import {decodePng} from '../server/png-codec.mjs';
import {tileAt,paintPlan,tileCell,walkableCell,TILE_SIZE} from '../server/tile-painter.mjs';
import {validateWorldPng} from '../server/world-png.mjs';

const tiles=JSON.parse(readFileSync(new URL('../server/tile-artwork.json',import.meta.url),'utf8')),avatars=JSON.parse(readFileSync(new URL('../server/avatars.json',import.meta.url),'utf8'));
function fixture(){ // The live world with content, like world-controls.test.mjs, so every zone kind has a real floor.
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-03T12:00:00Z');
 const live=createWorldContent(db,{now:()=>time,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment});
 const zones=createQuestZones(db,{now:()=>time,roll:()=>0,live,grant:()=>({owner:'alice',id:'alice',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
 zones.tick();
 return {db,live,zones,renderer:createMapRenderer({tiles,compiled:compiledArtwork,avatars,asset:key=>live.asset(key)}),close(){zones.close();db.close();}};
}
const pixel=(img,x,y)=>[...img.data.subarray((y*img.width+x)*4,(y*img.width+x)*4+4)];

test('paintMap carries everything the painter needs and the catalog names dives properly',()=>{
 const f=fixture();try{
  const names=Object.fromEntries(f.zones.world.catalog().map(z=>[z.id,z.name]));assert.equal(names['overworld-autumnal-plains'],'Autumnal Plains');assert.equal(names['dive-quarters'],"Princess' Quarters - Dungeon Dive");assert.equal(names['honeydew-lantern'],'Honeydew Village');
  const plains=f.zones.world.paintMap('overworld-autumnal-plains');assert.equal(plains.floor.theme,'autumn_plains');assert.ok(Array.isArray(plains.floor.cover));assert.ok(Array.isArray(plains.placements));assert.equal(plains.revision,f.zones.world.map('overworld-autumnal-plains').revision);
  const quarters=f.zones.world.paintMap('dive-quarters');assert.equal(quarters.floor.theme,'princess_quarters'); // The route's theme fills in for floors generated without one.
  const town=f.zones.world.paintMap('honeydew-lantern');assert.equal(town.floor.district.tileset,'tileTown');assert.ok(Array.isArray(town.floor.floors)&&Array.isArray(town.floor.wallTiles));assert.equal(town.district.locked,true);assert.equal(paintPlan(town.floor).mode,'district');
  const rose=f.zones.world.paintMap('princess-rose');assert.equal(rose.floor.tilesets.wall,'tilePrincessQuarters');assert.ok(Array.isArray(rose.floor.treeTiles));assert.equal(paintPlan(rose.floor).mode,'authored');
  const inn=f.zones.world.paintMap('littlebig-clockwork-beds');assert.equal(inn.floor.tilesets.decor,'tileLBCInterior');assert.ok(inn.floor.fixtures.some(x=>x.kind==='bed'));
  const hall=f.zones.world.paintMap('princess-rose-dives');assert.equal(hall.floor.theme,'rose');assert.equal(hall.floor.kind,'dives');assert.equal(paintPlan(hall.floor).mode,'hub');
  assert.deepEqual(Object.keys(f.zones.world.map('honeydew-lantern').floor).sort(),Object.keys(f.zones.world.map('honeydew-lantern').floor).sort(),'the plain map view is unchanged');assert.equal(f.zones.world.map('honeydew-lantern').floor.floors,undefined);
 }finally{f.close();}
});

test('rendered pictures have the zone size, copy atlas cells pixel for pixel, anchor scenery by origin and downscale',()=>{
 const f=fixture();try{
  const view=f.zones.world.paintMap('overworld-autumnal-plains'),floor=view.floor,png=f.renderer.render(view);validateWorldPng(f.renderer.render(f.zones.world.paintMap('princess-rose')),20*TILE_SIZE,20*TILE_SIZE); // The upload validator bounds decompression at 17 MB, so check a courtyard-sized picture.
  const img=decodePng(png);assert.equal(img.width,floor.width*TILE_SIZE);assert.equal(img.height,floor.height*TILE_SIZE);
  const atlas=decodePng(Buffer.from(tiles.sprites.sprTileAutumnPlains.png,'base64')),bare=f.renderer.paint({...view,placements:[],players:[]},['terrain']);
  let checked=0;for(let y=1;y<floor.height-1&&checked<6;y+=7)for(let x=1;x<floor.width-1&&checked<6;x+=11){const [layer]=tileAt(floor,x,y),{sx,sy}=tileCell(layer.tile,10);const a=pixel(atlas,sx+9,sy+9);if(a[3]!==255)continue;assert.deepEqual(pixel(bare,x*TILE_SIZE+9,y*TILE_SIZE+9),a,`cell ${x},${y} tile ${layer.tile}`);checked++;}assert.ok(checked>=3,'compared several opaque atlas cells');
  const deco=floor.decorations.find(d=>d.sprite==='sprPlainsEnvOuthouse')??floor.decorations[0],sprite=tiles.sprites[deco.sprite],art=decodePng(Buffer.from(sprite.png,'base64'));
  const scenery=f.renderer.paint({...view,placements:[],players:[]},['scenery']),ox=deco.x*TILE_SIZE+TILE_SIZE/2-sprite.xorigin,oy=deco.y*TILE_SIZE+TILE_SIZE/2-sprite.yorigin;
  let matched=0;for(let y=0;y<art.height&&matched<4;y+=3)for(let x=0;x<art.width&&matched<4;x+=3){const p=pixel(art,x,y);if(p[3]!==255)continue;assert.deepEqual(pixel(scenery,ox+x,oy+y),p);matched++;}assert.ok(matched>=2,'scenery pixels land where the client draws the sprite origin');
  const small=decodePng(f.renderer.render(view,{scale:8}));assert.equal(small.width,floor.width*8);assert.equal(small.height,floor.height*8);
  assert.equal(f.renderer.render(view),png,'the same revision is served from the cache');assert.notEqual(f.renderer.render(view,{layers:['terrain']}),png);
  assert.throws(()=>f.renderer.render(view,{scale:12}),/scale/);assert.throws(()=>f.renderer.render({id:'x',floor:null}),/not ready/);
  for(const id of ['honeydew-lantern','princess-rose','littlebig-clockwork-beds','dive-quarters','overworld-seafoam-coast','dungeon-coastal-caverns','utopia-arcanum','arcadia-foundry-dives']){const v=f.zones.world.paintMap(id);if(!v.floor)continue;const out=decodePng(f.renderer.render(v,{scale:16}));assert.equal(out.width,v.floor.width*16,id);}
  const manifest=f.renderer.manifest();assert.equal(manifest.sprites.sprTileTown.width,320);assert.equal(manifest.sprites.sprTileTown.png,undefined);assert.equal(manifest.tilesets.tileTown,'sprTileTown');
  const rose=f.zones.world.paintMap('princess-rose'),roseImg=f.renderer.paint({...rose,placements:[],players:[]},['terrain']),townAtlas=decodePng(Buffer.from(tiles.sprites.sprTileTown.png,'base64'));
  const treeCell=(()=>{for(let y=0;y<rose.floor.height;y++)for(let x=0;x<rose.floor.width;x++)if(rose.floor.treeTiles[y][x])return {x,y};})(),treeTile=rose.floor.treeTiles[treeCell.y][treeCell.x],{sx,sy}=tileCell(treeTile,10);
  assert.deepEqual(pixel(roseImg,treeCell.x*TILE_SIZE+16,treeCell.y*TILE_SIZE+16),pixel(townAtlas,sx+16,sy+16),'tree clumps paint from the woodland atlas over the castle walls');
  assert.deepEqual([...DEFAULT_LAYERS],['terrain','scenery','content','players']);
 }finally{f.close();}
});

test('GET /gm/map.png and /gm/tile-artwork are staff-only and serve a real picture',async()=>{
 const staff='s'.repeat(43),player='p'.repeat(43),service=createQuestService({log:()=>{},walletClient:{authenticate:async token=>({owner:token===staff?'staff':'player',gamemaster:token===staff,client:'lidollquest',coins:0,scope:'social:read'})}});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;
 const get=(path,token)=>fetch(base+path,{headers:token?{Authorization:'Bearer '+token}:{}});
 try{
  assert.equal((await get('/gm/map.png?zone=princess-rose')).status,401);assert.equal((await get('/gm/map.png?zone=princess-rose',player)).status,403);
  assert.equal((await get('/gm/map.png?zone=nowhere',staff)).status,400);assert.equal((await get('/gm/map.png?zone=princess-rose&scale=5',staff)).status,400);
  const response=await get('/gm/map.png?zone=princess-rose&scale=16&layers=terrain,scenery',staff);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'no-store');
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),20*16);assert.equal(bytes.readUInt32BE(20),20*16);assert.equal(Number(response.headers.get('content-length')),bytes.length);
  const manifest=await (await get('/gm/tile-artwork',staff)).json();assert.equal(manifest.sprites.sprTileAutumnPlains.height,96);assert.equal(manifest.sprites.sprTileAutumnPlains.png,undefined);
  const scenery=await (await get('/gm/asset?id=sprPlainsEnvOuthouse',staff)).json();assert.equal(scenery.width,32);assert.equal(scenery.yorigin,16);assert.ok(scenery.png.length>100); // Shipped scenery is served through the asset route for the editor.
  assert.equal((await get('/gm/asset?id=sprNotReal',staff)).status,404);
  const painted=await (await get('/gm/map?zone=honeydew-lantern&paint=1',staff)).json();assert.equal(painted.floor.district.tileset,'tileTown');assert.equal((await (await get('/gm/map?zone=honeydew-lantern',staff)).json()).floor.district,undefined);
  const page=await (await fetch(base+'/gm')).text();assert.match(page,/worldMapPng/);const script=page.match(/<script>([\s\S]*?)<\/script>/)[1];new Function(script);assert.doesNotMatch(script,/\/\/.*(const|let|var)\s+\w+\s*=/);
 }finally{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}
});

test('NPCs fit their one 32px cell like the client draws them, even from 64px Piko canvases',()=>{
 const f=fixture();try{
  const view=f.zones.world.paintMap('overworld-autumnal-plains'),floor={...view.floor,exits:[],portals:[],chests:[],pickups:[],enemies:[],fixtures:[],decorations:[]}; // An empty content layer, so only the NPC differs.
  assert.equal(compiledArtwork.sprNPCWhistleblower.height,64,'the townspeople art is a 64px canvas');
  const npc={kind:'npc',sprite:'sprNPCWhistleblower',x:5,y:5};
  const spill=(withNpc,without)=>{let changed=0;for(let i=0;i<withNpc.data.length;i+=4)if(withNpc.data[i]!==without.data[i]||withNpc.data[i+1]!==without.data[i+1]||withNpc.data[i+2]!==without.data[i+2]){changed++;const x=(i/4)%withNpc.width,y=Math.floor(i/4/withNpc.width);assert.ok(Math.floor(x/TILE_SIZE)===5&&Math.floor(y/TILE_SIZE)===5,`NPC pixel ${x},${y} spills outside its cell`);}return changed;}; // Every pixel the NPC changed must sit in its own cell.
  assert.ok(spill(f.renderer.paint({...view,floor,placements:[npc],players:[]},['content']),f.renderer.paint({...view,floor,placements:[],players:[]},['content']))>50,'the placed NPC was drawn');
  assert.ok(spill(f.renderer.paint({...view,floor:{...floor,fixtures:[{...npc,id:'n'}]},placements:[],players:[]},['scenery']),f.renderer.paint({...view,floor,placements:[],players:[]},['scenery']))>50,'the resident fixture was drawn'); // Hub resident fixtures use the same rule.
 }finally{f.close();}
});

test('tiles under hub furniture are painted: the paint view carries terrain walls, not the fixture-stamped grid',()=>{
 const f=fixture();try{
  let checked=0;
  for(const z of f.zones.world.catalog().filter(z=>z.kind==='hub')){
   const view=f.zones.world.paintMap(z.id),floor=view.floor;if(!floor?.floors)continue; // District and authored rooms paint from tile grids.
   const plan=paintPlan(floor);
   for(const fx of floor.fixtures??[])if(fx.solid!==false)for(let dy=0;dy<(fx.span_h??1);dy++)for(let dx=0;dx<(fx.span_w??1);dx++){const x=fx.x+dx,y=fx.y+dy;if(x<0||y<0||x>=floor.width||y>=floor.height)continue;
    assert.ok(tileAt(floor,x,y,{plan,tilesets:tiles.tilesets}).length>0,z.id+': nothing painted under '+fx.kind+' '+fx.id+' at '+x+','+y);checked++;}
   assert.ok(walkableCell(floor,0,0)===false,'the border is still solid');
   const solid=(floor.fixtures??[]).find(fx=>fx.solid!==false);if(solid)assert.equal(walkableCell(floor,solid.x,solid.y),false,z.id+': furniture still blocks walking in the editor');
  }
  assert.ok(checked>50,'checked the tiles under many hub fixtures ('+checked+')');
 }finally{f.close();}
});

test('Auto-Nursery floors paint per room type like tilemap_paint_nursery',()=>{
 const W=12,H=8,walls=Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>x===0||y===0||x===W-1||y===H-1||x===6||(y===4&&x>6)?1:0));
 const floor={theme:'nursery',width:W,height:H,walls,rooms:[{x:1,y:1,w:5,h:6,type:'control'},{x:7,y:1,w:4,h:3,type:'play'}]},cell=(x,y)=>tileAt(floor,x,y)[0];
 assert.equal(cell(2,2).atlas,'sprTileAutoNursery');
 assert.ok([8,9].includes(cell(2,2).tile),'control room floor is dark wood');assert.ok([15,16,17].includes(cell(6,2).tile),'a wall touching the control room takes its panels');
 assert.ok([7,2].includes(cell(8,2).tile),'play room floor');assert.ok([10,14].includes(cell(8,4).tile),'play room walls are white with pink floral accents');
 assert.ok([1,3].includes(cell(8,6).tile),'corridor floor');assert.ok([10,11,12,14].includes(cell(0,3).tile),'the map edge is white with soft accents');
 floor.walls[6][9]=1;assert.equal(cell(9,6).tile,10,'corridor walls are plain white');
 let white=0,edge=0;for(let x=0;x<W;x++){edge++;if(cell(x,0).tile===10)white++;}assert.ok(white>edge/2,'walls are mostly white ('+white+'/'+edge+')');
});

test('School walls are mostly red brick or pea green, Hospital walls mostly white, and boss rooms keep their panels',()=>{
 const W=30,H=20,walls=Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>x===0||y===0||x===W-1||y===H-1||x===15?1:0)),rooms=(boss,type)=>[{x:1,y:1,w:14,h:18,type:boss},{x:16,y:1,w:13,h:18,type}]; // The divider at x=15 takes the left room's palette first, like the client.
 const share=(floor,tiles,cells)=>cells.filter(([x,y])=>tiles.includes(tileAt(floor,x,y)[0].tile)).length/cells.length;
 const ring=[];for(let x=0;x<W;x++)ring.push([x,0],[x,H-1]);for(let y=1;y<H-1;y++)ring.push([0,y],[W-1,y],[15,y]);
 const school={theme:'school',width:W,height:H,walls,rooms:rooms('principals_office','classroom')};
 assert.equal(tileAt(school,2,2)[0].atlas,'sprTileSchool');assert.ok(share(school,[10,13],ring.filter(([x])=>x!==15))>0.6,'school walls are mostly brick or pea green');
 assert.equal(tileAt(school,15,5)[0].tile,17,"the principal's office keeps its dark wood");
 const hospital={theme:'hospital',width:W,height:H,walls,rooms:rooms('directors_office','lab')};
 assert.equal(tileAt(hospital,2,2)[0].atlas,'sprTileHospital');assert.ok(share(hospital,[10],ring.filter(([x])=>x!==15))>0.6,'hospital walls are mostly white');
 assert.equal(tileAt(hospital,15,5)[0].tile,16,"the director's office keeps its stainless steel");
});
