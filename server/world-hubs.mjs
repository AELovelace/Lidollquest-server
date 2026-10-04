import {storyFoes} from './story-encounter.mjs';
import {randomUUID} from 'node:crypto';
import {createDiveEncounters} from './dive-encounters.mjs';
import {mapRevision} from './world-dive.mjs';
import {pathTo,walkable} from './dive-generation.mjs';
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'hub_encounter_conflict'});};
export function createHubEncounters(db,{now,roll,parties,live,definition,ids}){
 db.exec('CREATE TABLE IF NOT EXISTS world_hub_maps(zone TEXT PRIMARY KEY,edition TEXT NOT NULL,content TEXT NOT NULL,updated INTEGER NOT NULL)');
 const engines=new Map();
 function engine(zone){
  if(!ids.includes(zone))fail('Unknown hub.');if(engines.has(zone))return engines.get(zone);
  const route='hub-event:'+zone,data={config:{route,zone_id:zone,boss_id:'none',enemy_respawn_seconds:600,boss_respawn_seconds:600,theme:definition(zone).theme},enemies:live.published().monsters};
  function record(){const z=definition(zone),old=db.prepare('SELECT * FROM world_hub_maps WHERE zone=?').get(zone),floor=old?JSON.parse(old.content):{enemies:[]};
   Object.assign(floor,{width:z.width??20,height:z.height??12,walls:z.walls,props:z.props,entrance:z.spawn??{x:10,y:9},fixtures:z.fixtures??[],rooms:z.rooms??[],portals:z.portals??[],exits:z.exit?[z.exit]:[]});const edition=z.district?.layoutKey?'hub-'+zone+':'+z.district.layoutKey:old?.edition??'hub-'+zone;floor.managedOccupancy=live.placementPositions?.(zone,edition)??[];return {edition,floor,updated:old?.updated??0};
  }
  function saveFloor(r){db.prepare('INSERT INTO world_hub_maps VALUES (?,?,?,?) ON CONFLICT(zone) DO UPDATE SET edition=excluded.edition,content=excluded.content,updated=excluded.updated').run(zone,r.edition,JSON.stringify(r.floor),now());}
  function saveCharacter(c,s){c.revision++;s.loadoutRevision=c.revision;c.state=JSON.stringify(s);db.prepare('UPDATE quest_characters SET revision=?,state=? WHERE id=?').run(c.revision,c.state,c.id);}
  function relocate(c,s,position,scene,downedAt=now()){
   if(scene&&s.deferDefeatReturn){s.pendingDefeat={id:scene.id,position,readyAt:downedAt+60000,sceneComplete:false,hub:zone};return;}
   s.hubSafeUntil=now()+10000;db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(position.x,position.y,c.id);
  }
  const encounters=createDiveEncounters(db,{live,now,roll,data,parties,saveFloor,saveCharacter,progress:()=>({}),saveProgress:()=>{},pay:()=>0,back:()=>{},entry:f=>f.entrance,relocate,context:{eligible:(s,c)=>s.contentVersion===1&&db.prepare('SELECT zone FROM quest_presence WHERE character_id=?').get(c.id)?.zone===zone}});
  const players=()=>db.prepare('SELECT c.*,p.x,p.y,p.seen FROM quest_characters c JOIN quest_presence p ON p.character_id=c.id WHERE p.zone=?').all(zone);
  const positions=()=>db.prepare('SELECT c.id,c.name,p.x,p.y FROM quest_characters c JOIN quest_presence p ON p.character_id=c.id WHERE p.zone=?').all(zone); // Same rows as players() without each character's whole saved state: the map view and placement checks only need where people stand.
  function view(){const r=record();return {id:zone,kind:'hub',edition:r.edition,revision:mapRevision(r),floor:r.floor,players:positions().map(c=>({id:c.id,name:c.name,x:c.x,y:c.y}))};}
  function place(input){const r=record();if(input.edition!==r.edition||input.revision!==mapRevision(r))fail('The map changed. Refresh first.');
   if(input.action==='world_remove'){const foe=r.floor.enemies.find(e=>e.id===input.monster);if(!foe||foe.engaged)fail('Choose a monster outside combat.');r.floor.enemies=r.floor.enemies.filter(e=>e!==foe);}
   else if(input.action==='world_move'){const foe=r.floor.enemies.find(e=>e.id===input.monster&&e.manual&&!e.dead);if(!foe||foe.engaged)fail('Choose a DM monster outside combat.');const z=definition(zone),x=Number(input.x),y=Number(input.y); // The Map Editor's drag and cut/paste: same id, definition and flags, new tile.
    if(!Number.isInteger(x)||!Number.isInteger(y)||!walkable(r.floor,x,y)||[...r.floor.enemies.filter(e=>e!==foe),...positions(),...(z.fixtures??[]),...(z.portals??[]),z.spawn??{x:10,y:9},...(z.exit?[z.exit]:[])].some(p=>Math.abs(x-p.x)+Math.abs(y-p.y)<=1))fail('Choose a free tile away from players, entrances and fixtures.'); // world_place's rules, minus the monster itself.
    foe.x=x;foe.y=y;foe.spawn={x,y};}
   else {if(r.floor.enemies.length>=128)fail('This hub already has 128 DM monsters.');const monster=live.published().monsters[input.monster],z=definition(zone),{x,y}=input;
    if(!monster||monster.retired)fail('Choose a published monster.');
    if(!walkable(r.floor,x,y)||[...r.floor.enemies,...positions(),...(z.fixtures??[]),...(z.portals??[]),z.spawn??{x:10,y:9},...(z.exit?[z.exit]:[])].some(p=>Math.abs(x-p.x)+Math.abs(y-p.y)<=1))fail('Choose a free tile away from players, entrances and fixtures.');
    r.floor.enemies.push({id:'dm-'+randomUUID(),type:input.monster,definition:structuredClone(monster),x,y,spawn:{x,y},manual:true,respawning:!!input.respawning,roaming:!!input.aggressive,engaged:null,respawnAt:0});
   }saveFloor(r);return view();
  }
  function storyEncounter(c,s,monster,receipt,fight=true){
   if(s.diveCombatVersion!==3||s.contentVersion!==1)fail('Update the game before entering a story encounter.');
   const r=record(),p=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);if(p?.zone!==zone)fail('Enter this area first.');
   const foes=storyFoes(r.floor,c,p,monster,receipt),foe=foes[0];if(!fight)saveFloor(r);
   if(fight){encounters.start(c,s,r,foe,foes);return s.run.sharedEncounter;}return foe.id;
  } // Uses shared encounter settlement while keeping story initiation personal.
  function recover(c,s){if(s.pendingDefeat?.hub===zone&&s.pendingDefeat.sceneComplete&&now()>=s.pendingDefeat.readyAt){const p=s.pendingDefeat.position;delete s.pendingDefeat;relocate(c,s,p);return true;}return false;}
  function act(c,s,input,p){const r=record();
   if(input.action==='defeat_complete'){if(s.pendingDefeat?.hub!==zone||s.pendingDefeat.id!==input.scene)fail('This defeat scene changed.');s.pendingDefeat.sceneComplete=true;recover(c,s);return;}
   if(s.run?.kind==='hub_event'){encounters.act(c,s,input,r);return;}
   const foe=r.floor.enemies.find(e=>e.id===input.encounter);if(s.contentVersion!==1)fail('Update the game to join a DM encounter.');
   if(s.pendingDefeat||s.run||!foe||foe.engaged||foe.dead||foe.respawnAt>now()||Math.abs(p.x-foe.x)+Math.abs(p.y-foe.y)>1)fail('Stand beside an available monster.');
   encounters.start(c,s,r,foe);
  }
  function tick(){data.enemies=live.published().monsters;encounters.tick(()=>record());const r=record();let changed=false;
   for(const c of players()){const s=JSON.parse(c.state);if(recover(c,s))saveCharacter(c,s);}
   const present=players(); // Once per tick, after recoveries moved anyone; engagements below update these same rows in place.
   for(const foe of r.floor.enemies){if(foe.engaged)continue;if(foe.dead){if(!foe.respawning||data.enemies[foe.type]?.retired){foe.remove=true;changed=true;continue;}if(foe.respawnAt>now())continue;foe.dead=false;foe.definition=structuredClone(data.enemies[foe.type]??foe.definition);changed=true;}
    if(!foe.roaming)continue;
    for(const c of present.filter(c=>c.seen>now()-30000)){const s=JSON.parse(c.state);if(s.run||s.pendingDefeat||s.worldTurnDue||s.pendingPurchase||s.contentVersion!==1||s.hubSafeUntil>now()||s.loadout?.player_info.playerHealth<=0)continue;
     const path=pathTo(r.floor,foe,c,6);if(!path)continue;
     if(path.length<=1){try{encounters.start(c,s,r,foe);saveCharacter(c,s);}catch(e){if(!e.status)throw e;}break;}
     const step=path[0];if(![...r.floor.enemies,...present,...r.floor.fixtures].some(p=>p.x===step.x&&p.y===step.y)){Object.assign(foe,step);changed=true;}break;
    }
   }r.floor.enemies=r.floor.enemies.filter(e=>!e.remove);if(changed)saveFloor(r);
  }
  function relocateBlocked(){const r=record();let changed=false;for(const foe of r.floor.enemies){if(walkable(r.floor,foe.x,foe.y))continue;if(foe.engaged)fail('Finish the fight with '+(foe.definition?.name??foe.type)+' before changing its tile.');let spot=null;for(let d=1;d<=8&&!spot;d++)for(let dy=-d;dy<=d&&!spot;dy++)for(let dx=-d;dx<=d;dx++){if(Math.abs(dx)+Math.abs(dy)!==d)continue;const x=foe.x+dx,y=foe.y+dy;if(walkable(r.floor,x,y)&&!r.floor.enemies.some(e=>e!==foe&&e.x===x&&e.y===y)){spot={x,y};break;}}if(spot){Object.assign(foe,spot);foe.spawn={...spot};}else foe.remove=true;changed=true;}r.floor.enemies=r.floor.enemies.filter(e=>!e.remove);if(changed)saveFloor(r);return changed;} // After a GM terrain patch (zones.mjs patchAct): nearest free tile, or gone if boxed in.
  const api={view,place,act,tick,storyEncounter,relocateBlocked,snapshot:s=>encounters.snapshot(s),monsters:()=>record().floor.enemies.filter(e=>!e.dead).map(e=>({...e,definition:undefined,name:e.definition.name,sprite:e.definition.sprite}))};engines.set(zone,api);return api;
 }
 const idleUntil=new Map(); // zone -> when an empty hub gets its next catch-up tick.
 return {engine,tick(){const occupiedZones=new Set(db.prepare('SELECT DISTINCT zone FROM quest_presence WHERE seen>?').all(now()-30000).map(row=>row.zone)); // One presence query per tick answers "is anyone here?" for every hub, instead of one query per room (a flat ~4 ms per tick with nobody online).
  for(const row of db.prepare('SELECT zone FROM world_hub_maps').all()){if(!ids.includes(row.zone))continue; // Skip maps saved for rooms a later deployment retired, so boot never crash-loops on old DM monsters.
  const occupied=occupiedZones.has(row.zone);
  if(!occupied&&now()<(idleUntil.get(row.zone)??0))continue; // Nobody online here: rebuilding the room and its monsters every second changes nothing anyone can see.
  if(!occupied)idleUntil.set(row.zone,now()+15000); // Empty hubs still tick every 15 s, so respawns, retired monsters and offline defeat recoveries catch up.
  engine(row.zone).tick();}}};
}
