// Zone music: which song plays in each online zone, picked by a GM on the /gm Music tab (and the Map Editor's Zone music
// box). Each zone row has three slots: field (walking around), battle and boss. Blank slots inherit: a hub room falls back
// to its parent hub, then to the Default row (zone '*'), and a blank battle/boss slot finally means the `combat` / `boss`
// library tracks. The client resolves the inheritance (scrMusic.gml online_music_slot) from the snapshot's `zoneMusic`
// section, which is hash-cached (snapshot-cache.mjs), so it only travels after a GM edit.
//
// Every song is a served file named by content hash (no music is compiled into the game any more):
//  - Library tracks come from the game repo's audio-masters/music/, converted by python/export_online_music.py into
//    music-library/<id>.mp3|.ogg plus music-library.json ({name: {id, seconds}}). Slots name them ("town").
//  - GM uploads are converted here (music-transcode.mjs) into DATA_DIR/music/<id>.mp3|.ogg. Slots name them "upload:<id>".
// Players fetch both kinds from the public GET /music/<id>.mp3|.ogg route (service.mjs), published by nginx as
// /quest-music/. The snapshot carries `streams` for uploads only; clients know library ids from their own copy of
// music_library.json. Settings follow welcome.mjs: small tables cached in memory, with a snapshot-epoch domain ('music').
import {existsSync,readFileSync,statSync,unlinkSync} from 'node:fs';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const fail=(status,message,code='zone_music_invalid')=>{throw Object.assign(Error(message),{status,code});}; // Same rejection shape as welcome.mjs.
export const DEFAULT_ZONE='*'; // The Default row: what plays where neither the zone nor its parent hub has a song.
export const SILENCE='none'; // Field slot only: this zone plays no music at all.
export const SLOTS=Object.freeze(['track','battle','boss']); // field, battle and boss music.
export const UPLOAD_PREFIX='upload:'; // Slot values naming a GM upload: "upload:<id>".
const TRACK_NAME=/^[A-Za-z][A-Za-z0-9_]{0,63}$/; // Library names (the master's file name).
export const MUSIC_ID=/^[0-9a-f]{32}$/; // Content-hash ids; also keeps file paths inside their folder.
export const LIBRARY_DIR=fileURLToPath(new URL('./music-library/',import.meta.url)); // Exported library files.
const AUDIO_SIGNATURES=[ // Accepted upload formats, sniffed from the first bytes (ffmpeg would read more, but GMs only need these).
 b=>b.subarray(0,3).toString('latin1')==='ID3'||(b[0]===0xff&&(b[1]&0xe0)===0xe0), // mp3 (tagged, or a bare MPEG frame)
 b=>b.subarray(0,4).toString('latin1')==='OggS', // ogg / opus
 b=>b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WAVE', // wav
 b=>b.subarray(0,4).toString('latin1')==='fLaC', // flac
 b=>b.subarray(4,8).toString('latin1')==='ftyp', // m4a / aac
];
const oneLine=v=>String(v??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim(); // Upload titles: one line, no control characters.

export function loadMusicLibrary(){ // [{name,id,seconds}] from the exporter, or [] on a server that has not been given one yet.
 try{const map=JSON.parse(readFileSync(new URL('./music-library.json',import.meta.url),'utf8'));return Object.entries(map).filter(([name,t])=>TRACK_NAME.test(name)&&MUSIC_ID.test(t?.id??'')).map(([name,t])=>({name,id:t.id,seconds:Number(t.seconds)||0}));}catch(error){return [];}
}

export function createZoneMusic(db,{now=Date.now,library=loadMusicLibrary(),libraryDir=LIBRARY_DIR,zones=()=>[],uploadDir=null,transcoder=null,publicBase=process.env.QUEST_MUSIC_PUBLIC_BASE||'/quest-music/',maxInputBytes=(Number(process.env.QUEST_MUSIC_MAX_UPLOAD_MB)||50)*1024*1024}={}){ // zones(): [{id,name,category,parent?}].
 db.exec(`CREATE TABLE IF NOT EXISTS quest_zone_music(zone TEXT PRIMARY KEY,body TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS quest_music_uploads(id TEXT PRIMARY KEY,title TEXT NOT NULL,bytes INTEGER NOT NULL,seconds REAL NOT NULL,created INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');`); // One row per mapped zone ('*' is the Default); one row per converted upload.
 const tracks=new Map(library.map(t=>[t.name,t])),libraryIds=new Set(library.map(t=>t.id)); // Library names a GM may pick, and the ids whose files live in libraryDir.
 let cached,referenceScan=()=>[],overrideList=()=>[]; // cached: undefined = not built yet; null = nothing mapped. referenceScan: story flows/quests that name an upload; overrideList: quest stages that override zones (both set by zones.mjs).
 function rows(){return db.prepare('SELECT zone,body,updated,actor FROM quest_zone_music ORDER BY zone').all();}
 function uploads(){return db.prepare('SELECT id,title,bytes,seconds,created,actor FROM quest_music_uploads ORDER BY created DESC').all();}
 function upload(id){return db.prepare('SELECT id,title,bytes,seconds,created,actor FROM quest_music_uploads WHERE id=?').get(id);}
 function streamEntry(id,title){return {url:publicBase+id+'.mp3',ogg:publicBase+id+'.ogg',title};} // Relative paths: same origin as the game page.
 function streamsFor(values){ // {id:{url,ogg,title}} for every "upload:<id>" among `values`.
  const out={};for(const v of values)if(typeof v==='string'&&v.startsWith(UPLOAD_PREFIX)){const id=v.slice(UPLOAD_PREFIX.length),row=upload(id);if(row)out[id]=streamEntry(id,row.title);}
  return out;
 }
 function content(){ // Snapshot section: {default, zones:{id:{track,battle,boss,volume}}, streams}, or null while nothing is mapped.
  if(cached!==undefined)return cached;
  const out={default:null,zones:{}};
  for(const row of rows()){const body=JSON.parse(row.body);if(row.zone===DEFAULT_ZONE)out.default=body;else out.zones[row.zone]=body;}
  const bodies=[out.default,...Object.values(out.zones)].filter(Boolean);
  out.streams=streamsFor(bodies.flatMap(b=>SLOTS.map(k=>b[k])));
  cached=out.default||Object.keys(out.zones).length?out:null;return cached; // zones.mjs leaves the section out of the snapshot while this is null.
 }
 function usedBy(token){ // Zone rows (and story content) that name `token` in any slot.
  const zonesUsing=rows().filter(r=>SLOTS.some(k=>JSON.parse(r.body)[k]===token)).map(r=>r.zone===DEFAULT_ZONE?'Default':r.zone);
  return [...zonesUsing,...referenceScan(token)];
 }
 function gmView(){ // Everything the Music tab and the Map Editor draw.
  const mapping={};for(const row of rows())mapping[row.zone]={...JSON.parse(row.body),updated:row.updated,actor:row.actor};
  return {mapping,overrides:overrideList(),catalog:library.map(t=>({name:t.name,id:t.id,seconds:t.seconds})),uploads:uploads().map(u=>({...u,used_by:usedBy(UPLOAD_PREFIX+u.id)})),zones:zones(),defaultZone:DEFAULT_ZONE,silence:SILENCE,uploadPrefix:UPLOAD_PREFIX,uploadsEnabled:!!(uploadDir&&transcoder),kbps:transcoder?.kbps??null,maxInputBytes};
 }
 function zoneKey(value){ // '*' or a zone the server actually hosts (hubs, hub rooms, overworlds, dungeons, dives).
  if(value===DEFAULT_ZONE)return value;
  if(typeof value!=='string'||!zones().some(z=>z.id===value))fail(400,'Choose a zone from the list.');
  return value;
 }
 function track(value,key='track'){ // A slot value: null = inherit; a library name; "upload:<id>"; or silence (field slot only). Shared with story validation.
  if(value===null||value===undefined||value==='')return null;
  if(key==='track'&&value===SILENCE)return SILENCE;
  if(typeof value==='string'&&(tracks.has(value)||(value.startsWith(UPLOAD_PREFIX)&&upload(value.slice(UPLOAD_PREFIX.length)))))return value;
  fail(400,(key==='track'?'Field':key==='battle'?'Battle':'Boss')+' music: choose a song from the list'+(key==='track'?', inherit or silence.':' or the game default.'));
 }
 function gmSet(input,actor=''){ // Save one zone's row. Takes effect on the next snapshot.
  if(!input||typeof input!=='object')fail(400,'Nothing to change.');
  const zone=zoneKey(input.zone),body={};
  for(const key of SLOTS)body[key]=track(input[key],key);
  const volume=input.volume??100;if(!Number.isInteger(volume)||volume<0||volume>100)fail(400,'Volume: a whole number from 0 to 100.');body.volume=volume;
  db.prepare('INSERT INTO quest_zone_music(zone,body,updated,actor) VALUES (?,?,?,?) ON CONFLICT(zone) DO UPDATE SET body=excluded.body,updated=excluded.updated,actor=excluded.actor').run(zone,JSON.stringify(body),now(),actor);
  cached=undefined;return {zone,...body};
 }
 function gmClear(input){ // Forget one zone's row so it inherits again.
  const zone=zoneKey(input?.zone);
  db.prepare('DELETE FROM quest_zone_music WHERE zone=?').run(zone);cached=undefined;return {zone,cleared:true};
 }
 async function addUpload(buffer,title,actor=''){ // GM upload: sniff, convert (mp3 + ogg), store by content hash. Returns the upload row.
  if(!uploadDir||!transcoder)fail(409,'Song uploads are not available on this server.','music_uploads_off');
  if(!Buffer.isBuffer(buffer)||!buffer.length)fail(400,'Choose a song file to upload.');
  if(buffer.length>maxInputBytes)fail(413,'Songs can be up to '+Math.round(maxInputBytes/1024/1024)+' MB before conversion.','music_too_large');
  if(!AUDIO_SIGNATURES.some(test=>buffer.length>=12&&test(buffer)))fail(415,'Upload mp3, ogg, wav, flac or m4a.','music_bad_format');
  const name=oneLine(title);if(!name||name.length>60)fail(400,'Give the song a title of 1-60 characters.');
  const out=await transcoder.convert(buffer);
  const id=createHash('sha256').update(out.mp3).digest('hex').slice(0,32); // Same rule as the library exporter; a repeat upload lands on the same row.
  const existing=upload(id);if(existing)return {...existing,duplicate:true};
  await mkdir(uploadDir,{recursive:true});
  for(const [ext,bytes] of [['mp3',out.mp3],['ogg',out.ogg]]){const target=join(uploadDir,id+'.'+ext);await writeFile(target+'.tmp',bytes);await rename(target+'.tmp',target);} // Rename into place so a half-written file is never served.
  db.prepare('INSERT INTO quest_music_uploads(id,title,bytes,seconds,created,actor) VALUES (?,?,?,?,?,?)').run(id,name,out.mp3.length,out.seconds,now(),actor);
  cached=undefined;return upload(id);
 }
 function removeUpload(input){ // Delete an unused upload's files and row; refused while anything still plays it.
  const id=String(input?.id??'');if(!MUSIC_ID.test(id)||!upload(id))fail(404,'That upload does not exist.','music_unknown');
  const users=usedBy(UPLOAD_PREFIX+id);if(users.length)fail(409,'Still in use by: '+users.join(', ')+'. Change those first.','music_in_use');
  db.prepare('DELETE FROM quest_music_uploads WHERE id=?').run(id);
  for(const ext of ['mp3','ogg'])try{unlinkSync(join(uploadDir,id+'.'+ext));}catch{} // Already-missing files are fine; nginx's cache keeps a copy until it expires.
  cached=undefined;return {id,deleted:true};
 }
 function seconds(name){ // A song's length in seconds (library or upload), or 0 when unknown.
  if(typeof name!=='string')return 0;
  if(name.startsWith(UPLOAD_PREFIX))return upload(name.slice(UPLOAD_PREFIX.length))?.seconds??0;
  return tracks.get(name)?.seconds??0;
 }
 function override({scene=null,sting=null,keep=null,quest=null}={},at=now()){ // Per-character snapshot field musicOverride (uncached), or null when no story music applies.
  const out={};
  if(sting?.track&&sting.key&&at-(sting.at??0)<(seconds(sting.track)+15)*1000)out.sting={track:sting.track,volume:sting.volume??100,key:sting.key}; // A sting is offered only while it could still be playing.
  if(scene?.track)out.scene={track:scene.track,volume:scene.volume??100};
  if(keep?.track)out.keep={track:keep.track,volume:keep.volume??100};
  if(quest&&(quest.track||quest.battle||quest.boss))out.quest={...quest};
  if(!Object.keys(out).length)return null;
  out.streams=streamsFor([out.sting?.track,out.scene?.track,out.keep?.track,out.quest?.track,out.quest?.battle,out.quest?.boss]);
  return out;
 }
 function musicFile(id,ext){ // {path,bytes,type} for the public route and GM previews, or null for anything unknown.
  if(typeof id!=='string'||!MUSIC_ID.test(id)||!['mp3','ogg'].includes(ext))return null;
  const dir=uploadDir&&upload(id)?uploadDir:libraryIds.has(id)?libraryDir:null;if(!dir)return null;
  const path=join(dir,id+'.'+ext);if(!existsSync(path))return null;
  return {path,bytes:statSync(path).size,type:ext==='mp3'?'audio/mpeg':'audio/ogg'};
 }
 return {content,gmView,gmSet,gmClear,track,streamsFor,addUpload,removeUpload,musicFile,library:()=>library,ffmpegReady:async()=>!!transcoder&&await transcoder.available(),override,setReferenceScan(fn){referenceScan=typeof fn==='function'?fn:()=>[];},setOverrideList(fn){overrideList=typeof fn==='function'?fn:()=>[];},invalidate(){cached=undefined;}};
}
