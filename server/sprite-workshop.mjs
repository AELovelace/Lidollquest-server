import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {craftingData} from './crafting.mjs';
import {decodePng,encodePng} from './png-codec.mjs';
import {validateWorldPng} from './world-png.mjs';

const stores=new WeakMap(),shipped=JSON.parse(readFileSync(new URL('./sprite-lab-sheets.json',import.meta.url),'utf8')).sheets;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,code:'sprite_workshop_failed'});};
const identity=i=>{if(!i||typeof i.owner!=='string'||!i.owner)fail('Sign in first.',401);return i;};
const named=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>64||/[\x00-\x1f]/.test(value))fail('Names must contain 1 to 64 characters.');return value.trim();};
export function workshopMetadata(previous,input){ // Only presentation fields are editable; ownership, slot, premium status and asset identity stay server-owned.
 const meta=structuredClone(previous),rgb=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isInteger(n)&&n>=0&&n<=255),fraction=n=>Number.isFinite(n)&&n>=0&&n<=1;
 if(input.name!==undefined)meta.name=named(input.name);
 if(input.hides!==undefined){if(!Array.isArray(input.hides)||input.hides.length>4||input.hides.some(s=>!craftingData.sprite_lab.order.includes(s)||s==='base'||s===meta.slot))fail('Choose other clothing slots to hide.');meta.hides=[...new Set(input.hides)];}
 if(input.channels!==undefined){
  if(!Array.isArray(input.channels)||input.channels.length>8)fail('Use up to eight tint channels.');
  let colours=0;const seen=new Set();
  meta.channels=input.channels.map(c=>{
   if(!c||!Array.isArray(c.source)||!c.source.length||!Array.isArray(c.shade)||c.shade.length!==c.source.length)fail('Each tint channel needs matching source colours and shades.');
   colours+=c.source.length;if(colours>8)fail('Use up to eight source colours across all channels.');
   const kind=c.kind??'';if(!['','skin','eyes'].includes(kind)||(kind&&meta.slot!=='base'))fail('Skin and eye channels belong to body layers.');
   if((kind==='skin'&&c.source.length>4)||(kind==='eyes'&&c.source.length!==1))fail('Skin uses up to four shades; eyes use one.');
   for(const colour of c.source){if(!rgb(colour)||(!kind&&(colour[0]!==colour[1]||colour[1]!==colour[2]))||seen.has(colour.join(',')))fail('Tint sources must be unique RGB colours; clothing uses grey shades.');seen.add(colour.join(','));}
   if(c.shade.some(s=>kind==='skin'?!(Array.isArray(s)&&s.length===3&&s.every(fraction)):!fraction(s)))fail('Tint shades must be between zero and one.');
   if(c.default_rgb!==undefined&&!rgb(c.default_rgb))fail('Choose a valid default RGB colour.');
   if(c.palette!==undefined&&!Object.hasOwn(craftingData.sprite_lab.swatches,c.palette))fail('Choose a registered colour palette.');
   return {name:named(c.name),source:structuredClone(c.source),shade:structuredClone(c.shade),...(kind?{kind}:{}),...(c.default_rgb?{default_rgb:[...c.default_rgb]}:{}),...(c.palette?{palette:c.palette}:{})};
  });
 }
 return meta;
}
export function workshopPng(png){ // Canonicalize bounded, exact-size pixel sheets before saving any client input.
 if(typeof png!=='string'||png.length>100000||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(png))fail('Upload a PNG sheet, not a URL.');
 const bytes=Buffer.from(png,'base64');
 if(bytes.length<33||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(16)!==128||bytes.readUInt32BE(20)!==128)fail('Piko sheets must be exactly 128 x 128 pixels (sixteen 32 x 32 frames).');
 validateWorldPng(bytes,128,128);return encodePng(decodePng(bytes)).toString('base64');
}
export function workshopStrip(png){ // Preserve row-major frame order and every transparent border for GameMaker's strip loader.
 const sheet=decodePng(Buffer.from(workshopPng(png),'base64')),data=new Uint8Array(512*32*4);
 for(let frame=0;frame<16;frame++)for(let y=0;y<32;y++){
  const start=((Math.floor(frame/4)*32+y)*128+(frame%4)*32)*4;
  data.set(sheet.data.subarray(start,start+128),(y*512+frame*32)*4);
 }
 return encodePng({width:512,height:32,data}).toString('base64');
}
export function spriteWorkshop(db,{now=Date.now}={}){
 if(stores.has(db))return stores.get(db);
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sprite_workshop'").get())db.exec(`
 CREATE TABLE sprite_workshop(id TEXT PRIMARY KEY,owner TEXT NOT NULL,shared INTEGER NOT NULL,meta TEXT NOT NULL,png TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,published INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
 CREATE TABLE sprite_workshop_versions(id TEXT NOT NULL,version INTEGER NOT NULL,meta TEXT NOT NULL,png TEXT NOT NULL,hash TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(id,version));
 CREATE INDEX sprite_workshop_owner ON sprite_workshop(owner,shared);`);
 let cachedKey='',published=[];
 function rows(){ // Refresh across worker connections without keeping another process's stale catalog.
  const tag=JSON.stringify(db.prepare('SELECT id,published FROM sprite_workshop WHERE published>0 ORDER BY id').all()); // Exact version keys cannot collide when a different record is published by another worker.
  if(tag!==cachedKey){published=db.prepare('SELECT s.id,s.owner,s.shared,v.meta,v.hash,v.version FROM sprite_workshop s JOIN sprite_workshop_versions v ON v.id=s.id AND v.version=s.published').all();cachedKey=tag;}
  return published;
 }
 const metadata=r=>({...JSON.parse(r.meta),revision:r.version,hash:r.hash,personal:!r.shared});
 function catalog(){const overrides=new Map(rows().map(r=>[r.id,metadata(r)]));return structuredClone({...craftingData.sprite_lab,assets:[...craftingData.sprite_lab.assets.map(a=>{const edited=overrides.get(a.id);overrides.delete(a.id);return edited??a;}),...overrides.values()]});}
 const owned=owner=>rows().filter(r=>!r.shared&&r.owner===owner).map(r=>r.id);
 function manifest(owner,referenced=[]){const refs=new Set(referenced);return rows().filter(r=>r.shared||r.owner===owner||refs.has(r.id)).map(metadata);}
 function authorize(i,row){identity(i);if(!row)fail('Sprite draft not found.',404);if(row.shared?i.gamemaster!==true:row.owner!==i.owner)fail('You cannot edit this sprite.',403);return row;}
 const draft=(i,id)=>{const r=authorize(i,db.prepare('SELECT * FROM sprite_workshop WHERE id=?').get(id));return {...JSON.parse(r.meta),png:r.png,revision:r.revision,published:r.published,shared:!!r.shared,history:db.prepare('SELECT version,hash,created FROM sprite_workshop_versions WHERE id=? ORDER BY version DESC LIMIT 20').all(id)};};
 function sheet(i,id){
  identity(i);
  const row=rows().find(r=>r.id===id);
  if(row){if(!row.shared&&row.owner!==i.owner)fail('This personal sprite belongs to another account.',403);return db.prepare('SELECT png FROM sprite_workshop_versions WHERE id=? AND version=?').get(id,row.version).png;}
  const asset=craftingData.sprite_lab.assets.find(a=>a.id===id);if(!asset||!shipped[asset.sprite])fail('Sprite not found.',404);return shipped[asset.sprite];
 }
 function view(i){identity(i);const cat=catalog(),own=new Set(owned(i.owner));return {catalog:{...cat,assets:cat.assets.filter(a=>!a.personal||own.has(a.id))},drafts:db.prepare('SELECT id,meta,revision,published,shared FROM sprite_workshop WHERE owner=? OR (shared=1 AND ?=1) ORDER BY updated DESC').all(i.owner,i.gamemaster===true?1:0).map(r=>({...JSON.parse(r.meta),revision:r.revision,published:r.published,shared:!!r.shared})),gamemaster:i.gamemaster===true};}
 function mutate(i,input){
  identity(i);if(!input||typeof input!=='object'||Array.isArray(input))fail('Choose a sprite action.');
  const action=input.action;
  if(action==='create'){
   const shared=input.shared===true;if(shared&&i.gamemaster!==true)fail('Shared artwork requires a gamemaster.',403);
   if(db.prepare('SELECT COUNT(*) AS n FROM sprite_workshop WHERE owner=? AND shared=?').get(i.owner,shared?1:0).n>=(shared?500:32))fail('Sprite draft limit reached.',409);
   const source=catalog().assets.find(a=>a.id===input.source);
   if(input.source&&!source)fail('Choose a registered source sprite.');
   if(source?.personal&&!owned(i.owner).includes(source.id))fail('This personal sprite belongs to another account.',403);
   if(!shared&&source&&!source.personal&&(source.premium||(catalog().slots.find(s=>s.id===source.slot)?.accessory))&&(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='look_unlocks'").get()||!db.prepare("SELECT 1 FROM look_unlocks WHERE owner=? AND asset=?").get(i.owner,source.id)))fail('Unlock this source in the wardrobe before copying it.',403);
   const replace=input.replace===true;if(replace&&(!shared||!source||source.personal))fail('Only shared sprites can be replaced.',403);
   const id=replace?source.id:'workshop_'+randomUUID().replaceAll('-','');
   if(db.prepare('SELECT 1 FROM sprite_workshop WHERE id=?').get(id))fail('A draft for this shared sprite already exists; open it instead.',409);
   const slot=source?.slot??input.slot;if(!catalog().order.includes(slot))fail('Choose a valid wardrobe slot.');
   const name=named(input.name??source?.name??'New sprite');
   const meta={...(source??{channels:[]}),id,name,slot,template:'piko_32_v1',sprite:replace?source.sprite:id,...(!replace?{premium:false}:{} )};delete meta.hash;delete meta.revision;delete meta.personal;
   const png=source?sheet(i,source.id):encodePng({width:128,height:128,data:new Uint8Array(128*128*4)}).toString('base64');
   db.prepare('INSERT INTO sprite_workshop(id,owner,shared,meta,png,updated) VALUES (?,?,?,?,?,?)').run(id,i.owner,shared?1:0,JSON.stringify(meta),png,now());return draft(i,id);
  }
  if(typeof input.id!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(input.id))fail('Choose a valid sprite draft.');
  const row=authorize(i,db.prepare('SELECT * FROM sprite_workshop WHERE id=?').get(input.id));
  if(!Number.isSafeInteger(input.revision)||input.revision!==row.revision)fail('This draft changed in another tab. Reopen it before saving.',409);
  if(action==='save'||action==='restore'){
   const previous=action==='restore'?db.prepare('SELECT png,meta FROM sprite_workshop_versions WHERE id=? AND version=?').get(row.id,input.version):null;
   if(action==='restore'&&!previous)fail('Published version not found.',404);
   const png=previous?.png??workshopPng(input.png),meta=previous?JSON.parse(previous.meta):workshopMetadata(JSON.parse(row.meta),input);
   db.prepare('UPDATE sprite_workshop SET png=?,meta=?,revision=revision+1,updated=? WHERE id=?').run(png,JSON.stringify(meta),now(),row.id);
  }else if(action==='publish'){
   const decoded=decodePng(Buffer.from(row.png,'base64'));if(!decoded.data.some((n,k)=>k%4===3&&n))fail('Draw some pixels before publishing.');
   const version=row.published+1,hash=createHash('sha256').update(row.png).update(row.meta).digest('hex');
   db.prepare('INSERT INTO sprite_workshop_versions VALUES (?,?,?,?,?,?,?)').run(row.id,version,row.meta,row.png,hash,i.owner,now());
   db.prepare('UPDATE sprite_workshop SET published=?,revision=revision+1,updated=? WHERE id=?').run(version,now(),row.id);
  }else fail('Unknown sprite action.');
  return draft(i,row.id);
 }
 function act(i,input){ // Check revisions and write in one transaction; SQLite rejects a stale read-to-write upgrade. Savepoints compose with existing transactions.
  db.exec('SAVEPOINT sprite_workshop_write');try{const result=mutate(i,input);db.exec('RELEASE sprite_workshop_write');cachedKey='';return result;}catch(error){db.exec('ROLLBACK TO sprite_workshop_write');db.exec('RELEASE sprite_workshop_write');cachedKey='';throw error;}
 }
 function asset(id,hash){ // Published art is visible in-world; drafts never cross the gameplay API.
  if(typeof id!=='string'||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))fail('Choose a published sprite hash.');
  const row=db.prepare('SELECT png FROM sprite_workshop_versions WHERE id=? AND hash=?').get(id,hash);if(!row)fail('Published sprite version not found.',404);
  return {id,hash,png:workshopStrip(row.png),frames:16,width:512,height:32}; // Immutable old hashes remain usable while a client finishes an earlier snapshot.
 }
 function gmLab(){const sheets={...shipped};for(const row of rows().filter(r=>r.shared))sheets[JSON.parse(row.meta).sprite]=db.prepare('SELECT png FROM sprite_workshop_versions WHERE id=? AND version=?').get(row.id,row.version).png;return {catalog:{...catalog(),assets:catalog().assets.filter(a=>!a.personal)},sheets};}
 const store={catalog,owned,manifest,draft,sheet,view,act,asset,gmLab};stores.set(db,store);return store;
}
