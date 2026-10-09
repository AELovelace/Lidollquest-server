import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStoryFlows} from '../server/story-flows.mjs';
import {validateFlow} from '../server/flow-content.mjs';
import {validateQuestContent,validateStageMusic} from '../server/quest-content.mjs';
import {createZoneMusic} from '../server/zone-music.mjs';

// Story Workshop music: the Music block (scene / once / silence / keep / clear) and quest stage music, which reach the
// client through the per-character snapshot field musicOverride (zone-music.mjs override()).

const n=(id,type,rest={})=>({id,type,...rest});
const e=(from,port,to)=>({from,port,to});
const story=()=>({id:'serenade',name:'Serenade',nodes:[n('entry','entry'),n('scene','music',{mode:'scene',track:'forest',volume:80}),n('hello','dialogue',{text:'Listen.'}),n('sting','music',{mode:'once',track:'boss'}),n('after','dialogue',{text:'Wow.'}),n('keep','music',{mode:'keep',track:'town',volume:60}),n('end','end')],
 edges:[e('entry','next','scene'),e('scene','next','hello'),e('hello','next','sting'),e('sting','next','after'),e('after','next','keep'),e('keep','next','end')],bindings:[{kind:'npc',ref:'bard',entry:'entry'}]});
function fixture(){
 const db=new DatabaseSync(':memory:'),dir=mkdtempSync(join(tmpdir(),'story-music-'));let time=1_000_000;
 db.exec('CREATE TABLE quest_characters(id TEXT PRIMARY KEY,name TEXT,state TEXT,revision INTEGER)');
 const c={id:'alice'},s={flowVersion:1,fullDungeon:{flags:{}}};db.prepare('INSERT INTO quest_characters VALUES (?,?,?,?)').run(c.id,'Alice',JSON.stringify(s),0);
 const music=createZoneMusic(db,{now:()=>time,zones:()=>[],uploadDir:dir,transcoder:{kbps:96,available:async()=>true,convert:async input=>({mp3:Buffer.concat([Buffer.from('ID3'),input,Buffer.alloc(2000)]),ogg:Buffer.from('OggS'),seconds:20})}});
 const p={npcs:{bard:{id:'bard'},singer:{id:'singer'}},monsters:{},quests:{},orbs:{}},live={published:()=>p,view:()=>({compiledSprites:[],assets:[],equipment:[]}),bundle:()=>{}};
 const flows=createStoryFlows(db,{live,world:{catalog:()=>[]},enabled:true,now:()=>time,adapters:{},music});
 const publish=(entry=story())=>flows.gm({action:'flow_publish',id:entry.id,entry,revision:flows.get(entry.id)?.revision??0},'gm');
 const choose=()=>{const v=flows.snapshot(c,s);flows.act(c,s,{flow_run:v.id,flow_step:v.step,choice:''});};
 return {db,c,s,music,flows,publish,choose,advance:ms=>{time+=ms;},now:()=>time,close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('Music block validation: modes, songs, volume, and the catalog check',()=>{
 const bad=mode=>{const d=story();d.nodes.find(v=>v.id==='scene').mode=mode;return d;};
 assert.throws(()=>validateFlow(bad('dance'),{publish:true}),/Choose what the Music block does/);
 const noSong=story();noSong.nodes.find(v=>v.id==='scene').track='';assert.throws(()=>validateFlow(noSong,{publish:true}),/Choose a song/);
 const loud=story();loud.nodes.find(v=>v.id==='scene').volume=101;assert.throws(()=>validateFlow(loud,{publish:true}),/volume/);
 const catalog={music:{tracks:['forest','town'],uploads:[]},npcs:[{id:'bard'}]};
 assert.throws(()=>validateFlow(story(),{publish:true,catalog}),/library or the uploads/,'boss is not in this catalog');
 catalog.music.tracks.push('boss');assert.doesNotThrow(()=>validateFlow(story(),{publish:true,catalog}));
 const silence=story();Object.assign(silence.nodes.find(v=>v.id==='scene'),{mode:'silence',track:'forest'});
 assert.equal(validateFlow(silence,{publish:true}).flow.nodes.find(v=>v.id==='scene').track,'','silence and clear carry no song');
});

test('scene music lasts for the scene, a sting is keyed once, and a kept song outlives the scene until cleared',()=>{
 const f=fixture();
 try{
  f.publish();assert.equal(f.flows.start(f.c,f.s,'npc','bard'),true);
  assert.deepEqual(f.flows.sceneMusic(f.c),{track:'forest',volume:80},'scene music while the run is on its first page');
  const run=f.flows.snapshot(f.c,f.s);f.choose();
  assert.equal(f.s.storySting.track,'boss');assert.equal(f.s.storySting.key,run.id+':'+f.s.storySting.key.split(':')[1]);const key=f.s.storySting.key;
  assert.deepEqual(f.flows.sceneMusic(f.c),{track:'forest',volume:80},'the scene song stays underneath the sting');
  f.choose();
  assert.deepEqual(f.s.storyMusic,{track:'town',volume:60},'keep: stored on the character');
  assert.equal(f.flows.sceneMusic(f.c),null,'the scene ended, so its music ended');
  assert.equal(f.s.storySting.key,key,'the sting key never changes on replay');
  const override=f.music.override({scene:f.flows.sceneMusic(f.c),sting:f.s.storySting,keep:f.s.storyMusic},f.now());
  assert.deepEqual(override.sting,{track:'boss',volume:100,key});assert.deepEqual(override.keep,{track:'town',volume:60});assert.equal(override.scene,undefined);assert.deepEqual(override.streams,{});
  f.advance((141.3+16)*1000);
  assert.equal(f.music.override({sting:f.s.storySting,keep:f.s.storyMusic},f.now()).sting,undefined,'a sting is offered only while it could still be playing');
  const clear={id:'quiet',name:'Quiet',nodes:[n('entry','entry'),n('clear','music',{mode:'clear'}),n('end','end')],edges:[e('entry','next','clear'),e('clear','next','end')],bindings:[{kind:'npc',ref:'singer',entry:'entry'}]};
  f.publish(clear);f.flows.start(f.c,f.s,'npc','singer');
  assert.equal(f.s.storyMusic,undefined,'clear forgets the kept song');
  assert.equal(f.music.override({},f.now()),null,'nothing applies: no musicOverride at all');
 }finally{f.close();}
});

test('the editor catalog lists library songs and uploads, and override streams cover referenced uploads',async()=>{
 const f=fixture();
 try{
  const song=await f.music.addUpload(Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'),Buffer.from('lullaby')]),'Lullaby','gm');
  const cat=f.flows.catalog();assert.ok(cat.music.tracks.includes('forest'));assert.deepEqual(cat.music.uploads,['upload:'+song.id]);assert.equal(cat.music.songs.uploads[0].title,'Lullaby');
  const override=f.music.override({keep:{track:'upload:'+song.id,volume:50},quest:{track:null,battle:'boss',boss:null,volume:100,quest:'Q',stage:'S'}},f.now());
  assert.deepEqual(Object.keys(override.streams),[song.id]);assert.equal(override.quest.battle,'boss');
  f.music.setReferenceScan(token=>token==='upload:'+song.id?['flow: Serenade']:[]);
  assert.throws(()=>f.music.removeUpload({id:song.id}),/Serenade/);
 }finally{f.close();}
});

test('quest stage music validation is optional, checked against real songs, and dropped when empty',()=>{
 const base={id:'music_quest',name:'Q',description:'',stages:[{id:'one',name:'One',objectives:[{id:'wait',type:'timer',count:10}],next:'complete'}],rewards:{}};
 const options={assetRef:v=>v,spells:{},equipment:{},look:v=>v};
 assert.equal(validateQuestContent('quest',base,options).stages[0].music,undefined,'no music key: existing definitions keep their hashes');
 const empty=structuredClone(base);empty.stages[0].music=[];assert.equal(validateQuestContent('quest',empty,options).stages[0].music,undefined);
 const withMusic=structuredClone(base);withMusic.stages[0].music=[{zone:'honeydew-lantern',track:'town',boss:'boss',volume:70},{zone:'*',track:'forest'}];
 const checked=validateQuestContent('quest',withMusic,{...options,musicTrack:(v)=>['town','boss','forest'].includes(v)?v:assert.fail('unknown '+v)}).stages[0].music;
 assert.deepEqual(checked,[{zone:'honeydew-lantern',track:'town',boss:'boss',volume:70},{zone:'*',track:'forest',volume:100}]);
 assert.throws(()=>validateStageMusic([{zone:'',track:'town'}]),/Choose a zone/);
 assert.throws(()=>validateStageMusic([{zone:'*'}]),/at least one song/);
 assert.throws(()=>validateStageMusic([{zone:'*',track:'town',volume:150}]));
 assert.throws(()=>validateQuestContent('quest',withMusic,{...options,musicTrack:()=>{throw Error('Field music: choose a song');}}),/choose a song/);
});
