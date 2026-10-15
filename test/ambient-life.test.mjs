import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAmbientLife,AMBIENT_DEFAULTS} from '../server/ambient-life.mjs';
import {npcParticipationContext} from '../server/participation-gate.mjs';

// AMBIENT_NPC_LIFE_PLAN.md: persona NPCs open conversations on a roll, Decider Chat keeps them going, 5 responses each,
// one chime-in, players answered by name or by the Decider, shopkeepers beckon, gate down = nothing, lines local only.
const AREA='utopia-arcanum-tower';
const persona=(name,extra={})=>({name,ai_persona:{enabled:true,pronouns:'she/her',occupation:name+' job',desires:[],traits:[],background:'',interests:[name.toLowerCase()+' things'],relationships:[],voice:[],chattiness:50,talks_to:'both',avoid:[],...extra}});
const NPCS={wren:persona('Wren'),felix:persona('Felix'),padma:persona('Padma'),shy:persona('Shy',{talks_to:'players'}),off:{...persona('Off'),ai_persona:{...persona('Off').ai_persona,enabled:false}}};

function harness({knobs={},npcs=[{ref:'p-wren',content:'wren',x:3,y:17},{ref:'p-felix',content:'felix',x:6,y:15}],shops=[],players=[{id:'c1',owner:'o1',name:'Dollie',x:5,y:16,area:AREA,state:{}}],decide=()=>'join',chat=null,backend='decider'}={}){
 const db=new DatabaseSync(':memory:');let time=Date.parse('2026-10-14T18:00:00Z');
 db.exec('CREATE TABLE quest_chat(seq INTEGER PRIMARY KEY AUTOINCREMENT,zone TEXT,owner TEXT,character_id TEXT,name TEXT,text TEXT,created INTEGER,emote INTEGER,x INTEGER,y INTEGER)');
 const calls=[],holds=[],scene={zone:AREA,npcs,shops,players};let stamps=0;
 const pool={configured:true,async request(path,body){
  calls.push({path,body});
  if(path==='/v1/participation/decide'){const d=decide(body);if(typeof d==='number')return {ok:false,status:d,body:{}};return {ok:true,status:200,body:{decision:d,join:d==='join',join_probability:d==='join'?0.9:0.1,policy:'participation-sociable-v1-schema_first',model:'lidoll/decider-chat-0-1'}};}
  const r=chat?.(body);if(r)return r;
  return {ok:true,status:200,body:{reply:`${body.npc_name} (${body.kind})`,lane:'local',fallback:false}};
 }};
 const life=createAmbientLife(db,{now:()=>time,roll:()=>0,pool:()=>pool,gateBackend:backend,tuning:()=>({...AMBIENT_DEFAULTS,ambient_enabled:'on',ambient_chime_chance:0,...knobs}),
  npcs:()=>NPCS,scenes:(only)=>!only||only.includes(AREA)?[scene]:[],stamp:()=>{stamps++;},hold:(id,until)=>holds.push(id),sleep:async()=>{},log:()=>{}});
 const settle=async()=>{for(let i=0;i<60;i++)await new Promise(r=>setImmediate(r));}; // Let every queued AI step finish.
 const lines=()=>db.prepare('SELECT * FROM quest_chat ORDER BY seq').all();
 return {db,life,calls,holds,scene,settle,lines,stamps:()=>stamps,advance:ms=>{time+=ms;},tick:async()=>{life.tick();await settle();}};
}
async function opened(h){h.advance(60000);await h.tick();h.advance(60000);await h.tick();} // First tick staggers the roll; the next one may open.

test('nothing happens while the switch is off or the gate backend is not the Decider',async()=>{
 for(const opts of [{knobs:{ambient_enabled:'off'}},{backend:'qwen'}]){
  const h=harness(opts);await opened(h);h.life.hear({id:'c1',name:'Dollie'},'Wren, hello!',{area:AREA,zone:AREA,x:5,y:16});await h.tick();
  assert.equal(h.calls.length,0,JSON.stringify(opts));assert.equal(h.lines().length,0);
 }
});

test('two persona NPCs talk until each has said 5 lines, in turn, as heard area rows at their tiles',async()=>{
 const h=harness({npcs:[{ref:'p-wren',content:'wren',x:3,y:17},{ref:'p-felix',content:'felix',x:6,y:15}],players:[{id:'c1',owner:'o1',name:'Dollie',x:12,y:12,area:AREA,state:{}}]}); // The player is on screen but out of talk range: NPC to NPC only.
 await opened(h);
 const rows=h.lines();assert.equal(rows.length,10,'5 responses each');
 assert.deepEqual(rows.map(r=>r.name),['Wren','Felix','Wren','Felix','Wren','Felix','Wren','Felix','Wren','Felix']);
 assert.equal(rows[0].text,'Wren (ambient_open)');assert.equal(rows[1].text,'Felix (ambient_reply)');
 assert.ok(rows.every(r=>r.owner==='ambient:'+AREA&&r.zone===AREA&&r.character_id.startsWith('npc:'+AREA+':p-')));
 assert.deepEqual([rows[0].x,rows[0].y],[3,17]);assert.equal(h.stamps(),10,'every line learns who heard it');
 assert.ok(h.holds.includes('p-wren')&&h.holds.includes('p-felix'),'speakers stand still');
 const decides=h.calls.filter(c=>c.path==='/v1/participation/decide');assert.equal(decides.length,9);
 assert.equal(decides[0].body.candidate.kind,'npc');assert.equal(decides[0].body.conversation_with_candidate,true);assert.equal(decides[0].body.speaker,'Wren');
 const chat=h.calls.find(c=>c.path==='/v1/companion/chat').body;assert.equal(chat.kind,'ambient_open');assert.equal(chat.partner.name,'Felix');assert.ok(chat.persona.startsWith('Wren (she/her) is a Wren job.'));
 assert.equal(chat.lore_version,undefined,'residents never trigger a lore push');
});

test('a QUIET from the Decider ends the conversation after the opener',async()=>{
 const h=harness({decide:()=>'quiet',players:[{id:'c1',owner:'o1',name:'Dollie',x:12,y:12,area:AREA,state:{}}]});await opened(h);
 assert.deepEqual(h.lines().map(r=>r.text),['Wren (ambient_open)']);
});

test('a Decider failure pauses all ambient life for a minute (gate down = do nothing)',async()=>{
 const h=harness({decide:()=>503,players:[{id:'c1',owner:'o1',name:'Dollie',x:12,y:12,area:AREA,state:{}}]});await opened(h);
 assert.equal(h.lines().length,1);assert.ok(h.life.view().gate_down_for_ms>0);
 const before=h.calls.length;h.life.hear({id:'c1',name:'Dollie'},'Wren, hello!',{area:AREA,zone:AREA,x:5,y:16});h.advance(30000);await h.tick();
 assert.equal(h.calls.length,before,'not even a named NPC answers while the gate is down');
});

test('local_busy (429) and a cloud lane both drop the line; only the cloud one raises the cost alarm',async()=>{
 const busy=harness({chat:()=>({ok:false,status:429,body:{detail:'local_busy'}}),players:[{id:'c1',owner:'o1',name:'Dollie',x:12,y:12,area:AREA,state:{}}]});await opened(busy);
 assert.equal(busy.lines().length,0);assert.equal(busy.life.view().stats.busy>=1,true);assert.equal(busy.life.view().cost_alarms,0);
 const cloud=harness({chat:b=>({ok:true,status:200,body:{reply:'paid words',lane:'cloud'}}),players:[{id:'c1',owner:'o1',name:'Dollie',x:12,y:12,area:AREA,state:{}}]});await opened(cloud);
 assert.equal(cloud.lines().length,0);assert.equal(cloud.life.view().cost_alarms,1);
});

test('a player who names an NPC is answered by that NPC without asking the Decider',async()=>{
 const h=harness({knobs:{ambient_chance:0}});await h.tick();
 h.life.hear({id:'c1',name:'Dollie'},'Felix, can I get a milk?',{area:AREA,zone:AREA,x:5,y:16});await h.tick();
 assert.equal(h.calls.filter(c=>c.path==='/v1/participation/decide').length,0);
 const chat=h.calls.find(c=>c.path==='/v1/companion/chat').body;assert.equal(chat.kind,'ambient_answer');assert.equal(chat.npc_name,'Felix');assert.equal(chat.message,'Felix, can I get a milk?');assert.equal(chat.player_name,'Dollie');
 assert.deepEqual(h.lines().map(r=>r.name),['Felix']);
});

test('an unnamed line is gated over the closest NPCs (fan-out knob) and at most one answers; companion lines are left alone',async()=>{
 const h=harness({knobs:{ambient_chance:0,ambient_gate_fanout:1},npcs:[{ref:'p-wren',content:'wren',x:3,y:17},{ref:'p-felix',content:'felix',x:6,y:15},{ref:'p-padma',content:'padma',x:9,y:14}]});await h.tick();
 h.life.hear({id:'c1',name:'Dollie'},'anyone know where the well is?',{area:AREA,zone:AREA,x:6,y:16});await h.tick();
 const decides=h.calls.filter(c=>c.path==='/v1/participation/decide');assert.equal(decides.length,1,'fan-out 1: only the closest is asked');assert.equal(decides[0].body.candidate.name,'Felix');
 assert.equal(decides[0].body.speaker,'Dollie');assert.equal(h.lines().length,1);
 h.life.hear({id:'c1',name:'Dollie'},'Sable, are you hungry?',{area:AREA,zone:AREA,x:6,y:16,companion:()=>true});await h.tick();
 assert.equal(h.lines().length,1,'a line a companion is answering gets no resident reply');
});

test('a third NPC in earshot may chime in once, chosen by the Decider',async()=>{
 const h=harness({knobs:{ambient_chime_chance:1,ambient_max_responses:2},npcs:[{ref:'p-wren',content:'wren',x:3,y:17},{ref:'p-felix',content:'felix',x:6,y:15},{ref:'p-padma',content:'padma',x:9,y:14}],
  players:[{id:'c1',owner:'o1',name:'Dollie',x:12,y:12,area:AREA,state:{}}]});
 await opened(h);
 const kinds=h.calls.filter(c=>c.path==='/v1/companion/chat').map(c=>c.body.npc_name+':'+c.body.kind);
 assert.ok(kinds.includes('Padma:ambient_chime'),kinds.join(' '));assert.equal(kinds.filter(k=>k.endsWith('ambient_chime')).length,1,'once per conversation');
 assert.ok(h.lines().filter(r=>r.name==='Padma').length>=1);
 assert.ok(h.lines().filter(r=>r.name==='Wren').length<=2&&h.lines().filter(r=>r.name==='Felix').length<=2,'the response cap holds');
});

test('NPCs whose persona is off, or who only talk to players, never start NPC conversations',async()=>{
 const h=harness({npcs:[{ref:'p-off',content:'off',x:3,y:17},{ref:'p-shy',content:'shy',x:5,y:17}],players:[{id:'c1',owner:'o1',name:'Dollie',x:14,y:12,area:AREA,state:{}}]});await opened(h);
 assert.equal(h.lines().length,0);
});

test('an NPC can greet a player in talk range, remarking on what anyone could see',async()=>{
 const h=harness({npcs:[{ref:'p-padma',content:'padma',x:9,y:14}],players:[{id:'c1',owner:'o1',name:'Dollie',x:10,y:15,area:AREA,state:{loadout:{player_info:{diaper_wet_absorbed:20}}}}]});await opened(h);
 const chat=h.calls.find(c=>c.path==='/v1/companion/chat').body;assert.equal(chat.kind,'ambient_greet');assert.equal(chat.player_name,'Dollie');
 assert.ok(chat.situation.some(s=>/padding is wet/.test(s)),'visible state may be remarked on in public (Doll, no Dignity cost)');
});

test('shopkeepers beckon a passing player once per cooldown',async()=>{
 const h=harness({knobs:{ambient_beckons:'on',ambient_beckon_chance:1},npcs:[],shops:[{ref:'objNPCDiaperVendor',name:'Prudence',x:10,y:10,wares:['Night Guard','Pullups']}],players:[{id:'c1',owner:'o1',name:'Dollie',x:13,y:11,area:AREA,state:{}}]});
 await h.tick();
 const chat=h.calls.find(c=>c.path==='/v1/companion/chat').body;assert.equal(chat.kind,'shop_beckon');assert.match(chat.about,/Night Guard/);
 assert.equal(h.lines()[0].character_id,'npc:'+AREA+':shop:objNPCDiaperVendor');
 h.advance(70000);await h.tick();assert.equal(h.lines().length,1,'the same player is not beckoned again within the cooldown');
});

test('the decision export scrubs player names and keeps NPC names',async()=>{
 const h=harness({knobs:{ambient_chance:0}});await h.tick();
 h.life.hear({id:'c1',name:'Dollie'},'is Dollie allowed a biscuit?',{area:AREA,zone:AREA,x:6,y:16});await h.tick();
 const rows=h.life.exportDecisions().split('\n').map(l=>JSON.parse(l));
 assert.ok(rows.length>=1);assert.ok(!JSON.stringify(rows).includes('Dollie'));assert.equal(rows[0].speaker,'Player1');assert.match(rows[0].message,/Player1/);
 assert.ok(['Wren','Felix'].includes(rows[0].candidate.name));assert.equal(rows[0].source,'live_review');
});

test('the NPC gate context is bounded and never carries persona text',()=>{
 const body=npcParticipationContext({name:'Wren',profile:{role:'tavernkeeper',interests:['a','b','c','d','e']},persona:'SECRET'},{speaker:'Felix',message:'x'.repeat(900),turns:Array(9).fill({speaker:'Felix',text:'hi'}),nearbyNames:Array(20).fill('N').map((n,i)=>n+i),kind:'shout'});
 assert.equal(body.candidate.interests.length,4);assert.equal(body.message.length,500);assert.equal(body.recent_turns.length,4);assert.equal(body.nearby_names.length,8);assert.equal(body.kind,'chat');
 assert.ok(!JSON.stringify(body).includes('SECRET'));assert.equal(body.speaker_hired_candidate,false);
});

test('the GM persona preview answers with one local line or one Decider verdict, without spending live budgets',async()=>{
 const h=harness({knobs:{ambient_calls_per_minute:0,ambient_gate_calls_per_minute:0}}),def={id:'utopia_wren',name:'Wren',ai_persona:NPCS.wren.ai_persona};
 const said=await h.life.test(def,{mode:'line'});assert.equal(said.ok,true);assert.equal(said.text,'Wren (ambient_greet)');assert.match(said.persona,/^Wren \(she\/her\)/);
 const answered=await h.life.test(def,{mode:'line',message:'Hi Wren',speaker:'Doll'});assert.equal(h.calls.at(-1).body.kind,'ambient_answer');assert.equal(answered.text,'Wren (ambient_answer)');
 const verdict=await h.life.test(def,{mode:'gate',message:'anyone fancy a drink?'});assert.equal(verdict.decision,'join');assert.equal(verdict.candidate.role,'Wren job');
 assert.equal(h.lines().length,0,'a preview never posts in game');
});
