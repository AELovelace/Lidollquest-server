// GM panel "Testing" tab (2026-10-02): a shared QA checklist of every multiplayer feature, tracked per game version.
// A build is a game client version (major.minor.patch, e.g. 0.2.1 — GAME_VERSION in the client's scrSaveMigration.gml).
// Online clients send client_version with every /zones/action command; the first time a new version connects it is added
// here automatically. GMs can also add a version by hand to start testing before anyone has connected with it.
// The highest version is the current build. Each item gets at most one result per build (pass / fail / blocked, plus a note
// and the tester's name); no row = untested. Seed items come from gm-testing-data.json and are inserted once by id, so
// panel edits and retirements survive restarts and new seed ids simply appear on the next start.
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

export const TEST_STATUSES=Object.freeze(['pass','fail','blocked']); // "untested" is the absence of a row, never stored.
export const VERSION_PATTERN=/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,20})?$/; // 0.2.1, or a pre-release tag like 0.3.0-beta.2.
const SEEN_WRITE_MS=60000; // A connected version's "last seen" is written at most once a minute per version, never per heartbeat.
const SEED=JSON.parse(readFileSync(new URL('./gm-testing-data.json',import.meta.url),'utf8')); // Shipped checklist, read once at import.

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,code:'gm_testing_invalid'});}; // Same rejection shape as the rest of gm.mjs.
const text=(value,max)=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max); // One-line, control-free, length-capped.
const note=(value,max)=>String(value??'').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g,' ').trim().slice(0,max); // Notes keep their line breaks.

export function compareVersions(a,b){ // Semantic-version order: 0.2.10 > 0.2.9, and a pre-release (0.3.0-beta) sorts before its release (0.3.0).
 const [coreA,preA='']=String(a).split('-',2),[coreB,preB='']=String(b).split('-',2);
 const x=coreA.split('.').map(Number),y=coreB.split('.').map(Number);
 for(let i=0;i<3;i++)if((x[i]??0)!==(y[i]??0))return (x[i]??0)-(y[i]??0); // Numeric major, minor, patch.
 if(preA===preB)return 0;if(!preA)return 1;if(!preB)return -1; // A full release outranks its pre-releases.
 return preA.localeCompare(preB,undefined,{numeric:true}); // beta.2 < beta.10
}

export function createTestingStore(db,{now=Date.now,seed=SEED}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS gm_test_items(id TEXT PRIMARY KEY,area TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',sort INTEGER NOT NULL,custom INTEGER NOT NULL DEFAULT 0,retired INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS gm_test_builds(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT NOT NULL UNIQUE,notes TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual',created INTEGER NOT NULL,last_seen INTEGER);
 CREATE TABLE IF NOT EXISTS gm_test_results(build INTEGER NOT NULL,item TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',tester TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '',updated INTEGER NOT NULL,PRIMARY KEY(build,item));
 CREATE INDEX IF NOT EXISTS gm_test_results_item ON gm_test_results(item,build);`); // Builds key on the version label; results key on (build,item) so re-marking just overwrites.

 const insertSeed=db.prepare('INSERT OR IGNORE INTO gm_test_items(id,area,title,detail,sort,custom,retired,created,updated) VALUES (?,?,?,?,?,0,0,?,?)'); // OR IGNORE: never clobber a GM's edit.
 (seed?.areas??[]).forEach((group,a)=>(group.items??[]).forEach((item,i)=>insertSeed.run(item.id,group.area,item.title,item.detail??'',a*1000+i,now(),now()))); // sort = area order * 1000 + position, so areas stay in report order.

 const allBuilds=()=>db.prepare('SELECT * FROM gm_test_builds').all().sort((a,b)=>compareVersions(b.label,a.label)); // Highest version first.
 const buildRow=id=>db.prepare('SELECT * FROM gm_test_builds WHERE id=?').get(Number(id))??null; // One build by id, or null.
 const itemRow=id=>db.prepare('SELECT * FROM gm_test_items WHERE id=?').get(String(id??''))??null; // One item by id, or null.
 const lastWrite=new Map(); // version -> when we last wrote last_seen (in memory, so heartbeats stay cheap).

 function seen(version){ // Called for every game command: note which client version is being played. Silently ignores junk.
  const label=String(version??'');if(!VERSION_PATTERN.test(label))return false;
  const at=now(),prior=lastWrite.get(label);
  if(prior!==undefined&&at-prior<SEEN_WRITE_MS)return false; // Already noted this minute.
  lastWrite.set(label,at);
  const added=db.prepare("INSERT OR IGNORE INTO gm_test_builds(label,notes,actor,source,created,last_seen) VALUES (?,'','','client',?,?)").run(label,at,at).changes>0; // First connection on a new version opens its checklist.
  if(!added)db.prepare('UPDATE gm_test_builds SET last_seen=? WHERE label=?').run(at,label);
  return added;
 }

 function view(buildId){ // Everything the Testing tab draws for one build (default: the highest version).
  const builds=allBuilds(),current=builds[0]??null;
  const selected=(buildId!==undefined&&buildId!==null&&buildId!=='')?builds.find(b=>b.id===Number(buildId))??current:current; // An unknown id falls back to the current build.
  const live=db.prepare('SELECT id,area,title,detail,sort,custom FROM gm_test_items WHERE retired=0 ORDER BY sort,id').all(); // Active checklist in report order.
  const retired=db.prepare('SELECT id,area,title FROM gm_test_items WHERE retired=1 ORDER BY area,title').all(); // Shown so they can be restored.
  const results=new Map(selected?db.prepare('SELECT * FROM gm_test_results WHERE build=?').all(selected.id).map(r=>[r.item,r]):[]); // This build's marks by item id.
  const previous=new Map(); // Each item's mark on the nearest LOWER version, so testers see "0.2.0: pass" while testing 0.2.1.
  if(selected){
   const older=builds.filter(b=>compareVersions(b.label,selected.label)<0); // Already highest-first.
   const marks=db.prepare('SELECT build,item,status,updated,tester FROM gm_test_results WHERE build<>?').all(selected.id);
   const byBuild=new Map();marks.forEach(r=>{if(!byBuild.has(r.build))byBuild.set(r.build,[]);byBuild.get(r.build).push(r);});
   for(const b of older)for(const r of byBuild.get(b.id)??[])if(!previous.has(r.item))previous.set(r.item,{status:r.status,label:b.label,updated:r.updated,tester:r.tester});
  }
  const items=live.map(item=>{const r=results.get(item.id);return {...item,custom:!!item.custom,status:r?.status??'untested',note:r?.note??'',tester:r?.tester??'',actor:r?.actor??'',updated:r?.updated??null,previous:previous.get(item.id)??null};}); // One row per item with its mark (or untested).
  const counts={total:items.length,pass:0,fail:0,blocked:0,untested:0};items.forEach(item=>counts[item.status]++); // Summary tiles.
  const tally=new Map(db.prepare(`SELECT build,COUNT(*) AS marked,SUM(status='pass') AS pass,SUM(status='fail') AS fail,SUM(status='blocked') AS blocked FROM gm_test_results GROUP BY build`).all().map(t=>[t.build,t])); // Quick tally per build.
  const list=builds.slice(0,100).map(b=>{const t=tally.get(b.id);return {...b,marked:t?.marked??0,pass:t?.pass??0,fail:t?.fail??0,blocked:t?.blocked??0};});
  return {current,selected,builds:list,items,retired,counts,statuses:TEST_STATUSES,areas:[...new Set(live.map(item=>item.area))]};
 }

 function startBuild(input,actor){ // Add a version by hand, e.g. before the first tester has connected with it.
  const label=text(input?.label,40);
  if(!VERSION_PATTERN.test(label))fail('Use the game version number, like 0.2.1 (or 0.3.0-beta.1).');
  if(db.prepare('SELECT 1 FROM gm_test_builds WHERE label=?').get(label))fail('Version '+label+' is already on the list.',409);
  const id=Number(db.prepare("INSERT INTO gm_test_builds(label,notes,actor,source,created) VALUES (?,?,?,'manual',?)").run(label,note(input?.notes,1000),actor??'',now()).lastInsertRowid);
  return buildRow(id);
 }

 function buildNotes(input){ // Edit a version's "what changed" note (client-added versions start with none).
  const build=buildRow(input?.build)??fail('Choose a version first.',404);
  db.prepare('UPDATE gm_test_builds SET notes=? WHERE id=?').run(note(input?.notes,1000),build.id);
  return buildRow(build.id);
 }

 function mark(input,actor){ // Record (or clear) one item's result on one build.
  const build=buildRow(input?.build)??fail('Choose a version first.',404),item=itemRow(input?.item)??fail('That checklist item no longer exists.',404);
  const status=String(input?.status??'');
  if(status==='untested'){db.prepare('DELETE FROM gm_test_results WHERE build=? AND item=?').run(build.id,item.id);return {build:build.id,item:item.id,status:'untested'};} // Clearing removes the row.
  if(!TEST_STATUSES.includes(status))fail('Status must be pass, fail, blocked or untested.');
  const row={build:build.id,item:item.id,status,note:note(input?.note,1000),tester:text(input?.tester,40),actor:actor??'',updated:now()};
  db.prepare('INSERT INTO gm_test_results(build,item,status,note,tester,actor,updated) VALUES (?,?,?,?,?,?,?) ON CONFLICT(build,item) DO UPDATE SET status=excluded.status,note=excluded.note,tester=excluded.tester,actor=excluded.actor,updated=excluded.updated')
   .run(row.build,row.item,row.status,row.note,row.tester,row.actor,row.updated); // Last tester wins; the panel shows who and when.
  return row;
 }

 function saveItem(input){ // Add a custom item, or edit any item's area/title/detail.
  const area=text(input?.area,40),title=text(input?.title,120),detail=note(input?.detail,600);
  if(!area||!title)fail('An item needs an area and a title.');
  const existing=input?.id?itemRow(input.id):null;
  if(input?.id&&!existing)fail('That checklist item no longer exists.',404);
  if(existing){db.prepare('UPDATE gm_test_items SET area=?,title=?,detail=?,updated=? WHERE id=?').run(area,title,detail,now(),existing.id);return itemRow(existing.id);} // Results stay attached by id.
  const last=db.prepare('SELECT MAX(sort) AS s FROM gm_test_items WHERE area=?').get(area)?.s; // New items go to the end of their area...
  const sort=last===null||last===undefined?(db.prepare('SELECT MAX(sort) AS s FROM gm_test_items').get()?.s??0)+1000:last+1; // ...or open a new area after the last one.
  const id='custom-'+randomUUID().slice(0,8);
  db.prepare('INSERT INTO gm_test_items(id,area,title,detail,sort,custom,retired,created,updated) VALUES (?,?,?,?,?,1,0,?,?)').run(id,area,title,detail,sort,now(),now());
  return itemRow(id);
 }

 function retireItem(input){ // Hide an item that no longer applies (or bring it back); its old results are kept.
  const item=itemRow(input?.id)??fail('That checklist item no longer exists.',404),retired=input?.retired===false?0:1;
  db.prepare('UPDATE gm_test_items SET retired=?,updated=? WHERE id=?').run(retired,now(),item.id);
  return {id:item.id,title:item.title,retired:!!retired};
 }

 return {view,seen,startBuild,buildNotes,mark,saveItem,retireItem};
}
