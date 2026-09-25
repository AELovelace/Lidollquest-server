// A/B world benchmark: one online player stepping through a hub town while the world timer runs, on a
// database shaped like live (hundreds of offline characters parked on dive routes, offline online-quests,
// DM monsters in empty hubs). Point --server at any checkout's server folder to compare two versions:
//   git worktree add ../lq-baseline <commit>
//   node deploy/benchmark-world.mjs --server=../lq-baseline/server
//   node deploy/benchmark-world.mjs --server=server
// It prints the same timing rows the /gm Performance tab shows (calls, total, average) plus wall-clock
// time per read and per world tick.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const arg=(name,fallback)=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3)??fallback; // --name=value options.
const serverDir=resolve(arg('server','server')),offline=Number(arg('characters',200)),seconds=Number(arg('seconds',60)),hub=arg('hub','honeydew-lantern'); // What to load and how big to make the world.
const load=file=>import(pathToFileURL(resolve(serverDir,file)).href); // Import a module from the chosen checkout.
const [{createQuestZones},{createWorldContent},{combatData},{hubData}]=await Promise.all(['zones.mjs','world-content.mjs','combat.mjs','hubs.mjs'].map(load));

const db=new DatabaseSync(':memory:');let time=Date.parse('2026-09-25T12:00:00Z'),owner='player'; // Fixed clock so both versions see the same weeks and months.
const rows=new Map(),measure=(name,work)=>{const start=performance.now();try{return work();}finally{const r=rows.get(name)??{calls:0,ms:0,max:0},ms=performance.now()-start;r.calls++;r.ms+=ms;r.max=Math.max(r.max,ms);rows.set(name,r);}}; // Stand-in for the /gm performance monitor.
const live=createWorldContent(db,{now:()=>time,spells:combatData.spells,equipment:{...hubData.equipment,...combatData.defeat_items},defeatEquipment:combatData.defeat_equipment});
const zones=createQuestZones(db,{now:()=>time,roll:()=>0,live,measure,grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:{log:()=>{}}});
const loadout={player_info:{class_id:'fighter',playerHealth:500,playerHealthMax:500,str:10,def:8,dex:8,int:20,cha:10,level:12,xp:0,stat_points:0},inventory:[{item_id:'adult_food'}],player_spells:[],player_mp:10,player_mp_max:10}; // A mid-level adventurer.
const act=(id,action,extra={})=>{time+=350;const s=id?zones.read('',id):null;return zones.act('',{action,request_id:randomUUID(),controller:'window',character_id:id,revision:s?.character.revision,...(s?.character.dive?{edition:s.dive.edition}:{}),...extra});}; // One player command, as the client sends it.
const publish=(kind,entry)=>{let revision=0;try{revision=live.entry(kind,entry.id).revision;}catch{}return live.change({action:'content_publish',kind,id:entry.id,revision,entry},'dm');}; // GM publication.

// World setup: generate every weekly floor, then content like the live server has.
zones.tick();time+=1001;zones.tick();
const monster={id:'bench_monster',enemy_id:'bench_monster',name:'Bench monster',hp:20,str:1,def:0,dex:1,exp:12,spell_cast_chance:0,enemy_spells:[],sprite:'sprItem',battle_sprite:'',roaming:true};
publish('monster',monster);
publish('npc',{id:'bench_npc',name:'Bench guide',description:'Stands very still for benchmarks',dialogue:[{id:'hello',text:'Hi!',next:'close',actions:[]}],quests:[]});
publish('quest',{id:'bench_quest',name:'Bench quest',description:'Wait around',givers:['bench_npc'],turn_in:{mode:'journal'},timer:{seconds:86400,mode:'online'},stages:[{id:'start',name:'Wait',objectives:[{id:'arrive',type:'visit',target:'honeydew-lantern',count:1}],next:'complete'}],rewards:{xp:5,coins:10}});
const questDefinition=live.published().quests.bench_quest;

const ids=[];
for(let n=0;n<offline;n++){owner='offline-'+n;const c=act(null,'create',{name:'Offline '+n}).character;act(c.id,'enter',{zone:n%2?'princess-rose':hub,loadout,combat_version:3,content_version:1,quest_version:1});ids.push(c.id);} // Parked characters, half in the player's town.
owner='diver';const diver=act(null,'create',{name:'Diver'}).character;act(diver.id,'enter',{zone:'princess-rose',loadout,combat_version:3,content_version:1,quest_version:1});act(diver.id,'dive_enter',{loadout});
const template=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(diver.id).state).dive; // A real dive visit to copy onto the parked characters.
const routes=db.prepare('SELECT route,MAX(edition) AS edition FROM dive_editions GROUP BY route').all(); // Every weekly or static route and its current floor.
ids.forEach((id,n)=>{if(n%3===0)return;const s=JSON.parse(db.prepare('SELECT state FROM quest_characters WHERE id=?').get(id).state),r=routes[n%routes.length];s.dive={...template,route:r.route,edition:r.edition};db.prepare('UPDATE quest_characters SET state=? WHERE id=?').run(JSON.stringify(s),id);}); // Two in three logged off inside a dive, like live.
ids.slice(0,Math.floor(offline*0.75)).forEach(id=>db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)').run(randomUUID(),id,'bench_quest','bench',JSON.stringify(questDefinition),JSON.stringify({status:'active',stage:'start',progress:{},tokens:{},elapsed:0,last_tick:time,branch:[]}),time)); // Offline characters holding an active online quest.

for(const zone of ['princess-rose','utopia-arcanum','arcadia-foundry']){ // DM monsters in hubs nobody online stands in.
 try{const m=zones.world.map(zone);let placed=0;
  for(let y=3;y<m.floor.height-3&&placed<3;y+=2)for(let x=3;x<m.floor.width-3&&placed<3;x+=3)try{const now=zones.world.map(zone);zones.world.act({action:'world_place',zone,edition:now.edition,revision:now.revision,monster:monster.id,x,y,aggressive:true,respawning:true});placed++;}catch(e){if(!e.status)throw e;}
 }catch(error){console.warn('No DM monsters in',zone,error.message);}
}

owner='player';const player=act(null,'create',{name:'Player'}).character;act(player.id,'enter',{zone:hub,loadout,combat_version:3,content_version:1,quest_version:1});
db.prepare('INSERT INTO online_quests VALUES (?,?,?,?,?,?,?)').run(randomUUID(),player.id,'bench_quest','bench',JSON.stringify(questDefinition),JSON.stringify({status:'active',stage:'start',progress:{},tokens:{},elapsed:0,last_tick:time,branch:[]}),time);
db.prepare('UPDATE quest_presence SET seen=? WHERE owner LIKE ?').run(time-3600000,'offline-%'); // Everyone but the player logged off an hour ago.
time+=60000;for(let n=0;n<3;n++){time+=1001;zones.tick();} // Settle past the first sweeps.

// Measured window: two reads (steps) and one world tick per simulated second, like one active player.
rows.clear();let readMs=0,tickMs=0;
for(let s=0;s<seconds;s++){
 for(let k=0;k<2;k++){time+=500;db.prepare('UPDATE quest_presence SET seen=? WHERE owner=?').run(time,'player');const t=performance.now();zones.read('',player.id);readMs+=performance.now()-t;}
 const t=performance.now();zones.tick();tickMs+=performance.now()-t;
}
const round=v=>Math.round(v*100)/100;
console.log(JSON.stringify({server:serverDir,characters:offline,seconds,readAvgMs:round(readMs/(seconds*2)),tickAvgMs:round(tickMs/seconds),
 timings:[...rows].sort((a,b)=>b[1].ms-a[1].ms).slice(0,25).map(([name,r])=>({name,calls:r.calls,totalMs:round(r.ms),avgMs:round(r.ms/r.calls),maxMs:round(r.max)}))},null,1));
zones.close();db.close();
