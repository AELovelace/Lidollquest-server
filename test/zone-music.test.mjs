import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createZoneMusic,loadMusicCatalog,DEFAULT_ZONE,SILENCE} from '../server/zone-music.mjs';
import {createQuestService} from '../server/service.mjs';
import {CACHED_SECTIONS} from '../server/snapshot-cache.mjs';
import {installZoneSnapshotEpochs} from '../server/zone-snapshot-epochs.mjs';
import {readFileSync} from 'node:fs';

// Zone music (zone-music.mjs): a GM picks field/battle/boss tracks per online zone on the /gm Music tab. The snapshot
// carries `zoneMusic` (cached section); the client walks zone -> parent hub -> Default itself (scrMusic.gml).

const CATALOG=[{name:'town',file:'town.mp3',duration:60},{name:'forest',file:'forest.mp3',duration:30},{name:'boss',file:'boss.mp3',duration:141}];
const ZONES=[{id:'honeydew-lantern',name:'Honeydew Village',category:'hub'},{id:'honeydew-lantern-beds',name:'Honeydew Inn',category:'room',parent:'honeydew-lantern'},{id:'overworld-autumnal-plains',name:'Autumnal Plains',category:'overworld'}];
function store(){const db=new DatabaseSync(':memory:');return {db,m:createZoneMusic(db,{now:()=>1000,catalog:CATALOG,zones:()=>ZONES})};}

test('content() is null until something is mapped, then carries the Default and each zone row',()=>{
 const {db,m}=store();
 try{
  assert.equal(m.content(),null,'nothing mapped: the client keeps today\'s behaviour');
  m.gmSet({zone:DEFAULT_ZONE,track:'forest'},'gm');
  m.gmSet({zone:'honeydew-lantern',track:'town',battle:'forest',boss:'boss',volume:60},'gm');
  assert.deepEqual(m.content(),{default:{track:'forest',battle:null,boss:null,volume:100},zones:{'honeydew-lantern':{track:'town',battle:'forest',boss:'boss',volume:60}}});
  m.gmSet({zone:'overworld-autumnal-plains',track:SILENCE},'gm');assert.equal(m.content().zones['overworld-autumnal-plains'].track,'none','silence is stored as "none"');
  m.gmClear({zone:'overworld-autumnal-plains'});assert.equal(m.content().zones['overworld-autumnal-plains'],undefined,'cleared rows inherit again');
  const view=m.gmView();assert.equal(view.mapping['honeydew-lantern'].actor,'gm');assert.equal(view.catalog.length,3);assert.equal(view.zones[1].parent,'honeydew-lantern');assert.equal(view.defaultZone,'*');
 }finally{db.close();}
});

test('validation: unknown zones, unknown tracks, silence outside the field slot and bad volumes are refused',()=>{
 const {db,m}=store();
 try{
  const refuse=(input,pattern)=>assert.throws(()=>m.gmSet(input,'gm'),error=>error.status===400&&pattern.test(error.message));
  refuse({zone:'nowhere',track:'town'},/Choose a zone/);
  refuse({zone:'__proto__',track:'town'},/Choose a zone/);
  refuse({zone:'honeydew-lantern',track:'castle'},/Field music/);
  refuse({zone:'honeydew-lantern',battle:SILENCE},/Battle music/);
  refuse({zone:'honeydew-lantern',boss:'../../etc/passwd'},/Boss music/);
  refuse({zone:'honeydew-lantern',volume:101},/Volume/);
  refuse({zone:'honeydew-lantern',volume:2.5},/Volume/);
  assert.throws(()=>m.gmClear({zone:'nowhere'}),/Choose a zone/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM quest_zone_music').get().n,0,'nothing half-saved');
 }finally{db.close();}
});

test('previewFile only resolves catalog names, so no path can leave music-preview/',()=>{
 const {db,m}=store();
 try{
  assert.match(m.previewFile('town'),/music-preview[\\/]town\.mp3$/);
  for(const bad of ['castle','../town','town.mp3','','__proto__',null])assert.equal(m.previewFile(bad),null,String(bad));
 }finally{db.close();}
});

test('a GM edit bumps the music snapshot epoch, and the section is hash-cached',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const m=createZoneMusic(db,{catalog:CATALOG,zones:()=>ZONES});
  for(const [,table] of readFileSync(new URL('../server/zone-snapshot-epochs.mjs',import.meta.url),'utf8').split('export')[0].matchAll(/'([a-z_]+)'/g))db.exec('CREATE TABLE IF NOT EXISTS '+table+'(x)'); // The installer triggers on every domain's table; stand-ins for the ones this test does not build.
  installZoneSnapshotEpochs(db);
  const epoch=()=>db.prepare("SELECT revision FROM zone_snapshot_epochs WHERE domain='music'").get().revision;
  const before=epoch();m.gmSet({zone:'honeydew-lantern',track:'town'},'gm');assert.equal(epoch(),before+1,'workers see the change and drop their cache');
  assert.ok(CACHED_SECTIONS.includes('zoneMusic'));
 }finally{db.close();}
});

test('the shipped catalog (from python/export_online_music.py) lists the game\'s bgm tracks',()=>{
 const names=loadMusicCatalog().map(t=>t.name);
 assert.ok(names.includes('town')&&names.includes('combat')&&names.includes('boss'),names.join(','));
});

// ── End to end: the /gm routes and the snapshot ───────────────────────────
const loadout={player_info:{playerHealth:50,playerHealthMax:50,level:1,str:10,def:10,dex:10,int:10,cha:2},inventory:[],player_spells:[]};
const playerToken='p'.repeat(43),owner='o'.repeat(64),staffToken='s'.repeat(43),staff='a'.repeat(64);
function harness(){ // Same gateway + panel driver as welcome.test.mjs.
 let now=Date.parse('2026-10-08T12:00:00Z');
 const accounts={[staffToken]:{owner:staff,gamemaster:true},[playerToken]:{owner,gamemaster:false}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant-'+a.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({now:()=>now,walletClient,gmEnabled:true});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const held={},base=()=>'http://127.0.0.1:'+service.server.address().port;
 async function ok(secret,action,extra={}){
  now+=500;
  const body={action,character_id:held[secret]?.id,revision:held[secret]?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch(base()+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(result.character)held[secret]=result.character;
  assert.equal(response.status,200,JSON.stringify(result));return result;
 }
 const raw=(path,token=staffToken)=>fetch(base()+path,{headers:{Authorization:'Bearer '+token}});
 const gm=async(path,init={})=>{const response=await fetch(base()+path,{method:init.method??'GET',headers:{Authorization:'Bearer '+(init.token??staffToken),...(init.body?{'Content-Type':'application/json'}:{})},body:init.body?JSON.stringify(init.body):undefined});return {status:response.status,body:await response.json().catch(()=>({}))};};
 const act=(action,payload={})=>gm('/gm/action',{method:'POST',body:{action,...payload}});
 const audit=action=>service.db.prepare('SELECT * FROM gm_audit WHERE action=?').all(action);
 return {service,started,ok,raw,gm,act,audit,close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('the Music tab lists every zone, saves and audits rows, streams previews, and the snapshot follows',async()=>{
 const h=harness();await h.started;
 try{
  const created=await h.ok(playerToken,'create',{name:'Poppy'});
  assert.equal(created.capabilities.zoneMusic,true);assert.equal(created.zoneMusic,undefined,'nothing mapped yet: the section is left out');
  await h.ok(playerToken,'enter',{zone:'honeydew-lantern',loadout,quest_version:1,content_version:1,combat_version:3}); // Heartbeats need a zone.
  const view=await h.gm('/gm/music');assert.equal(view.status,200);
  const ids=view.body.zones.map(z=>z.id);
  for(const id of ['honeydew-lantern','honeydew-lantern-beds','princess-rose-garden','overworld-autumnal-plains','dungeon-spooky-mansion'])assert.ok(ids.includes(id),id);
  assert.equal(view.body.zones.find(z=>z.id==='honeydew-lantern-beds').parent,'honeydew-lantern','hub rooms name their hub');
  assert.equal((await h.gm('/gm/music',{token:playerToken})).status,403,'players cannot read the panel');
  const refused=await h.act('music_set',{zone:'honeydew-lantern',battle:'none'});assert.equal(refused.status,400);assert.match(refused.body.error_description,/Battle music/);
  const bad=await h.act('music_set',{zone:'nowhere',track:'town'});assert.equal(bad.status,400);
  const saved=await h.act('music_set',{zone:'honeydew-lantern',track:'town',boss:'boss',volume:80});assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.deepEqual(JSON.parse(h.audit('music_set')[0].detail),{track:'town',battle:null,boss:'boss',volume:80});
  const after=await h.ok(playerToken,'heartbeat');assert.deepEqual(after.zoneMusic.zones['honeydew-lantern'],{track:'town',battle:null,boss:'boss',volume:80});
  assert.equal((await h.act('music_clear',{zone:'honeydew-lantern'})).status,200);assert.equal(h.audit('music_clear').length,1);
  assert.equal((await h.ok(playerToken,'heartbeat')).zoneMusic,undefined,'cleared: left out again');
  const mp3=await h.raw('/gm/music/town.mp3');assert.equal(mp3.status,200);assert.equal(mp3.headers.get('content-type'),'audio/mpeg');assert.ok((await mp3.arrayBuffer()).byteLength>1000);
  for(const path of ['/gm/music/castle.mp3','/gm/music/..%2Fmusic-catalog.json','/gm/music/../gm.mjs','/gm/music/town.wav'])assert.equal((await h.raw(path)).status,404,path);
  assert.equal((await h.raw('/gm/music/town.mp3',playerToken)).status,403,'previews are staff-only too');
 }finally{await h.close();}
});
