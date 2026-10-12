import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFollowers,followerData} from '../server/followers.mjs';
import {createFollowerChat,SLIP_DEFAULTS} from '../server/follower-chat.mjs';
import {createCompanionMemory,MEMORY_DEFAULTS} from '../server/companion-memory.mjs';
import {render,zoneName,EVENT_KINDS} from '../server/companion-events.mjs';
import {importLoadout} from '../server/loadout.mjs';
import {dignityOf} from '../server/dignity.mjs';

// Companion experiences (companion-events.mjs) and long-term memory (companion-memory.mjs): followers.remember() queues
// inside the command transaction, drain() renders + stores after the commit, bonds rise with an hourly cap, and the
// follower chat sends this speaker's memories and bond to the companion graph.

function world(){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-12T12:00:00Z');
 db.exec(`CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,name TEXT,state TEXT,revision INTEGER DEFAULT 0);
  CREATE TABLE quest_presence(character_id TEXT PRIMARY KEY,owner TEXT,zone TEXT,x INTEGER,y INTEGER,seen INTEGER);
  CREATE TABLE quest_chat(seq INTEGER PRIMARY KEY,zone TEXT,owner TEXT,character_id TEXT,name TEXT,text TEXT,created INTEGER,emote INTEGER,x INTEGER,y INTEGER);
  CREATE TABLE quest_chat_heard(seq INTEGER NOT NULL,character_id TEXT NOT NULL,PRIMARY KEY(seq,character_id));`);
 const followers=createFollowers(db,{enabled:true,now:()=>time}),geometry={width:20,height:20,entrance:{x:5,y:5},walls:[]};
 const memory=createCompanionMemory(db,{now:()=>time,log:()=>{}});
 const player=id=>{const c={id,owner:id,name:id[0].toUpperCase()+id.slice(1),state:JSON.stringify({followerVersion:1,loadout:importLoadout({player_info:{class_id:'fighter',level:1,playerHealth:100,playerHealthMax:100},inventory:[]})})};db.prepare('INSERT INTO quest_characters(id,owner,name,state) VALUES (?,?,?,?)').run(c.id,c.owner,c.name,c.state);return c;};
 const doll=player('doll'),bea=player('bea');
 function hire(c=doll,npc='paladin_aegis'){
  const zone=followerData[npc].online.home_zone,at=followers.placement(npc,zone,geometry);
  db.prepare('INSERT OR REPLACE INTO quest_presence VALUES (?,?,?,?,?,?)').run(c.id,c.owner,zone,at.x,at.y,time);
  const id=followers.reserve(c,JSON.parse(c.state),{npc,request_id:'r-'+npc+c.id},{zone,...at},geometry,[c.id]);followers.complete(id,true);
  followers.move(c,JSON.parse(c.state),null,{zone,x:5,y:5},'room');return zone;
 }
 return {db,followers,memory,doll,bea,hire,geometry,now:()=>time,advance:n=>{time+=n;},close:()=>{memory.close();db.close();}};
}
const queued=w=>w.db.prepare('SELECT COUNT(*) n FROM quest_companion_events').get().n;

test('templates name the player in memories, never in gossip, and flag the embarrassing ones',()=>{
 assert.equal(zoneName('overworld-autumnal-plains'),'the Autumnal Plains');assert.equal(zoneName('dive-forest'),'the Forest');assert.equal(zoneName(''),'the wilds');
 for(const kind of Object.keys(EVENT_KINDS)){
  const r=render(kind,{zone:'overworld-emberfall-caldera',enemy:'Ember Wyrm',title:'Lost Lantern'},'Doll');
  assert.match(r.text,/Doll|I /,kind);assert.doesNotMatch(r.gossip,/Doll/,kind+': gossip is anonymous');
  assert.ok(r.importance>=1&&r.importance<=5&&r.bond>0,kind);
 }
 assert.deepEqual(Object.entries(EVENT_KINDS).filter(([,k])=>k.embarrassing).map(([id])=>id).sort(),['accident','battle_lost','care','change']);
 assert.equal(render('battle_win',{zone:'dive-forest',enemy:'Slime Knight',boss:true},'Doll').text,'Doll and I beat Slime Knight in the Forest together, and it was a boss.');
 assert.equal(render('nonsense',{}),null);
 assert.ok(render('quest',{title:'x'.repeat(500)},'Doll\n<b>').text.length<=400,'titles and names are clipped to one short line');
});

test('remember() only queues for an active hire the player is with, and rolls back with the command',()=>{
 const w=world();try{
  assert.equal(w.followers.remember(w.doll,'accident',{zone:'dive-forest'}),false,'no companion: nothing to remember');
  const zone=w.hire();const before=queued(w); // Hiring itself queued a "hire" memory.
  assert.equal(before,1);
  assert.equal(w.followers.remember(w.doll,'accident',{zone:'somewhere-else'}),false,'the companion is not in that zone');
  assert.equal(w.followers.remember(w.doll,'battle_win',{zone:'somewhere-else',enemy:'Rat'},{present:true}),true,'battles vouch for presence');
  w.db.exec('BEGIN');w.followers.remember(w.doll,'accident',{zone});w.db.exec('ROLLBACK');
  assert.equal(queued(w),before+1,'a rolled-back command leaves no phantom memory');
  const row=w.db.prepare("SELECT * FROM quest_companion_events WHERE kind='battle_win'").get();
  assert.equal(row.npc,'paladin_aegis');assert.equal(JSON.parse(row.data).player,'Doll');
 }finally{w.close();}
});

test('drain stores rendered memories once, keeps only the first visit to a zone, and caps bond per hour',()=>{
 const w=world();try{
  const zone=w.hire();
  for(let i=0;i<6;i++)w.followers.remember(w.doll,'quest',{title:'Errand '+i},{present:true}); // 6 x 5 bond, far over the hourly cap.
  w.followers.move(w.doll,JSON.parse(w.doll.state),{zone,x:5,y:5},{zone:'overworld-autumnal-plains',x:1,y:1},'plains');
  w.followers.move(w.doll,JSON.parse(w.doll.state),{zone:'overworld-autumnal-plains',x:1,y:1},{zone,x:5,y:5},'room');
  w.followers.move(w.doll,JSON.parse(w.doll.state),{zone,x:5,y:5},{zone:'overworld-autumnal-plains',x:1,y:1},'plains');
  const stored=w.memory.drain();assert.equal(queued(w),0,'the queue is emptied after a successful drain');
  const kinds=w.memory.view('doll').memories.map(m=>m.kind);
  assert.equal(kinds.filter(k=>k==='zone').length,2,'the plains and the home zone once each, however often they cross');
  assert.equal(stored,kinds.length);
  assert.equal(w.memory.bondOf('paladin_aegis','doll'),MEMORY_DEFAULTS.bond_hourly_cap,'bond stops at the hourly cap');
  w.advance(3600000);w.followers.remember(w.doll,'quest',{title:'Next hour'},{present:true});w.memory.drain();
  assert.equal(w.memory.bondOf('paladin_aegis','doll'),MEMORY_DEFAULTS.bond_hourly_cap+5,'a new hour, new room to grow');
  assert.equal(w.memory.bondOf('paladin_aegis','bea'),0);
  w.db.prepare("INSERT INTO quest_companion_events(id,npc,character_id,kind,data,created) VALUES (1,'paladin_aegis','doll','hire','{}',1)").run();
  assert.equal(w.memory.drain(),0,'a replayed queue id (crash between the two databases) is stored only once');
 }finally{w.close();}
});

test('candidates favour shared words, importance and freshness; forget and the orphan sweep remove everything',()=>{
 const w=world();try{
  w.hire();w.followers.remember(w.doll,'battle_win',{zone:'dive-forest',enemy:'Slime Knight'},{present:true});
  w.followers.remember(w.doll,'accident',{zone:'dive-forest'});w.advance(40*86400000);w.followers.remember(w.doll,'quest',{title:'Lost Lantern'},{present:true});w.memory.drain();
  const top=w.memory.candidates('paladin_aegis','doll','remember the slime knight?');
  assert.match(top[0].text,/Slime Knight/);assert.ok(top.every(m=>typeof m.age_days==='number'));
  assert.ok(top.some(m=>m.embarrassing),'embarrassing memories travel flagged; the AI node keeps them out of public replies');
  assert.equal(w.memory.candidates('paladin_aegis','doll','hi',2).length,2,'the send cap is respected');
  assert.deepEqual(w.memory.candidates('paladin_aegis','bea','slime'),[],'another character never receives these memories');
  w.memory.forget('doll');assert.deepEqual(w.memory.view('doll'),{bonds:[],memories:[],summaries:[],pending:0});
  w.hire(w.bea);w.memory.drain();w.db.prepare("DELETE FROM quest_characters WHERE id='bea'").run();
  assert.equal(w.memory.orphans(),1);assert.equal(w.memory.view('bea').memories.length,0);
 }finally{w.close();}
});

test('the companion chat sends this speaker\'s bond, memories and summary, and drains first',async()=>{
 const w=world();let chat;try{
  const zone=w.hire();w.followers.remember(w.doll,'battle_win',{zone,enemy:'Slime Knight'},{present:true});
  w.memory.db.prepare('INSERT INTO summaries VALUES (?,?,?,?)').run('paladin_aegis','doll','Doll trusts Elowen in a fight.',w.now());
  const bodies=[];
  chat=createFollowerChat(w.db,{followers:w.followers,now:w.now,memoryStore:w.memory,locate:(c,area)=>w.followers.chatTargets(c,{area,geometry:w.geometry}),
   fetcher:async(url,opts)=>{const path=new URL(url).pathname,body=JSON.parse(opts.body);if(path==='/v1/companion/lore')return Response.json({ok:true});bodies.push(body);return Response.json({reply:'I remember, Doll.'});}});
  chat.enqueue(w.doll,'Elowen, remember the slime knight?',1,'room');chat.kick(); // kick() drains the queued battle first.
  for(let i=0;i<50&&!chat.idle();i++)await new Promise(r=>setTimeout(r,5));
  const body=bodies[0];
  assert.equal(body.bond,3,'hire +1 and the win +2');assert.equal(body.summary,'Doll trusts Elowen in a fight.');
  assert.ok(body.memories.some(m=>/Slime Knight/.test(m.text)));
  assert.ok(body.memories.every(m=>!/Bea/.test(m.text)));
 }finally{chat?.close();w.close();}
});

test('impression jobs: short lines skipped, three per pair, retried, then stored as things the player said',()=>{
 const w=world();try{
  const job={npc:'paladin_aegis',characterId:'doll',player:'Doll',npcName:'Dame Elowen',reply:'Noted.'};
  assert.equal(w.memory.queueImpression({...job,message:'hi Elowen'}),false,'too short to carry anything personal');
  for(let i=0;i<4;i++)w.memory.queueImpression({...job,message:'I really love strawberry milk number '+i});
  assert.equal(w.memory.db.prepare('SELECT COUNT(*) n FROM impression_jobs').get().n,3,'a chatty player cannot flood the queue');
  let next=w.memory.nextImpression();w.memory.failImpression(next);assert.notEqual(w.memory.nextImpression()?.id,next.id,'a failed job waits a minute');
  w.advance(61000);next=w.memory.nextImpression();
  w.memory.storeImpressions(next,[{text:'Doll said she loves strawberry milk.',importance:7},{text:'Doll said she is a night owl.'},{text:'Doll said she wet the bed.',embarrassing:true}]);
  const said=w.memory.view('doll').memories.filter(m=>m.kind==='said');
  assert.deepEqual(said.map(m=>[m.text,m.importance,m.embarrassing]).sort(),[['Doll said she is a night owl.',1,false],['Doll said she loves strawberry milk.',3,false],['Doll said she wet the bed.',1,true]]);
  assert.equal(w.memory.db.prepare('SELECT gossip FROM memories WHERE kind=\'said\'').get().gossip,null,'impressions are never gossip');
  w.advance(86400001);assert.equal(w.memory.nextImpression(),null,'day-old jobs are dropped');
 }finally{w.close();}
});

test('folding: a pair over the cap folds its oldest small memories into the summary in one step',()=>{
 const w=world();try{
  const memory=createCompanionMemory(w.db,{now:w.now,log:()=>{},tuning:()=>({keep_per_pair:5})});
  const ins=memory.db.prepare('INSERT INTO memories(id,npc,character_id,kind,text,importance,embarrassing,created) VALUES (?,?,?,?,?,?,0,?)');
  for(let i=0;i<8;i++)ins.run('m'+i,'paladin_aegis','doll','zone','memory '+i,i===0?5:1,1000+i);
  assert.equal(memory.foldTarget().ids.includes('m0'),false,'the important old memory is folded last');
  const target=memory.foldTarget();assert.equal(target.ids.length,4,'8 over a cap of 5: fold 3 plus 10% extra');assert.equal(target.summary,'');
  memory.applyFold(target,'We have been through a lot, Doll and I.');
  assert.equal(memory.summary('paladin_aegis','doll'),'We have been through a lot, Doll and I.');
  assert.deepEqual(memory.view('doll').memories.map(m=>m.id).sort(),['m0','m5','m6','m7']);assert.equal(memory.foldTarget(),null);
  const shy=memory.db.prepare("INSERT INTO memories(id,npc,character_id,kind,text,importance,embarrassing,created) VALUES (?,?,?,'accident',?,1,1,?)");
  for(let i=0;i<3;i++)shy.run('x'+i,'paladin_aegis','doll','Doll had an accident '+i,10+i); // Older than everything left.
  const fade=memory.foldTarget();assert.ok(fade.ids.includes('x0'));assert.ok(fade.memories.every(t=>!/accident/.test(t)),'embarrassing memories are never sent to the summarizer');
  memory.applyFold({...fade,memories:[]},null);assert.equal(memory.summary('paladin_aegis','doll'),'We have been through a lot, Doll and I.','a fade-only fold keeps the summary');
  memory.close();
 }finally{w.close();}
});

test('the chat queues an impression after a graph reply and the next kick asks the AI node, then folds when due',async()=>{
 const w=world();let chat;try{
  const memory=createCompanionMemory(w.db,{now:w.now,log:()=>{},tuning:()=>({keep_per_pair:1,impression_min_words:3})});
  const zone=w.hire();const seen=[];
  chat=createFollowerChat(w.db,{followers:w.followers,now:w.now,memoryStore:memory,locate:(c,area)=>w.followers.chatTargets(c,{area,geometry:w.geometry}),
   fetcher:async(url,opts)=>{const path=new URL(url).pathname,body=JSON.parse(opts.body);seen.push({path,body});
    if(path==='/v1/companion/impressions')return Response.json({facts:[{text:'Doll said she is scared of thunder.',importance:2}]});
    if(path==='/v1/companion/summarize')return Response.json({summary:'Doll and I have shared some storms.'});
    return Response.json({reply:'Storms pass, Doll. I am here.'});}});
  const settle=async()=>{for(let i=0;i<100&&!chat.idle();i++)await new Promise(r=>setTimeout(r,5));await new Promise(r=>setTimeout(r,20));};
  chat.enqueue(w.doll,'Elowen, I am really scared of thunder',1,'room');chat.kick();await settle();
  chat.kick();await settle(); // The next kick runs the reflection job.
  const ask=seen.find(s=>s.path==='/v1/companion/impressions');
  assert.deepEqual(ask.body,{npc_name:'Dame Elowen',player_name:'Doll',message:'Elowen, I am really scared of thunder',reply:'Storms pass, Doll. I am here.'});
  assert.ok(memory.view('doll').memories.some(m=>m.kind==='said'&&/thunder/.test(m.text)));
  w.advance(61000);chat.kick();await settle(); // hire + said = 2 > keep 1: fold.
  const fold=seen.find(s=>s.path==='/v1/companion/summarize');assert.ok(fold,'the fold asked the AI node');assert.equal(fold.body.player_name,'Doll');
  assert.equal(memory.summary('paladin_aegis','doll'),'Doll and I have shared some storms.');
  memory.close();
 }finally{chat?.close();w.close();}
});

test('slip candidates are embarrassing, once a day; gossip is other travellers\' anonymous lines only',()=>{
 const w=world();try{
  w.hire();w.hire(w.bea,'merchant_mira');
  w.followers.remember(w.doll,'battle_win',{zone:'dive-forest',enemy:'Rat'},{present:true});w.followers.remember(w.doll,'accident',{zone:'dive-forest'},{present:true});w.memory.drain();
  const slip=w.memory.slipCandidate('paladin_aegis','doll');assert.equal(slip.embarrassing,true);assert.match(slip.text,/accident/);
  w.memory.markSlip(slip.id);assert.equal(w.memory.slipCandidate('paladin_aegis','doll'),null,'not again today');
  w.advance(86400001);assert.equal(w.memory.slipCandidate('paladin_aegis','doll').id,slip.id,'a day later it can slip again');
  const lines=w.memory.gossipLines('paladin_aegis','bea');assert.ok(lines.length>=2);
  assert.ok(lines.every(l=>!/Doll/.test(l.text)),'gossip never names who it was about');assert.deepEqual(w.memory.gossipLines('paladin_aegis','doll'),[],'never your own memories');
  w.memory.storeImpressions({id:99,npc:'paladin_aegis',character_id:'doll'},[{text:'Doll said a secret.'}]);
  assert.ok(w.memory.gossipLines('paladin_aegis','bea').every(l=>!/secret/.test(l.text)),'things a player said are never gossip');
 }finally{w.close();}
});

test('a slip said in front of a real listener costs the speaker Dignity once; unheard or unsaid slips cost nothing',async()=>{
 const w=world();let chat;try{
  const zone=w.hire();w.followers.remember(w.doll,'accident',{zone});
  const bodies=[];let say=null,hearers=[];
  chat=createFollowerChat(w.db,{followers:w.followers,now:w.now,memoryStore:w.memory,audience:()=>2,roll:()=>0,locate:(c,area)=>w.followers.chatTargets(c,{area,geometry:w.geometry}),
   stamp:()=>{const seq=w.db.prepare('SELECT MAX(seq) s FROM quest_chat').get().s;for(const id of hearers)w.db.prepare('INSERT OR IGNORE INTO quest_chat_heard VALUES (?,?)').run(seq,id);},
   fetcher:async(url,opts)=>{const path=new URL(url).pathname,body=JSON.parse(opts.body);if(path!=='/v1/companion/chat')return Response.json({facts:[]});bodies.push(body);
    return Response.json({reply:'Remember your little accident, Doll?',slip:say?.(body)??null});}});
  const dignity=()=>dignityOf(JSON.parse(w.db.prepare("SELECT state FROM quest_characters WHERE id='doll'").get().state).loadout.player_info); // Missing reads as full Dignity (1024).
  const ask=async(text,seq)=>{w.advance(11000);w.db.prepare('UPDATE quest_presence SET seen=?').run(w.now());chat.enqueue(w.doll,text,seq,'room');chat.kick();for(let i=0;i<100&&!chat.idle();i++)await new Promise(r=>setTimeout(r,5));};
  const start=dignity();
  say=body=>body.slip?{memory_id:body.slip.id}:null;hearers=['doll']; // Said, but only the speaker heard it.
  await ask('Elowen, how are you today?',1);
  assert.equal(bodies[0].audience,2);assert.match(bodies[0].slip.text,/accident/);assert.equal(dignity(),start,'nobody else heard: no cost');
  hearers=['doll','bea'];await ask('Elowen, how are you today?',2);
  assert.ok(dignity()<start,'heard by someone else: Dignity drops');const after=dignity();
  const log=JSON.parse(w.db.prepare("SELECT state FROM quest_characters WHERE id='doll'").get().state).lastResult.log[0];assert.match(log,/let something embarrassing slip about you in front of someone/);
  await ask('Elowen, how are you today?',3);
  assert.equal(bodies[2].slip,undefined,'that memory already slipped today');assert.equal(dignity(),after);
  assert.equal(SLIP_DEFAULTS.slip_dignity,10);
 }finally{chat?.close();w.close();}
});
