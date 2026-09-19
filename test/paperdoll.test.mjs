import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decode,encode,blank,over} from '../server/png.mjs';
import {createPaperdoll,layersFor} from '../server/paperdoll.mjs';

// The service renders paperdoll portraits itself, with no native canvas and no
// dependencies, so these tests cover both halves: the stdlib PNG codec, and the
// layer ordering ported from the companion client's paperdoll.js. If the two ever
// disagree, the Discord post and the in-browser preview stop matching.

const ASSETS=fileURLToPath(new URL('../server/paperdoll-assets/',import.meta.url));
const exported=existsSync(join(ASSETS,'manifest.json'));
const manifest=exported?JSON.parse(readFileSync(join(ASSETS,'manifest.json'),'utf8')):null;

const appearance=(over={})=>({
 gender:'Female',face_expression:'cheeky',hair_style:1,hair_color:'Brown',
 has_breasts:false,nipple_style:0,pubes_style:0,penis_style:0,inspection_embarrassment:0,
 diaper_wet_absorbed:0,diaper_tum_absorbed:0,
 equipped_socks:'',equipped_panties:'',equipped_diaper_cover:'',equipped_bra:'',equipped_pants:'',
 equipped_shoes:'',equipped_torso:'',equipped_gloves:'',equipped_special:'',equipped_accessory_1:'',
 equipped_accessory_2:'',equipped_accessory_3:'',equipped_mouth:'',equipped_weapon:'',equipped_plug:'',
 equipped_head:'',...over});
const names=list=>list.map(layer=>layer.name);
const all=()=>true;

// ---------------------------------------------------------------- codec ----

test('the codec round-trips 8-bit RGBA losslessly',()=>{
 const image=blank(9,5);
 for(let i=0;i<image.data.length;i++)image.data[i]=(i*37+11)%256; // noise defeats every row filter equally
 const back=decode(encode(image));
 assert.equal(back.width,9);assert.equal(back.height,5);
 assert.equal(Buffer.compare(back.data,image.data),0);
});

test('every PNG row filter decodes',()=>{
 // Gradients, flat runs and noise push the encoder through all five filter choices.
 const image=blank(24,24);
 for(let y=0;y<24;y++)for(let x=0;x<24;x++){
  const i=(y*24+x)*4;
  image.data[i]=x*10;image.data[i+1]=y*10;image.data[i+2]=(x^y)*7;image.data[i+3]=255;
 }
 assert.equal(Buffer.compare(decode(encode(image)).data,image.data),0);
});

test('unsupported PNG shapes are refused rather than guessed at',()=>{
 const header=(depth,colour,interlace)=>{
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(4,0);ihdr.writeUInt32BE(4,4);
  ihdr[8]=depth;ihdr[9]=colour;ihdr[12]=interlace;
  const chunk=Buffer.concat([Buffer.alloc(4),Buffer.from('IHDR','latin1'),ihdr,Buffer.alloc(4)]);
  chunk.writeUInt32BE(13,0);
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk]);
 };
 assert.throws(()=>decode(header(8,0,0)),/8-bit RGBA/);        // greyscale
 assert.throws(()=>decode(header(8,3,0)),/8-bit RGBA/);        // palette
 assert.throws(()=>decode(header(16,6,0)),/8-bit RGBA/);       // 16-bit
 assert.throws(()=>decode(header(8,6,1)),/Interlaced/);
 assert.throws(()=>decode(Buffer.from('not a png at all')),/Not a PNG/);
});

test('compositing matches source-over with an alpha multiplier',()=>{
 const target=blank(3,1);target.data.set([255,0,0,255, 0,0,0,0, 10,20,30,255]);
 const source=blank(3,1);source.data.set([0,0,255,128, 0,255,0,255, 1,2,3,0]);
 over(target,source);
 assert.deepEqual([...target.data.slice(0,4)],[127,0,128,255]);   // half blue over opaque red
 assert.deepEqual([...target.data.slice(4,8)],[0,255,0,255]);     // opaque onto empty wins outright
 assert.deepEqual([...target.data.slice(8,12)],[10,20,30,255]);   // fully transparent source changes nothing
 const faded=blank(1,1);faded.data.set([0,0,0,255]);
 over(faded,(()=>{const s=blank(1,1);s.data.set([255,255,255,255]);return s;})(),0.5);
 assert.deepEqual([...faded.data],[128,128,128,255]);             // globalAlpha, as the plug layer uses
});

// ------------------------------------------------------------- ordering ----

test('the body, face and hair stack in the companion order',()=>{
 const list=names(layersFor(appearance({has_breasts:true,nipple_style:2,inspection_embarrassment:1}),all));
 assert.equal(list[0],'TQ_Base_3');                              // the body is always the back layer
 assert.ok(list.indexOf('sprTQ_Breasts_1')<list.indexOf('sprTQ_Nipples_2'));
 assert.ok(list.indexOf('sprTQ_Face_CheekyFemale_1')>list.indexOf('sprTQ_Breasts_1'));
 assert.equal(list.at(-1),'sprTQ_Hair_1_Brown');                 // hair draws over the face
});

test('long hair brackets the character with a back and front layer',()=>{
 const list=names(layersFor(appearance({hair_style:4,hair_color:'Pink'}),all));
 assert.equal(list[1],'sprTQ_Hair_4_Pink_Back');                 // behind the body
 assert.equal(list.at(-1),'sprTQ_Hair_4_Pink_Front');            // and over the shoulders
 assert.ok(list.includes('sprTQ_Hair_4_Pink'));
});

test('a mood with no artwork falls back to the authored default face',()=>{
 const has=name=>name!=='sprTQ_Face_SmugFemale_0';
 assert.ok(names(layersFor(appearance({face_expression:'smug'}),has)).includes('sprTQ_Face_CheekyFemale_0'));
 assert.ok(names(layersFor(appearance({face_expression:'smug'}),all)).includes('sprTQ_Face_SmugFemale_0'));
});

test('anatomy shows only when nothing covers it',()=>{
 const bare=appearance({pubes_style:2,penis_style:1});
 assert.ok(names(layersFor(bare,all)).includes('sprTQ_Pubes_2'));
 assert.ok(names(layersFor(bare,all)).includes('sprTQ_Penis_1'));
 const covered=names(layersFor({...bare,equipped_panties:'cotton_panties'},all));
 assert.equal(covered.includes('sprTQ_Pubes_2'),false);
 assert.equal(covered.includes('sprTQ_Penis_1'),false);
});

test('a dress fills both slots but is drawn once',()=>{
 const list=names(layersFor(appearance({equipped_torso:'frilly_dress_1',equipped_pants:'frilly_dress_1'}),all));
 assert.equal(list.filter(name=>name==='sprTQ_frilly_dress_1').length,1);
 // A real skirt in the pants slot still draws separately.
 const skirt=names(layersFor(appearance({equipped_torso:'blouse_1',equipped_pants:'skirts_floral'}),all));
 assert.ok(skirt.includes('sprTQ_blouse_1')&&skirt.includes('sprTQ_skirts_floral'));
});

test('a diaper uses its used-state artwork and falls back when a variant is missing',()=>{
 const items={knickers_diaper_7:{is_diaper:true},cotton_panties:{}};
 const wet=appearance({equipped_panties:'knickers_diaper_7',diaper_wet_absorbed:3});
 assert.ok(names(layersFor(wet,all,items)).includes('sprTQ_knickers_diaper_7_2'));
 const messy={...wet,diaper_tum_absorbed:1};
 assert.ok(names(layersFor(messy,all,items)).includes('sprTQ_knickers_diaper_7_3'));
 const clean={...wet,diaper_wet_absorbed:0};
 assert.ok(names(layersFor(clean,all,items)).includes('sprTQ_knickers_diaper_7_1'));
 // No variant artwork: the base sprite is drawn rather than nothing at all.
 const bare=name=>!/_[123]$/.test(name);
 assert.ok(names(layersFor(wet,bare,items)).includes('sprTQ_knickers_diaper_7'));
 // Ordinary panties never take a used-state suffix.
 assert.ok(names(layersFor(appearance({equipped_panties:'cotton_panties',diaper_wet_absorbed:3}),all,items)).includes('sprTQ_cotton_panties'));
});

test('the two aliased panties borrow another item artwork',()=>{
 const items={blessed_pottypants_diaper:{is_diaper:true},thick_medical_diaper:{is_diaper:true}};
 const hugger=names(layersFor(appearance({equipped_panties:'diaper_hugger_diaper'}),all,items));
 assert.ok(hugger.some(name=>name.startsWith('sprTQ_blessed_pottypants_diaper')));
 assert.equal(hugger.includes('sprTQ_diaper_hugger_diaper'),false);
 const school=names(layersFor(appearance({equipped_panties:'diaper_school_issued'}),all,items));
 assert.ok(school.some(name=>name.startsWith('sprTQ_thick_medical_diaper')));
});

test('the plug is drawn under the clothing rather than on top of it',()=>{
 const list=layersFor(appearance({equipped_plug:'goblin_plug',equipped_torso:'blouse_1'}),all);
 const plug=list.find(layer=>layer.name==='sprTQ_goblin_plug');
 assert.equal(plug.alpha,0.7);                                   // the companion's globalAlpha
 assert.equal(list.find(layer=>layer.name==='sprTQ_blouse_1').alpha,1);
});

test('headwear is the very last layer, over the hair',()=>{
 const list=names(layersFor(appearance({equipped_head:'witch_hat'}),all));
 assert.equal(list.at(-1),'sprTQ_witch_hat');
 assert.ok(list.indexOf('sprTQ_Hair_1_Brown')<list.indexOf('sprTQ_witch_hat'));
});

test('empty slots contribute nothing',()=>{
 assert.deepEqual(names(layersFor(appearance(),all)),['TQ_Base_3','sprTQ_Face_CheekyFemale_0','sprTQ_Hair_1_Brown']);
});

// --------------------------------------------------------------- render ----

test('a deployment with no exported artwork degrades instead of failing',()=>{
 const empty=createPaperdoll({assets:mkdtempSync(join(tmpdir(),'paperdoll-')),log:()=>{}});
 assert.equal(empty.available,false);
 assert.match(empty.reason,/has not been exported/);
 assert.equal(empty.render({character_id:'c',revision:1,player_info:appearance()}),null);
});

test('only manifest names are ever opened',()=>{
 // Item ids reach the renderer as sprite names, so a traversal attempt must find
 // nothing rather than read a file beside the artwork.
 const dir=mkdtempSync(join(tmpdir(),'paperdoll-'));
 writeFileSync(join(dir,'secret.txt'),'not artwork');
 writeFileSync(join(dir,'manifest.json'),JSON.stringify({version:1,scale:1,width:2,height:2,sprites:{}}));
 const doll=createPaperdoll({assets:dir,log:()=>{}});
 assert.equal(doll.available,true);
 assert.equal(doll.render({character_id:'c',revision:1,player_info:appearance({equipped_head:'../secret'})}),null);
});

test('a rendered portrait is a decodable PNG at the manifest size',{skip:!exported&&'paperdoll assets not exported'},()=>{
 const doll=createPaperdoll({log:()=>{}});
 const png=doll.render({character_id:'c1',revision:1,player_info:appearance({
  has_breasts:true,equipped_torso:'frilly_dress_1',equipped_pants:'frilly_dress_1',
  equipped_socks:'knee_socks',equipped_head:'witch_hat'})});
 assert.ok(Buffer.isBuffer(png));
 const image=decode(png);
 assert.equal(image.width,manifest.width);
 assert.equal(image.height,manifest.height);
 assert.ok(image.data.some((v,i)=>i%4===3&&v>0),'the portrait must not be fully transparent');
});

test('portraits are cached per character revision and the caches stay bounded',{skip:!exported&&'paperdoll assets not exported'},()=>{
 const doll=createPaperdoll({log:()=>{}});
 const sheet=r=>({character_id:'c1',revision:r,player_info:appearance({equipped_socks:'knee_socks'})});
 const first=doll.render(sheet(1));
 assert.equal(doll.render(sheet(1)),first,'the same revision must return the cached buffer');
 assert.notEqual(doll.render(sheet(2)),first,'a new revision must re-render');
 // Draw far more distinct characters than either cache holds.
 for(let n=0;n<120;n++)doll.render({character_id:'bulk'+n,revision:1,player_info:appearance()});
 const stats=doll.stats();
 assert.ok(stats.portraits<=64,'portrait cache grew past its bound: '+stats.portraits);
 assert.ok(stats.layers<=64,'layer cache grew past its bound: '+stats.layers);
});

test('changing worn gear changes the picture',{skip:!exported&&'paperdoll assets not exported'},()=>{
 const doll=createPaperdoll({log:()=>{}});
 const bare=doll.render({character_id:'a',revision:1,player_info:appearance()});
 const dressed=doll.render({character_id:'b',revision:1,player_info:appearance({equipped_torso:'frilly_dress_1'})});
 assert.notEqual(Buffer.compare(bare,dressed),0);
});
