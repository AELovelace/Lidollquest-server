import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createWorldContent} from '../server/world-content.mjs';
import {createQuestZones} from '../server/zones.mjs';
import {hubData} from '../server/hubs.mjs';
import {combatData} from '../server/combat.mjs';
const npc={id:'guide_npc',name:'Guide',description:'A friendly guide',dialogue:[{id:'hello',text:'Welcome!',next:'close',actions:[]}],quests:[]};
const quest=(extra={})=>({id:'first_quest',name:'First quest',description:'Explore together',givers:['guide_npc'],turn_in:{mode:'journal'},stages:[{id:'start',name:'Explore',objectives:[{id:'arrive',type:'visit',target:'honeydew-lantern',count:1}],next:'complete'}],rewards:{xp:5,coins:10,rpp:3,stats:{cha:1}},...extra});
const authorObjectiveFlag=(f,id,retired=false)=>f.api.world.flows.gm({action:'flow_flag_save',revision:f.api.world.flows.flags().find(v=>v.id===id)?.revision??0,entry:{id,name:id,retired}},'dm');
const objectiveCharacter=(f,id=f.c.id)=>JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id).state);
function fixture(){const db=new DatabaseSync(':memory:'),live=createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment}),paid=[];let time=Date.parse('2026-09-19T12:00:00Z'),api,c,last;
 const start=()=>api=createQuestZones(db,{live,now:()=>time,roll:()=>0,grant:()=>({owner:'alice',id:'grant',client:'lidollquest'}),wallet:()=>({coins:0}),adjust:(...args)=>paid.push(args),diveOptions:{log:()=>{}}});start();
 const command=(action,extra={})=>({action,controller:'control',request_id:randomUUID(),character_id:c?.id,revision:c?.revision,...extra});
 const send=input=>{if(input.quest&&!input.quest_revision){const data=api.read('',c.id).onlineQuests;input.quest_revision=(input.action==='quest_accept'?[...data.available,...data.instances]:[...data.instances,...data.available]).find(q=>(q.quest??q.id)===input.quest)?.revision;}last=api.act('',input);c=last.character;return last;};const act=(action,extra)=>send(command(action,extra));
 const publish=(kind,entry)=>live.change({action:'content_publish',kind,id:entry.id,revision:(live.view()[kind==='npc'?'npcs':'quests'].find(r=>r.id===entry.id)?.revision??0),entry},'dm');
 act('create',{name:'Alice'});act('enter',{zone:'honeydew-lantern',content_version:1,quest_version:1,combat_version:3,loadout:{player_info:{cha:2,playerHealth:20,playerHealthMax:20,level:1,xp:0},inventory:[],player_spells:[]}});
 publish('npc',npc);
 return {db,live,paid,publish,command,send,act,get api(){return api;},get c(){return c;},get last(){return last;},advance(ms){time+=ms;},restart(){api.close();start();c=api.read('',c.id).character;},close(){api.close();db.close();}};
}
function acceptQuest(f,input){ // Drive a real NPC conversation for generic quest-behavior tests.
 const d=f.live.published().quests[input.quest],giver=d.givers[0]||d.turn_in.npc,zone='honeydew-lantern';let map=f.api.world.map(zone),p=map.placements.find(p=>p.kind==='npc'&&p.content===giver),temporary=false;
 if(!p){map=place(f,'npc',giver);p=map.placements.find(p=>p.content===giver);temporary=true;}
 beside(f,p);f.act('npc_talk',{placement:p.id,edition:map.edition});let talk=f.last.onlineQuests.conversation;
 const choose=label=>{talk=f.last.onlineQuests.conversation;const choice=talk.choices.find(c=>c.label===label);assert.ok(choice,'Missing conversation choice '+label);f.act('npc_choice',{conversation:talk.id,page:talk.page,choice:choice.index});};
 if(talk.choices.some(c=>c.label==='Ask about quests')){choose('Ask about quests');talk=f.last.onlineQuests.conversation;const stored=JSON.parse(f.db.prepare('SELECT definition FROM online_conversations WHERE character_id=?').get(f.c.id).definition),index=stored.dialogue.find(p=>p.id===talk.page).actions.findIndex(a=>a.next==='_offer_'+input.quest);assert.ok(index>=0,'This quest is already active or is not available again yet.');f.act('npc_choice',{conversation:talk.id,page:talk.page,choice:index});}else assert.fail('This quest is already active or is not available again yet.');
 const accept=f.last.onlineQuests.conversation.choices.find(c=>/^(Accept|Resume) quest$/.test(c.label));const command=f.command('npc_choice',{conversation:f.last.onlineQuests.conversation.id,page:f.last.onlineQuests.conversation.page,choice:accept.index});const result=f.send(command);
 if(temporary&&d.turn_in.mode==='journal'&&!d.stages.some(stage=>stage.objectives.some(o=>o.target===giver||o.npc===giver))){const current=f.api.world.map(zone);f.api.world.act({action:'world_remove_content',zone,edition:current.edition,revision:current.revision,placement:p.id});}
 return result;
}
test('quest publication, acceptance, progression and capped claim are durable and exactly once',()=>{const f=fixture();try{
 f.publish('quest',quest());const accepted=acceptQuest(f,{quest:'first_quest'});assert.equal(accepted.onlineQuests.instances[0].status,'ready');
 const command=f.command('quest_claim',{quest:'first_quest'});f.send(command);f.send(command);assert.equal(f.paid.length,1);assert.equal(f.c.loadout.player_info.cha,3);assert.equal(f.db.prepare('SELECT balance FROM quest_rpp_wallets').get().balance,3);
 assert.equal(f.c.run,null);assert.equal(JSON.parse(f.db.prepare('SELECT state FROM quest_characters WHERE id=?').get(f.c.id).state).run,null,'Quest XP must leave an explicit idle run in the saved character');
 f.restart();assert.throws(()=>acceptQuest(f,{quest:'first_quest'}),/not available again/);assert.equal(f.api.read('',f.c.id).onlineQuests.instances[0].status,'claimed');
 }finally{f.close();}});
test('NPC drafts, references, conflict, history and retirement preserve published content',()=>{const f=fixture();try{let row=f.publish('npc',npc);assert.equal(f.live.published().npcs.guide_npc.name,'Guide');assert.throws(()=>f.live.change({kind:'npc',id:npc.id,action:'content_save',revision:0,entry:npc},'dm'),/changed/);row=f.publish('npc',{...npc,name:'Changed',retired:true});assert.equal(f.live.published().npcs.guide_npc.retired,true);f.live.change({kind:'npc',id:npc.id,action:'content_rollback',revision:row.revision,target_revision:1},'dm');assert.equal(f.live.published().npcs.guide_npc.name,'Guide');assert.throws(()=>f.publish('npc',{...npc,quests:['missing_quest']}),/referenced quest/);assert.throws(()=>f.publish('quest',quest({stages:[{id:'loop',objectives:[{id:'wait',type:'timer'}],next:'loop'}]})),/cycle/);}finally{f.close();}});
test('accepted definitions pin rewards and branching; abandoning cannot restart the timer',()=>{const f=fixture();try{f.publish('quest',quest({timer:{seconds:60,mode:'online'},stages:[{id:'start',objectives:[{id:'wait',type:'timer',count:20}],branches:[{id:'good',label:'Finish',to:'complete',conditions:[]}]}]}));acceptQuest(f,{quest:'first_quest'});f.advance(10000);f.act('heartbeat');f.api.tick();f.act('quest_abandon',{quest:'first_quest'});f.publish('quest',quest({rewards:{coins:999}}));acceptQuest(f,{quest:'first_quest'});f.advance(11000);f.act('heartbeat');f.api.tick();const q=f.api.read('',f.c.id).onlineQuests.instances[0];assert.equal(q.status,'choice');assert.equal(q.rewards.coins,10);f.act('quest_branch',{quest:'first_quest',branch:'good'});assert.equal(f.last.onlineQuests.instances[0].status,'ready');}finally{f.close();}});
test('managed placements reject stale maps and blocked tiles; conversations validate position and pages',()=>{const f=fixture();try{f.publish('npc',npc);let map=f.api.world.map('honeydew-lantern');assert.throws(()=>f.api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'npc',content:npc.id,x:0,y:0}),/reachable tile/);let placed;
 for(let y=2;y<map.floor.height-2&&!placed;y++)for(let x=2;x<map.floor.width-2&&!placed;x++)try{placed=f.api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'npc',content:npc.id,x,y});}catch(e){if(!/reachable tile/.test(e.message))throw e;}
 assert.ok(placed);const p=placed.placements[0];assert.throws(()=>f.api.world.act({action:'world_remove_content',zone:map.id,edition:map.edition,revision:map.revision,placement:p.id}),/map changed/);
 f.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(p.x+1,p.y,f.c.id);f.act('npc_talk',{placement:p.id,edition:map.edition});const talk=f.last.onlineQuests.conversation;assert.equal(talk.text,'Welcome!');assert.throws(()=>f.act('npc_choice',{conversation:talk.id,page:'stale',choice:-1}),/page changed/);f.act('npc_choice',{conversation:talk.id,page:'hello',choice:-1});assert.equal(f.last.onlineQuests.conversation.ended,true);
 const floor=structuredClone(placed.floor);floor.walls[p.y][p.x]=1;const relocated=f.api.quests.placements.realize(map.id,'replacement',floor);assert.ok(relocated[0].x!==p.x||relocated[0].y!==p.y);f.restart();assert.equal(f.api.world.map(map.id).placements[0].id,p.id);
 }finally{f.close();}});

function place(f,kind,content,lifetime='persistent',zone='honeydew-lantern',extra={}){const map=f.api.world.map(zone);for(let y=2;y<map.floor.height-2;y++)for(let x=2;x<map.floor.width-2;x++)try{return f.api.world.act({action:'world_place_content',zone,edition:map.edition,revision:map.revision,placement_kind:kind,content,x,y,lifetime,...extra});}catch(e){if(!/reachable tile/.test(e.message))throw e;}throw Error('No placement');}
function beside(f,p){f.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(p.x+1,p.y,f.c.id);}

test('walking collects placed tokens once, hides them personally, and keeps uncollected tokens available',()=>{const f=fixture();try{
 const first=place(f,'token','parcel').placements.find(p=>p.kind==='token');
 const map=place(f,'token','parcel'),second=map.placements.find(p=>p.kind==='token'&&p.id!==first.id);
 const stepOn=token=>{beside(f,token);f.advance(1000);return f.act('move',{direction:'west'});};
 stepOn(first);assert.ok(!f.last.worldPlacements.some(p=>p.id===first.id),'Tokens are hidden before accepting their quest');
 f.publish('quest',quest({stages:[{id:'find',objectives:[{id:'parcel',type:'collect',target:'parcel',token:true,count:2}],next:'deliver'},{id:'deliver',objectives:[{id:'give',type:'deliver',target:'parcel',token:true,count:2,npc:npc.id}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});
 // A nearby heartbeat alone must not collect: walking must actually touch the token tile.
 beside(f,first);f.act('heartbeat');assert.equal(JSON.parse(f.db.prepare('SELECT state FROM online_quests').get().state).tokens.parcel,undefined);
 f.advance(1000);const move=f.command('move',{direction:'west'});f.send(move);f.send(move);
 let state=JSON.parse(f.db.prepare('SELECT state FROM online_quests').get().state);assert.equal(state.tokens.parcel,1);assert.equal(state.progress['find:parcel'],1);
 assert.ok(!f.last.worldPlacements.some(p=>p.id===first.id));assert.ok(f.last.worldPlacements.some(p=>p.id===second.id));
 f.act('quest_interact',{placement:first.id,edition:map.edition});stepOn(first);
 assert.equal(JSON.parse(f.db.prepare('SELECT state FROM online_quests').get().state).tokens.parcel,1,'Clicks and subsequent movement share the placement receipt');
 f.restart();assert.ok(!f.api.read('',f.c.id).worldPlacements.some(p=>p.id===first.id),'Collection display survives restart');
 assert.equal(f.api.world.map(map.id).placements.filter(p=>p.kind==='token').length,2,'Shared world content is retained for other players');
 stepOn(second);state=JSON.parse(f.db.prepare('SELECT state FROM online_quests').get().state);assert.equal(state.tokens.parcel,2);assert.equal(state.stage,'deliver');
 assert.ok(!f.last.worldPlacements.some(p=>p.kind==='token'));
 }finally{f.close();}});

test('legacy unsuccessful token receipts do not hide or block an active collection after restart',()=>{const f=fixture();try{
 const token=place(f,'token','parcel').placements[0],map=place(f,'token','parcel'),second=map.placements.find(p=>p.id!==token.id);
 f.publish('quest',quest({stages:[{id:'find',objectives:[{id:'parcel',type:'collect',target:'parcel',token:true,count:2}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});
 const q=f.db.prepare('SELECT * FROM online_quests').get(),receipt='find:interact:'+token.id;
 f.db.prepare('INSERT INTO online_quest_events VALUES (?,?)').run(q.id,receipt); // Older servers recorded unsuccessful interactions before checking the objective.
 f.db.prepare('INSERT INTO online_quest_events VALUES (?,?)').run(q.id,'find:interact:'+second.id);
 f.restart();assert.ok(f.api.read('',f.c.id).worldPlacements.some(p=>p.id===token.id),'An old receipt with zero collection progress is not a successful pickup');
 beside(f,token);const command=f.command('quest_interact',{placement:token.id,edition:map.edition});f.send(command);f.send(command);
 let state=JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE id=?').get(q.id).state);
 assert.equal(state.tokens.parcel,1);assert.equal(state.progress['find:parcel'],1);assert.ok(!f.last.worldPlacements.some(p=>p.id===token.id));
 assert.ok(f.last.worldPlacements.some(p=>p.id===second.id),'Recover all failed copies before the first pickup can make their old receipts look successful');
 f.restart();assert.ok(!f.api.read('',f.c.id).worldPlacements.some(p=>p.id===token.id),'A successful partial collection remains hidden after restart');
 beside(f,token);f.act('quest_interact',{placement:token.id,edition:map.edition});
 state=JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE id=?').get(q.id).state);assert.equal(state.tokens.parcel,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quest_events WHERE instance=? AND event=?').get(q.id,receipt).n,1);
 beside(f,second);f.act('quest_interact',{placement:second.id,edition:map.edition});assert.equal(f.last.onlineQuests.instances[0].status,'ready');
 assert.equal(JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE id=?').get(q.id).state).tokens.parcel,2);
 }finally{f.close();}});

test('ineligible party token events leave no receipt and cannot block a later personal pickup',()=>{const f=fixture();try{
 const map=place(f,'token','parcel'),token=map.placements[0];
 f.publish('quest',quest({stages:[{id:'find',objectives:[{id:'parcel',type:'collect',target:'parcel',token:true,sharing:'personal'}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});
 f.api.quests.event(f.c,f.c,{id:'interact:'+token.id,type:'collect',target:token.content,tokenPlacement:token.id,zone:map.id,quests:['first_quest'],shared:true}); // A nearby owner's pickup must not reserve a personal objective's token.
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quest_events WHERE event=?').get('find:interact:'+token.id).n,0);
 beside(f,token);f.act('quest_interact',{placement:token.id,edition:map.edition});assert.equal(f.last.onlineQuests.instances[0].status,'ready');
 }finally{f.close();}});

test('a condition-blocked token interaction does not consume the later collection receipt',()=>{const f=fixture();try{
 const map=place(f,'token','parcel'),token=map.placements[0];
 f.publish('quest',quest({stages:[{id:'find',objectives:[{id:'parcel',type:'collect',target:'parcel',token:true,conditions:[{field:'shame',op:'gte',value:10}]}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});
 beside(f,token);f.act('quest_interact',{placement:token.id,edition:map.edition});
 assert.ok(!f.last.worldPlacements.some(p=>p.id===token.id));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quest_events WHERE event=?').get('find:interact:'+token.id).n,0);
 const loadout=structuredClone(f.c.loadout);loadout.player_info.shame=10;f.act('loadout',{loadout});
 f.act('quest_interact',{placement:token.id,edition:map.edition});assert.equal(f.last.onlineQuests.instances[0].status,'ready');assert.ok(!f.last.worldPlacements.some(p=>p.id===token.id));
 }finally{f.close();}});

test('a batched walk collects its intermediate token tile and ignores forged paths',()=>{const f=fixture();try{
 f.publish('quest',quest({stages:[{id:'find',objectives:[{id:'parcel',type:'collect',target:'parcel',token:true}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});
 const map=f.api.world.map('honeydew-lantern'),floor=map.floor;
 const open=(x,y)=>floor.walls[y]?.[x]===0&&![...(floor.fixtures??[]),...(floor.portals??[]),...map.placements].some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=1);
 let placed;
 for(let y=3;y<floor.height-3&&!placed;y++)for(let x=3;x<floor.width-3&&!placed;x++)if(open(x-1,y)&&open(x,y)&&open(x+1,y)){
  try{placed=f.api.world.act({action:'world_place_content',zone:map.id,edition:map.edition,revision:map.revision,placement_kind:'token',content:'parcel',x,y});}catch(error){if(!/reachable tile/.test(error.message))throw error;}
 }
 assert.ok(placed,'A token can be placed on a clear three-tile strip');const token=placed.placements.find(p=>p.kind==='token');
 f.db.prepare('UPDATE quest_presence SET x=?,y=?,moved=0 WHERE character_id=?').run(token.x-1,token.y,f.c.id);
 assert.throws(()=>f.act('heartbeat',{walkPath:[{x:token.x,y:token.y}]}),/Unsupported zone input/);
 f.advance(2000);const command=f.command('walk',{steps:['east','east'],loadout:structuredClone(f.c.loadout)});f.send(command);f.send(command);
 assert.deepEqual(f.last.position,{x:token.x+1,y:token.y});assert.equal(f.last.onlineQuests.instances[0].status,'ready');
 assert.equal(JSON.parse(f.db.prepare('SELECT state FROM online_quests').get().state).tokens.parcel,1);
 assert.ok(!f.last.worldPlacements.some(p=>p.id===token.id));
 }finally{f.close();}});

test('token visibility follows each character active stage and returns after resuming an uncollected quest',()=>{const f=fixture();try{
 const map=place(f,'token','parcel'),token=map.placements[0];
 f.publish('quest',quest({stages:[{id:'find',objectives:[{id:'parcel',type:'collect',target:'parcel',token:true}],next:'complete'}]}));
 assert.ok(!f.api.read('',f.c.id).worldPlacements.some(p=>p.id===token.id));acceptQuest(f,{quest:'first_quest'});
 assert.ok(f.last.worldPlacements.some(p=>p.id===token.id));
 const other='token-other',original=f.db.prepare('SELECT * FROM quest_characters WHERE id=?').get(f.c.id);
 f.db.prepare('INSERT INTO quest_characters VALUES (?,?,?,?,?,?,?)').run(other,'bob','Bob',0,0,original.state,'bob-token-create');
 f.db.prepare('INSERT INTO quest_presence(owner,character_id,zone,grant_id,controller,x,y,seen,moved) VALUES (?,?,?,?,?,?,?,?,?)').run('bob',other,map.id,'bob','bob',token.x+1,token.y,Date.parse('2026-09-19T12:00:00Z'),0);
 const view=()=>f.api.quests.visiblePlacements({id:other},JSON.parse(original.state),f.api.world.map(map.id).placements);assert.ok(!view().some(p=>p.id===token.id),'Another character without the quest cannot see it');
 const q=f.db.prepare('SELECT * FROM online_quests').get();f.db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)').run('bob-token-quest',other,q.quest,q.revision,q.definition,q.state,q.created);
 assert.ok(view().some(p=>p.id===token.id));
 f.act('quest_abandon',{quest:'first_quest'});assert.ok(!f.last.worldPlacements.some(p=>p.id===token.id));acceptQuest(f,{quest:'first_quest'});assert.ok(f.last.worldPlacements.some(p=>p.id===token.id));
 beside(f,token);f.act('quest_interact',{placement:token.id,edition:map.edition});assert.ok(!f.last.worldPlacements.some(p=>p.id===token.id));assert.ok(view().some(p=>p.id===token.id),'Another eligible character keeps their own token');
 }finally{f.close();}});
test('quest tokens are personal, non-farmable and consumed once by explicit delivery',()=>{const f=fixture();try{
 f.publish('npc',npc);const n=place(f,'npc',npc.id).placements[0],map=place(f,'token','parcel'),token=map.placements.find(p=>p.kind==='token');
 f.publish('quest',quest({stages:[{id:'collecting',objectives:[{id:'parcel',type:'collect',target:'parcel',token:true}],next:'delivery'},{id:'delivery',objectives:[{id:'hand_over',type:'deliver',target:'parcel',token:true,npc:npc.id}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});
 beside(f,token);f.act('quest_interact',{placement:token.id,edition:map.edition});f.act('quest_interact',{placement:token.id,edition:map.edition});assert.equal(f.last.onlineQuests.instances[0].stage,'delivery');
 beside(f,n);f.act('npc_talk',{placement:n.id,edition:map.edition});const conversation=f.last.onlineQuests.conversation.id;f.act('quest_deliver',{quest:'first_quest',objective:'hand_over',conversation});assert.equal(f.last.onlineQuests.instances[0].status,'ready');const stored=JSON.parse(f.db.prepare('SELECT state FROM online_quests').get().state);assert.equal(stored.tokens.parcel,0);assert.throws(()=>f.act('quest_deliver',{quest:'first_quest',objective:'hand_over',conversation}),/not active/);
 }finally{f.close();}});
test('state, equipment, inventory and timer predicates evaluate committed character state',()=>{const f=fixture();try{
 const item=Object.keys(hubData.equipment)[0];f.publish('quest',quest({stages:[{id:'conditions',objectives:[{id:'state',type:'state',field:'shame',op:'gte',value:2},{id:'gear',type:'equipment',slot:'head',target:item},{id:'inventory',type:'collect',target:item}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});assert.equal(f.last.onlineQuests.instances[0].status,'active');const loadout=structuredClone(f.c.loadout);loadout.player_info.shame=3;loadout.player_info.equipped_head=item;loadout.inventory.push(structuredClone(hubData.equipment[item]));f.act('loadout',{loadout});assert.equal(f.last.onlineQuests.instances[0].status,'ready');
 }finally{f.close();}});
test('inventory overflow keeps rewards pending; caps and spell unlocks survive claim retries',()=>{const f=fixture();try{
 const item=Object.keys(hubData.equipment).find(id=>!['food','drink','ammo'].includes(hubData.equipment[id].category)&&hubData.equipment[id].stackable!==true),spell=Object.keys(combatData.spells)[0];f.publish('quest',quest({rewards:{coins:1000000,items:[{id:item,count:1}],spells:[spell]}})); /* A real slot-taking item: snacks stack into one free row and would never fill the bag. */acceptQuest(f,{quest:'first_quest'});const full=structuredClone(f.c.loadout);full.inventory=Array.from({length:hubData.config.inventory_capacity},()=>structuredClone(hubData.equipment[item]));f.act('loadout',{loadout:full});assert.throws(()=>f.act('quest_claim',{quest:'first_quest'}),/Make room/);assert.equal(f.paid.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quest_claims').get().n,0);full.inventory=[];f.act('loadout',{loadout:full});f.act('quest_claim',{quest:'first_quest'});assert.ok(f.last.onlineQuests.instances[0].reward.cappedCoins>0);assert.ok(f.c.loadout.player_spells.includes(spell));assert.equal(f.c.loadout.inventory.length,1);const old=structuredClone(f.c.loadout);old.player_spells=[];f.act('loadout',{loadout:old});assert.ok(f.c.loadout.player_spells.includes(spell));
 }finally{f.close();}});
test('online clocks pause after presence expires and across restart; real-time deadlines do not',()=>{const f=fixture();try{
 for(const mode of ['online','realtime'])f.publish('quest',quest({id:'clock_'+mode,timer:{mode,seconds:40},stages:[{id:'waiting',objectives:[{id:'wait',type:'timer',count:100}],next:'complete'}]}));for(const mode of ['online','realtime'])acceptQuest(f,{quest:'clock_'+mode});f.advance(30000);f.api.tick();f.advance(60000);f.restart();f.api.tick();const states=f.api.read('',f.c.id).onlineQuests.instances;assert.equal(states.find(q=>q.quest==='clock_online').status,'active');assert.equal(states.find(q=>q.quest==='clock_realtime').status,'failed');
 }finally{f.close();}});

test('zone timers count only connected destination intervals and preserve credit across travel and restart',()=>{const f=fixture();try{
 f.publish('quest',quest({timer:{mode:'realtime',seconds:0},stages:[{id:'stay',objectives:[{id:'watch',type:'timer',count:90,zone:'honeydew-lantern'}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});
 const progress=()=>f.api.quests.detail(f.c,f.c,'first_quest').objectives[0].progress;
 const presence=(zone='honeydew-lantern')=>f.db.prepare('UPDATE quest_presence SET zone=?,seen=? WHERE character_id=?').run(zone,Date.parse('2026-09-19T12:00:00Z')+time,f.c.id);
 let time=0;const step=ms=>{time+=ms;f.advance(ms);};f.api.tick();step(10000);presence();f.api.tick();assert.equal(progress(),10);
 f.api.tick();assert.equal(progress(),10,'Duplicate ticks do not repeat credit');
 presence('littlebig-clockwork');f.api.tick();step(20000);presence('littlebig-clockwork');f.api.tick();assert.equal(progress(),10,'Other zones do not count');
 presence();f.api.tick();step(10000);presence();f.api.tick();assert.equal(progress(),20,'Returning continues accumulated time');
 step(30000);f.api.tick();const disconnected=progress();step(300000);presence();f.api.tick();assert.equal(progress(),disconnected,'A refreshed lease cannot backfill offline time');
 step(300000);f.restart();f.api.tick();assert.equal(progress(),disconnected,'Server downtime does not count even with a realtime quest clock');
 presence();f.api.tick();step(10000);presence();f.api.tick();assert.equal(progress(),disconnected+10);
 }finally{f.close();}});

test('zone timer upgrade preserves previously recorded objective credit without granting offline time',()=>{const f=fixture();try{
 f.publish('quest',quest({stages:[{id:'stay',objectives:[{id:'watch',type:'timer',count:120,zone:'honeydew-lantern'}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});
 const row=f.db.prepare('SELECT id,state FROM online_quests').get(),state=JSON.parse(row.state);delete state.objective_elapsed;state.progress['stay:watch']=45;
 f.db.prepare('UPDATE online_quests SET state=? WHERE id=?').run(JSON.stringify(state),row.id);f.advance(300000);f.restart();f.api.tick();
 assert.equal(f.api.quests.detail(f.c,f.c,'first_quest').objectives[0].progress,45);
 }finally{f.close();}});
test('repeat policies use claim time, and accepted reward revisions survive publication and rollback',()=>{const f=fixture();try{
 f.publish('quest',quest({repeat:'cooldown',cooldown_seconds:2}));acceptQuest(f,{quest:'first_quest'});f.act('quest_claim',{quest:'first_quest'});assert.throws(()=>acceptQuest(f,{quest:'first_quest'}),/not available again/);f.advance(2100);acceptQuest(f,{quest:'first_quest'});f.publish('quest',quest({repeat:'cooldown',cooldown_seconds:2,rewards:{coins:99}}));assert.equal(f.last.onlineQuests.instances.find(q=>q.status==='ready').rewards.coins,10);f.act('quest_claim',{quest:'first_quest'});assert.equal(f.paid.length,2);
 }finally{f.close();}});
test('party event credit requires proximity and per-objective opt-in; kill events remain encounter-scoped',()=>{const f=fixture();try{f.publish('npc',npc);
 f.publish('quest',quest({stages:[{id:'talking',objectives:[{id:'chat',type:'talk',target:npc.id,sharing:'party'}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});const original=f.db.prepare('SELECT * FROM online_quests').get(),other='other-character';f.db.prepare('INSERT INTO quest_characters VALUES (?,?,?,?,?,?,?)').run(other,'bob','Bob',0,0,JSON.stringify(f.c),'bob-create');f.db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)').run('other-quest',other,original.quest,original.revision,original.definition,original.state,original.created);const p=f.db.prepare('SELECT * FROM quest_presence').get();f.db.prepare('INSERT INTO quest_presence(owner,character_id,zone,grant_id,controller,x,y,seen,moved) VALUES (?,?,?,?,?,?,?,?,?)').run('bob',other,p.zone,'bob','bob',p.x+8,p.y,p.seen,p.moved);f.db.prepare('INSERT INTO quest_parties VALUES (?,?,?)').run('party',f.c.id,0);for(const id of [f.c.id,other])f.db.prepare('INSERT INTO quest_party_members VALUES (?,?,?)').run(id,'party',0);
 f.api.quests.event(f.c,f.c,{id:'talk-event',type:'talk',target:npc.id});assert.equal(JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE id=?').get('other-quest').state).status,'ready');
 const reset=JSON.parse(original.state);f.db.prepare('UPDATE online_quests SET state=? WHERE id=?').run(JSON.stringify(reset),'other-quest');f.db.prepare('UPDATE quest_presence SET x=x+1 WHERE character_id=?').run(other);f.api.quests.event(f.c,f.c,{id:'far-talk',type:'talk',target:npc.id});assert.equal(JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE id=?').get('other-quest').state).status,'active');
 }finally{f.close();}});
test('required placements block removal, temporary placements expire, and invalid replacement geometry is rejected',()=>{const f=fixture();try{
 f.publish('npc',npc);const map=place(f,'npc',npc.id),p=map.placements[0];f.publish('quest',quest({stages:[{id:'talking',objectives:[{id:'chat',type:'talk',target:npc.id}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});assert.throws(()=>f.api.world.act({action:'world_remove_content',zone:map.id,revision:map.revision,edition:map.edition,placement:p.id}),/Active quests depend/);
 const temporary=place(f,'token','temporary_token','temporary'),frozen=structuredClone(temporary.floor);assert.equal(f.api.quests.placements.realize(map.id,'next-map',frozen).length,1);frozen.walls=frozen.walls.map(row=>row.map(()=>1));assert.throws(()=>f.api.quests.placements.realize(map.id,'invalid-map',frozen),/No reachable tile/);const latest=f.api.world.map(map.id);f.api.world.act({action:'world_remove_content',zone:map.id,revision:latest.revision,edition:latest.edition,placement:p.id,resolution:'fail'});assert.equal(f.api.read('',f.c.id).onlineQuests.instances[0].status,'failed');
 }finally{f.close();}});

test('Dive regeneration realizes persistent NPCs, expires temporary objects and keeps the old map after placement failure',async()=>{const f=fixture();try{
 f.publish('npc',npc);const zone='dive-quarters';place(f,'npc',npc.id,'persistent',zone);place(f,'token','one_map_token','temporary',zone);let map=f.api.world.map(zone),old=map.edition;
 f.api.world.act({action:'world_regenerate',zone,edition:map.edition,revision:map.revision,confirm_reset_rewards:true});f.restart();f.api.tick();await new Promise(r=>setImmediate(r));f.advance(1100);f.api.tick();map=f.api.world.map(zone);assert.notEqual(map.edition,old);assert.equal(map.placements.length,1);assert.equal(map.placements[0].content,npc.id);
 old=map.edition;f.api.world.act({action:'world_regenerate',zone,edition:map.edition,revision:map.revision,confirm_reset_rewards:true});f.advance(1100);f.api.tick();await new Promise(r=>setImmediate(r));const job=f.db.prepare("SELECT * FROM world_regeneration WHERE status='draining'").get();assert.ok(job);const broken=JSON.parse(job.candidate);broken.walls=broken.walls.map(row=>row.map(()=>1));f.db.prepare('UPDATE world_regeneration SET candidate=? WHERE id=?').run(JSON.stringify(broken),job.id);f.advance(1100);f.api.tick();map=f.api.world.map(zone);assert.equal(map.edition,old);assert.equal(map.lastJob.status,'failed');assert.match(map.lastJob.error,/No reachable tile/);
 }finally{f.close();}});
test('NPC publication validates references, retired dependencies and old-client entry is gated',()=>{const f=fixture();try{
 assert.throws(()=>f.publish('quest',quest({turn_in:{mode:'npc',npc:'missing_npc'}})),/referenced NPC/);f.publish('npc',npc);f.publish('quest',quest({givers:[npc.id]}));assert.throws(()=>f.publish('npc',{...npc,retired:true}),/referencing/);assert.throws(()=>f.act('enter',{zone:'honeydew-lantern',content_version:1,combat_version:3}),/Update the game/);assert.throws(()=>f.api.questRead('', 'someone-elses-character','first_quest'),/not found for this account/);
 }finally{f.close();}});
test('UTC daily and weekly eligibility opens only after the claim period ends',()=>{const f=fixture();try{
 for(const repeat of ['daily','weekly'])f.publish('quest',quest({id:'repeat_'+repeat,repeat}));for(const repeat of ['daily','weekly']){acceptQuest(f,{quest:'repeat_'+repeat});f.act('quest_claim',{quest:'repeat_'+repeat});assert.throws(()=>acceptQuest(f,{quest:'repeat_'+repeat}),/not available again/);}
 f.advance(8*86400000);f.act('enter',{zone:'honeydew-lantern',content_version:1,quest_version:1,combat_version:3,loadout:f.c.loadout});for(const repeat of ['daily','weekly'])acceptQuest(f,{quest:'repeat_'+repeat});assert.equal(f.last.onlineQuests.instances.filter(q=>q.status==='ready').length,2);
 }finally{f.close();}});

test('equipment and state predicates must still hold when the remaining objectives finish',()=>{const f=fixture();try{
 const item=Object.keys(hubData.equipment)[0];f.publish('quest',quest({stages:[{id:'checks',objectives:[{id:'gear',type:'equipment',target:item,slot:'head'},{id:'condition',type:'state',field:'shame',value:2},{id:'clock',type:'timer',count:5}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});const gear=structuredClone(f.c.loadout);gear.player_info.equipped_head=item;gear.player_info.shame=3;f.act('loadout',{loadout:gear});assert.equal(f.last.onlineQuests.instances[0].objectives[0].progress,1);gear.player_info.equipped_head='';gear.player_info.shame=0;f.act('loadout',{loadout:gear});f.advance(6000);f.api.tick();const q=f.api.read('',f.c.id).onlineQuests.instances[0];assert.equal(q.status,'active');assert.equal(q.objectives[0].progress,0);assert.equal(q.objectives[1].progress,0);
 }finally{f.close();}});

test('abandoned retired quests resume their exact accepted NPC and reward definitions',()=>{const f=fixture();try{
 f.publish('npc',npc);const map=place(f,'npc',npc.id),p=map.placements[0];f.publish('quest',quest({stages:[{id:'talking',objectives:[{id:'chat',type:'talk',target:npc.id}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});const pinned=f.db.prepare('SELECT revision,definition FROM online_quests').get();f.act('quest_abandon',{quest:'first_quest'});f.publish('quest',quest({retired:true}));f.publish('npc',{...npc,dialogue:[{id:'hello',text:'A changed NPC.',next:'close',actions:[]}]});acceptQuest(f,{quest:'first_quest'});assert.deepEqual(f.db.prepare('SELECT revision,definition FROM online_quests').get(),pinned);beside(f,p);f.act('npc_talk',{placement:p.id,edition:map.edition});assert.equal(f.last.onlineQuests.conversation.text,'Welcome!');
 }finally{f.close();}});

test('map replacement cannot strand an active quest on an expiring objective',()=>{const f=fixture();try{
 const map=place(f,'token','required_token','temporary');f.publish('quest',quest({stages:[{id:'tokens',objectives:[{id:'gather',type:'collect',token:true,target:'required_token'}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});assert.throws(()=>f.api.quests.placements.realize(map.id,'replacement',map.floor),/expiring placement/);place(f,'token','required_token');assert.equal(f.api.quests.placements.realize(map.id,'replacement',map.floor).length,1);
 }finally{f.close();}});

test('conversation offers disclose consequences and reject changed quest revisions',()=>{const f=fixture();try{
 f.publish('npc',npc);f.publish('quest',quest({givers:[npc.id]}));f.publish('npc',{...npc,dialogue:[{id:'hello',text:'Please help.',actions:[{label:'Accept',effect:'offer',quest:'first_quest',next:'close'}]}]});const map=place(f,'npc',npc.id),p=map.placements[0];beside(f,p);f.act('npc_talk',{placement:p.id,edition:map.edition});let talk=f.last.onlineQuests.conversation;assert.match(talk.text,/10 coins/);f.publish('quest',quest({givers:[npc.id],rewards:{coins:20}}));assert.throws(()=>f.act('npc_choice',{conversation:talk.id,page:talk.page,choice:0}),/quest changed/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quests').get().n,0);f.act('npc_talk',{placement:p.id,edition:map.edition});talk=f.last.onlineQuests.conversation;assert.match(talk.text,/20 coins/);f.act('npc_choice',{conversation:talk.id,page:talk.page,choice:0});assert.equal(f.last.onlineQuests.instances[0].status,'ready');
 }finally{f.close();}});

test('shared delivery consumes only the deliverer tokens and credits the matching nearby objective once',()=>{const f=fixture();try{
 f.publish('npc',npc);const map=place(f,'npc',npc.id),p=map.placements[0];f.publish('quest',quest({stages:[{id:'delivery',objectives:[{id:'parcel',type:'deliver',target:'parcel',token:true,npc:npc.id,sharing:'party'}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});const original=f.db.prepare('SELECT * FROM online_quests').get(),state=JSON.parse(original.state);state.tokens.parcel=1;f.db.prepare('UPDATE online_quests SET state=? WHERE id=?').run(JSON.stringify(state),original.id);const other='delivery-friend';f.db.prepare('INSERT INTO quest_characters VALUES (?,?,?,?,?,?,?)').run(other,'bob','Bob',0,0,JSON.stringify(f.c),'bob-create');f.db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)').run('friend-quest',other,original.quest,original.revision,original.definition,original.state,original.created);const pos=f.db.prepare('SELECT * FROM quest_presence').get();f.db.prepare('INSERT INTO quest_presence(owner,character_id,zone,grant_id,controller,x,y,seen,moved) VALUES (?,?,?,?,?,?,?,?,?)').run('bob',other,pos.zone,'bob','bob',p.x+2,p.y,pos.seen,pos.moved);f.db.prepare('INSERT INTO quest_parties VALUES (?,?,?)').run('delivery-party',f.c.id,0);for(const id of [f.c.id,other])f.db.prepare('INSERT INTO quest_party_members VALUES (?,?,?)').run(id,'delivery-party',0);beside(f,p);f.act('npc_talk',{placement:p.id,edition:map.edition});const command=f.command('quest_deliver',{quest:'first_quest',objective:'parcel',conversation:f.last.onlineQuests.conversation.id});f.send(command);f.send(command);const mine=JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE id=?').get(original.id).state),friend=JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE id=?').get('friend-quest').state);assert.equal(mine.tokens.parcel,0);assert.equal(friend.tokens.parcel,undefined);assert.equal(friend.status,'ready');
 }finally{f.close();}});

test('token and object artwork accepts shipped icons and immutable uploads, rejecting unknown references',()=>{const f=fixture();try{
 const icon='sprIcon_stamina_potion';assert.ok(f.live.view().compiledSprites.includes(icon));assert.ok(f.live.asset(icon).png);
 let map=place(f,'token','quest_parcel','persistent','honeydew-lantern',{sprite:icon});const token=map.placements.find(p=>p.content==='quest_parcel');assert.equal(token.sprite,icon);
 const asset=f.live.putAsset({png:'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAN0lEQVR4nO3QQREAMAgDQYofTCKxhspUBZ+NgcvsudUvFpebcQcIECBAgAABAgQIECBAgACBTzBf6ALAS4QDIwAAAABJRU5ErkJggg==',frames:1});map=place(f,'interact','quest_switch','persistent',map.id,{sprite:asset.id});assert.equal(map.placements.find(p=>p.content==='quest_switch').sprite,asset.id);
 for(const sprite of ['missing_sprite','managed-missing','https://invalid.test/image.png'])assert.throws(()=>place(f,'token','bad_sprite','persistent',map.id,{sprite}),/artwork|Artwork/);
 f.publish('npc',npc);assert.ok(!f.api.read('',f.c.id).worldPlacements.some(p=>p.id===token.id));assert.equal(f.api.world.map(map.id).placements.find(p=>p.id===token.id).sprite,icon);f.restart();assert.equal(f.api.world.map(map.id).placements.find(p=>p.id===token.id).sprite,icon);assert.equal(f.api.quests.placements.realize(map.id,'replacement',map.floor).find(p=>p.content==='quest_switch').sprite,asset.id);
 }finally{f.close();}});

test('acceptance requires an offered dialogue choice beside the giver, with replay and restart protection',()=>{const f=fixture();try{
 f.publish('quest',quest());const map=place(f,'npc',npc.id),p=map.placements.find(p=>p.content===npc.id);assert.deepEqual(f.api.read('',f.c.id).onlineQuests.available,[]);assert.throws(()=>f.act('quest_accept',{quest:'first_quest'}),/Speak to the designated NPC/);beside(f,p);f.act('npc_talk',{placement:p.id,edition:map.edition});let t=f.last.onlineQuests.conversation;assert.throws(()=>f.act('quest_accept',{quest:'first_quest',conversation:t.id}),/Speak to the designated NPC/);
 const choose=label=>{t=f.api.read('',f.c.id).onlineQuests.conversation;const a=t.choices.find(a=>a.label===label&&a.available);assert.ok(a);return f.act('npc_choice',{conversation:t.id,page:t.page,choice:a.index});};choose('Ask about quests');choose('First quest');t=f.last.onlineQuests.conversation;const command=f.command('npc_choice',{conversation:t.id,page:t.page,choice:t.choices.find(c=>c.label==='Accept quest').index});
 f.db.prepare('UPDATE quest_presence SET x=x+12 WHERE character_id=?').run(f.c.id);assert.throws(()=>f.send(command),/Stand beside/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quests').get().n,0);beside(f,p);f.restart();f.send(command);f.send(command);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quests').get().n,1);assert.deepEqual(f.last.onlineQuests.available,[]);
 }finally{f.close();}});

test('giver menus paginate without replacing original dialogue and enforce acceptance requirements',()=>{const f=fixture();try{
 f.publish('npc',{...npc,dialogue:[{id:'hello',text:'First page',next:'second',actions:[]},{id:'second',text:'Second page',next:'close',actions:[]}]});for(let i=0;i<8;i++)f.publish('quest',quest({id:'offer_'+i,name:'Offer '+i}));f.publish('quest',quest({id:'locked_offer',conditions:[{field:'shame',op:'gte',value:999}]}));assert.throws(()=>f.publish('quest',quest({id:'missing_giver',givers:[]})),/quest giver/);const map=place(f,'npc',npc.id),p=map.placements.find(p=>p.content===npc.id);beside(f,p);f.act('npc_talk',{placement:p.id,edition:map.edition});const choose=label=>{const t=f.last.onlineQuests.conversation,c=t.choices.find(c=>c.label===label);assert.ok(c);f.act('npc_choice',{conversation:t.id,page:t.page,choice:c.index});};choose('Continue');assert.equal(f.last.onlineQuests.conversation.text,'Second page');f.act('npc_talk',{placement:p.id,edition:map.edition});choose('Ask about quests');assert.equal(f.last.onlineQuests.conversation.choices.length,8);choose('More quests');assert.equal(f.last.onlineQuests.conversation.choices.length,3);choose('Offer 7');choose('Accept quest');assert.equal(f.last.onlineQuests.instances[0].quest,'offer_7');
 }finally{f.close();}});

test('legacy abandoned journal quests can resume at a newly assigned giver without changing accepted rewards',()=>{const f=fixture();try{
 f.publish('quest',quest({stages:[{id:'wait',objectives:[{id:'wait',type:'timer',count:60}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});f.act('quest_abandon',{quest:'first_quest'});const row=f.db.prepare('SELECT * FROM online_quests').get(),definition=JSON.parse(row.definition);definition.givers=[];definition.npcs={};f.db.prepare('UPDATE online_quests SET definition=? WHERE id=?').run(JSON.stringify(definition),row.id);f.publish('quest',quest({rewards:{coins:99}}));acceptQuest(f,{quest:'first_quest'});const resumed=f.api.read('',f.c.id).onlineQuests.instances[0];assert.equal(resumed.rewards.coins,10);assert.equal(resumed.status,'active');assert.equal(resumed.stage,'wait');
 }finally{f.close();}});

test('wandering NPCs step once per 2 s slot, stay inside their radius, and pause for conversations',()=>{const f=fixture();try{
 f.publish('npc',{...npc,wander_radius:2});const map=place(f,'npc',npc.id),home=map.placements[0].home; // A guide that may roam two tiles from home.
 const where=()=>{const row=f.db.prepare('SELECT body FROM world_placement_maps WHERE zone=? AND edition=?').get(map.id,map.edition);return JSON.parse(row.body)[0];}; // Stored, authoritative NPC position.
 let moved=0,last=where();
 for(let slot=0;slot<30;slot++){
  f.advance(2000);f.api.tick();const once=where();f.advance(1);f.api.tick();const twice=where(); // Two ticks inside one slot (1 ms apart).
  assert.deepEqual(twice,once,'a second tick in the same slot never takes another step');
  assert.ok(Math.abs(once.x-home.x)+Math.abs(once.y-home.y)<=2,'never leaves the wander radius');
  if(once.x!==last.x||once.y!==last.y)moved++;last=once;
 }
 assert.ok(moved>0,'the NPC actually wanders');
 const talking=where(),insert=f.db.prepare('INSERT INTO online_conversations VALUES (?,?,?,?,?,?,?,?)'); // A player holds the guide in conversation.
 insert.run('talker','conv-1',talking.id,map.id,map.edition,'{}','hello',Date.now()+1e12);
 for(let slot=0;slot<5;slot++){f.advance(2000);f.api.tick();}
 const paused=where();assert.deepEqual({x:paused.x,y:paused.y,step:paused.step},{x:talking.x,y:talking.y,step:talking.step},'a held NPC neither moves nor spends its slot');
 f.db.prepare('DELETE FROM online_conversations').run();f.advance(100);f.api.tick(); // Conversation ends inside the same 2 s slot.
 assert.notEqual(where().step,paused.step,'the paused NPC is retried in the same slot once released');
}finally{f.close();}});

test('objective completion flags fire before stage completion and stay once-only after clear, restart and resume',()=>{const f=fixture();try{
 const flag='story_objective_done';authorObjectiveFlag(f,flag);
 f.publish('quest',quest({stages:[{id:'start',objectives:[{id:'healthy',type:'state',field:'health',value:1,on_complete_flags:[flag]},{id:'later',type:'timer',count:10000}],next:'complete'}]}));
 acceptQuest(f,{quest:'first_quest'});assert.equal(f.last.onlineQuests.instances[0].status,'active');assert.equal(objectiveCharacter(f).fullDungeon.flags[flag],true);
 const q=JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE quest=?').get('first_quest').state);assert.equal(q.completion_flags_applied['start:healthy'],true);
 const row=f.db.prepare('SELECT revision FROM quest_characters WHERE id=?').get(f.c.id);
 f.api.world.flows.gm({action:'flow_flag_set',character_id:f.c.id,revision:row.revision,flag,value:false},'dm');
 f.act('heartbeat',{revision:row.revision+1});assert.equal(objectiveCharacter(f).fullDungeon.flags[flag],false,'A satisfied predicate must not undo a later clear action');
 f.restart();f.act('heartbeat');assert.equal(objectiveCharacter(f).fullDungeon.flags[flag],false);
 f.act('quest_abandon',{quest:'first_quest'});acceptQuest(f,{quest:'first_quest'});assert.equal(objectiveCharacter(f).fullDungeon.flags[flag],false,'Resuming the same attempt retains the receipt');
}finally{f.close();}});

test('objective completion flags respect token thresholds, any-stage completion and pinned accepted actions',()=>{const f=fixture();try{
 const flag='story_collected',replacement='story_changed',skipped='story_not_completed';for(const id of [flag,replacement,skipped])authorObjectiveFlag(f,id);
 const d=quest({stages:[{id:'gather',mode:'any',objectives:[{id:'stars',type:'collect',target:'stars',token:true,count:2,on_complete_flags:[flag]},{id:'never',type:'timer',count:10000,on_complete_flags:[skipped]}],next:'complete'}]});
 f.publish('quest',d);const first=place(f,'token','stars').placements.find(p=>p.kind==='token'),map=place(f,'token','stars'),second=map.placements.find(p=>p.kind==='token'&&p.id!==first.id);acceptQuest(f,{quest:'first_quest'});
 d.stages[0].objectives[0].on_complete_flags=[replacement];f.publish('quest',d);authorObjectiveFlag(f,flag,true); // Live retirement does not rewrite the accepted, authorized target list.
 beside(f,first);f.act('quest_interact',{placement:first.id,edition:map.edition});assert.equal(objectiveCharacter(f).fullDungeon?.flags?.[flag],undefined);
 beside(f,second);const cmd=f.command('quest_interact',{placement:second.id,edition:map.edition});f.send(cmd);f.send(cmd);
 assert.equal(f.last.onlineQuests.instances[0].status,'ready');const flags=objectiveCharacter(f).fullDungeon.flags;assert.equal(flags[flag],true);assert.equal(flags[replacement],undefined);assert.equal(flags[skipped],undefined,'Completing an any-stage never completes its other objectives');
 assert.equal(JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE quest=?').get(d.id).state).completion_flags_applied['gather:stars'],true);
}finally{f.close();}});

test('objective completion flags from passive timers persist character revisions and grant again on a new repeat attempt',()=>{const f=fixture();try{
 const flag='story_timer_done';authorObjectiveFlag(f,flag);
 f.publish('quest',quest({repeat:'cooldown',cooldown_seconds:1,stages:[{id:'wait',objectives:[{id:'clock',type:'timer',count:5,on_complete_flags:[flag]}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});
 const before=f.db.prepare('SELECT revision FROM quest_characters WHERE id=?').get(f.c.id).revision;f.advance(6000);f.api.tick();
 assert.equal(objectiveCharacter(f).fullDungeon.flags[flag],true);assert.equal(f.db.prepare('SELECT revision FROM quest_characters WHERE id=?').get(f.c.id).revision,before+1);
 f.restart();assert.equal(f.c.fullDungeon.flags[flag],true);f.act('quest_claim',{quest:'first_quest'});
 const row=f.db.prepare('SELECT revision FROM quest_characters WHERE id=?').get(f.c.id);f.api.world.flows.gm({action:'flow_flag_set',character_id:f.c.id,revision:row.revision,flag,value:false},'dm');f.restart();f.advance(2000);
 acceptQuest(f,{quest:'first_quest'});assert.equal(objectiveCharacter(f).fullDungeon.flags[flag],false);f.advance(6000);f.api.tick();assert.equal(objectiveCharacter(f).fullDungeon.flags[flag],true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM online_quests WHERE quest=?').get('first_quest').n,2);
}finally{f.close();}});

test('objective completion flags persist for eligible nearby party members and exclude distant members',()=>{const f=fixture();try{
 const flag='story_party_token';authorObjectiveFlag(f,flag);
 const map=place(f,'token','parcel'),token=map.placements.find(p=>p.kind==='token');
 f.publish('quest',quest({stages:[{id:'find',objectives:[{id:'parcel',type:'collect',target:'parcel',token:true,sharing:'party',on_complete_flags:[flag]}],next:'complete'}]}));acceptQuest(f,{quest:'first_quest'});beside(f,token);
 const q=f.db.prepare('SELECT * FROM online_quests WHERE quest=?').get('first_quest'),pos=f.db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(f.c.id);
 f.db.prepare('INSERT INTO quest_parties VALUES (?,?,?)').run('flag-party',f.c.id,0);f.db.prepare('INSERT INTO quest_party_members VALUES (?,?,?)').run(f.c.id,'flag-party',0);
 for(const [id,offset] of [['near-friend',2],['far-friend',30]]){
  f.db.prepare('INSERT INTO quest_characters VALUES (?,?,?,?,?,?,?)').run(id,id,id,0,0,JSON.stringify(objectiveCharacter(f)),id+'-create');
  f.db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)').run(id+'-quest',id,q.quest,q.revision,q.definition,q.state,q.created);
  f.db.prepare('INSERT INTO quest_presence(owner,character_id,zone,grant_id,controller,x,y,seen,moved) VALUES (?,?,?,?,?,?,?,?,?)').run(id,id,pos.zone,id,id,token.x+offset,token.y,pos.seen,pos.moved);
  f.db.prepare('INSERT INTO quest_party_members VALUES (?,?,?)').run(id,'flag-party',0);
 }
 const cmd=f.command('quest_interact',{placement:token.id,edition:map.edition});f.send(cmd);f.send(cmd);
 assert.equal(objectiveCharacter(f).fullDungeon.flags[flag],true);assert.equal(objectiveCharacter(f,'near-friend').fullDungeon.flags[flag],true);assert.equal(objectiveCharacter(f,'far-friend').fullDungeon?.flags?.[flag],undefined);
 const receipt=JSON.parse(f.db.prepare('SELECT state FROM online_quests WHERE id=?').get('near-friend-quest').state);assert.equal(receipt.completion_flags_applied['find:parcel'],true);
 assert.equal(f.db.prepare('SELECT revision FROM quest_characters WHERE id=?').get('near-friend').revision,1);
 f.restart();assert.equal(objectiveCharacter(f,'near-friend').fullDungeon.flags[flag],true);
}finally{f.close();}});

test('objective completion flags validate authored references on publish and rollback, and prevent referenced flag retirement',()=>{const f=fixture();try{
 const flag='story_valid_completion';authorObjectiveFlag(f,flag);authorObjectiveFlag(f,'story_retired_completion',true);
 const d=quest(),o=d.stages[0].objectives[0];
 for(const value of [['school_graduated'],['__proto__'],['story_'],['story_invalid-flag'],'story_wrong_type',Array(17).fill(flag)]){o.on_complete_flags=value;assert.throws(()=>f.publish('quest',d),/authored|entries/);}
 for(const value of ['story_missing_completion','story_retired_completion']){o.on_complete_flags=[value];assert.throws(()=>f.publish('quest',d),/Unknown or retired objective completion flag/);}
 o.on_complete_flags=[flag,flag];const saved=f.publish('quest',d);assert.deepEqual(saved.draft.stages[0].objectives[0].on_complete_flags,[flag]);
 assert.ok(f.api.world.flows.references(flag).some(r=>r.kind==='quests'&&r.id===d.id));assert.throws(()=>authorObjectiveFlag(f,flag,true),/Remove the flag/);
 delete o.on_complete_flags;const clean=f.publish('quest',d);authorObjectiveFlag(f,flag,true);
 assert.throws(()=>f.live.change({action:'content_rollback',kind:'quest',id:d.id,revision:clean.revision,target_revision:saved.revision},'dm'),/Unknown or retired objective completion flag/);
 assert.equal(f.live.published().quests[d.id].stages[0].objectives[0].on_complete_flags,undefined);
}finally{f.close();}});
