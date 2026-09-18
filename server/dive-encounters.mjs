import {randomUUID} from 'node:crypto';
import {beginRound,clearEffects,readyTurn,combatAction,enemyAction,tickEnemyEffects,awardExperience,defeatPresentation,combatData} from './combat.mjs';
import {importLoadout,applyRunLoadout,syncRunHealth} from './loadout.mjs';

const fail=message=>{throw Object.assign(Error(message),{status:409,code:'encounter_conflict'});};
const clone=structuredClone;
const defaults={second_enemy_chance:0.5,third_enemy_chance:0.25,base_delay_ms:4000,dexterity_step_ms:100,min_delay_ms:1500,max_delay_ms:6000,player_initial_fill:0.5};
export const encounterTuning={...defaults,...combatData.online_combat};
export const actionDelay=(dex=0,tuning=encounterTuning)=>Math.max(tuning.min_delay_ms,Math.min(tuning.max_delay_ms,tuning.base_delay_ms-tuning.dexterity_step_ms*dex));

export function selectReinforcements(floor,foe,data,roll,time,tuning=encounterTuning){
 const max=data.enemies[foe.type].hp,pool=floor.enemies.filter(e=>e.id!==foe.id&&!e.engaged&&e.respawnAt<=time&&data.enemies[e.type]?.hp<=max);
 const chosen=[foe];if(pool.length&&roll(10000)<tuning.second_enemy_chance*10000){
  chosen.push(pool.splice(roll(pool.length),1)[0]);
  if(pool.length&&roll(10000)<tuning.third_enemy_chance*10000)chosen.push(pool.splice(roll(pool.length),1)[0]);
 }return chosen;
} // Draw actual living floor monsters without replacement; their existing IDs carry locks and boss entitlements.

export function selectEncounterEnemies(floor,foe,data,roll,time){
 const guards={matron_rosalind_boss:'nanny_sentinel',slime_queen_boss:'bottle_slime',school_nurse:'teachers_pet',school_nurse_boss:'teachers_pet'};
 const guard=guards[data.enemies[foe.type].enemy_id];
 if(guard&&data.enemies[guard])return [foe,...[1,2].map(index=>({id:foe.id+':escort:'+index,type:guard}))];
 return selectReinforcements(floor,foe,data,roll,time);
} // Campaign-authored boss escorts replace random picks and disappear with their encounter; floor residents stay available.

export function applyCombatPatch(loadout,patch){
 if(!Array.isArray(patch)||patch.length>256||Buffer.byteLength(JSON.stringify(patch))>192*1024)fail('Invalid combat changes.');
 const result=clone(loadout),protectedKeys=new Set(['__proto__','prototype','constructor','level','xp','stat_points','playerHealthMax','player_mp_max','name','companions']);
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
 }return importLoadout(result);
} // Numeric deltas preserve intervening attacks/heals; structural item edits require an unchanged baseline.

export function createDiveEncounters(db,{now,roll,data,parties,saveFloor,progress,saveProgress,pay,back,entry,saveCharacter}){
 const config=data.config,zone=config.zone_id??'dive-quarters',route=config.route,boss=config.boss_id??'iris',z={theme:config.theme??'princess_quarters',activeTime:true};
 db.exec('CREATE TABLE IF NOT EXISTS quest_dive_encounters(id TEXT PRIMARY KEY,route TEXT NOT NULL,edition TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL)');
 db.exec("CREATE INDEX IF NOT EXISTS quest_open_dive_encounters ON quest_dive_encounters(route) WHERE json_extract(state,'$.finished') IS NOT 1"); // Retain history without scanning every settled fight on each simulation tick.
 const fetch=id=>{const row=db.prepare('SELECT state FROM quest_dive_encounters WHERE id=? AND route=?').get(id??'',route);return row?JSON.parse(row.state):null;};
 const write=e=>db.prepare('INSERT INTO quest_dive_encounters VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated').run(e.id,route,e.edition,JSON.stringify(e),now());
 function message(e,text){e.sequence++;e.events.push({seq:e.sequence,text});e.events=e.events.slice(-40);} // Bounded event history keeps snapshots within the gateway budget.
 function roster(e,caller=null,state=null){return e.players.map(a=>{const c=caller?.id===a.id?caller:db.prepare('SELECT * FROM quest_characters WHERE id=?').get(a.id);return {a,c,s:caller?.id===a.id?state:JSON.parse(c.state)};});}
 function projection(e,a){const enemy=e.enemies.find(v=>v.data.hp>0)??e.enemies[0];return {...a.run,enemy:clone(enemy.data),sharedEncounter:e.id,combatVersion:3,cycle:a.cycle,readyAt:a.readyAt,duration:a.duration,turnReady:a.prepared,phase:'fight',status:a.status,turn:a.cycle,log:e.events.map(v=>v.text)};}
 function persist(e,rows,caller=null){for(const {a,c,s} of rows){if(!e.finished){s.run=projection(e,a);syncRunHealth(s,a.run);}if(c.id!==caller?.id)saveCharacter(c,s);}write(e);}
 function reset(a,s){a.cycle++;a.prepared=false;a.duration=actionDelay(s.loadout.player_info.dex);a.readyAt=now()+a.duration;a.run.turn=a.cycle;a.run.turnReady=false;}
 function out(e,a,enemy,outcome){a.status=outcome;a.defeatEnemy=clone(enemy);a.prepared=false;message(e,a.name+' '+(outcome==='defeat'?'is down.':outcome==='flee'?'retreats from the fight.':'is out of the fight.'));}
 function start(c,state,record,foe){
  const members=parties?.members(c.id)??[],people=members.length?members:[c];
  const rows=people.map(other=>({c:other,s:other.id===c.id?state:JSON.parse(other.state)}));
  for(const {c:other,s} of rows){if(s.run||s.worldTurnDue||s.pendingPurchase||!s.loadout||s.loadout.player_info.stat_points>0||s.loadout.player_info.playerHealth<=0||s.dive?.edition!==record.edition||s.dive?.route!==route)fail(other.name+' must finish preparing before the party can fight.');}
  const e={id:randomUUID(),edition:record.edition,zone,route,origin:{x:foe.x,y:foe.y},created:now(),sequence:0,events:[],players:[],enemies:[]};
  for(const selected of selectEncounterEnemies(record.floor,foe,data,roll,now())){selected.engaged=e.id;const enemy=clone(data.enemies[selected.type]);enemy.maxHp=enemy.hp;enemy.turn=0;e.enemies.push({id:selected.id,data:enemy,duration:actionDelay(enemy.dex??0),readyAt:now()+actionDelay(enemy.dex??0),dots:[],debuffs:[]});}
  for(const row of rows){const {c:other,s}=row,enemy=clone(e.enemies[0].data);s.lastResult=null;s.run={kind:'dive',id:e.id,sharedEncounter:e.id,zone,edition:record.edition,encounter:foe.id,stage:1,phase:'fight',hp:s.loadout.player_info.playerHealth,maxHp:s.loadout.player_info.playerHealthMax,heals:0,pot:0,handicaps:[],enemy,acted:now(),log:[]};beginRound(s,z,roll,enemy);
   const duration=actionDelay(s.loadout.player_info.dex);const a={id:other.id,name:other.name,status:'active',run:s.run,cycle:1,duration,readyAt:now()+duration*(1-encounterTuning.player_initial_fill),prepared:false};e.players.push(a);row.a=a;
  }
  message(e,e.enemies.map(v=>v.data.name).join(', ')+' approach.');saveFloor(record);persist(e,rows,c);return e;
 }
 function settle(e,rows,record,force=false){
  const win=e.enemies.every(v=>v.data.hp<=0);if(!force&&!win&&e.players.some(a=>a.status==='active'))return false;
  const xp=e.enemies.filter(v=>v.data.hp<=0).reduce((n,v)=>n+(v.data.exp??0),0),bossDown=e.enemies.some(v=>v.id===boss&&v.data.hp<=0);
  e.finished=true;message(e,win?'The encounter is cleared.':'The party returns to the entrance.');
  for(const enemy of e.enemies){const foe=record.floor.enemies.find(v=>v.id===enemy.id);if(!foe)continue;foe.engaged=null;foe.respawnAt=enemy.data.hp<=0?now()+(foe.id===boss?config.boss_respawn_seconds:config.enemy_respawn_seconds)*1000:0;Object.assign(foe,foe.spawn);}
  for(const {a,c,s} of rows){s.run=a.run;clearEffects(s);if(['defeat','charm_backfire'].includes(a.status))a.run.hp=Math.max(1,Math.ceil(a.run.maxHp/4));
   const enemy=a.defeatEnemy??e.enemies[0].data;a.run.enemy={...enemy,exp:xp};if(xp)awardExperience(s,roll);syncRunHealth(s,a.run);
   if(bossDown){const p=progress(c,record.edition);p.completed=true;saveProgress(c,record.edition,p);}
   const coins=bossDown?pay(c,s,record,true):0,outcome=a.status==='active'?(win?'win':'abandoned'):a.status;
   s.lastResult={outcome,coins,rounds:1,zone,log:e.events.map(v=>v.text),...defeatPresentation(a.run,outcome)};s.wins=(s.wins??0)+(win?1:0);s.run=null;
   if(s.dive){const pos=win?e.origin:entry(record.floor,s.dive.origin);s.dive.position={...pos};s.dive.safeUntil=now()+10000;db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(pos.x,pos.y,c.id);}
   if(force)back(c,s);
  }saveFloor(record);return true;
 } // All participants, enemy locks and reward entitlements settle in the caller's single database transaction.
 function act(c,state,input,record){
  const e=fetch(state.run?.sharedEncounter);if(!e||e.finished||input.battle!==e.id)fail('This encounter has changed.');
  const rows=roster(e,c,state),row=rows.find(v=>v.a.id===c.id),a=row.a;
  for(const v of rows)v.s.run=v.a.run;
  if(a.status!=='active')fail('Wait for the rest of your party to finish.');
  if(input.cycle!==a.cycle)fail('That action cycle has already ended.');
  if(['flee','submit'].includes(input.action)){out(e,a,e.enemies.find(v=>v.data.hp>0)?.data??e.enemies[0].data,input.action);}
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
   if(restarted){for(const enemy of e.enemies)enemy.readyAt=Math.max(enemy.readyAt,now()+enemy.duration);for(const {a} of rows)if(!a.prepared)a.readyAt=Math.max(a.readyAt,now()+a.duration*(1-encounterTuning.player_initial_fill));changed=true;}
   const forced=now()>=record.ends+600000||rows.every(v=>(db.prepare('SELECT seen FROM quest_presence WHERE character_id=?').get(v.c.id)?.seen??0)<now()-150000);
   if(!forced){for(const enemy of e.enemies){if(enemy.data.hp<=0||enemy.readyAt>now())continue;
    const active=rows.filter(v=>v.a.status==='active');if(!active.length)break;const target=active[roll(active.length)];target.a.run.enemy=enemy.data;target.a.run.dots=enemy.dots;target.a.run.debuffs=enemy.debuffs;target.a.run.log=[];
    tickEnemyEffects(target.a.run);if(enemy.data.hp>0&&enemyAction(target.s,z,roll)==='defeat')out(e,target.a,enemy.data,'defeat');
    for(const line of target.a.run.log)message(e,line+' ('+target.a.name+')');enemy.duration=actionDelay(enemy.data.dex??0);enemy.readyAt=now()+enemy.duration;changed=true;
   }}
   if(forced||changed){settle(e,rows,record,forced);persist(e,rows);}
  }restarted=false;
 } // Process at most one action per enemy per tick; restart never replays a backlog of missed attacks.
 function snapshot(state){const e=fetch(state?.run?.sharedEncounter);if(!e||e.finished)return null;return {id:e.id,sequence:e.sequence,events:e.events,players:e.players.map(a=>({id:a.id,name:a.name,hp:a.run.hp,maxHp:a.run.maxHp,status:a.status,readyAt:a.readyAt,duration:a.duration,cycle:a.cycle,prepared:a.prepared,connected:(db.prepare('SELECT seen FROM quest_presence WHERE character_id=?').get(a.id)?.seen??0)>now()-30000})),enemies:e.enemies.map(v=>({id:v.id,...v.data,readyAt:v.readyAt,duration:v.duration}))};}
 return {start,act,tick,snapshot};
}
