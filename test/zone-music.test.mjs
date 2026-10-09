import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createZoneMusic,loadMusicLibrary,LIBRARY_DIR,DEFAULT_ZONE,SILENCE} from '../server/zone-music.mjs';
import {createQuestService} from '../server/service.mjs';
import {CACHED_SECTIONS} from '../server/snapshot-cache.mjs';
import {installZoneSnapshotEpochs} from '../server/zone-snapshot-epochs.mjs';

// Zone music (zone-music.mjs): a GM picks field/battle/boss songs per online zone on the /gm Music tab (or the Map
// Editor). Songs are served files: library tracks (music-library/, from the game repo's exporter) and GM uploads
// (converted by music-transcode.mjs; faked here, the real ffmpeg round trip lives in music-transcode.test.mjs).

const ZONES=[{id:'honeydew-lantern',name:'Honeydew Village',category:'hub'},{id:'honeydew-lantern-beds',name:'Honeydew Inn',category:'room',parent:'honeydew-lantern'},{id:'overworld-autumnal-plains',name:'Autumnal Plains',category:'overworld'}];
function fakeTranscoder(){ // Deterministic stand-in: "converts" by prefixing the input, so different inputs give different ids.
 const t={calls:0,kbps:96,available:async()=>true,async convert(input){t.calls++;return {mp3:Buffer.concat([Buffer.from('ID3'),input,Buffer.alloc(2000)]),ogg:Buffer.concat([Buffer.from('OggS'),input]),seconds:12.5};}};
 return t;
}
const WAV=text=>Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'),Buffer.from(text)]); // Passes the format sniff.
function store(options={}){
 const db=new DatabaseSync(':memory:'),dir=mkdtempSync(join(tmpdir(),'zone-music-test-'));
 const m=createZoneMusic(db,{now:()=>1000,zones:()=>ZONES,uploadDir:dir,transcoder:fakeTranscoder(),...options});
 return {db,m,dir,close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('the shipped library (python/export_online_music.py) lists every former packaged track, and its files exist',()=>{
 const library=loadMusicLibrary(),names=library.map(t=>t.name);
 for(const name of ['boss','castle','combat','desert','dungeon','forest','princess','princess2','town'])assert.ok(names.includes(name),name);
 for(const t of library)for(const ext of ['mp3','ogg'])assert.ok(existsSync(join(LIBRARY_DIR,t.id+'.'+ext)),t.name+'.'+ext);
});

test('content() is null until something is mapped, then carries rows and streams for referenced uploads only',async()=>{
 const s=store();
 try{
  assert.equal(s.m.content(),null,'nothing mapped: the client keeps today\'s behaviour');
  const used=await s.m.addUpload(WAV('one'),'Lantern Waltz','gm'),spare=await s.m.addUpload(WAV('two'),'Spare Tune','gm');
  s.m.gmSet({zone:DEFAULT_ZONE,track:'forest'},'gm');
  s.m.gmSet({zone:'honeydew-lantern',track:'upload:'+used.id,battle:'forest',boss:'boss',volume:60},'gm');
  const content=s.m.content();
  assert.deepEqual(content.default,{track:'forest',battle:null,boss:null,volume:100});
  assert.deepEqual(content.zones['honeydew-lantern'],{track:'upload:'+used.id,battle:'forest',boss:'boss',volume:60});
  assert.deepEqual(content.streams,{[used.id]:{url:'/quest-music/'+used.id+'.mp3',ogg:'/quest-music/'+used.id+'.ogg',title:'Lantern Waltz'}},'library names need no stream entry; the unused upload is left out');
  assert.equal(content.streams[spare.id],undefined);
  s.m.gmSet({zone:'overworld-autumnal-plains',track:SILENCE},'gm');assert.equal(s.m.content().zones['overworld-autumnal-plains'].track,'none');
  s.m.gmClear({zone:'overworld-autumnal-plains'});assert.equal(s.m.content().zones['overworld-autumnal-plains'],undefined,'cleared rows inherit again');
  const view=s.m.gmView();assert.equal(view.mapping['honeydew-lantern'].actor,'gm');assert.ok(view.catalog.some(t=>t.name==='town'&&t.id));
  assert.deepEqual(view.uploads.find(u=>u.id===used.id).used_by,['honeydew-lantern']);assert.deepEqual(view.uploads.find(u=>u.id===spare.id).used_by,[]);
  assert.equal(view.uploadsEnabled,true);assert.equal(view.uploadPrefix,'upload:');
 }finally{s.close();}
});

test('slot validation: unknown zones, unknown songs and uploads, silence outside the field slot and bad volumes are refused',()=>{
 const s=store();
 try{
  const refuse=(input,pattern)=>assert.throws(()=>s.m.gmSet(input,'gm'),error=>error.status===400&&pattern.test(error.message));
  refuse({zone:'nowhere',track:'town'},/Choose a zone/);
  refuse({zone:'__proto__',track:'town'},/Choose a zone/);
  refuse({zone:'honeydew-lantern',track:'nope'},/Field music/);
  refuse({zone:'honeydew-lantern',track:'upload:'+'0'.repeat(32)},/Field music/);
  refuse({zone:'honeydew-lantern',battle:SILENCE},/Battle music/);
  refuse({zone:'honeydew-lantern',boss:'../../etc/passwd'},/Boss music/);
  refuse({zone:'honeydew-lantern',volume:101},/Volume/);
  refuse({zone:'honeydew-lantern',volume:2.5},/Volume/);
  assert.throws(()=>s.m.gmClear({zone:'nowhere'}),/Choose a zone/);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM quest_zone_music').get().n,0,'nothing half-saved');
  assert.equal(s.m.track('castle'),'castle','castle.mp3 became a library track');assert.equal(s.m.track(null),null);
 }finally{s.close();}
});

test('uploads: format sniff, size and title limits, duplicates land on one row, and servers without a data folder refuse',async()=>{
 const s=store({maxInputBytes:64});
 try{
  const rejects=async(buffer,title,status)=>assert.rejects(s.m.addUpload(buffer,title,'gm'),error=>error.status===status);
  await rejects(Buffer.from('this is just some text, not a song'),'Text',415);
  await rejects(Buffer.alloc(65,1),'Huge',413);
  await rejects(Buffer.alloc(0),'Empty',400);
  await rejects(WAV('x'),'',400);await rejects(WAV('x'),'y'.repeat(61),400);
  const first=await s.m.addUpload(WAV('same'),'  Same\nSong  ','gm');assert.equal(first.title,'Same Song','titles are one tidy line');assert.equal(first.seconds,12.5);
  const again=await s.m.addUpload(WAV('same'),'Other title','gm');assert.equal(again.id,first.id);assert.equal(again.duplicate,true);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM quest_music_uploads').get().n,1);
  for(const ext of ['mp3','ogg'])assert.ok(existsSync(join(s.dir,first.id+'.'+ext)),'both formats are stored');
  for(const ext of ['mp3','ogg'])assert.ok(!existsSync(join(s.dir,first.id+'.'+ext+'.tmp')),'no temp files left behind');
 }finally{s.close();}
 const off=createZoneMusic(new DatabaseSync(':memory:'),{zones:()=>ZONES});
 await assert.rejects(off.addUpload(WAV('x'),'T','gm'),error=>error.status===409);assert.equal(off.gmView().uploadsEnabled,false);
});

test('deleting an upload is refused while a zone or story content plays it, then removes its files',async()=>{
 const s=store();
 try{
  const song=await s.m.addUpload(WAV('dear'),'Dear','gm');
  s.m.gmSet({zone:'honeydew-lantern',track:'upload:'+song.id},'gm');
  assert.throws(()=>s.m.removeUpload({id:song.id}),error=>error.status===409&&/honeydew-lantern/.test(error.message));
  s.m.gmClear({zone:'honeydew-lantern'});
  s.m.setReferenceScan(token=>token==='upload:'+song.id?['flow: Night Walk']:[]);
  assert.throws(()=>s.m.removeUpload({id:song.id}),error=>error.status===409&&/Night Walk/.test(error.message),'story references block deletion too');
  s.m.setReferenceScan(null);
  assert.deepEqual(s.m.removeUpload({id:song.id}),{id:song.id,deleted:true});
  for(const ext of ['mp3','ogg'])assert.ok(!existsSync(join(s.dir,song.id+'.'+ext)));
  assert.throws(()=>s.m.removeUpload({id:song.id}),error=>error.status===404);
  assert.throws(()=>s.m.removeUpload({id:'../x'}),error=>error.status===404);
 }finally{s.close();}
});

test('musicFile resolves library ids and uploads only, never a path outside their folders',async()=>{
 const s=store();
 try{
  const town=loadMusicLibrary().find(t=>t.name==='town'),song=await s.m.addUpload(WAV('file'),'File','gm');
  assert.equal(s.m.musicFile(town.id,'mp3').path,join(LIBRARY_DIR,town.id+'.mp3'));assert.equal(s.m.musicFile(town.id,'ogg').type,'audio/ogg');
  assert.equal(s.m.musicFile(song.id,'mp3').path,join(s.dir,song.id+'.mp3'));assert.equal(s.m.musicFile(song.id,'mp3').type,'audio/mpeg');
  for(const [id,ext] of [['0'.repeat(32),'mp3'],[town.id,'wav'],['../'+town.id,'mp3'],[town.id.toUpperCase(),'mp3'],[null,'mp3']])assert.equal(s.m.musicFile(id,ext),null,String(id)+'.'+ext);
 }finally{s.close();}
});

test('GM edits and uploads bump the music snapshot epoch, and the section is hash-cached',async()=>{
 const s=store();
 try{
  for(const [,table] of readFileSync(new URL('../server/zone-snapshot-epochs.mjs',import.meta.url),'utf8').split('export')[0].matchAll(/'([a-z_]+)'/g))s.db.exec('CREATE TABLE IF NOT EXISTS '+table+'(x)'); // The installer triggers on every domain's table; stand-ins for the ones this test does not build.
  installZoneSnapshotEpochs(s.db);
  const epoch=()=>s.db.prepare("SELECT revision FROM zone_snapshot_epochs WHERE domain='music'").get().revision;
  let before=epoch();s.m.gmSet({zone:'honeydew-lantern',track:'town'},'gm');assert.equal(epoch(),before+1,'workers see a row change');
  before=epoch();await s.m.addUpload(WAV('epoch'),'Epoch','gm');assert.equal(epoch(),before+1,'and a new upload (stream titles live in the snapshot)');
  assert.ok(CACHED_SECTIONS.includes('zoneMusic'));
 }finally{s.close();}
});

// ── End to end: the /gm routes, the public /music route and the snapshot ──
const loadout={player_info:{playerHealth:50,playerHealthMax:50,level:1,str:10,def:10,dex:10,int:10,cha:2},inventory:[],player_spells:[]};
const playerToken='p'.repeat(43),owner='o'.repeat(64),staffToken='s'.repeat(43),staff='a'.repeat(64);
function harness(){ // Same gateway + panel driver as welcome.test.mjs, with uploads stored in a temp folder.
 let now=Date.parse('2026-10-09T12:00:00Z');
 const dir=mkdtempSync(join(tmpdir(),'zone-music-e2e-'));
 const accounts={[staffToken]:{owner:staff,gamemaster:true},[playerToken]:{owner,gamemaster:false}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant-'+a.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({now:()=>now,walletClient,gmEnabled:true,musicOptions:{uploadDir:dir,transcoder:fakeTranscoder()}});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const held={},base=()=>'http://127.0.0.1:'+service.server.address().port;
 async function ok(secret,action,extra={}){
  now+=500;
  const body={action,character_id:held[secret]?.id,revision:held[secret]?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch(base()+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(result.character)held[secret]=result.character;
  assert.equal(response.status,200,JSON.stringify(result));return result;
 }
 const raw=(path,init={})=>fetch(base()+path,init);
 const gm=async(path,init={})=>{const response=await fetch(base()+path,{method:init.method??'GET',headers:{Authorization:'Bearer '+(init.token??staffToken),...(init.body?{'Content-Type':'application/json'}:{})},body:init.body?JSON.stringify(init.body):undefined});return {status:response.status,body:await response.json().catch(()=>({}))};};
 const act=(action,payload={})=>gm('/gm/action',{method:'POST',body:{action,...payload}});
 const upload=(bytes,title,token=staffToken)=>raw('/gm/music/upload?title='+encodeURIComponent(title),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'audio/wav'},body:bytes});
 const audit=action=>service.db.prepare('SELECT * FROM gm_audit WHERE action=?').all(action);
 return {service,started,ok,raw,gm,act,upload,audit,close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));rmSync(dir,{recursive:true,force:true});}};
}

test('the Music tab saves rows and uploads, the snapshot carries streams, and songs are served publicly with ranges',async()=>{
 const h=harness();await h.started;
 try{
  const created=await h.ok(playerToken,'create',{name:'Poppy'});
  assert.equal(created.capabilities.zoneMusic,true);assert.equal(created.zoneMusic,undefined,'nothing mapped yet: the section is left out');
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern',loadout,quest_version:1,content_version:1,combat_version:3}); // Heartbeats need a zone.
  const view=await h.gm('/gm/music');assert.equal(view.status,200);assert.equal(view.body.ffmpegReady,true);
  const ids=view.body.zones.map(z=>z.id);
  for(const id of ['honeydew-lantern','honeydew-lantern-beds','princess-rose-garden','overworld-autumnal-plains','dungeon-spooky-mansion'])assert.ok(ids.includes(id),id);
  assert.equal(view.body.zones.find(z=>z.id==='honeydew-lantern-beds').parent,'honeydew-lantern','hub rooms name their hub');
  assert.equal((await h.gm('/gm/music',{token:playerToken})).status,403,'players cannot read the panel');
  // Upload through the raw route: staff-only, audited, refused when not audio.
  assert.equal((await h.upload(WAV('x'),'Nope',playerToken)).status,403);
  assert.equal((await h.upload(Buffer.from('plain text body here'),'Text')).status,415);
  const up=await h.upload(WAV('lantern'),'Lantern Waltz');assert.equal(up.status,200);const song=(await up.json()).result;
  assert.match(song.id,/^[0-9a-f]{32}$/);assert.deepEqual(JSON.parse(h.audit('music_upload')[0].detail),{title:'Lantern Waltz',seconds:12.5,input_bytes:WAV('lantern').length,duplicate:false});
  // Map it and watch the snapshot.
  const refused=await h.act('music_set',{zone:'honeydew-lantern',battle:'none'});assert.equal(refused.status,400);assert.match(refused.body.error_description,/Battle music/);
  const saved=await h.act('music_set',{zone:'honeydew-lantern',track:'upload:'+song.id,boss:'boss',volume:80});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const after=await h.ok(playerToken,'heartbeat');
  assert.deepEqual(after.zoneMusic.zones['honeydew-lantern'],{track:'upload:'+song.id,battle:null,boss:'boss',volume:80});
  assert.equal(after.zoneMusic.streams[song.id].url,'/quest-music/'+song.id+'.mp3');
  // Public route: no auth, immutable, ranges; library and uploads alike.
  const town=loadMusicLibrary().find(t=>t.name==='town');
  const full=await h.raw('/music/'+town.id+'.mp3');assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),'audio/mpeg');assert.match(full.headers.get('cache-control'),/immutable/);assert.equal(full.headers.get('accept-ranges'),'bytes');
  const bytes=Buffer.from(await full.arrayBuffer());assert.deepEqual(bytes,readFileSync(join(LIBRARY_DIR,town.id+'.mp3')));
  const part=await h.raw('/music/'+town.id+'.mp3',{headers:{Range:'bytes=10-19'}});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 10-19/'+bytes.length);assert.deepEqual(Buffer.from(await part.arrayBuffer()),bytes.subarray(10,20));
  const tail=await h.raw('/music/'+town.id+'.mp3',{headers:{Range:'bytes=-5'}});assert.equal(tail.status,206);assert.deepEqual(Buffer.from(await tail.arrayBuffer()),bytes.subarray(bytes.length-5));
  assert.equal((await h.raw('/music/'+town.id+'.mp3',{headers:{Range:'bytes=999999999-'}})).status,416);
  assert.equal((await h.raw('/music/'+town.id+'.mp3',{headers:{Range:'bytes=0-1,4-5'}})).status,416,'multi-range is refused, not guessed');
  const ogg=await h.raw('/music/'+song.id+'.ogg');assert.equal(ogg.status,200);assert.equal(ogg.headers.get('content-type'),'audio/ogg');
  assert.equal((await h.raw('/music/'+town.id+'.mp3',{method:'HEAD'})).status,200);
  for(const path of ['/music/'+'0'.repeat(32)+'.mp3','/music/'+town.id+'.wav','/music/..%2Fquest.sqlite','/music/../server/gm.mjs'])assert.equal((await h.raw(path)).status,404,path);
  for(let i=0;i<40;i++)assert.equal((await h.raw('/music/'+town.id+'.mp3',{headers:{Range:'bytes=0-0'}})).status,206,'no per-token limiter on public music');
  // GM previews: staff-only, ids only.
  assert.equal((await h.raw('/gm/music/file/'+town.id+'.mp3',{headers:{Authorization:'Bearer '+staffToken}})).status,200);
  assert.equal((await h.raw('/gm/music/file/'+town.id+'.mp3',{headers:{Authorization:'Bearer '+playerToken}})).status,403);
  assert.equal((await h.raw('/gm/music/file/town.mp3',{headers:{Authorization:'Bearer '+staffToken}})).status,404);
  // Deleting: blocked while mapped, then allowed and audited.
  assert.equal((await h.act('music_delete',{id:song.id})).status,409);
  assert.equal((await h.act('music_clear',{zone:'honeydew-lantern'})).status,200);
  assert.equal((await h.act('music_delete',{id:song.id})).status,200);assert.equal(h.audit('music_delete').length,1);
  assert.equal((await h.raw('/music/'+song.id+'.mp3')).status,404,'a deleted upload is gone from the origin');
  assert.equal((await h.ok(playerToken,'heartbeat')).zoneMusic,undefined,'cleared: left out again');
 }finally{await h.close();}
});
