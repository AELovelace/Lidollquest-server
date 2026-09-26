import {followerAction,guardianTarget} from './follower-combat.mjs';
import {randomUUID} from 'node:crypto';
import {recordDungeonVictories} from './full-dungeon-rules.mjs';
import {pinDefeat,publicEnemy} from './defeat-scenes.mjs';
import {applyDefeatEquipment} from './defeat-equipment.mjs';
import {applyDefeatDignity} from './defeat-dignity.mjs';
import {applyDefeatAftermath} from './defeat-aftermath.mjs';
import {beginRound,clearEffects,readyTurn,combatAction,enemyAction,tickEnemyEffects,awardExperience,defeatPresentation,combatData,currentTuning} from './combat.mjs';
import {levelEnemy,encounterLevel,routeLevelFor,pickTarget,rowSwapCostsTurn} from './scaling.mjs';
import {isCrawling} from './crawl.mjs';
import {importLoadout,applyRunLoadout,syncRunHealth} from './loadout.mjs';

const fail=message=>{throw Object.assign(Error(message),{status:409,code:'encounter_conflict'});};
const clone=structuredClone;
const defaults={second_enemy_chance:0.5,third_enemy_chance:0.25,base_delay_ms:4000,dexterity_step_ms:100,min_delay_ms:1500,max_delay_ms:6000,player_initial_fill:0.5,enemy_delay_variance:0.2,enemy_initial_stagger_ms:400};
export const encounterTuning={...defaults,...combatData.online_combat};
export const actionDelay=(dex=0,tuning=encounterTuning)=>Math.max(tuning.min_delay_ms,Math.min(tuning.max_delay_ms,tuning.base_delay_ms-tuning.dexterity_step_ms*dex));

export function enemyActionDelay(dex,roll,tuning=encounterTuning){
 const base=actionDelay(dex,tuning),spread=tuning.enemy_delay_variance;
 const low=Math.ceil(Math.max(tuning.min_delay_ms,base*(1-spread))),high=Math.floor(Math.min(tuning.max_delay_ms,base*(1+spread)));
 if(high<=low)return base; // Zero/tiny variance also supports fractional Dexterity without an invalid random interval.
 return low+roll(high-low+1); // Roll inside the legal interval so fast/slow enemies do not all clamp to the same endpoint.
}

export function selectReinforcements(floor,foe,data,roll,time,tuning=encounterTuning){
 const max=(foe.definition??data.enemies[foe.type]).hp,pool=floor.enemies.filter(e=>!e.manual&&!foe.manual&&e.id!==foe.id&&!e.engaged&&e.respawnAt<=time&&(e.definition??data.enemies[e.type])?.hp<=max);
 const chosen=[foe];if(pool.length&&roll(10000)<tuning.second_enemy_chance*10000){
  chosen.push(pool.splice(roll(pool.length),1)[0]);
  if(pool.length&&roll(10000)<tuning.third_enemy_chance*10000)chosen.push(pool.splice(roll(pool.length),1)[0]);
 }return chosen;
} // Draw actual living floor monsters without replacement; their existing IDs carry locks and boss entitlements.

export function selectEncounterEnemies(floor,foe,data,roll,time){
 const guards={matron_rosalind_boss:'nanny_sentinel',slime_queen_boss:'bottle_slime',school_nurse:'teachers_pet',school_nurse_boss:'teachers_pet'};
 const guard=guards[(foe.definition??data.enemies[foe.type]).enemy_id];
 if(guard&&data.enemies[guard])return [foe,...[1,2].map(index=>({id:foe.id+':escort:'+index,type:guard}))];
 return selectReinforcements(floor,foe,data,roll,time);
} // Campaign-authored boss escorts replace random picks and disappear with their encounter; floor residents stay available.

export function applyCombatPatch(loadout,patch){
 if(!Array.isArray(patch)||patch.length>256||Buffer.byteLength(JSON.stringify(patch))>192*1024)fail('Invalid combat changes.');
 const result=clone(loadout),protectedKeys=new Set(['__proto__','prototype','constructor','level','xp','stat_points','playerHealthMax','player_mp_max','name','companions','rpp_abilities']); // Paid passive unlocks only change through the server purchase ledger.
 for(const op of patch){
  if(!Array.isArray(op.path)||!op.path.length||op.path.length>8||op.path.some(k=>typeof k!=='string'||protectedKeys.has(k))||!['player_info','inventory','world','childish','player_mp'].includes(op.path[0]))fail('Unsupported combat change.');
  if(op.path.length===1&&op.path[0]==='inventory'&&Number.isSafeInteger(op.index)){
   if(op.index<0||op.index>result.inventory.length||!Array.isArray(op.before)||!Array.isArray(op.after)||JSON.stringify(result.inventory.slice(op.index,op.index+op.before.length))!==JSON.stringify(op.before))fail('This inventory item changed; refresh before using it.');
   result.inventory.splice(op.index,op.before.length,...clone(op.after));continue;
  } // A one-item use sends a small splice even with a full inventory, rather than two complete inventory copies.
  let dest=result;for(const key of op.path.slice(0,-1)){if(!dest[key]||typeof dest[key]!=='object'||Array.isArray(dest[key]))fail('Invalid combat field.');dest=dest[key];}
  const key=op.path.at(-1),current=dest[key];
  if(typeof op.before==='number'&&typeof op.after==='number'&&typeof current==='number'){if(!Number.isFinite(op.before)||!Number.isFinite(op.after))fail('Invalid combat number.');dest[key]=current+op.after-op.before;}
  else {if(JSON.stringify(current??null)!==JSON.stringify(op.before))fail('This item or status changed; refresh before using it.');dest[key]=clone(op.after);}
 }if(result.player_info&&typeof result.player_info==='object')result.player_info.rpp_abilities=clone(loadout.player_info.rpp_abilities??[]);return importLoadout(result); // A whole player_info replacement cannot bypass protected paid-ability paths.
} // Numeric deltas preserve intervening attacks/heals; structural item edits require an unchanged baseline.

export function createDiveEncounters(db,{live=null,now,roll,data,parties,saveFloor,progress,saveProgress,pay,back,entry,saveCharacter,relocate,context=null}){
 const config=data.config,zone=config.zone_id??'dive-quarters',route=config.route,boss=(config.boss_id??'iris')||'world_boss',z={theme:config.theme??'princess_quarters',activeTime:true};
 db.exec('CREATE TABLE IF NOT EXISTS quest_dive_encounters(id TEXT PRIMARY KEY,route TEXT NOT NULL,edition TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL)');
 db.exec("CREATE INDEX IF NOT EXISTS quest_open_dive_encounters ON quest_dive_encounters(route) WHERE json_extract(state,'$.finished') IS NOT 1"); // Retain history without scanning every settled fight on each simulation tick.
 const fetch=id=>{const row=db.prepare('SELECT state FROM quest_dive_encounters WHERE id=? AND route=?').get(id??'',route);return row?JSON.parse(row.state):null;};
 const write=e=>db.prepare('INSERT INTO quest_dive_encounters VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated').run(e.id,route,e.edition,JSON.stringify(e),now());
 function message(e,text){e.sequence++;e.events.push({seq:e.sequence,text});e.events=e.events.slice(-40);} // Bounded event history keeps snapshots within the gateway budget.
 function roster(e,caller=null,state=null){return [...e.players.map(a=>{const c=caller?.id===a.id?caller:db.prepare('SELECT * FROM quest_characters WHERE id=?').get(a.id);return {a,c,s:caller?.id===a.id?state:JSON.parse(c.state)};}),...(e.followers??[]).map(a=>({a,c:{id:a.id},s:{...a.state,run:a.run}}))];} // NPC state lives inside the encounter, never in a player account.
 function projection(e,a){const enemy=e.enemies.find(v=>v.data.hp>0)??e.enemies[0];const active=[...e.players,...(e.followers??[])].filter(v=>v.status==='active');return {...a.run,row:a.row??'front',rowSwapped:a.rowSwapped===true,rowPartner:active.length>1,rowAlone:!active.some(v=>(v.row??'front')!=='back'),enemy:clone(enemy.data),sharedEncounter:e.id,combatVersion:3,cycle:a.cycle,readyAt:a.readyAt,duration:a.duration,turnReady:a.prepared,phase:'fight',status:a.status,turn:a.cycle,log:e.events.map(v=>v.text)};}
 function persist(e,rows,caller=null){for(const {a,c,s} of rows){if(!e.finished){s.run=projection(e,a);syncRunHealth(s,a.run);}if(a.npc){const {run,...rest}=s;a.state=rest;}else if(c.id!==caller?.id)saveCharacter(c,s);}write(e);}
 function reset(a,s){a.cycle++;a.prepared=false;a.rowSwapped=false;a.duration=actionDelay(s.loadout.player_info.dex);a.readyAt=now()+a.duration;a.run.turn=a.cycle;a.run.turnReady=false;}
 function out(e,a,enemy,outcome){a.status=outcome;a.defeatEnemy=clone(enemy);a.prepared=false;a.downedAt=now();for(const ally of e.followers??[])if(ally.hirer===a.id&&ally.status==='active')ally.status='owner_out';message(e,a.name+' '+(outcome==='defeat'?'is down.':outcome==='flee'?'retreats from the fight.':'is out of the fight.'));} // Recovery time starts when this member goes down, not when the survivors finish fighting.
 function start(c,state,record,foe){
  const members=parties?.members(c.id)??[],people=members.length?members:[c];
  const eligible=(s,other)=>context?context.eligible(s,other,record):s.dive?.edition===record.edition&&s.dive?.route===route;
  const rows=people.map(other=>({c:other,s:other.id===c.id?state:JSON.parse(other.state)})).filter(({s,c:other})=>!s.pendingDefeat&&eligible(s,other)); // Downed or elsewhere members retain membership but do not enter this encounter.
  parties?.followers?.assertSlots(people.map(v=>v.id));
  if(rows.some(v=>parties?.followers?.get(v.c.id)?.status==='pending'))fail('Finish the companion payment before entering combat.');
  if(!rows.some(row=>row.c.id===c.id))fail('Finish recovering before entering combat.');
  for(const {c:other,s} of rows){
   if(s.run||s.dungeonScene||s.worldTurnDue||s.pendingPurchase||!s.loadout||s.loadout.player_info.playerHealth<=0||!eligible(s,other))fail(other.name+' must finish preparing before the party can fight.'); // A durable dungeon scene must finish before this member enters combat.
  }
  const e={id:randomUUID(),edition:record.edition,zone,route,origin:{x:foe.x,y:foe.y},created:now(),sequence:0,events:[],players:[],followers:[],enemies:[]};
  const tuning=currentTuning(),fightLevel=encounterLevel(tuning,routeLevelFor(tuning,route,record.depth),rows.map(row=>row.s.loadout.player_info.level)); // Floor band, raised toward the strongest party member (party_level_slack); hub events use the default band.
  for(const selected of (context?[foe]:selectEncounterEnemies(record.floor,foe,data,roll,now()))){selected.engaged=e.id;const enemy=pinDefeat(clone(selected.definition??data.enemies[selected.type]));enemy.maxHp=enemy.hp;enemy.turn=0;
   levelEnemy(tuning,enemy,fightLevel,{boss:selected.type===data.config.boss_id||enemy.tier==='boss'||enemy.boss===true}); // str/def/exp by the loot level curve, HP by turns-to-kill for the tier.
   const duration=enemyActionDelay(enemy.dex??0,roll)+e.enemies.length*encounterTuning.enemy_initial_stagger_ms;
   e.enemies.push({id:selected.id,data:enemy,duration,readyAt:now()+duration,dots:[],debuffs:[]});
  } // Opening stagger separates identical enemies; later cycles reroll their own bounded delay.
  for(const row of rows){const {c:other,s}=row,enemy=clone(e.enemies[0].data);s.lastResult=null;s.run={kind:context?'hub_event':'dive',id:e.id,sharedEncounter:e.id,zone,edition:record.edition,encounter:foe.id,stage:1,phase:'fight',hp:s.loadout.player_info.playerHealth,maxHp:s.loadout.player_info.playerHealthMax,heals:0,pot:0,handicaps:[],enemy,acted:now(),log:[]};beginRound(s,z,roll,enemy);
   const duration=actionDelay(s.loadout.player_info.dex);const a={id:other.id,name:other.name,status:'active',run:s.run,cycle:1,duration,readyAt:now()+duration*(1-encounterTuning.player_initial_fill),prepared:false};e.players.push(a);row.a=a;
  }
  for(const actor of parties?.followers?.actors(rows.map(v=>v.c),e.id)??[]){
   const s=actor.state,enemy=clone(e.enemies[0].data);s.run={kind:'dive',id:e.id,phase:'fight',hp:s.loadout.player_info.playerHealth,maxHp:s.loadout.player_info.playerHealthMax,handicaps:[],enemy,log:[]};beginRound(s,z,roll,enemy);
   const a={...actor,status:'active',run:s.run,cycle:1,duration:actionDelay(s.loadout.player_info.dex),readyAt:now()+actionDelay(s.loadout.player_info.dex)*.5,prepared:false};e.followers.push(a);rows.push({a,c:{id:a.id},s});
  }
  if(rows.length>3)fail('An encounter has only three allied slots.');
  message(e,e.enemies.map(v=>v.data.name).join(', ')+' approach.');saveFloor(record);persist(e,rows,c);return e;
 }
 function settle(e,rows,record,force=false){
  const win=e.enemies.every(v=>v.data.hp<=0);if(!force&&!win&&e.players.some(a=>a.status==='active'))return false;
  const xp=e.enemies.filter(v=>v.data.hp<=0).reduce((n,v)=>n+(v.data.exp??0),0),bossDown=e.enemies.some(v=>v.id===boss&&v.data.hp<=0);
  e.finished=true;message(e,win?'The encounter is cleared.':'The encounter is over.');
  for(const enemy of e.enemies){const foe=record.floor.enemies.find(v=>v.id===enemy.id);if(!foe)continue;foe.dead=enemy.data.hp<=0;foe.diedAt=foe.dead?now():null;foe.engaged=null;foe.respawnAt=enemy.data.hp<=0?now()+(foe.id===boss?config.boss_respawn_seconds:config.enemy_respawn_seconds)*1000:0;Object.assign(foe,foe.spawn);}
  for(const {a,c,s} of rows){s.run=a.run;clearEffects(s);
   if(a.npc){a.state={loadout:s.loadout};parties.followers.settle(a,e.id,['flee','abandoned','owner_out'].includes(a.status)?0:xp);continue;}if(['defeat','charm_backfire'].includes(a.status))a.run.hp=Math.max(1,Math.ceil(a.run.maxHp/4));
   const enemy=a.defeatEnemy??e.enemies[0].data;a.run.enemy={...enemy,exp:xp};if(xp)awardExperience(s,roll);syncRunHealth(s,a.run);
   if(bossDown){const p=progress(c,record.edition);p.completed=true;saveProgress(c,record.edition,p);}
   if(!['flee','abandoned'].includes(a.status))recordDungeonVictories(data,c,s,record,e.enemies.filter(v=>v.data.hp<=0).map(v=>v.id),progress,saveProgress);
   const coins=bossDown?pay(c,s,record,true):0,outcome=a.status==='active'?(win?'win':'abandoned'):a.status;
   const equipment=applyDefeatEquipment(s,a.run,outcome); // Only this member's actual defeat opponent supplies their outfit, even when their party wins.
   const outfitLog=equipment?.changes.length?a.run.log.slice(-equipment.changes.length):[]; // Read the outfit lines before dignity appends its own.
   const dignity=[...applyDefeatDignity(s,a.run,outcome),...applyDefeatAftermath(s,a.run,outcome)]; // Only the members who went down lose dignity and take their loss blurb's effects; survivors of a winning party keep theirs.
   s.lastResult={outcome,coins,rounds:1,zone,log:[...e.events.map(v=>v.text),...outfitLog,...dignity],...defeatPresentation(a.run,outcome),...(equipment?{defeatEquipment:equipment}:{})};s.wins=(s.wins??0)+(win?1:0);s.run=null;
   if(s.dive||context)relocate(c,s,win&&!s.lastResult.defeatScene?e.origin:entry(record.floor,s.dive?.origin),s.lastResult.defeatScene,a.downedAt); // A defeated member returns to their own gate even when the survivors win.
   if(!['flee','abandoned'].includes(outcome))for(const enemy of e.enemies.filter(v=>v.data.hp<=0))live?.questEvent?.(c,s,{id:'kill:'+e.id+':'+enemy.id,type:'kill',target:enemy.data.enemy_id??enemy.data.id,zone,created:e.created});
   if(force)back(c,s);
  }saveFloor(record);return true;
 } // All participants, enemy locks and reward entitlements settle in the caller's single database transaction.
 function act(c,state,input,record){
  const e=fetch(state.run?.sharedEncounter);if(!e||e.finished||input.battle!==e.id)fail('This encounter has changed.');
  const rows=roster(e,c,state),row=rows.find(v=>v.a.id===c.id),a=row.a;
  for(const v of rows)v.s.run=v.a.run;
  if(a.status!=='active')fail('Wait for the rest of your party to finish.');
  if(input.cycle!==a.cycle)fail('That action cycle has already ended.');
  if(input.action==='row'){ // Rows: a free change once per cycle by default; with row_swap_costs_turn it spends a full gauge instead.
   if(rows.filter(v=>v.a.status==='active').length<2)fail('No one is here to hold the line; alone you always fight in front.');
   if(isCrawling(state.loadout))fail('Stand up before changing rows.');
   const costs=rowSwapCostsTurn(currentTuning());if(a.rowSwapped&&!costs)fail('You already changed rows this cycle.');
   if(costs&&now()<a.readyAt)fail('Your action gauge is still filling.');
   a.row=(a.row??'front')==='back'?'front':'back';a.rowSwapped=true;message(e,a.name+' moves to the '+a.row+' row.');
   if(costs)reset(a,state);
  }
  else if(['flee','submit'].includes(input.action)){out(e,a,e.enemies.find(v=>v.data.hp>0)?.data??e.enemies[0].data,input.action);}
  else {
   if(now()<a.readyAt)fail('Your action gauge is still filling.');
   if(input.action==='turn_ready'){
    if(a.prepared||typeof input.forfeit!=='boolean')fail('This action cycle is already prepared.');
    state.loadout=applyCombatPatch(state.loadout,input.patch??[]);a.run.turnReady=false;readyTurn(state,false,z,roll);a.prepared=true;
    if(input.forfeit){message(e,a.name+' is too distracted to act.');reset(a,state);}
   }else{
    if(!a.prepared)fail('Finish this action cycle’s needs first.');
    const support=input.action==='cast'&&['heal','cure','buff'].includes(combatData.spells[input.spell]?.type);
    const target=support?rows.find(v=>v.a.id===(input.target??a.id)&&v.a.status==='active'):null;
    const enemy=e.enemies.find(v=>v.id===((support||input.action==='stand')?e.enemies.find(v=>v.data.hp>0)?.id:input.target)&&v.data.hp>0);
    if(support&&!target||!support&&!enemy)fail('Choose an active target.');
    const foe=enemy??e.enemies.find(v=>v.data.hp>0);a.run.enemy=foe.data;a.run.dots=foe.dots;a.run.debuffs=foe.debuffs;a.run.turnReady=true;
    if(input.action==='use_item'){state.loadout=applyCombatPatch(state.loadout,input.patch??[]);applyRunLoadout(a.run,state.loadout);}
    const outcome=combatAction(state,input,z,roll,target?.s??state);for(const line of a.run.log)message(e,a.name+': '+line);
    if(outcome==='charm_backfire')out(e,a,foe.data,outcome);else reset(a,state);
   }
  }
  settle(e,rows,record);persist(e,rows,c);
 }
 let restarted=true;
 function tick(getFloor){
  for(const row of db.prepare("SELECT state FROM quest_dive_encounters WHERE route=? AND json_extract(state,'$.finished') IS NOT 1").all(route)){
   const e=JSON.parse(row.state);if(e.finished)continue;const record=getFloor(e.edition);if(!record)continue;const rows=roster(e);for(const v of rows)v.s.run=v.a.run;
   let changed=false;
   if(restarted){for(const [index,enemy] of e.enemies.entries()){
    enemy.duration=Math.max(enemy.readyAt-now(),enemyActionDelay(enemy.data.dex??0,roll)+index*encounterTuning.enemy_initial_stagger_ms);enemy.readyAt=now()+enemy.duration;
   }for(const {a} of rows)if(!a.prepared)a.readyAt=Math.max(a.readyAt,now()+a.duration*(1-encounterTuning.player_initial_fill));changed=true;} // Persist fresh staggered recovery timers once; polling never rerolls a running gauge.
   const forced=!config.static&&now()>=record.ends+600000||rows.filter(v=>!v.a.npc).every(v=>(db.prepare('SELECT seen FROM quest_presence WHERE character_id=?').get(v.c.id)?.seen??0)<now()-150000);
   if(!forced){
    for(const row of rows.filter(v=>v.a.npc&&v.a.status==='active'&&v.a.readyAt<=now())){
     if(!rows.some(v=>v.a.id===row.a.hirer&&v.a.status==='active')){row.a.status='owner_out';changed=true;continue;}
     const foe=e.enemies.find(v=>v.data.hp>0);if(!foe)break;const r=row.a.run;r.enemy=foe.data;r.dots=foe.dots;r.debuffs=foe.debuffs;r.log=[];r.turnReady=false;readyTurn(row.s,false,z,roll);
     followerAction(row,rows,foe,z,roll,parties.followers.catalog[row.a.npc]);for(const line of r.log)message(e,line);reset(row.a,row.s);changed=true;
    }
    for(const enemy of e.enemies){if(enemy.data.hp<=0||enemy.readyAt>now())continue;
    const active=rows.filter(v=>v.a.status==='active');if(!active.length)break;const target=guardianTarget(pickTarget(currentTuning(),active,roll,v=>v.a.row??'front'),active,parties?.followers?.catalog??{});target.a.run.row=target.a.row??'front';target.a.run.rowAlone=!active.some(v=>(v.a.row??'front')!=='back');target.a.run.enemy=enemy.data;/* Front row draws fire (row_front_target_weight); an all-back party is treated as front. */target.a.run.dots=enemy.dots;target.a.run.debuffs=enemy.debuffs;target.a.run.log=[];
    tickEnemyEffects(target.a.run);if(enemy.data.hp>0&&enemyAction(target.s,z,roll)==='defeat')out(e,target.a,enemy.data,'defeat');
    for(const line of target.a.run.log)message(e,line+' ('+target.a.name+')');enemy.duration=enemyActionDelay(enemy.data.dex??0,roll);enemy.readyAt=now()+enemy.duration;changed=true;
   }}
   if(forced||changed){settle(e,rows,record,forced);persist(e,rows);}
  }restarted=false;
 } // Process at most one action per enemy per tick; restart never replays a backlog of missed attacks.
 function snapshot(state){const e=fetch(state?.run?.sharedEncounter);if(!e||e.finished)return null;return {id:e.id,sequence:e.sequence,events:e.events,players:roster(e).map(({a,s})=>({id:a.id,name:a.name,npc:a.npc??null,hirer:a.hirer??null,row:a.row??'front',hp:a.run.hp,maxHp:a.run.maxHp,mp:s.loadout?.player_mp??0,maxMp:s.loadout?.player_mp_max??0,status:a.status,readyAt:a.readyAt,duration:a.duration,cycle:a.cycle,prepared:a.prepared,connected:!!a.npc||(db.prepare('SELECT seen FROM quest_presence WHERE character_id=?').get(a.id)?.seen??0)>now()-30000})),enemies:e.enemies.map(v=>({id:v.id,...publicEnemy(v.data),readyAt:v.readyAt,duration:v.duration}))};} // players carry row for the party cards. // Publish current committed mana, including ally casting, without duplicating it in encounter state.
 return {start,act,tick,snapshot};
}
