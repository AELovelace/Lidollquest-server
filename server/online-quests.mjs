import {refreshMana} from './magic-balance.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {awardExperience,combatData} from './combat.mjs';
import {changeEquipment} from './companion-equipment.mjs';
import {hubData,DAILY_COIN_CAP} from './hubs.mjs';
import {createQuestPlacements} from './quest-placements.mjs';
const clone=structuredClone,fail=(message,status=409)=>{throw Object.assign(Error(message),{status,code:'online_quest_conflict'});};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const period=(mode,time)=>mode==='daily'?Math.floor(time/86400000):mode==='weekly'?Math.floor((time+3*86400000)/604800000):0;
export function createOnlineQuests(db,{live,now=Date.now,world,origins,adjust,roll,parties}){
 db.exec(`CREATE TABLE IF NOT EXISTS online_quests(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,quest TEXT NOT NULL,revision TEXT NOT NULL,definition TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS online_quest_owner ON online_quests(character_id,quest);
 CREATE TABLE IF NOT EXISTS online_quest_events(instance TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(instance,event));
 CREATE TABLE IF NOT EXISTS online_quest_claims(instance TEXT PRIMARY KEY,character_id TEXT NOT NULL,quest TEXT NOT NULL,claimed INTEGER NOT NULL,result TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS online_conversations(character_id TEXT PRIMARY KEY,id TEXT NOT NULL,placement TEXT NOT NULL,zone TEXT NOT NULL,edition TEXT NOT NULL,definition TEXT NOT NULL,page TEXT NOT NULL,expires INTEGER NOT NULL);`);
 const unpack=r=>r?{...r,definition:JSON.parse(r.definition),state:JSON.parse(r.state)}:null;
 const instances=c=>db.prepare('SELECT * FROM online_quests WHERE character_id=? ORDER BY created,id').all(c.id).map(unpack);
 const save=q=>db.prepare('UPDATE online_quests SET state=? WHERE id=?').run(JSON.stringify(q.state),q.id);
 live.setReferenceCheck((kind,body)=>{
  if(body.retired)return;const registry=new Set(world.catalog().map(z=>z.id));
  const npcExists=key=>{if(live.published().npcs[key]&&!live.published().npcs[key].retired)return true;const split=key.indexOf(':');if(split<0||!registry.has(key.slice(0,split)))return false;return (world.map(key.slice(0,split)).floor?.fixtures??[]).some(f=>f.kind==='npc'&&f.id===key.slice(split+1));};
  if(kind==='quest'){
   for(const key of [...body.givers,...(body.turn_in.mode==='npc'?[body.turn_in.npc]:[])])if(!npcExists(key))fail('Choose a published NPC or existing online resident: '+key);
   for(const stage of body.stages)for(const o of stage.objectives){if(o.zone&&!registry.has(o.zone))fail('Choose a registered online zone.');if(o.type==='talk'&&!npcExists(o.target))fail('Choose an existing NPC for this talk objective.');if(['collect','deliver','equipment'].includes(o.type)&&!o.token&&!Object.hasOwn(hubData.equipment,o.target)&&!Object.hasOwn(combatData.defeat_items,o.target))fail('Choose an existing item for this objective.');if(o.type==='deliver'&&!o.npc)o.npc=body.turn_in.npc;if(o.type==='deliver'&&!npcExists(o.npc))fail('Choose an existing delivery NPC.');}
  }else for(const page of body.dialogue)for(const choice of page.actions)if(choice.effect==='branch'&&!live.published().quests[choice.quest]?.stages.some(s=>s.branches.some(b=>b.id===choice.branch)))fail('Choose an existing quest branch.');
 });
 const placements=createQuestPlacements(db,{live,now,base:world,affected:p=>db.prepare('SELECT * FROM online_quests').all().map(unpack).filter(q=>['active','choice','ready'].includes(q.state.status)&&references(q.definition,p.content)&&!placements.rows(p.zone).some(other=>other.id!==p.id&&other.content===p.content&&(!p.replacementEdition||other.lifetime==='persistent'||other.edition===p.replacementEdition))),failQuests:rows=>{for(const q of rows){q.state.status='failed';q.state.failure='A required world placement was removed by a gamemaster.';save(q);}}});
 function references(d,key){return d.turn_in.npc===key||d.stages.some(s=>s.objectives.some(o=>o.target===key||o.npc===key));}
 function position(c,s){const p=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);if(!p)return null;return {...p,edition:s.dive?.edition??world.map(p.zone).edition};}
 function field(s,key){const p=s.loadout?.player_info??{};return key==='childish'?s.loadout?.childish??0:key==='health'?p.playerHealth??0:Number(p[key]??0);}
 function conditions(s,list=[]){return list.every(c=>{const value=field(s,c.field);return c.op==='eq'?value===c.value:c.op==='lte'?value<=c.value:value>=c.value;});}
 function active(c,key){return instances(c).find(q=>q.quest===key&&['active','choice','ready'].includes(q.state.status));}
 function eligible(c,d){const all=instances(c);if(all.some(q=>q.quest===d.id&&['active','choice','ready'].includes(q.state.status)))return false;const claimed=db.prepare('SELECT * FROM online_quest_claims WHERE character_id=? AND quest=? ORDER BY claimed DESC LIMIT 1').get(c.id,d.id);if(!claimed)return true;if(d.repeat==='once')return false;if(d.repeat==='cooldown')return now()>=claimed.claimed+d.cooldown_seconds*1000;return period(d.repeat,now())>period(d.repeat,claimed.claimed);}
 function nearby(c,s,key,edition){const p=position(c,s);if(!p||p.seen<=now()-30000)fail('Enter an online zone first.');if(edition&&p.edition!==edition)fail('This map has changed.');const map=placements.view(p.zone),managed=map.placements.find(n=>n.id===key||n.kind==='npc'&&n.content===key),fixture=(map.floor?.fixtures??[]).find(n=>n.kind==='npc'&&(n.id===key||p.zone+':'+n.id===key));const n=managed??fixture;if(!n||Math.abs(n.x-p.x)+Math.abs(n.y-p.y)>1)fail('Stand beside this NPC or objective.');return {p,map,n,key:managed?.content??p.zone+':'+fixture.id};}
 function npcDefinition(key,n,c){const pinned=instances(c).find(q=>['active','choice','ready'].includes(q.state.status)&&q.definition.npcs?.[key])?.definition.npcs[key];return pinned??live.published().npcs[key]??{id:key,name:n.name,dialogue:[{id:'greeting',text:n.line??'Hello.',next:'close',actions:[]}],quests:[],sprite:n.sprite??''};}
 function offerDefinition(c,key){return instances(c).find(q=>q.quest===key&&q.state.status==='abandoned')?.definition??live.published().quests[key];}
 function offersFrom(d,source){return !!source&&(d.givers.length?d.givers.includes(source):(d.turn_in.mode==='npc'&&d.turn_in.npc===source)||!!live.published().npcs[source]?.quests.includes(d.id)||(d.turn_in.mode==='journal'&&!!live.published().quests[d.id]?.givers.includes(source)));}
 function canOffer(c,s,d,source){return !!d&&!d.retired&&offersFrom(d,source)&&eligible(c,d)&&conditions(s,d.conditions)&&d.prerequisites.every(key=>db.prepare('SELECT 1 FROM online_quest_claims WHERE character_id=? AND quest=?').get(c.id,key));}
 function prepareConversation(c,s,definition){ // Add paged offers without changing the NPC's published dialogue or services.
  const keys=new Set([...Object.keys(live.published().quests),...instances(c).filter(q=>q.state.status==='abandoned').map(q=>q.quest)]),offers=[...keys].map(key=>offerDefinition(c,key)).filter(d=>canOffer(c,s,d,definition.id)&&!definition.dialogue.some(page=>page.actions.some(a=>a.effect==='offer'&&a.quest===d.id))).slice(0,64);
  if(offers.length&&definition.dialogue.length){
   const root=definition.dialogue[0];if(!root.actions.length)root.actions.push({label:'Continue',next:root.next??'close',effect:'none'});
   root.actions.push({label:'Ask about quests',next:'_offers_0',effect:'none'});
   for(let offset=0;offset<offers.length;offset+=6){const menu='_offers_'+offset,actions=[];
    for(const d of offers.slice(offset,offset+6)){const page='_offer_'+d.id,resume=instances(c).some(q=>q.quest===d.id&&q.state.status==='abandoned');actions.push({label:d.name,next:page,effect:'none'});definition.dialogue.push({id:page,text:d.name+'\n\n'+d.description,next:menu,actions:[{label:resume?'Resume quest':'Accept quest',next:'_accepted_'+d.id,effect:'offer',quest:d.id},{label:'Back to quests',next:menu,effect:'none'}]});definition.dialogue.push({id:'_accepted_'+d.id,text:'Quest added to your journal: '+d.name+'.',next:root.id,actions:[]});}
    if(offset+6<offers.length)actions.push({label:'More quests',next:'_offers_'+(offset+6),effect:'none'});actions.push({label:offset?'Previous quests':'Back to conversation',next:offset?'_offers_'+(offset-6):root.id,effect:'none'});definition.dialogue.push({id:menu,text:'What would you like to help with?',next:root.id,actions});
   }
  }
  definition.quest_reviews={};for(const choice of definition.dialogue.flatMap(page=>page.actions))if(choice.effect==='offer'){const d=offerDefinition(c,choice.quest);if(d)definition.quest_reviews[choice.quest]={revision:digest(d),name:d.name,rewards:d.rewards};}
  return definition;
 }
 function accept(c,s,key,source){const previous=instances(c).find(q=>q.quest===key&&q.state.status==='abandoned'),d=previous?.definition??live.published().quests[key];if(!d||d.retired)fail('This quest is not available.');if(instances(c).filter(q=>['active','choice','ready'].includes(q.state.status)).length>=16)fail('Finish or abandon a quest before accepting another (16 active quests).');if(!eligible(c,d))fail('This quest is already active or is not available again yet.');if(!conditions(s,d.conditions)||d.prerequisites.some(k=>!db.prepare('SELECT 1 FROM online_quest_claims WHERE character_id=? AND quest=?').get(c.id,k)))fail('Quest requirements are not met.');
  if(!offersFrom(d,source))fail('Accept this quest from its designated NPC.');
  return instantiate(c,s,key,d,previous);
 }
 function instantiate(c,s,key,d,previous){ // Pin the definition and create (or resume) one instance; shared by NPC acceptance and the GM start tool.
  const definition=clone(d),equipment={...hubData.equipment,...combatData.defeat_items};
  definition.items??=Object.fromEntries([...new Set([...definition.rewards.items.map(i=>i.id),...definition.rewards.equipment])].map(id=>[id,clone(equipment[id])]));definition.npcs??={};
  for(const [id,npc] of Object.entries(live.published().npcs))if(!previous&&(references(definition,id)||definition.givers.includes(id)||npc.quests.includes(key)))definition.npcs[id]=clone(npc);
  const q={id:previous?.id??randomUUID(),quest:key,character_id:c.id,revision:digest(definition),definition,created:previous?.created??now(),state:previous?{...previous.state,status:previous.state.abandoned_status??'active'}:{status:'active',stage:definition.stages[0].id,progress:{},tokens:{},elapsed:0,last_tick:now(),branch:[]}};
  db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(q.id,c.id,key,q.revision,JSON.stringify(definition),JSON.stringify(q.state),q.created);evaluate(q,c,s);return q;
 } // Reaccepting an abandoned attempt resumes its original timer and progress instead of resetting eligibility.
 function transition(q,to){if(['complete','failed'].includes(to))q.state.status=to==='complete'?'ready':'failed';else{q.state.stage=to;q.state.status='active';q.state.stage_started=q.state.elapsed;}}
 function evaluate(q,c,s,event=null){
  if(q.state.status!=='active')return;const stage=q.definition.stages.find(v=>v.id===q.state.stage),progress=q.state.progress,grantedTokens=new Set();
  for(const o of stage.objectives){const key=stage.id+':'+o.id;if(!conditions(s,o.conditions)){if(['state','equipment','collect'].includes(o.type)&&!o.token)progress[key]=0;continue;}let count=progress[key]??0;
   if(o.type==='state')count=conditions(s,[o])?o.count:0;
   if(o.type==='equipment'){count=0;const p=s.loadout?.player_info??{};if(o.slot?p['equipped_'+o.slot]===o.target:Object.entries(p).some(([k,v])=>k.startsWith('equipped_')&&v===o.target))count=o.count;}
   if(o.type==='collect'&&!o.token)count=(s.loadout?.inventory??[]).filter(i=>i.item_id===o.target).length;
   if(o.type==='timer')count=Math.floor((q.state.elapsed-(q.state.stage_started??0))/1000);
   if(event&&o.token&&o.type==='collect'&&event.type==='collect'&&event.target===o.target&&(!o.zone||o.zone===event.zone)&&(!event.shared||o.sharing==='party')&&!grantedTokens.has(o.target)){q.state.tokens[o.target]=(q.state.tokens[o.target]??0)+1;grantedTokens.add(o.target);}
   if(event&&(!event.shared||o.sharing==='party')&&(!o.zone||o.zone===event.zone)&&event.type===o.type&&(!o.target||o.target===event.target)&&(!event.objective||event.objective===o.id))count+=event.count??1;
   progress[key]=Math.min(o.count,count);
  }
  const met=o=>(progress[stage.id+':'+o.id]??0)>=o.count;if(stage.mode==='any'?stage.objectives.some(met):stage.objectives.every(met)){if(stage.branches.length)q.state.status='choice';else transition(q,stage.next);}save(q);
 }
 function event(c,s,e){if(!db.prepare("SELECT 1 FROM online_quests WHERE character_id=? AND json_extract(state,'$.status')='active' LIMIT 1").get(c.id)&&!(parties.members(c.id).length))return;const p=position(c,s);e={...e,zone:e.zone??p?.zone,quests:e.quests??instances(c).filter(q=>q.state.status==='active').map(q=>q.quest)};for(const q of instances(c)){if(q.state.status!=='active'||(e.stage&&e.stage!==q.state.stage)||(e.shared&&e.quests&&!e.quests.includes(q.quest))||q.created>(e.created??now()))continue;if(!db.prepare('INSERT OR IGNORE INTO online_quest_events VALUES (?,?)').run(q.id,q.state.stage+':'+e.id).changes)continue;evaluate(q,c,s,e);}
  if(e.shared||e.type==='kill'||!p)return;for(const other of parties.members(c.id)){if(other.id===c.id)continue;const state=JSON.parse(other.state),op=position(other,state);if(op&&op.seen>now()-30000&&op.zone===p.zone&&op.edition===p.edition&&Math.abs(op.x-p.x)+Math.abs(op.y-p.y)<=8)event(other,state,{...e,shared:true});}
 } // Each durable gameplay event can affect an accepted instance at most once, including after restart.
 function advance(c,s,key,branch){const q=active(c,key);if(!q||q.state.status!=='choice')fail('This quest is not awaiting a choice.');const b=q.definition.stages.find(v=>v.id===q.state.stage).branches.find(b=>b.id===branch);if(!b||!conditions(s,b.conditions))fail('That branch is unavailable.');q.state.branch.push(b.id);transition(q,b.to);save(q);}
 function claim(c,s,key,source){const q=active(c,key);if(!q||q.state.status!=='ready')fail('This quest is not ready to turn in.');if(q.definition.turn_in.mode==='npc'&&source!==q.definition.turn_in.npc)fail('Return to the designated NPC.');if(!s.loadout)fail('Load this character before claiming rewards.');
  const r=q.definition.rewards,next=clone(s),capacity=hubData.config.inventory_capacity;if(next.loadout.inventory.length+r.items.reduce((n,i)=>n+i.count,0)>capacity)fail('Make room in your inventory; your reward is still waiting.');
  for(const id of r.equipment)next.loadout=changeEquipment(next.loadout,{action:'defeat_equip',item_id:id},{...hubData.equipment,...combatData.defeat_items,...q.definition.items},capacity);
  for(const item of r.items)for(let n=0;n<item.count;n++)next.loadout.inventory.push(origins.mint(c.id,clone(q.definition.items[item.id])));
  for(const [key,amount] of Object.entries(r.stats))next.loadout.player_info[key]=Math.max(key==='playerHealthMax'?1:-1000000,(next.loadout.player_info[key]??0)+amount);
  next.loadout.player_info.playerHealth=Math.min(next.loadout.player_info.playerHealth,next.loadout.player_info.playerHealthMax);refreshMana(next.loadout);
  if(r.xp){next.run={enemy:{exp:r.xp},log:[],hp:next.loadout.player_info.playerHealth,maxHp:next.loadout.player_info.playerHealthMax};awardExperience(next,roll);delete next.run;}
  for(const spell of r.spells){db.prepare('INSERT OR IGNORE INTO quest_rpp_unlocks VALUES (?,?,?,?)').run(c.id,spell,'spell',now());if(!next.loadout.player_spells.includes(spell))next.loadout.player_spells.push(spell);}
  if(r.rpp){const balance=db.prepare('SELECT balance FROM quest_rpp_wallets WHERE character_id=?').get(c.id)?.balance??0;if(balance+r.rpp>1000000000)fail('Spend some RPP before claiming this reward.');db.prepare('INSERT INTO quest_rpp_wallets VALUES (?,?) ON CONFLICT(character_id) DO UPDATE SET balance=balance+excluded.balance').run(c.id,r.rpp);db.prepare('INSERT INTO quest_rpp_ledger(request_id,fingerprint,owner,character_id,kind,amount,balance,actor,reason,created) VALUES (?,?,?,?,?,?,?,?,?,?)').run('quest:'+q.id,q.revision,c.owner,c.id,'quest',r.rpp,balance+r.rpp,'quest',q.definition.name,now());}
  const day=Math.floor(now()/86400000),spent=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(c.owner,day)?.coins??0,paid=Math.min(r.coins,Math.max(0,DAILY_COIN_CAP-spent));
  if(paid){adjust(c.owner,'coins',paid,'quest-'+q.id,'Quest: '+q.definition.name);db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(c.owner,day,paid);}
  const result={quest:key,name:q.definition.name,coins:paid,cappedCoins:r.coins-paid,xp:r.xp,rpp:r.rpp,items:r.items};db.prepare('INSERT INTO online_quest_claims VALUES (?,?,?,?,?)').run(q.id,c.id,key,now(),JSON.stringify(result));q.state.status='claimed';q.state.reward=result;save(q);Object.assign(s,next);s.questReward=result;
 } // The caller's transaction owns the claim, inventory, progression, currency outbox, and command receipt.
 function gm(c,s,op,key){ // Gamemaster test shortcuts. They move quest state only; rewards still come from the normal turn-in.
  const published=live.published().quests[key],current=active(c,key);
  if(op==='quest_start'){
   if(!published||published.retired)fail('That quest is not published.');
   if(current)fail('That quest is already active; reset it first to start over.');
   if(instances(c).filter(q=>['active','choice','ready'].includes(q.state.status)).length>=16)fail('Finish or abandon a quest before starting another (16 active quests).');
   db.prepare("DELETE FROM online_quests WHERE character_id=? AND quest=? AND json_extract(state,'$.status')='abandoned'").run(c.id,key); // A forced start is always a clean attempt, never a resumed one.
   instantiate(c,s,key,published,null); // Skips giver, eligibility, conditions and prerequisites on purpose.
   return published.name;
  }
  if(op==='quest_reset'){
   const rows=db.prepare('SELECT id FROM online_quests WHERE character_id=? AND quest=?').all(c.id,key);
   if(!rows.length&&!db.prepare('SELECT 1 FROM online_quest_claims WHERE character_id=? AND quest=?').get(c.id,key))fail('This character has no history with that quest.');
   for(const row of rows)db.prepare('DELETE FROM online_quest_events WHERE instance=?').run(row.id); // Forget which events were counted so a new attempt can earn them again.
   db.prepare('DELETE FROM online_quest_claims WHERE character_id=? AND quest=?').run(c.id,key); // Clears once-only and cooldown eligibility for this character alone.
   db.prepare('DELETE FROM online_quests WHERE character_id=? AND quest=?').run(c.id,key);
   return published?.name??key;
  }
  if(!current)fail('That quest is not active on this character.');
  if(op==='quest_complete'){
   if(current.state.status==='ready')fail('That quest is already ready to turn in.');
   current.state.status='ready';save(current); // Skip every remaining stage; the reward is still claimed at the usual NPC or journal.
   return current.definition.name;
  }
  if(op==='quest_advance'){
   if(current.state.status!=='active')fail(current.state.status==='choice'?'Pick a branch in the journal to continue.':'That quest is already ready to turn in.');
   const stage=current.definition.stages.find(v=>v.id===current.state.stage);
   for(const o of stage.objectives)current.state.progress[stage.id+':'+o.id]=o.count; // Mark every objective of this stage met.
   if(stage.branches.length)current.state.status='choice';else transition(current,stage.next); // Same exit rule evaluate() applies to a naturally finished stage.
   save(current);evaluate(current,c,s); // The next stage may already be satisfied by the character's current state.
   return current.definition.name;
  }
  fail('Unknown quest tool.',400);
 }
 function gmCatalog(c){ // Every published quest plus this character's latest status, for the in-game GM list.
  const all=instances(c);
  return Object.values(live.published().quests).filter(d=>!d.retired).slice(0,200).map(d=>{
   const mine=all.filter(q=>q.quest===d.id).at(-1),claimed=db.prepare('SELECT 1 FROM online_quest_claims WHERE character_id=? AND quest=?').get(c.id,d.id);
   return {id:d.id,name:d.name,status:mine?.state.status??(claimed?'claimed':'')};
  });
 }
 function busy(s){if(s.run||s.pendingDefeat||s.worldTurnDue||s.pendingPurchase)fail('Finish the current action before continuing this quest.');}
 function conversation(c,s,input){const row=db.prepare('SELECT * FROM online_conversations WHERE character_id=?').get(c.id);if(!row||row.id!==input.conversation||row.expires<=now())fail('This conversation has ended. Speak to the NPC again.');nearby(c,s,row.placement,row.edition);return {...row,definition:JSON.parse(row.definition)};}
 function act(c,s,input){busy(s);if(input.action==='quest_accept')fail('Speak to the designated NPC and choose a quest in their conversation.');if(input.quest){const q=active(c,input.quest),definition=live.published().quests[input.quest],revision=q?.revision??(definition?digest(definition):null);if(typeof input.quest_revision!=='string'||input.quest_revision!==revision)fail('This quest changed. Refresh before choosing an action.');}if(input.action==='npc_talk'||input.action==='quest_interact'){
   if(typeof input.edition!=='string')fail('Refresh the map before interacting.');const {p,map,n,key}=nearby(c,s,input.placement,input.edition);if(input.action==='quest_interact'){if(n.kind==='npc')fail('Speak to this NPC.');event(c,s,{id:'interact:'+(n.kind==='token'?n.id:input.request_id),type:n.kind==='token'?'collect':'interact',target:key,zone:p.zone});return;}
   if(n.kind!=='npc')fail('Choose an NPC.');const definition=clone(npcDefinition(key,n,c)),cid=randomUUID(),page=definition.dialogue[0]?.id??'close';definition.id=key;prepareConversation(c,s,definition);
   db.prepare('INSERT INTO online_conversations VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET id=excluded.id,placement=excluded.placement,zone=excluded.zone,edition=excluded.edition,definition=excluded.definition,page=excluded.page,expires=excluded.expires').run(c.id,cid,n.id,p.zone,map.edition,JSON.stringify(definition),page,now()+300000);event(c,s,{id:'talk:'+cid,type:'talk',target:key,zone:p.zone});return;
  }
  let source='';if(input.conversation)source=conversation(c,s,input).definition.id;
  if(input.action==='quest_claim')claim(c,s,input.quest,source);
  else if(input.action==='quest_branch')advance(c,s,input.quest,input.branch);
  else if(input.action==='quest_abandon'){const q=active(c,input.quest);if(!q)fail('Quest is not active.');q.state.abandoned_status=q.state.status;q.state.status='abandoned';save(q);}
  else if(input.action==='quest_deliver'){
   const q=active(c,input.quest);if(!q||q.state.status!=='active')fail('Quest is not active.');const stage=q.definition.stages.find(v=>v.id===q.state.stage),o=stage.objectives.find(o=>o.id===input.objective&&o.type==='deliver');if(!o||!conditions(s,o.conditions)||!source||(o.npc&&source!==o.npc))fail('Speak to the delivery NPC.');const key=stage.id+':'+o.id;if((q.state.progress[key]??0)>=o.count)fail('Delivery is already complete.');
   if(o.token){if((q.state.tokens[o.target]??0)<o.count)fail('Collect the required quest tokens first.');q.state.tokens[o.target]-=o.count;}else{const items=s.loadout.inventory.filter(i=>i.item_id===o.target);if(items.length<o.count)fail('Collect the required items first.');const remove=new Set(items.slice(0,o.count));s.loadout.inventory=s.loadout.inventory.filter(i=>!remove.has(i));}q.state.progress[key]=o.count;save(q);evaluate(q,c,s);if(o.sharing==='party')event(c,s,{id:'delivery:'+input.request_id,type:'deliver',target:o.target,count:o.count,objective:o.id,stage:stage.id,quests:[q.quest]});
  }else if(input.action==='npc_choice'){
   const talk=conversation(c,s,input),page=talk.definition.dialogue.find(p=>p.id===talk.page);if(input.page!==talk.page||!page)fail('This dialogue page changed.');if(!Number.isInteger(input.choice)||input.choice < -1)fail('Choose a dialogue option.');const choice=input.choice===-1&&!page.actions.length?{next:page.next,effect:'none'}:page.actions[input.choice];if(!choice||!conditions(s,choice.conditions))fail('This choice is unavailable.');
   if(choice.effect==='offer'){const offered=offerDefinition(c,choice.quest);if(!offered||digest(offered)!==talk.definition.quest_reviews?.[choice.quest]?.revision)fail('This quest changed. Speak to the NPC again before choosing.');if(!canOffer(c,s,offered,talk.definition.id))fail('This quest is already active or is not available again yet.');}
   if(choice.effect==='offer')accept(c,s,choice.quest,talk.definition.id);if(choice.effect==='turn_in')claim(c,s,choice.quest,talk.definition.id);if(choice.effect==='branch')advance(c,s,choice.quest,choice.branch);
   db.prepare('UPDATE online_conversations SET page=?,expires=? WHERE character_id=?').run(choice.next??'close',now()+300000,c.id);
  }else if(input.action==='npc_close')db.prepare('DELETE FROM online_conversations WHERE character_id=?').run(c.id);else fail('Unknown quest action.');
 }
 function publicQuest(q,s){const stage=q.definition.stages.find(v=>v.id===q.state.stage);return {id:q.id,quest:q.quest,revision:q.revision,name:q.definition.name,description:q.definition.description,status:q.state.status,stage:stage?.id,text:stage?.text,objectives:(stage?.objectives??[]).map(o=>({...o,progress:q.state.progress[stage.id+':'+o.id]??0})),branches:q.state.status==='choice'?stage.branches.filter(b=>conditions(s,b.conditions)).map(({id,label})=>({id,label})):[],rewards:q.definition.rewards,turn_in:q.definition.turn_in,remaining:q.definition.timer.seconds?Math.max(0,q.definition.timer.seconds-Math.floor(q.state.elapsed/1000)):null,reward:q.state.reward??null,failure:q.state.failure??q.definition.failure_text};}
 function snapshot(c,s){if(!c)return null;const talk=db.prepare('SELECT * FROM online_conversations WHERE character_id=? AND expires>?').get(c.id,now());let conversation=null;
  if(talk){const d=JSON.parse(talk.definition),page=d.dialogue.find(p=>p.id===talk.page);conversation={id:talk.id,npc:d.id,name:d.name,sprite:d.battle_sprite||d.sprite,page:talk.page,text:(page?.text??'End of conversation.')+(page?.actions.filter(a=>a.effect==='offer').map(a=>{const review=d.quest_reviews?.[a.quest];if(!review)return '';const r=review.rewards;return '\n\n'+review.name+' rewards: '+r.xp+' XP; '+r.coins+' coins (account cap applies); '+r.rpp+' RPP; items: '+r.items.map(i=>i.count+' x '+i.id).join(', ')+'; spells: '+r.spells.join(', ')+'; permanent stats: '+Object.entries(r.stats).map(([key,value])=>key+' '+value).join(', ')+'; forced equipment: '+r.equipment.join(', ');}).join('')??''),ended:!page,choices:page?.actions.map((a,index)=>({index,label:a.label,available:conditions(s,a.conditions)&&(a.effect!=='offer'||canOffer(c,s,offerDefinition(c,a.quest),d.id))}))??[]};}
  return {instances:instances(c).filter(q=>['active','choice','ready'].includes(q.state.status)).map(q=>publicQuest(q,s)).concat(instances(c).filter(q=>!['active','choice','ready'].includes(q.state.status)).slice(-32).map(q=>({...publicQuest(q,s),objectives:[],description:q.definition.description.slice(0,512)}))),available:[],conversation};
 }
 function tickCharacter(c,s){const p=position(c,s);for(const q of instances(c)){if(!['active','choice','ready'].includes(q.state.status))continue;const timer=q.definition.timer,elapsed=timer.mode==='realtime'?now()-q.created:q.state.elapsed+Math.max(0,Math.min(now(),(p?.seen??0)+30000)-(q.state.last_tick??now()));q.state.elapsed=elapsed;q.state.last_tick=now();if(timer.seconds&&elapsed>=timer.seconds*1000&&q.state.status!=='ready'){q.state.status='failed';q.state.failure=q.definition.failure_text;}save(q);evaluate(q,c,s);}}
 function after(c,s,input){if(!db.prepare("SELECT 1 FROM online_quests WHERE character_id=? AND json_extract(state,'$.status') IN ('active','choice') LIMIT 1").get(c.id))return;tickCharacter(c,s);const p=position(c,s);if(p){event(c,s,{id:'zone:'+input.request_id,type:'visit',target:p.zone,zone:p.zone});const map=placements.view(p.zone);for(const place of map.placements)if(place.kind==='location'&&p.x===place.x&&p.y===place.y)event(c,s,{id:'location:'+input.request_id,type:'visit',target:place.content,zone:p.zone});}}
 // Reset online clock checkpoints on boot: time while the service was stopped never counts as connected play.
 for(const row of db.prepare('SELECT * FROM online_quests').all()){const q=unpack(row);if(q.definition.timer.mode==='online'){q.state.last_tick=now();save(q);}}
 return {placements,act,after,event,snapshot,conditions,gm,gmCatalog,detail(c,s,id){const q=instances(c).find(q=>q.id===id||q.quest===id);if(!q)fail('Quest not found.',404);return publicQuest(q,s);},tick(){for(const c of db.prepare("SELECT DISTINCT c.* FROM quest_characters c JOIN online_quests q ON q.character_id=c.id WHERE json_extract(q.state,'$.status') IN ('active','choice')").all())tickCharacter(c,JSON.parse(c.state));placements.tick();}};
}
