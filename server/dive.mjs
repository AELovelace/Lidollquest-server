import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {generateFloor,dressFloor,weeklyWindow,seeded,pathTo,walkable,inside} from './dive-generation.mjs';
import {beginRound,clearEffects,readyTurn,combatAction,awardExperience} from './combat.mjs';
import {importLoadout,syncRunHealth,applyRunLoadout} from './loadout.mjs';

export const diveData=JSON.parse(readFileSync(new URL('./dive-data.json',import.meta.url),'utf8'));
export const DIVE_ZONE='dive-quarters';
const fail=(message,code='dive_conflict')=>{throw Object.assign(Error(message),{status:409,code});};
const clone=structuredClone;
const seconds=1000,minutes=60000;

export function createDive(db,{now,roll,adjust,data=diveData,generate=generateFloor,log=console.warn}){
 const config=data.config,route=config.route;
 db.exec(`CREATE TABLE IF NOT EXISTS dive_editions(route TEXT NOT NULL,edition TEXT NOT NULL,depth INTEGER NOT NULL,starts INTEGER NOT NULL,ends INTEGER NOT NULL,content TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(route,edition,depth));
 CREATE TABLE IF NOT EXISTS dive_progress(character_id TEXT NOT NULL,route TEXT NOT NULL,edition TEXT NOT NULL,depth INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(character_id,route,edition,depth));`);
 let lastTick=-Infinity,retryAt=0,dressingRetryAt=0;
 const getFloor=edition=>{const row=db.prepare('SELECT * FROM dive_editions WHERE route=? AND edition=? AND depth=1').get(route,edition);return row?{...row,floor:JSON.parse(row.content)}:null;};
 const latest=()=>db.prepare('SELECT edition FROM dive_editions WHERE route=? ORDER BY starts DESC LIMIT 1').get(route)?.edition;
 function saveFloor(record){db.prepare('UPDATE dive_editions SET content=?,updated=? WHERE route=? AND edition=? AND depth=1').run(JSON.stringify(record.floor),record.updated,route,record.edition);}
 function progress(c,edition){const row=db.prepare('SELECT state FROM dive_progress WHERE character_id=? AND route=? AND edition=? AND depth=1').get(c.id,route,edition);return row?JSON.parse(row.state):{claimed:[],rolls:{},explored:[],completed:false,coinsPaid:0};}
 function saveProgress(c,edition,p){db.prepare('INSERT INTO dive_progress VALUES (?,?,?,1,?) ON CONFLICT(character_id,route,edition,depth) DO UPDATE SET state=excluded.state').run(c.id,route,edition,JSON.stringify(p));}
 function saveCharacter(c,state){c.revision++;c.state=JSON.stringify(state);db.prepare('UPDATE quest_characters SET revision=?,state=? WHERE id=?').run(c.revision,c.state,c.id);}
 function reveal(c,state,f,x,y){
  const p=progress(c,f.edition),seen=new Set(p.explored);
  function visible(tx,ty){let px=x,py=y,dx=Math.abs(tx-x),dy=Math.abs(ty-y),err=dx-dy;for(let n=0;n<dx+dy+2;n++){if(px===tx&&py===ty)return true;const e=err*2;if(e>-dy){err-=dy;px+=Math.sign(tx-x);}if(e<dx){err+=dx;py+=Math.sign(ty-y);}if(px===tx&&py===ty)return true;if(f.walls[py]?.[px]!==0)return false;}return false;} // Furniture shares the campaign's transparent CELL_PROP sight rules.
  for(let yy=Math.max(0,y-6);yy<=Math.min(f.height-1,y+6);yy++)for(let xx=Math.max(0,x-6);xx<=Math.min(f.width-1,x+6);xx++)if((xx-x)**2+(yy-y)**2<=36&&visible(xx,yy))seen.add(yy*f.width+xx);
  p.explored=[...seen];saveProgress(c,f.edition,p);state.dive.position={x,y};
 } // Match the campaign's six-cell circular reveal and structural-wall line of sight.
 function current(){return getFloor(latest());}
 function ensure(){
  if(!config.enabled)return;
  const window=weeklyWindow(now());if(getFloor(window.edition)||now()<retryAt)return;
  try{const floor=generate(data,window.edition);db.prepare('INSERT OR IGNORE INTO dive_editions VALUES (?,?,1,?,?,?,?)').run(route,window.edition,window.start,window.ends,JSON.stringify(floor),now());log('dive_generation_ready',window.edition);}
  catch(error){retryAt=now()+minutes;log('dive_generation_failed',String(error));}
 } // Never replace a valid edition until its successor is fully generated and validated.
 function back(c,state){
  const origin=state.dive?.origin??'honeydew-lantern';db.prepare('UPDATE quest_presence SET zone=?,x=10,y=9,moved=? WHERE character_id=?').run(origin,now(),c.id);
  state.dive=null;state.diveReturned=origin;
 }
 function finish(c,state,record,outcome){
  const run=state.run;if(!run||run.kind!=='dive')return;
  const foe=record?.floor.enemies.find(e=>e.id===run.encounter);
  clearEffects(state);
  if(outcome==='win'){
   awardExperience(state,roll);state.wins++;
   if(foe){foe.engaged=null;foe.respawnAt=now()+(foe.id==='iris'?config.boss_respawn_seconds:config.enemy_respawn_seconds)*seconds;foe.x=foe.spawn.x;foe.y=foe.spawn.y;}
   if(run.encounter==='iris'){const p=progress(c,run.edition);p.completed=true;saveProgress(c,run.edition,p);}
  }else{
   if(foe){foe.engaged=null;foe.respawnAt=0;foe.x=foe.spawn.x;foe.y=foe.spawn.y;}
   if(['defeat','charm_backfire'].includes(outcome))run.hp=Math.max(1,Math.ceil(run.maxHp/4));
   if(record){state.dive.position={...record.floor.entrance};db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(record.floor.entrance.x,record.floor.entrance.y,c.id);}
  }
  syncRunHealth(state,run);state.lastResult={outcome,coins:0,rounds:1,zone:DIVE_ZONE,log:run.log};state.run=null;
  if(state.dive)state.dive.safeUntil=now()+10*seconds;
  if(record)saveFloor(record);
 } // Combat settlement is independent of arena rounds, pots and handicaps.
 function pay(c,state,record,grace=false){
  if(!record||now()>=record.ends+(grace?10*minutes:0)&&record.edition!==latest())return 0;
  const p=progress(c,record.edition);if(!p.completed||p.coinsPaid>=config.boss_coins)return 0;
  const day=Math.floor(now()/86400000),used=db.prepare('SELECT coins FROM quest_reward_days WHERE owner=? AND day=?').get(c.owner,day)?.coins??0;
  const amount=Math.min(config.boss_coins-p.coinsPaid,Math.max(0,250-used));
  if(amount){adjust(c.owner,'coins',amount,randomUUID(),'Dungeon Dive: '+record.edition);db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?) ON CONFLICT(owner,day) DO UPDATE SET coins=coins+excluded.coins').run(c.owner,day,amount);p.coinsPaid+=amount;saveProgress(c,record.edition,p);}
  return amount;
 }
 function start(c,state,record,foe){
  if(state.run||state.loadout?.player_info.stat_points>0||state.loadout?.player_info.playerHealth<=0||!foe||foe.engaged||foe.respawnAt>now())fail('That encounter is not available.');
  if(!state.loadout)fail('Import your character before entering.');
  foe.engaged=c.id;const enemy=clone(data.enemies[foe.type]);enemy.maxHp=enemy.hp;enemy.turn=0;
  state.lastResult=null;state.run={kind:'dive',id:randomUUID(),zone:DIVE_ZONE,edition:record.edition,encounter:foe.id,stage:1,phase:'fight',hp:state.loadout.player_info.playerHealth,maxHp:state.loadout.player_info.playerHealthMax,heals:0,pot:0,handicaps:[],enemy,acted:now(),log:[enemy.name+' approaches.']};
  beginRound(state,{theme:'princess_quarters',attack:0},roll,enemy); // Keep authored encounter stats rather than the arena's progressive template.
  saveFloor(record);
 }
 function maintain(){
  ensure();let active=current();if(!active)return;
  if((active.floor.dressingVersion??0)<(data.dressing_version??2)&&now()>=dressingRetryAt){
   try{
    const visitors=db.prepare('SELECT state FROM quest_characters WHERE state LIKE ?').all('%"dive":{%').map(c=>JSON.parse(c.state).dive).filter(d=>d?.edition===active.edition).map(d=>d.position);
    const upgraded=clone(active);dressFloor(data,upgraded.floor,visitors);saveFloor(upgraded);active=upgraded;log('dive_dressing_upgraded',active.edition);
   }catch(error){dressingRetryAt=now()+minutes;log('dive_dressing_failed',String(error));}
  } // Existing weekly chest claims and ongoing fights survive the additive scenery/pickup upgrade.
  for(const c of db.prepare('SELECT * FROM quest_characters WHERE state LIKE ?').all('%"dive":{%')){
   const state=JSON.parse(c.state);if(!state.dive)continue;
   const old=state.dive.edition!==active.edition,record=getFloor(state.dive.edition),run=state.run,p=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);
   if(run?.kind==='dive'&&((!p||p.seen<now()-2*minutes)||run.acted<now()-5*minutes||old&&now()>=record.ends+10*minutes)){
    finish(c,state,record,'abandoned');log('dive_encounter_abandoned',c.id,run.encounter);saveCharacter(c,state);
   }
   if(old&&!state.run){back(c,state);saveCharacter(c,state);}
  }
  // Expired editions are retained for audit and receipt replay, but cannot accept new exploration.
  active=current(); // Settlement above may have released locks; never overwrite it with the earlier floor copy.
  if(now()-active.updated<seconds)return;
  const f=active.floor,players=db.prepare('SELECT p.*,c.revision,c.state FROM quest_presence p JOIN quest_characters c ON c.id=p.character_id WHERE p.zone=? AND p.seen>?').all(DIVE_ZONE,now()-30000);
  const occupied=new Set(f.enemies.filter(e=>e.respawnAt<=now()).map(e=>e.x+','+e.y));
  const rnd=seeded(active.edition+':'+Math.floor(now()/seconds));
  for(const foe of f.enemies){
   if(foe.engaged||foe.respawnAt>now()||foe.type!=='diaper_fairy')continue;
   const targets=players.filter(p=>{const s=JSON.parse(p.state);return s.dive?.edition===active.edition&&!s.run&&!(s.loadout?.player_info.stat_points>0)&&s.dive.safeUntil<=now()&&!inside(f.rooms[0],p.x,p.y);});
   let target=null,best=null;
   for(const p of targets){const path=pathTo(f,foe,p,config.pursuit_steps);if(path&&(!best||path.length<best.length)){target=p;best=path;}}
   if(best?.length===0||best?.length===1){const c={id:target.character_id,owner:target.owner,revision:target.revision},s=JSON.parse(target.state);if(s.loadout?.player_info.playerHealth>0){start(c,s,active,foe);saveCharacter(c,s);target.state=c.state;target.revision=c.revision;}continue;}
   let step=best?.[0];if(!step){const [dx,dy]=[[1,0],[-1,0],[0,1],[0,-1]][rnd(4)];step={x:foe.x+dx,y:foe.y+dy};}
   if(walkable(f,step.x,step.y)&&!inside(f.rooms[0],step.x,step.y)&&!occupied.has(step.x+','+step.y)&&!players.some(p=>p.x===step.x&&p.y===step.y)){
    occupied.delete(foe.x+','+foe.y);foe.x=step.x;foe.y=step.y;occupied.add(foe.x+','+foe.y);
   }
  }
  active.updated=now();saveFloor(active);
 }
 function tick(){if(now()-lastTick<seconds)return;lastTick=now();db.exec('BEGIN IMMEDIATE');try{maintain();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');lastTick=-Infinity;log('dive_tick_failed',String(error));}}
 function snapshot(c,p){
  const state=c?JSON.parse(c.state):null,record=state?.dive?getFloor(state.dive.edition):current(),personal=c&&record?progress(c,record.edition):null;
  const summary={enabled:config.enabled&&!!record,version:1,route,edition:record?.edition??'',resetsAt:record?.ends??weeklyWindow(now()).ends,completed:personal?.completed??false,claimed:record?.floor.chests.filter(ch=>personal?.claimed.includes(ch.id)).length??0,total:record?.floor.chests.length??0,pickupsClaimed:(record?.floor.pickups??[]).filter(ch=>personal?.claimed.includes(ch.id)).length,pickupsTotal:record?.floor.pickups?.length??0,claimableCoins:personal?.completed?Math.max(0,config.boss_coins-personal.coinsPaid):0};
  if(!record||p?.zone!==DIVE_ZONE||!state?.dive)return {dive:summary};
  const f=record.floor;
  return {dive:{...summary,depth:1,origin:state.dive.origin,explored:personal.explored,enemies:f.enemies.map(e=>({...e,name:data.enemies[e.type].name,sprite:data.enemies[e.type].sprite})),chests:f.chests.map(ch=>({...ch,claimed:personal.claimed.includes(ch.id)})),pickups:(f.pickups??[]).map(ch=>({...ch,claimed:personal.claimed.includes(ch.id)}))},definition:{id:DIVE_ZONE,name:"Princess' Quarters - Dungeon Dive",theme:'princess_quarters',walls:f.walls,props:f.props,dressingVersion:f.dressingVersion??0,width:f.width,height:f.height,rooms:f.rooms,entrance:f.entrance,decorations:f.decorations}};
 } // Snapshots expose claim status but never another character's inventory or chest rolls.
 function claim(c,state,record,chest,automatic=false){
  const personal=progress(c,record.edition);if(personal.claimed.includes(chest.id)){if(automatic)return;fail('You already claimed this treasure this week.');}
  if(state.loadout.inventory.length>=config.inventory_capacity){if(automatic){state.dive.lootNotice='Inventory full. Treasure remains here.';state.dive.lootNoticeAt=now();return;}fail('Inventory full. This treasure remains unclaimed.');}
  if(!personal.rolls[chest.id]){
   const rnd=seeded(`${route}:${record.edition}:1:${c.id}:${chest.id}`),items=chest.kind==='potion'?data.potion_pool:Object.keys(data.items).sort(),item=clone(data.items[items[rnd(items.length)]]);
   if(item.atk_min!==undefined){item.atk=item.atk_min+rnd(item.atk_max-item.atk_min+1);if(typeof item.desc==='string')item.desc=item.desc.replace('{atk}',String(item.atk));delete item.atk_min;delete item.atk_max;}
   personal.rolls[chest.id]=item;
  }
  const item=clone(personal.rolls[chest.id]);state.loadout.inventory.push(item);personal.claimed.push(chest.id);saveProgress(c,record.edition,personal);
  state.dive.lootNotice='Found '+(item.name??item.item_id)+'.';state.dive.lootNoticeAt=now();
 } // Inventory, deterministic item roll and personal claim commit together inside the zone transaction.
 function handles(input,p){return input.action==='dive_enter'||input.action==='enter'&&input.zone===DIVE_ZONE||p?.zone===DIVE_ZONE;}
 function act(i,c,state,input,p){
  const action=input.action;
  if(action==='dive_enter'||action==='enter'){
   if(!config.enabled)fail('Dungeon Dive is not enabled.');
   const existing=db.prepare('SELECT * FROM quest_presence WHERE owner=?').get(i.owner);
   if(existing&&existing.seen>now()-30000&&(existing.controller!==input.controller||existing.character_id!==c.id||existing.grant_id!==i.id)&&input.takeover!==true)fail('This account is active in another window.','zone_controller_conflict'); // Explicit re-entry can recover this character without discarding its dungeon fight or items.
   if(action==='enter'&&!state.dive&&state.diveReturned){
    db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,10,9,?,0) ON CONFLICT(owner) DO UPDATE SET character_id=excluded.character_id,zone=excluded.zone,grant_id=excluded.grant_id,controller=excluded.controller,x=10,y=9,seen=excluded.seen,moved=0').run(i.owner,c.id,state.diveReturned,i.id,input.controller,now());return;
   } // A browser suspended across reset resumes in its lobby instead of retrying a retired floor forever.
   if(state.run&&state.run.kind!=='dive')fail('Finish your arena run before diving.');
   if(!state.dive){if(!p||!['honeydew-lantern','littlebig-clockwork'].includes(p.zone)||p.seen<=now()-30000||p.controller!==input.controller||p.grant_id!==i.id)fail('Enter from an online arena lobby.');
    if(input.loadout)state.loadout=importLoadout(input.loadout);if(!state.loadout)fail('Import your character first.');
    const record=current();if(!record)fail('The weekly floor is not ready.');state.dive={route,edition:record.edition,depth:1,origin:p.zone,position:{...record.floor.entrance},safeUntil:now()+10*seconds};state.diveReturned=null;
   }
   const record=getFloor(state.dive.edition),position=state.dive.position;
   if(!record)fail('The weekly floor is unavailable.');
   const count=db.prepare('SELECT COUNT(*) AS n FROM quest_presence WHERE zone=? AND seen>? AND owner<>?').get(DIVE_ZONE,now()-30000,c.owner).n;if(count>=64)fail('The dive is full.');
   db.prepare('INSERT INTO quest_presence VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT(owner) DO UPDATE SET character_id=excluded.character_id,zone=excluded.zone,grant_id=excluded.grant_id,controller=excluded.controller,x=excluded.x,y=excluded.y,seen=excluded.seen,moved=0').run(i.owner,c.id,DIVE_ZONE,i.id,input.controller,position.x,position.y,now());
   reveal(c,state,record.floor,position.x,position.y);return;
  }
  if(!state.dive)fail('Re-enter the dungeon from its lobby.');
  const record=getFloor(state.dive.edition),f=record.floor;
  if(input.edition!==record.edition)fail('The dungeon edition changed. Refresh before acting.');
  if(action==='dive_exit'||action==='leave'){if(state.run)fail('Finish or flee from the current fight first.');back(c,state);return;}
  if(action==='chat'){
   const text=String(input.text??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069#]/g,' ').trim().slice(0,240);if(!text)fail('Write a message first.');
   if(db.prepare('SELECT COUNT(*) AS n FROM quest_chat WHERE owner=? AND created>?').get(i.owner,now()-10000).n>=5)fail('Wait before sending another message.');
   db.prepare('INSERT INTO quest_chat(zone,owner,character_id,name,text,created) VALUES (?,?,?,?,?,?)').run(DIVE_ZONE,i.owner,c.id,c.name,text,now());
   db.prepare('DELETE FROM quest_chat WHERE zone=? AND seq NOT IN (SELECT seq FROM quest_chat WHERE zone=? ORDER BY seq DESC LIMIT 100)').run(DIVE_ZONE,DIVE_ZONE);return;
  }
  if(action==='appearance'){state.avatar=input.avatar;return;} // The zone adapter validates the cosmetic allowlist before dispatch.
  if(action==='allocate'){if(state.run||!['str','def','dex','int','cha'].includes(input.stat)||!(state.loadout.player_info.stat_points>0))fail('Choose an available stat point outside combat.');state.loadout.player_info[input.stat]++;state.loadout.player_info.stat_points--;if(input.stat==='int')state.loadout.player_mp_max=Math.max(0,10+state.loadout.player_info.int*5);return;}
  if(record.edition!==latest()&&!state.run)fail('This weekly dungeon has ended.');
  if(action==='dive_claim_reward'){if(state.run)fail('Finish the current fight first.');const amount=pay(c,state,record);state.lastResult={outcome:'reward_claimed',coins:amount,zone:DIVE_ZONE,log:[]};return;}
  if(action==='dive_claim'){
   if(state.run)fail('Finish the current fight first.');const chest=[...f.chests,...(f.pickups??[])].find(ch=>ch.id===input.chest);if(!chest||Math.abs(chest.x-p.x)+Math.abs(chest.y-p.y)>1)fail('Stand next to that treasure.');
   claim(c,state,record,chest);return;
  }
  if(action==='move'||action==='dive_engage'){
   if(state.run||state.loadout.player_info.stat_points>0)fail('Finish combat and spend level-up points first.');
   if(action==='dive_engage'){const foe=f.enemies.find(e=>e.id===input.encounter);if(!foe||Math.abs(foe.x-p.x)+Math.abs(foe.y-p.y)>1)fail('Approach that enemy first.');start(c,state,record,foe);return;}
   if(now()-p.moved<200)fail('Movement is too fast.');const d={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]}[input.direction];if(!d)fail('Choose a direction.');
   const x=p.x+d[0],y=p.y+d[1];if(!walkable(f,x,y))fail('That tile is blocked.');const foe=f.enemies.find(e=>e.x===x&&e.y===y&&e.respawnAt<=now());
   if(foe){start(c,state,record,foe);return;}
   db.prepare('UPDATE quest_presence SET x=?,y=?,moved=? WHERE character_id=?').run(x,y,now(),c.id);reveal(c,state,f,x,y);
   const pickup=[...f.chests,...(f.pickups??[])].find(ch=>ch.x===x&&ch.y===y);if(pickup)claim(c,state,record,pickup,true);return; // Walking onto either a room chest or a loose pickup commits the same personal claim as Interact.
  }
  const z={id:DIVE_ZONE,theme:'princess_quarters',recovery:0};let result;
  if(action==='loadout'||action==='use_item'){
   if(action==='loadout'&&state.run)fail('Use Items during combat.');
   if(state.run&&!state.run.turnReady)fail('Wait for your turn.');
   state.loadout=importLoadout(input.loadout);if(state.run){if(now()-state.run.acted<300)fail('Wait for the current turn.');state.run.acted=now();applyRunLoadout(state.run,state.loadout);result=combatAction(state,input,z,roll);}else return;
  }else{
   if(state.run?.kind!=='dive')fail('No active dungeon fight.');
   if(['flee','submit'].includes(action)){finish(c,state,record,action);return;}
   if(action==='turn_ready'){
    if(typeof input.forfeit!=='boolean'||state.run.turnReady)fail('No unprepared turn.');state.loadout=importLoadout(input.loadout);state.run.acted=now();result=readyTurn(state,input.forfeit,z,roll); // An acknowledged accident/forfeit turn is combat activity, unlike a heartbeat.
   }else if(['attack','cast','charm','allure'].includes(action)){if(now()-state.run.acted<300)fail('Wait for the current turn.');state.run.acted=now();result=combatAction(state,input,z,roll);}
   else fail('Unknown dungeon action.');
  }
  if(['win','defeat','charm_backfire'].includes(result)){
   const grace=state.run?.kind==='dive'&&now()<record.ends+10*minutes;
   finish(c,state,record,result);
   if(result==='win'){ // A fight already underway at reset may settle its first boss entitlement during grace.
    if(record.edition===latest())state.lastResult.coins=pay(c,state,record);
    else if(grace)state.lastResult.coins=pay(c,state,record,true);
   }
   if(record.edition!==latest())back(c,state);
  }
 }
 return {tick,snapshot,handles,act};
} // All mutations run inside the zone command transaction; scheduled simulation owns its own transaction.
