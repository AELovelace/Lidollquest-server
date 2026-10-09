// Zone music: which game track plays in each online zone, picked by a GM on the /gm Music tab. Each zone row has three
// slots: field (walking around), battle and boss. Blank slots inherit: a hub room falls back to its parent hub, then to
// the Default row (zone '*'), and a blank battle/boss slot finally means the game's own `combat` / `boss` tracks.
// The client resolves the inheritance (scrMusic.gml online_music_slot) from the snapshot's `zoneMusic` section, which is
// hash-cached (snapshot-cache.mjs), so it only travels after a GM edit. Settings follow welcome.mjs: one small table,
// cached in memory, with a snapshot-epoch domain ('music') so the read-only snapshot workers drop their cache too.
// The track list (music-catalog.json) and the preview mp3s (music-preview/) come from the game repo's
// python/export_online_music.py; re-run it after importing a new track into the `bgm` audio group.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const fail=(status,message,code='zone_music_invalid')=>{throw Object.assign(Error(message),{status,code});}; // Same rejection shape as welcome.mjs.
export const DEFAULT_ZONE='*'; // The Default row: what plays where neither the zone nor its parent hub has a track.
export const SILENCE='none'; // Field slot only: this zone plays no music at all.
export const SLOTS=Object.freeze(['track','battle','boss']); // field, battle and boss music.
const TRACK_NAME=/^[A-Za-z][A-Za-z0-9_]{0,63}$/; // GameMaker asset names; also keeps preview paths inside music-preview/.
export const PREVIEW_DIR=fileURLToPath(new URL('./music-preview/',import.meta.url)); // Exported mp3 copies for the panel's preview button.

export function loadMusicCatalog(){ // [{name,file,duration}] from the exporter, or [] on a server that has not been given one yet.
 try{const list=JSON.parse(readFileSync(new URL('./music-catalog.json',import.meta.url),'utf8'));return Array.isArray(list)?list.filter(t=>t&&TRACK_NAME.test(t.name)):[];}catch(error){return [];}
}

export function createZoneMusic(db,{now=Date.now,catalog=loadMusicCatalog(),zones=()=>[]}={}){ // zones(): [{id,name,category,parent?}] for the panel and for validating ids.
 db.exec('CREATE TABLE IF NOT EXISTS quest_zone_music(zone TEXT PRIMARY KEY,body TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT \'\')'); // One row per mapped zone; '*' is the Default.
 const tracks=new Set(catalog.map(t=>t.name)); // Names a GM may pick.
 let cached; // undefined = not built yet; null = nothing mapped (the client keeps today's behaviour).
 function rows(){return db.prepare('SELECT zone,body,updated,actor FROM quest_zone_music ORDER BY zone').all();}
 function content(){ // Snapshot section: {default, zones:{id:{track,battle,boss,volume}}}, or null while nothing is mapped.
  if(cached!==undefined)return cached;
  const out={default:null,zones:{}};
  for(const row of rows()){const body=JSON.parse(row.body);if(row.zone===DEFAULT_ZONE)out.default=body;else out.zones[row.zone]=body;}
  cached=out.default||Object.keys(out.zones).length?out:null;return cached; // zones.mjs leaves the section out of the snapshot while this is null.
 }
 function gmView(){ // Everything the Music tab draws: the saved rows (with who/when), the track list and the zone list.
  const mapping={};for(const row of rows())mapping[row.zone]={...JSON.parse(row.body),updated:row.updated,actor:row.actor};
  return {mapping,catalog:catalog.map(t=>({name:t.name,duration:t.duration??0})),zones:zones(),defaultZone:DEFAULT_ZONE,silence:SILENCE};
 }
 function zoneKey(value){ // '*' or a zone the server actually hosts (hubs, hub rooms, overworlds, dungeons, dives).
  if(value===DEFAULT_ZONE)return value;
  if(typeof value!=='string'||!zones().some(z=>z.id===value))fail(400,'Choose a zone from the list.');
  return value;
 }
 function slot(value,key){ // null = inherit; a catalog track; or silence (field slot only).
  if(value===null||value===undefined||value==='')return null;
  if(key==='track'&&value===SILENCE)return SILENCE;
  if(typeof value!=='string'||!tracks.has(value))fail(400,(key==='track'?'Field':key==='battle'?'Battle':'Boss')+' music: choose a track from the list'+(key==='track'?', inherit or silence.':' or the game default.'));
  return value;
 }
 function gmSet(input,actor=''){ // Save one zone's row. Takes effect on the next snapshot.
  if(!input||typeof input!=='object')fail(400,'Nothing to change.');
  const zone=zoneKey(input.zone),body={};
  for(const key of SLOTS)body[key]=slot(input[key],key);
  const volume=input.volume??100;if(!Number.isInteger(volume)||volume<0||volume>100)fail(400,'Volume: a whole number from 0 to 100.');body.volume=volume;
  db.prepare('INSERT INTO quest_zone_music(zone,body,updated,actor) VALUES (?,?,?,?) ON CONFLICT(zone) DO UPDATE SET body=excluded.body,updated=excluded.updated,actor=excluded.actor').run(zone,JSON.stringify(body),now(),actor);
  cached=undefined;return {zone,...body};
 }
 function gmClear(input){ // Forget one zone's row so it inherits again.
  const zone=zoneKey(input?.zone);
  db.prepare('DELETE FROM quest_zone_music WHERE zone=?').run(zone);cached=undefined;return {zone,cleared:true};
 }
 function previewFile(name){ // Absolute mp3 path for GET /gm/music/<name>.mp3, or null for anything not in the catalog.
  return typeof name==='string'&&TRACK_NAME.test(name)&&tracks.has(name)?join(PREVIEW_DIR,name+'.mp3'):null;
 }
 return {content,gmView,gmSet,gmClear,previewFile,catalog:()=>catalog,invalidate(){cached=undefined;}};
}
