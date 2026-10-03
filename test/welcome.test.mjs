import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createWelcome,WELCOME_DEFAULTS,welcomeLinks,allowedButtonUrl} from '../server/welcome.mjs';
import {createQuestService} from '../server/service.mjs';
import {CACHED_SECTIONS} from '../server/snapshot-cache.mjs';

// Welcome tutorial (welcome.mjs): GM-edited pages shown once per new character. The snapshot carries `welcome`
// (content, cached) and `welcomeDue` (show it now?); the client answers with the `welcome_done` action.

const INSTALL=Date.parse('2026-10-03T12:00:00Z');
function store(){let time=INSTALL;const db=new DatabaseSync(':memory:');const w=createWelcome(db,{now:()=>time});return {db,w,advance:ms=>{time+=ms;},time:()=>time};}

test('defaults: four pages, wiki and store buttons, content() mirrors the settings and hides when disabled',()=>{
 const {db,w}=store();
 try{
  const links=welcomeLinks();
  assert.equal(WELCOME_DEFAULTS.enabled,true);assert.equal(WELCOME_DEFAULTS.show_to_existing,false);assert.equal(WELCOME_DEFAULTS.title,'Welcome to LiDollQuest');
  assert.equal(WELCOME_DEFAULTS.pages.length,4);
  assert.deepEqual(WELCOME_DEFAULTS.pages.map(p=>p.button),[null,null,{label:'Open the wiki',url:links.wiki},{label:'Visit the store',url:links.store}]);
  assert.match(WELCOME_DEFAULTS.pages[1].body,/Pip/,'the movement page points at the tutor');
  assert.deepEqual(w.settings(),WELCOME_DEFAULTS,'no rows stored yet: pure defaults');
  assert.equal(w.installed,INSTALL,'the install epoch is the creation time');
  const content=w.content();assert.equal(content.title,'Welcome to LiDollQuest');assert.equal(content.pages.length,4);assert.deepEqual(Object.keys(content.pages[0]).sort(),['body','button','heading']);
  w.gmSet({enabled:false},'gm');assert.equal(w.content(),null,'disabled: nothing to render');
  const view=w.gmView();assert.equal(view.settings.enabled,false);assert.deepEqual(view.defaults,WELCOME_DEFAULTS);assert.deepEqual(view.links,links);assert.equal(view.installed,INSTALL);assert.equal(view.limits.pages,8);
  assert.ok(db.prepare('SELECT 1 FROM quest_welcome_settings WHERE key=?').get('installed'),'the epoch is a stored row');
 }finally{db.close();}
});

test('links come from the environment with lidoll.dev defaults',()=>{
 const saved={...process.env};
 try{
  delete process.env.LIDOLLQUEST_WIKI_URL;delete process.env.LIDOLLQUEST_STORE_URL;delete process.env.LIDOLLQUEST_DISCORD_URL;
  assert.deepEqual(welcomeLinks(),{wiki:'https://lidoll.dev/wiki/',store:'https://lidoll.dev/tracker/store/',discord:'https://discord.gg/mZFRQvZ9d3'});
  process.env.LIDOLLQUEST_WIKI_URL='https://wiki.lidoll.dev/';process.env.LIDOLLQUEST_STORE_URL='https://lidoll.dev/shop/';process.env.LIDOLLQUEST_DISCORD_URL='https://discord.gg/other';
  assert.deepEqual(welcomeLinks(),{wiki:'https://wiki.lidoll.dev/',store:'https://lidoll.dev/shop/',discord:'https://discord.gg/other'});
 }finally{for(const k of ['LIDOLLQUEST_WIKI_URL','LIDOLLQUEST_STORE_URL','LIDOLLQUEST_DISCORD_URL']){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
});

test('gmSet validates switches, title, pages, bodies and the button link allow-list',()=>{
 const {db,w}=store();
 try{
  const page=(extra={})=>({heading:'Hi',body:'There',button:null,...extra});
  assert.throws(()=>w.gmSet({},'gm'),/Nothing to change/);
  assert.throws(()=>w.gmSet({enabled:'yes'},'gm'),/true or false/);
  assert.throws(()=>w.gmSet({show_to_existing:1},'gm'),/true or false/);
  assert.throws(()=>w.gmSet({title:''},'gm'),/Title: 1-60/);
  assert.throws(()=>w.gmSet({title:'x'.repeat(61)},'gm'),/Title: 1-60/);
  assert.equal(w.gmSet({title:'  Hello\n\u0007 there  '},'gm').title,'Hello there','titles are one clean line');
  assert.throws(()=>w.gmSet({pages:[]},'gm'),/1-8 pages/);
  assert.throws(()=>w.gmSet({pages:Array.from({length:9},()=>page())},'gm'),/1-8 pages/);
  assert.throws(()=>w.gmSet({pages:['nope']},'gm'),/Page 1: each page must be an object/);
  assert.throws(()=>w.gmSet({pages:[page({heading:''})]},'gm'),/Page 1: heading must be 1-60/);
  assert.throws(()=>w.gmSet({pages:[page(),page({heading:'h'.repeat(61)})]},'gm'),/Page 2: heading/);
  assert.throws(()=>w.gmSet({pages:[page({body:'b'.repeat(601)})]},'gm'),/body must be 1-600/);
  assert.throws(()=>w.gmSet({pages:[page({body:'   '})]},'gm'),/body must be 1-600/);
  assert.throws(()=>w.gmSet({pages:[page({button:'x'})]},'gm'),/button must be null/);
  assert.throws(()=>w.gmSet({pages:[page({button:{label:'',url:'https://lidoll.dev/'}})]},'gm'),/button label must be 1-24/);
  assert.throws(()=>w.gmSet({pages:[page({button:{label:'l'.repeat(25),url:'https://lidoll.dev/'}})]},'gm'),/button label must be 1-24/);
  for(const bad of ['http://lidoll.dev/wiki/','https://evil.example/','https://lidoll.dev.evil.example/','https://notlidoll.dev/','javascript:alert(1)','','https://sub.discord.gg/x'])
   assert.throws(()=>w.gmSet({pages:[page({button:{label:'Go',url:bad}})]},'gm'),/https:\/\/ and point at lidoll\.dev/,'rejects '+bad);
  for(const good of ['https://lidoll.dev/wiki/','https://sub.lidoll.dev/x','https://discord.gg/abc'])assert.equal(allowedButtonUrl(good),good,'accepts '+good);
  const saved=w.gmSet({pages:[page({body:'Line one\r\n\r\n\r\n\r\nLine\ttwo \u0001here  ',button:{label:' Open ','url':'https://sub.lidoll.dev/x'}}),page({heading:'Two'})]},'gm');
  assert.equal(saved.pages.length,2);assert.equal(saved.pages[0].body,'Line one\n\nLine two here','bodies keep line breaks, lose control characters and runs of blank lines');
  assert.deepEqual(saved.pages[0].button,{label:'Open',url:'https://sub.lidoll.dev/x'});assert.equal(saved.pages[1].button,null);
  assert.equal(saved.title,'Hello there','untouched settings survive a pages-only save');
  assert.equal(w.settings().pages.length,2,'the cache was refreshed');
  const fresh=createWelcome(db,{now:()=>INSTALL+5}); // A second process (snapshot worker) reads the same rows.
  assert.equal(fresh.settings().pages.length,2);assert.equal(fresh.installed,INSTALL,'INSERT OR IGNORE keeps the first epoch');
  assert.deepEqual(w.reset('gm'),WELCOME_DEFAULTS,'reset returns the defaults');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quest_welcome_settings').get().n,1,'only the installed row remains');
  assert.equal(w.installed,INSTALL);
 }finally{db.close();}
});

test('due() follows the install epoch, the show_to_existing switch and the seen marker; markSeen keeps the first timestamp',()=>{
 const {db,w,advance,time}=store();
 try{
  const older={id:'old',created:INSTALL-1},newer={id:'new',created:INSTALL},later={id:'later',created:INSTALL+86400000};
  assert.equal(w.due(newer,{}),true);assert.equal(w.due(later,{}),true);
  assert.equal(w.due(older,{}),false,'created before the feature: left alone by default');
  assert.equal(w.due(null,{}),false);assert.equal(w.due(newer,null),false);
  w.gmSet({show_to_existing:true},'gm');assert.equal(w.due(older,{}),true,'opted in: everyone who has not seen it');
  w.gmSet({enabled:false},'gm');assert.equal(w.due(newer,{}),false,'off: nobody');
  w.gmSet({enabled:true},'gm');
  const state={};advance(1000);const first=time();w.markSeen(state);assert.equal(state.welcomeSeen,first);
  advance(5000);w.markSeen(state);assert.equal(state.welcomeSeen,first,'idempotent');
  assert.equal(w.due(newer,state),false);assert.equal(w.due(older,state),false,'seen characters never see it again, whatever the switches say');
 }finally{db.close();}
});

// ── End to end: the snapshot and the welcome_done action ───────────────────
const playerToken='p'.repeat(43),owner='o'.repeat(64),staffToken='s'.repeat(43),staff='a'.repeat(64);
const loadout={player_info:{playerHealth:50,playerHealthMax:50,level:1,str:10,def:10,dex:10,int:10,cha:2},inventory:[],player_spells:[]};
function harness(){ // Drives the player gateway and the /gm panel exactly as the game and the browser do (see announcements.test.mjs).
 let now=Date.parse('2026-10-03T12:00:00Z');
 const accounts={[staffToken]:{owner:staff,gamemaster:true},[playerToken]:{owner,gamemaster:false}};
 const walletClient={async authenticate(secret){const a=accounts[secret];if(!a)throw Object.assign(Error('No account'),{status:401});return {owner:a.owner,id:'grant-'+a.owner.slice(0,4),client:'lidollquest',coins:0,scope:'',gamemaster:a.gamemaster,blockedAccounts:[]};}};
 const service=createQuestService({now:()=>now,walletClient,gmEnabled:true});
 const started=new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const held={},base=()=>'http://127.0.0.1:'+service.server.address().port;
 async function play(secret,action,extra={}){
  now+=500;
  const body={action,character_id:held[secret]?.id,revision:held[secret]?.revision,request_id:randomUUID(),controller:'window',...extra};
  const response=await fetch(base()+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(result.character)held[secret]=result.character;
  return {status:response.status,result};
 }
 const ok=async(secret,action,extra={})=>{const r=await play(secret,action,extra);assert.equal(r.status,200,JSON.stringify(r.result));return r.result;};
 const gm=async(path,init={})=>{const response=await fetch(base()+path,{method:init.method??'GET',headers:{Authorization:'Bearer '+(init.token??staffToken),...(init.body?{'Content-Type':'application/json'}:{})},body:init.body?JSON.stringify(init.body):undefined});return {status:response.status,body:await response.json().catch(()=>({}))};};
 const act=(action,payload={},init={})=>gm('/gm/action',{method:'POST',body:{action,...payload},...init});
 const audit=action=>service.db.prepare('SELECT * FROM gm_audit WHERE action=?').all(action);
 return {service,started,play,ok,gm,act,audit,advance:ms=>{now+=ms;},close:async()=>{service.server.closeAllConnections();await new Promise(resolve=>service.server.close(resolve));}};
}

test('a fresh character gets welcome + welcomeDue in every snapshot; welcome_done flips it off and replays safely; the GM panel edits and audits it',async()=>{
 const h=harness();await h.started;
 try{
  const created=await h.ok(playerToken,'create',{name:'Poppy'});
  assert.equal(created.capabilities.welcome,true);assert.deepEqual(created.capabilities.links,welcomeLinks());
  assert.equal(created.welcome.title,'Welcome to LiDollQuest');assert.equal(created.welcome.pages.length,4);
  assert.equal(created.welcomeDue,true,'due right after creation, before entering any hub');
  const entered=await h.ok(playerToken,'enter',{zone:'honeydew-lantern',loadout,quest_version:1,content_version:1,combat_version:3});
  assert.equal(entered.welcomeDue,true);assert.equal(entered.welcome.pages[2].button.url,welcomeLinks().wiki);
  const request_id=randomUUID();
  const done=await h.ok(playerToken,'welcome_done',{request_id});
  assert.equal(done.welcomeDue,false,'closed: not due any more');assert.equal(done.receipt.action,'welcome_done');assert.ok(done.welcome,'the content itself stays in the snapshot for the client to show on demand');
  const stored=JSON.parse(h.service.db.prepare('SELECT state FROM quest_characters WHERE name=?').get('Poppy').state);assert.ok(stored.welcomeSeen>0,'remembered on the character');
  const replay=await h.play(playerToken,'welcome_done',{request_id,revision:done.receipt.revision-1});assert.equal(replay.status,200,'the same request id returns the stored receipt');assert.equal(replay.result.receipt.revision,done.receipt.revision);
  assert.equal((await h.ok(playerToken,'heartbeat')).welcomeDue,false);
  // Snapshot cache: welcome is a cached section, welcomeDue is not.
  assert.ok(CACHED_SECTIONS.includes('welcome'));assert.ok(!CACHED_SECTIONS.includes('welcomeDue'));
  // GM panel: view, edit (with a bad link refused), audit, reset; the switch hides the content from snapshots.
  const view=await h.gm('/gm/welcome');assert.equal(view.status,200);assert.equal(view.body.settings.pages.length,4);assert.equal(view.body.links.discord,welcomeLinks().discord);
  assert.equal((await h.gm('/gm/welcome',{token:playerToken})).status,403,'players cannot read the panel');
  const refused=await h.act('welcome_settings',{pages:[{heading:'Hi',body:'x',button:{label:'Go',url:'https://evil.example/'}}]});assert.equal(refused.status,400);assert.match(refused.body.error_description,/Page 1: button links/);
  const saved=await h.act('welcome_settings',{title:'Hello, dolls',pages:[{heading:'One',body:'First page.',button:{label:'Chat',url:'https://discord.gg/abc'}}]});
  assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.result.title,'Hello, dolls');assert.equal(saved.body.result.pages.length,1);
  assert.equal(h.audit('welcome_settings').length,1);assert.deepEqual(JSON.parse(h.audit('welcome_settings')[0].detail),{enabled:true,show_to_existing:false,title:'Hello, dolls',pages:1});
  const after=await h.ok(playerToken,'heartbeat');assert.equal(after.welcome.title,'Hello, dolls');assert.deepEqual(after.welcome.pages[0].button,{label:'Chat',url:'https://discord.gg/abc'});
  assert.equal((await h.act('welcome_settings',{enabled:false})).status,200);assert.equal((await h.ok(playerToken,'heartbeat')).welcome,null,'off: no content in the snapshot');
  const reset=await h.act('welcome_reset',{});assert.equal(reset.status,200);assert.equal(reset.body.result.pages.length,4);assert.equal(reset.body.result.enabled,true);assert.equal(h.audit('welcome_reset').length,1);
  assert.equal((await h.ok(playerToken,'heartbeat')).welcome.title,'Welcome to LiDollQuest');
  // show_to_existing: an older character (created before install) is reached only with the switch on.
  const old=h.service.db.prepare('SELECT * FROM quest_characters WHERE name=?').get('Poppy');
  h.service.db.prepare('UPDATE quest_characters SET created=?,state=? WHERE id=?').run(0,JSON.stringify((()=>{const s=JSON.parse(old.state);delete s.welcomeSeen;return s;})()),old.id); // Pretend Poppy predates the feature and never closed it.
  assert.equal((await h.ok(playerToken,'heartbeat')).welcomeDue,false,'older character, switch off');
  assert.equal((await h.act('welcome_settings',{show_to_existing:true})).status,200);
  assert.equal((await h.ok(playerToken,'heartbeat')).welcomeDue,true,'older character, switch on');
 }finally{await h.close();}
});
