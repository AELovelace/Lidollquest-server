// Authoritative campaign interactions. Every caller runs inside the existing zone
// request transaction; presentation is a receipt, never a request to run GML effects.
import {randomUUID} from 'node:crypto';
import {walkable,inside} from './dive-generation.mjs';
import {dungeonReachable} from './full-dungeon-generation.mjs';
import {changeEquipment} from './companion-equipment.mjs';
import {removeCursedGear} from './curse-removal.mjs';
import {addToInventory,slotsUsed,stackable,importLoadout} from './loadout.mjs';
import {awardExperience,currentTuning} from './combat.mjs';
import {loseDignity,dignityOf} from './dignity.mjs';
import {dailyCoinCap} from './hubs.mjs';

const fail=message=>{throw Object.assign(Error(message),{status:409,code:'full_dungeon_conflict'});};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),num=v=>Number.isFinite(Number(v))?Number(v):0;
export const campaignState=s=>s.fullDungeon??={flags:{},counters:{},once:{}};
export function recordDungeonVictories(data,c,s,record,ids,progress,saveProgress){
 if(!data.config.full_dungeon_version)return;const p=progress(c,record.edition);p.defeated??=[];
 for(const id of ids){if(!p.defeated.includes(id))p.defeated.push(id);const enemy=record.floor.enemies.find(e=>e.id===id);if(!enemy)continue;const flags=campaignState(s).flags;flags['defeated:'+enemy.type]=true;if(enemy.type==='matron_rosalind_boss')flags.matron_rosalind_defeated=true;if(enemy.type==='school_principal')flags.school_graduated=true;}
 saveProgress(c,record.edition,p);
} // A participant's boss loot remains available after the shared boss respawns.
export function dungeonSkillCheck(check,s,roll,extra=0){
 const p=s.loadout.player_info,m=campaignState(s);let bonus=extra;
 for(const mod of check.state_modifiers??[]){const k=mod.state??mod.when,values={childish_score:num(s.loadout.childish),childish:num(s.loadout.childish),low_stamina:num(p.stamina)/Math.max(1,num(p.stamina_max))<=0.35,stamina_pct:Math.round(num(p.stamina)/Math.max(1,num(p.stamina_max))*100),crawling:!!s.loadout.world?.crawling,concealed:!s.loadout.world?.panties_showing,panties_concealed:!s.loadout.world?.panties_showing,visible_accident:!!(p.had_wet_accident||p.had_tum_accident)};const value=k?.startsWith('flag:')?!!m.flags[k.slice(5)]:(values[k]??num(p[k]));
  const applies=mod.equals!==undefined?value===mod.equals:mod.not!==undefined?value!==mod.not:(mod.min===undefined||value>=mod.min)&&(mod.max===undefined||value<=mod.max)&&(mod.present!==undefined?!!value===mod.present:!!value);if(applies)bonus+=num(mod.bonus);
 }
 const total=roll(20)+1+num(p[String(check.stat??'cha').toLowerCase()])+bonus,difficulty=num(check.difficulty)||10;return total>=difficulty?'success':total>=difficulty-3?'partial':'failure';
} // Native d20/stat/state modifiers are evaluated once in the command transaction.

export function applyDungeonEffects(effects,c,s,context){
 const {data,roll,origins,db,adjust,now,floor}=context,memory=campaignState(s),lines=[];let p=s.loadout.player_info;
 const delta=(field,n,min=0,max=1000000)=>{p[field]=clamp(num(p[field])+n,min,max);};
 for(const e of effects){
  const amount=num(e.amount??e.min??1)+(e.amount===undefined&&e.max!==undefined?roll(Math.max(1,num(e.max)-num(e.min)+1)):0),type=e.type;
  if(s.loadout.world?.wet_only_mode&&['tum','tum_delta'].includes(type))continue; // The campaign's wet-only setting survives the online port.
  const direct={wet:'wet',wet_delta:'wet',tum:'tum',tum_delta:'tum',excitement:'excitement',inco_up:'incontinence',incontinence_delta:'incontinence',stamina_heal:'stamina',stamina_delta:'stamina',hunger_delta:'hunger',thirst_delta:'thirst'};
  if(direct[type])delta(direct[type],amount,0,direct[type]==='stamina'?num(p.stamina_max)||100:direct[type]==='incontinence'?1000:direct[type]==='hunger'||direct[type]==='thirst'?250:100);
  else if(type==='wet_tum'){delta('wet',amount,0,100);if(!s.loadout.world?.wet_only_mode)delta('tum',amount,0,100);}
  else if(type==='shame'||type==='shame_delta'||type==='shame_relief'){const change=type==='shame'?-amount:amount;if(change<0)loseDignity(p,-change,currentTuning());else p.shame=Math.min(1024,dignityOf(p)+change);}
  else if(type==='set_wet')p.wet=clamp(amount,0,100);
  else if(type==='heal'||type==='damage')delta('playerHealth',type==='heal'?amount:-amount,1,num(p.playerHealthMax)||100);
  else if(type==='str_drain')delta('str',-amount,0);
  else if(type==='stat_buff')delta(String(e.stat).toLowerCase(),amount,-1000000);
  else if(type==='stamina_drain')delta('stamina',-amount,0,num(p.stamina_max)||100);
  else if(type==='excitement_down')delta('excitement',-amount,0,100);
  else if(type==='inco_down')delta('incontinence',-amount,0,1000);
  else if(type==='forced_inco'){if(!(p.forced_inco_turns>0))p.forced_inco_old_inco=num(p.incontinence);p.incontinence=clamp(e.value??amount,0,1000);p.forced_inco_turns=Math.max(num(p.forced_inco_turns),num(e.turns)||10);}
  else if(type==='diaper_wet_delta'){
   const item=s.loadout.inventory.find(i=>i.item_id===p.equipped_panties)??data.items[p.equipped_panties],field=item?.is_diaper?'diaper_wet_absorbed':'had_wet_accident',before=num(p[field]);p[field]=Math.max(0,before+Math.floor(amount));
   if(p[field]>before)p.wet=0;if(!item?.is_diaper&&p.equipped_panties){p.accident_bulk=Math.max(0,num(p.accident_bulk)+p[field]-before);p.panties_bulk=Math.max(0,num(p.panties_bulk)+p[field]-before);}p.slot_wet_panties=item?.is_diaper?num(p.diaper_wet_absorbed)+num(p.diaper_tum_absorbed)>0:num(p.had_wet_accident)+num(p.had_tum_accident)>0; // Exact native direct-fill semantics, committed with the page rather than replayed by the presenter.
  }
  else if(type==='flag')memory.flags[e.key]=e.value??true;
  else if(type==='counter')memory.counters[e.key]=num(memory.counters[e.key])+amount;
  else if(type==='log')lines.push(e.message??'');
  else if(type==='face'||type==='dud'){/* Expression/dud presentation has no gameplay mutation. */}
  else if(['give_item','force_equip_item','replace_diaper'].includes(type)){
   const id=e.item??e.item_id,item=data.items[id];if(!item)throw Error('Unknown full dungeon item '+id);
   if(type==='give_item'){
    if(!stackable(item)&&slotsUsed(s.loadout.inventory)>=data.config.inventory_capacity)fail('Make room in your bag before completing this interaction.');
    const copy=structuredClone(item);if(origins)origins.mint(c.id,copy);addToInventory(s.loadout.inventory,copy);
   }else {
    const old=p.equipped_panties,oldItem=p.equipped_item_data?.panties??data.items[old];
    if(type==='replace_diaper'&&oldItem?.cursed)s.loadout=removeCursedGear(s.loadout,'panties',old,data.items,data.config.inventory_capacity).loadout; // Requested care releases the outgoing curse; ordinary forced outfits keep their existing restrictions.
    s.loadout=changeEquipment(s.loadout,{action:'defeat_equip',item_id:id},data.items,data.config.inventory_capacity);p=s.loadout.player_info;
   }
  }else if(type==='release_campaign_curse'){
   const slot=e.slot,id=p['equipped_'+slot];if(!((slot==='mouth'&&['cursed_paci','cursed_paci_forest'].includes(id))||(slot==='weapon'&&id==='cursed_teddy')))fail('That campaign binding is no longer equipped.');
   const result=removeCursedGear(s.loadout,slot,id,data.items,data.config.inventory_capacity+1);result.loadout.inventory.pop();s.loadout=result.loadout;p=s.loadout.player_info; // Native friendly removal destroys this binding rather than returning it as reusable loot.
  }else if(type==='gold'){
   const day=Math.floor(now()/86400000),used=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(c.owner,day)?.coins??0,paid=Math.min(Math.max(0,amount),Math.max(0,dailyCoinCap()-used));
   if(paid){adjust(c.owner,'coins',paid,'dungeon-'+randomUUID(),'Dungeon discovery');db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(c.owner,day,paid);}lines.push(paid+' LiDollCoins.');
  }else if(type==='xp'){
   if(s.run)fail('Finish the current encounter first.');s.run={enemy:{exp:amount},log:[],hp:p.playerHealth,maxHp:p.playerHealthMax};awardExperience(s,roll);s.run=null; // XP uses a temporary combat context; walking snapshots must retain the explicit idle field.
  }else if(type==='spawn_enemy'){
   if(!floor)throw Error('An encounter effect needs a dungeon floor');
   const candidates=Object.keys(data.enemies).filter(k=>!data.config.bosses.some(b=>b.enemy_id===k)),target=e.enemy_id??e.enemy??candidates[roll(candidates.length)];
   for(let n=0;n<Math.min(6,Math.max(1,amount));n++){
    const at=s.dive.position,positions=[];for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){const x=at.x+dx,y=at.y+dy;if(Math.abs(dx)+Math.abs(dy)<2||!walkable(floor,x,y)||floor.enemies.some(v=>v.x===x&&v.y===y)||floor.safeRooms.some(r=>inside(r,x,y)))continue;positions.push({x,y});}
    if(!positions.length)break;const point=positions[roll(positions.length)];floor.enemies.push({id:'event-enemy-'+randomUUID(),type:target,...point,spawn:{...point},roaming:true,engaged:null,respawnAt:0,manual:true,respawning:false});
   }
  }else throw Error('Unsupported dungeon effect '+type); // Future authored mechanics cannot disappear silently.
 }
 return lines;
}

export function campaignDialogue(npc,s){
 const p=s.loadout.player_info,score=num(s.loadout.childish);
 const flags=campaignState(s).flags,branch=(npc.dialogue_flag_branches??[]).find(b=>(b.all_flags??[]).every(k=>flags[k])&&(!(b.any_flags?.length)||b.any_flags.some(k=>flags[k]))&&(b.no_flags??[]).every(k=>!flags[k])),band=score>=7?'high':score>=4?'mid':'low';
 let tree=s.loadout.world?.panties_showing&&p.had_tum_accident&&npc.dialogue_tum_accident?'dialogue_tum_accident':s.loadout.world?.panties_showing&&p.had_wet_accident&&npc.dialogue_wet_accident?'dialogue_wet_accident':branch?(branch.tree??branch.tree_childish?.[band]):npc.dialogue_mode==='covered_showing'?(s.loadout.world?.panties_showing?'dialogue_showing':'dialogue_covered'):'dialogue_childish_'+band;
 if(!Array.isArray(npc[tree]))tree=npc.default_tree;
 const pages=structuredClone(npc[tree]??[]).map(p=>typeof p==='string'?{text:p}:p),ids=pages.map((p,i)=>p.id??'page_'+i),next=v=>typeof v==='number'?(ids[v]??'close'):v??'close';
 if(!pages.length)pages.push({text:Array.isArray(npc.single_line_cycle)?npc.single_line_cycle[0]:'Hello.',actions:[]});
 if(npc.single_line_cycle===true&&pages.every(p=>!p.actions?.length)){const memory=campaignState(s),key='dialogue:'+npc.name+':'+tree,index=num(memory.counters[key]);memory.counters[key]=index+1;const page=pages[index%pages.length];return [{...page,id:'cycle',next:'close',actions:[]}];} // Single-line residents advance their own saved conversation counter.
 return pages.map((page,i)=>({...page,id:page.id??'page_'+i,next:next(page.close_on_continue?'close':page.next??(i+1<pages.length?i+1:'close')),actions:(page.actions??[]).map(a=>({...a,next:next(a.next),effect:'none',conditions:[]}))}));
} // Choose only the authored reaction tree; no campaign NPC instance is created.

export function campaignChoice(choice,c,s,context){
 const memory=campaignState(s),effects=[];
 const gift=choice.give_item,once=choice.once_key??(gift?'npc-gift:'+gift:null);
 if(once&&memory.once[once])return choice.next;
 if(gift)effects.push({type:'give_item',item:gift});
 effects.push(...(choice.campaign_effects??[]));
 if(choice.shame_delta)effects.push({type:'shame_delta',amount:choice.shame_delta});
 let next=choice.next;
 if(choice.skill_check){
  const check=choice.skill_check,outcome=dungeonSkillCheck(check,s,context.roll); // Dialogue and traps share the campaign's state modifier rules.
  const once=check[outcome+'_once_key'];if(!once||!memory.once[once]){effects.push(...(check[outcome+'_effects']??[]));if(once)memory.once[once]=true;}next=check[outcome+'_next']??next;
 }
 applyDungeonEffects(effects,c,s,context);if(once)memory.once[once]=true;return next;
}

export function createDungeonRules({db,data,now,roll,origins,adjust,progress,saveProgress,saveFloor}){
 const context=(record)=>({db,data,now,roll,origins,adjust,floor:record.floor});
 function present(s,title,message,narrative=''){
  const chunk=data.narratives?.[narrative],pages=structuredClone(chunk?.beats??[{text:message,next:'close'}]);pages.forEach((p,i)=>p.id??='page_'+i);
  const scene={id:randomUUID(),title:chunk?.title??title,text:message,narrative,pages,page:pages[0].id,revision:0,struggle:0,wait:0};if(s.dungeonScene)(s.dungeonScenes??=[]).push(scene);else s.dungeonScene=scene;
 } // A trap and room event on one move retain separate durable interactive presentations.
 function scene(s){const v=s.dungeonScene;if(!v)return null;const p=v.pages?.find(p=>p.id===v.page);return {id:v.id,title:v.title,text:p?.text??v.text,page:v.page,revision:v.revision,actions:p?.actions?.map(a=>({label:a.label}))??[]};}
 function pageEffects(page){const map={give_xp:'xp',shame_delta:'shame_delta',wet_delta:'wet',tum_delta:'tum',hunger_delta:'hunger_delta',thirst_delta:'thirst_delta',diaper_wet_delta:'diaper_wet_delta'};return Object.entries(map).filter(([k])=>page[k]!==undefined).map(([k,type])=>({type,amount:page[k]}));}
 function sceneChoice(c,s,record,input){
  const v=s.dungeonScene;if(!v||v.id!==input.scene||v.page!==input.page||v.revision!==input.mechanism_revision)fail('That scene page changed. Refresh before choosing.');
  const page=v.pages.find(p=>p.id===v.page),actions=page.actions??[],choice=actions.length?actions[input.choice]:input.choice===-1?{}:null;if(!choice||!Number.isInteger(input.choice))fail('Choose a scene option.');
  applyDungeonEffects(pageEffects(page),c,s,context(record));if(!choice.skill_check)applyDungeonEffects(pageEffects(choice),c,s,context(record)); // A skill choice commits its own effects through campaignChoice exactly once.
  v.struggle+=num(choice.trap_struggle);v.wait+=num(choice.trap_wait);let next=choice.skill_check?campaignChoice(choice,c,s,context(record)):choice.next??page.next??(page.close_on_continue?'close':v.pages[v.pages.indexOf(page)+1]?.id??'close');
  for(let n=0;n<32;n++){const dest=v.pages.find((p,i)=>p.id===next||i===next);if(!dest){if(next!=='close'&&next!==-1)throw Error('Invalid dungeon narrative destination '+next);s.dungeonScene=s.dungeonScenes?.shift()??null;return;}
   if(dest.gate_struggle_gte!==undefined||dest.gate_wait_gte!==undefined){next=(dest.gate_struggle_gte!==undefined?v.struggle>=dest.gate_struggle_gte:v.wait>=dest.gate_wait_gte)?dest.gate_pass:dest.gate_fail;continue;}
   v.page=dest.id;v.revision++;return;
  }throw Error('Dungeon narrative gate cycle');
 }
 function effectEvent(c,s,record,event){
  const lines=applyDungeonEffects(event.effects??[{...event,type:event.type}],c,s,context(record));present(s,event.name,event.message??lines.join(' '),event.narrative_chunk??'');
  const personal=progress(c,record.edition);if(event.lingering_turns){personal.lingering??=[];personal.lingering.push({turns:event.lingering_turns,delay:event.lingering_delay??0,wet:event.lingering_wet??0,tum:event.lingering_tum??0});saveProgress(c,record.edition,personal);}saveFloor(record);
 }
 function pick(values){const sum=values.reduce((n,e)=>n+(e.weight??1),0);let n=roll(sum);return values.find(e=>(n-=e.weight??1)<0);}
 function trap(c,s,record,id){
  const personal=progress(c,record.edition);personal.traps??=[];if(personal.traps.includes(id))return;const raw=pick(Object.values(data.traps));if(!raw)return;const event=structuredClone(raw);personal.traps.push(id);saveProgress(c,record.edition,personal);
  let amount=num(event.amount??event.min)+(event.amount===undefined&&event.max!==undefined?roll(event.max-event.min+1):0),bonus=0;const crawl=!!s.loadout.world?.crawling;
  if(amount>0){if(event.trigger_style==='wire'&&crawl&&roll(100)<60||event.trigger_style==='click'&&roll(100)<20)amount=0;else if(event.trigger_style==='swing')amount=Math.max(1,crawl?Math.floor(amount*.85):Math.ceil(amount*1.25));else if(event.trigger_style==='sticky')amount=Math.max(1,crawl?Math.floor(amount*.9):Math.ceil(amount*1.1));}
  if(event.detect_check){const outcome=dungeonSkillCheck(event.detect_check,s,roll);bonus=outcome==='success'?4:outcome==='partial'?2:0;}
  if(event.avoid_check){const outcome=dungeonSkillCheck(event.avoid_check,s,roll,bonus);if(outcome==='success'){present(s,event.name,'You avoid the '+event.name+' entirely.');return;}if(outcome==='partial'&&amount>0)amount=Math.max(1,Math.floor(amount*.5));}
  if(event.resist_check&&amount>0){const outcome=dungeonSkillCheck(event.resist_check,s,roll);if(outcome!=='failure')amount=Math.max(1,Math.floor(amount*(outcome==='success'?.65:.85)));}
  event.amount=amount;event.message=(event.message??'').replaceAll('{value}',String(amount)).replaceAll('{name}',event.name).replaceAll('{trigger}',event.trigger_style??'pressure').replaceAll('{zone}',data.config.event_zone);effectEvent(c,s,record,event);
 }
 function step(c,s,record,x,y){
  let personal=progress(c,record.edition);personal.events??={room:-1,left:0,count:0,once:[],last:''};const tracker=personal.events,f=record.floor;
  for(const e of personal.lingering??[]){if(e.delay>0){e.delay--;continue;}if(e.turns-->0)applyDungeonEffects([{type:'wet',amount:e.wet},{type:'tum',amount:e.tum}],c,s,context(record));}personal.lingering=(personal.lingering??[]).filter(e=>e.turns>0);
  const room=f.rooms.findIndex(r=>inside(r,x,y)),settings=data.event_settings;
  if(room>=0)campaignState(s).flags['visited:'+data.config.zone_id+':'+f.rooms[room].type]=true;
  if(room!==tracker.room){tracker.room=room;tracker.count=0;tracker.left=settings.step_timer_min+roll(settings.step_timer_max-settings.step_timer_min+1);}
  else if(room>=0&&tracker.count<settings.max_events_per_visit&&--tracker.left<=0){
   const r=f.rooms[room],events=Object.values(data.room_events).filter(e=>e.room_types.includes(r.type)&&(!e.once_per_floor||!tracker.once.includes(e.event_id))&&(!settings.avoid_immediate_repeat||e.event_id!==tracker.last));
   if(events.length){const event=pick(events);tracker.count++;tracker.last=event.event_id;if(event.once_per_floor)tracker.once.push(event.event_id);tracker.left=settings.step_timer_min+roll(settings.step_timer_max-settings.step_timer_min+1)+settings.rearm_bonus_steps*tracker.count;saveProgress(c,record.edition,personal);effectEvent(c,s,record,event);personal=progress(c,record.edition);}
  }
  saveProgress(c,record.edition,personal);
  const hidden=f.traps.find(t=>t.x===x&&t.y===y);if(hidden)trap(c,s,record,hidden.id);
  s.dungeonLullaby=(f.lullabyRooms??[]).some(r=>inside(r,x,y)); // Included in the committed needs receipt by dive.mjs.
 }
 function puzzle(c,s,record,input,p){
  const f=record.floor,q=f.puzzles.find(q=>q.id===input.puzzle);if(!q||input.mechanism_revision!==f.mechanismRevision)fail('The puzzle changed. Refresh before acting.');
  const bounds=q.bounds??{x:q.x-2,y:q.y-2,w:5,h:5};
  if(s.run)fail('Finish combat before moving blocks.');if(!inside({x:bounds.x-1,y:bounds.y-1,w:bounds.w+2,h:bounds.h+2},p.x,p.y))fail('Stand beside the puzzle.');
  const visitors=db.prepare('SELECT x,y FROM quest_presence WHERE zone=? AND character_id<>? AND seen>?').all(data.config.zone_id,c.id,now()-30000);
  if(input.action==='dungeon_reset'){
   if(q.solved)fail('This puzzle is already open for this edition.');
   if(q.initial.some(b=>[p,...visitors,...f.enemies.filter(e=>!e.dead)].some(v=>v.x===b.x&&v.y===b.y)))fail('Clear the starting block positions first.');
   for(const b of q.blocks)f.props[b.y][b.x]=0;q.blocks=structuredClone(q.initial);for(const b of q.blocks)f.props[b.y][b.x]=1;
  }else{
   if(q.solved)fail('The puzzle is already solved.');const b=q.blocks.find(b=>b.id===input.block);if(!b||Math.abs(p.x-b.x)+Math.abs(p.y-b.y)!==1)fail('Stand immediately beside that block.');
   const x=b.x+(b.x-p.x),y=b.y+(b.y-p.y);if(!walkable(f,x,y)||visitors.some(v=>v.x===x&&v.y===y)||f.enemies.some(e=>!e.dead&&e.x===x&&e.y===y)||f.exits.some(e=>e.x===x&&e.y===y)||f.fixtures.some(e=>e.x===x&&e.y===y)||!inside(bounds,x,y))fail('There is no space to push that block.');
   f.props[b.y][b.x]=0;b.x=x;b.y=y;f.props[y][x]=1;
   const seen=dungeonReachable(f,p);if(seen.has(q.x+','+q.y)){q.solved=true;for(const b of q.blocks)f.props[b.y][b.x]=0;q.blocks=[];}
  }
  q.revision++;f.mechanismRevision++;f.geometryVersion++;saveFloor(record);
 }
 function act(c,s,record,input,p){
  if(input.action==='dungeon_scene_choice'){sceneChoice(c,s,record,input);return true;}
  if(s.dungeonScene&&['move','dungeon_push','dungeon_reset','dungeon_interact','hub_rest','dive_engage'].includes(input.action))fail('Finish the current dungeon scene first.');
  if(['dungeon_push','dungeon_reset'].includes(input.action)){puzzle(c,s,record,input,p);return true;}
  if(!['dungeon_interact','hub_rest'].includes(input.action))return false;
  if(s.run)fail('Finish combat before using a fixture.');
  const fix=record.floor.fixtures.find(f=>f.id===input.fixture);if(!fix||Math.max(fix.x-p.x,0,p.x-(fix.x+(fix.span_w??1)-1))+Math.max(fix.y-p.y,0,p.y-(fix.y+(fix.span_h??1)-1))!==1)fail('Stand beside that fixture.');
  const personal=progress(c,record.edition);personal.fixtures??={};
  if(input.action==='hub_rest'){
   if(fix.kind!=='bed')fail('Choose a bed.');if(now()-(personal.fixtures[fix.id]??-Infinity)<1000)fail('Wait for the next rest turn.');
   const next=importLoadout(input.loadout);next.player_info.companions=s.loadout.player_info.companions??{};s.loadout=next;personal.fixtures[fix.id]=now(); // Reuse the existing online bed needs-and-choice receipt.
  }else if(fix.kind==='toilet'){
   const p=s.loadout.player_info,item=s.loadout.inventory.find(i=>i.item_id===p.equipped_panties)??data.items[p.equipped_panties];if(item?.is_diaper&&item.cursed)fail('Your cursed diaper prevents using this toilet.');
   p.wet=0;p.tum=0;p.incontinence=Math.max(0,num(p.incontinence)-(3+roll(3)));p.had_wet_accident=false;p.had_tum_accident=false;present(s,fix.name,'You use the '+fix.name.toLowerCase()+'.');
  }
  else if(fix.kind==='bed'){
   if(now()-(personal.fixtures[fix.id]??-Infinity)<1000)fail('Wait for the next rest turn.');personal.fixtures[fix.id]=now();applyDungeonEffects([{type:'heal',amount:2},{type:'stamina_heal',amount:5}],c,s,context(record));present(s,fix.name,'You rest for a moment.');
  }else if(fix.kind==='detail')present(s,fix.name,'',fix.narrative);
  else if(fix.kind==='quest_board')present(s,'Quest Board','Your online journal records your tasks.');
  else fail('Use the conversation or shop controls for this fixture.');
  saveProgress(c,record.edition,personal);return true;
 }
 return {step,trap,act,scene};
}
