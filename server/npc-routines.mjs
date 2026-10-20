import {moveDelays,extendTrail,trailView} from './crawl.mjs'; // Residents share the player's tuned walking interval and bounded, timestamped tile trail.
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'npc_routine_conflict'});};
const key=p=>p.x+','+p.y;
const cardinal=[[0,1],[-1,0],[1,0],[0,-1]];
export const BRITTANY_ROUTINE={version:1,enabled:true,name:"Brittany's day",entries:[
 {id:'morning',name:'Morning walk',clock:'game',from:420,to:540,priority:0,days:[0,1,2,3,4,5,6],blocks:[{kind:'travel',destination:{zone:'utopia-arcanum',anchor:'arrival',dx:2,dy:0}},{kind:'wait',seconds:20},{kind:'stay'}]},
 {id:'work',name:'At the toy shelf',clock:'game',from:540,to:1020,priority:0,days:[0,1,2,3,4,5,6],blocks:[{kind:'home'},{kind:'stay'}]},
 {id:'visit',name:'Workshop visit',clock:'game',from:1020,to:1200,priority:0,days:[0,1,2,3,4,5,6],blocks:[{kind:'travel',destination:{zone:'utopia-arcanum-dives',anchor:'arrival',dx:3,dy:1}},{kind:'stay'}]},
 {id:'sleep',name:'Rest in the Nap Pods',clock:'game',from:1200,to:420,priority:0,days:[0,1,2,3,4,5,6],blocks:[{kind:'travel',destination:{zone:'utopia-arcanum-beds',anchor:'arrival',dx:3,dy:1}},{kind:'stay'}]}
]}; // A copyable example, not a startup migration: GMs explicitly assign it to a resident.
export function activeRoutine(entries,gameMs,realMs){
 return entries.map((r,index)=>({r,index})).filter(({r})=>{const ms=r.clock==='real'?realMs:gameMs,minute=((ms/60000)%1440+1440)%1440,day=Math.floor(ms/86400000)-(r.from>r.to&&minute<r.to?1:0),weekday=r.clock==='real'?((day+4)%7+7)%7:((day%7)+7)%7;return r.days.includes(weekday)&&(r.from<r.to?minute>=r.from&&minute<r.to:minute>=r.from||minute<r.to);}).sort((a,b)=>b.r.priority-a.r.priority||a.index-b.index)[0]?.r??null;
} // A midnight-spanning routine belongs to its starting day; list order breaks equal priorities.
export function normalizeRoutine(raw,catalog){
 if(!raw||raw.version!==1||!Array.isArray(raw.entries)||raw.entries.length>16)fail('A version 1 routine supports up to 16 schedule blocks.');const known=new Set(catalog.map(z=>z.id)),ids=new Set();
 const int=(v,min,max,label)=>{if(!Number.isInteger(v)||v<min||v>max)fail('Invalid '+label+'.');return v;};
 const destination=d=>{if(!d||!known.has(d.zone))fail('Choose a known destination zone.');if(d.anchor){if(typeof d.anchor!=='string'||d.anchor.length>100)fail('Choose an arrival, fixture or door anchor.');return {zone:d.zone,anchor:d.anchor,dx:int(d.dx??0,-20,20,'anchor offset'),dy:int(d.dy??0,-20,20,'anchor offset')};}return {zone:d.zone,x:int(d.x,0,1023,'destination x'),y:int(d.y,0,1023,'destination y')};};
 const entries=raw.entries.map((r,i)=>{const id=String(r.id??'routine-'+i);if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)||ids.has(id))fail('Schedule IDs must be unique.');ids.add(id);if(!['game','real'].includes(r.clock))fail('Choose Game time or Real time.');const from=int(r.from,0,1439,'start time'),to=int(r.to,0,1439,'end time');if(from===to)fail('Start and end must differ.');if(!Array.isArray(r.days)||!r.days.length||r.days.length>7)fail('Choose days of the week.');if(!Array.isArray(r.blocks)||!r.blocks.length||r.blocks.length>32)fail('Use 1–32 action blocks per schedule.');let zone=null;
  const blocks=r.blocks.map(b=>{if(b.kind==='travel'){const d=destination(b.destination);zone=d.zone;return {kind:'travel',destination:d};}if(b.kind==='home')return {kind:'home'};if(b.kind==='stay')return {kind:'stay'};if(b.kind==='wait')return {kind:'wait',seconds:int(b.seconds,1,86400,'wait seconds')};if(b.kind==='patrol'){if(!Array.isArray(b.points)||!b.points.length||b.points.length>16)fail('A patrol needs 1–16 points.');const points=b.points.map(destination);if(points.some(p=>p.zone!==points[0].zone))fail('A patrol stays in one zone; use Travel blocks between zones.');return {kind:'patrol',points,loops:int(b.loops??1,1,100,'patrol loops')};}fail('Unknown action block '+b.kind);});
  return {id,name:String(r.name??'Schedule').slice(0,80),clock:r.clock,from,to,priority:int(r.priority??0,0,100,'priority'),days:[...new Set(r.days.map(d=>int(d,0,6,'weekday')))],blocks};});
 return {version:1,name:String(raw.name??'Routine').slice(0,80),enabled:raw.enabled!==false,entries};
}
export function facingToward(from,to){ // 0 down (+y), 1 up (-y), 2 right (+x), 3 left (-x); null when on the same tile.
 const dx=to.x-from.x,dy=to.y-from.y;if(!dx&&!dy)return null;return Math.abs(dx)>=Math.abs(dy)?(dx>0?2:3):(dy>0?0:1);
}
const AMBIENT_HOLD_MAX_MS=90000; // 2026-10-20: a stop-and-chat lasts about a minute; it was 30 s, so residents walked off mid-conversation.
export function createNpcRoutines(db,{now,base,clock,published,readOnly=false,held=()=>false,facing=()=>null,walkDelay=()=>base.walkDelay?.()??moveDelays().walk}={}){
 db.exec('CREATE TABLE IF NOT EXISTS world_npc_routines(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL)');
 const allQuery=db.prepare('SELECT * FROM world_npc_routines ORDER BY id'),oneQuery=db.prepare('SELECT * FROM world_npc_routines WHERE id=?');
 const unpack=r=>r?{...r,body:JSON.parse(r.body),state:JSON.parse(r.state)}:null,all=()=>allQuery.all().map(unpack),get=id=>unpack(oneQuery.get(id));
 const enabled=r=>r.body.enabled&&!published()[r.body.content]?.retired&&!!published()[r.body.content];
 const readMap=id=>(base.paintMap??base.map)(id);
 function open(f,x,y,ignore=null){return Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<f.width&&y<f.height&&!f.walls?.[y]?.[x]&&!f.props?.[y]?.[x]&&!(f.fixtures??[]).some(v=>v.id!==ignore&&v.solid!==false&&x>=v.x&&x<v.x+(v.span_w??1)&&y>=v.y&&y<v.y+(v.span_h??1));}
 function nearest(f,p,limit=5){if(!p)return null;for(let d=0;d<=limit;d++)for(let y=p.y-d;y<=p.y+d;y++)for(let x=p.x-d;x<=p.x+d;x++)if(Math.abs(x-p.x)+Math.abs(y-p.y)===d&&open(f,x,y))return {x,y};return null;}
 function links(map){return [...(map.floor?.doors??[]),...(map.floor?.portals??[]),...(map.floor?.exits??[])].map(d=>({...d,target:d.target??d.zone})).filter(d=>d.target&&d.target!==map.id);}
 function route(from,to,maps){const known=new Set(base.catalog().map(z=>z.id)),queue=[from],seen=new Map([[from,null]]);for(let i=0;i<queue.length&&i<128;i++){const id=queue[i];if(id===to){const path=[];for(let at=id;seen.get(at);at=seen.get(at).from)path.unshift(seen.get(at));return path;}let m;try{m=maps(id);}catch{continue;}for(const exit of links(m)){if(!known.has(exit.target)||seen.has(exit.target))continue;seen.set(exit.target,{from:id,to:exit.target,key:exit.key??null,exit});queue.push(exit.target);}}return null;} // Follow actual current portals, never the editor's list of merely permitted future connections.
 function destination(d,m){const f=m.floor;if(!f)return null;let p=d;if(d.anchor){p=d.anchor==='arrival'?(f.entrance??f.spawn):(f.placeAnchors??[]).find(v=>v.id===d.anchor)??(f.fixtures??[]).find(v=>v.id===d.anchor)??links(m).find(v=>v.key===d.anchor);if(!p)return null;p={x:p.x+(d.dx??0),y:p.y+(d.dy??0)};}return nearest(f,p,3);}
 function path(f,from,to,blocked=new Set()){if(!to)return null;if(from.x===to.x&&from.y===to.y)return [];const queue=[from],prev=new Map([[key(from),null]]);for(let i=0;i<queue.length;i++){const p=queue[i];for(const [dx,dy] of cardinal){const q={x:p.x+dx,y:p.y+dy},k=key(q);if(prev.has(k)||!open(f,q.x,q.y)||blocked.has(k))continue;prev.set(k,p);if(q.x===to.x&&q.y===to.y){const out=[q];for(let v=p;v!==from;v=prev.get(key(v)))out.unshift(v);return out;}queue.push(q);}}return null;}
 function save(input,placement){if(readOnly)fail('Snapshot workers cannot edit routines.');const old=get(placement.id);if((input.revision??0)!==(old?.revision??0))fail('This routine changed. Refresh before saving.');if(placement.kind!=='npc'||placement.lifetime==='temporary')fail('Choose a persistent GM NPC placement.');const body={...normalizeRoutine(input.routine,base.catalog()),content:placement.content,home:old?.body.home??{zone:placement.zone,x:placement.home?.x??placement.x,y:placement.home?.y??placement.y}};
  const maps=new Map(),map=id=>{if(!maps.has(id))maps.set(id,readMap(id));return maps.get(id);};
  for(const e of body.entries){let from=body.home.zone;for(const b of e.blocks){const destinations=b.kind==='travel'?[b.destination]:b.kind==='patrol'?b.points:b.kind==='home'?[body.home]:[];for(const d of destinations){if(!destination(d,map(d.zone)))fail('Destination in '+d.zone+' has no usable tile or anchor.');if(from!==d.zone&&!route(from,d.zone,map))fail('No connected journey from '+from+' to '+d.zone+'.');from=d.zone;}}if(from!==body.home.zone&&!route(from,body.home.zone,map))fail('The NPC needs a connected way home from '+from+'.');}
  const state=old?.state??{...body.home,facing:0,step:now(),status:'home'};state.active=null;state.block=0;delete state.until;delete state.patrol;state.status=body.enabled?'scheduled':'disabled';
  db.prepare('INSERT INTO world_npc_routines VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body,state=excluded.state,updated=excluded.updated').run(placement.id,(old?.revision??0)+1,JSON.stringify(body),JSON.stringify(state),now());return get(placement.id);
 }
 function project(zone,placements){const records=all(),ids=new Set(records.filter(enabled).map(r=>r.id)),out=placements.filter(p=>!ids.has(p.id));for(const r of records)if(enabled(r)&&r.state.zone===zone){const n=published()[r.body.content];out.push({id:r.id,zone,kind:'npc',content:r.body.content,name:n.name,sprite:n.sprite,lifetime:'persistent',x:r.state.x,y:r.state.y,home:r.body.home,facing:r.state.facing??0,walking:r.state.walking===true,...trailView(r.state,zone,now()),routine:{name:r.body.name,status:r.state.status,activity:r.state.activity,destination:r.state.destination},routineManaged:true});}return out;} // Exactly one current-zone projection; authored home definitions never respawn a traveller.
 function tick(){if(readOnly)return;const time=now(),gameMs=clock().gameMs,records=all().filter(enabled),maps=new Map(),map=id=>{if(!maps.has(id))maps.set(id,readMap(id));return maps.get(id);};let budget=400;
  const requested=Number(walkDelay()),delay=Number.isFinite(requested)&&requested>0?Math.max(50,requested):moveDelays().walk;
  for(const r of records){if(budget<=0)break;const s=r.state,elapsed=time-(s.step??time);if(elapsed<delay)continue;const e=activeRoutine(r.body.entries,gameMs,time),active=e?.id??'@home',blocks=e?.blocks??[{kind:'home'},{kind:'stay'}];
   const holding=held(r.id,time);if(holding==='ambient')s.holdSince??=time;else delete s.holdSince; // Ambient small talk may delay departure for at most AMBIENT_HOLD_MAX_MS.
   if(holding&&(holding!=='ambient'||time-s.holdSince<AMBIENT_HOLD_MAX_MS)){s.step=time;s.walking=false;s.status='talking';const f=holding==='ambient'?facing(r.id):null,d=f&&facingToward(s,f);if(d!=null)s.facing=d;}else{
    if(s.active!==active){s.active=active;s.block=0;delete s.until;delete s.patrol;}s.activity=e?.name??'Home';
    let current;try{current=map(s.zone);}catch{s.status='zone unavailable';s.step=time;current=null;}
    if(current?.floor){const repaired=nearest(current.floor,s);if(!repaired){s.status='no safe tile';s.step=time;}else{
     Object.assign(s,repaired);s.edition=current.edition;
     const watched=(current.players??[]).some(p=>p.online),steps=watched?1:Math.min(120,Math.max(1,Math.floor(elapsed/delay))),stepAt=time-elapsed%delay;let advance=steps;
     while(advance-->0&&budget-->0){const b=blocks[s.block];if(!b||b.kind==='stay'){s.status=b?'staying':'finished';s.walking=false;break;}if(b.kind==='wait'){s.until??=(s.step??time)+b.seconds*1000;if(time<s.until){s.status='waiting';s.walking=false;break;}delete s.until;s.block++;continue;}
      const d=b.kind==='home'?r.body.home:b.kind==='patrol'?b.points[(s.patrol??0)%b.points.length]:b.destination;s.destination=d.zone;s.walking=true;
      let m;try{m=map(s.zone);}catch{s.status='zone unavailable';s.walking=false;break;}const f=m.floor;if(!f){s.status='zone unavailable';s.walking=false;break;}let goal,hop=null;
      if(s.zone===d.zone)goal=destination(d,m);else{const journey=route(s.zone,d.zone,map);hop=journey?.[0];goal=hop?nearest(f,hop.exit,2):null;}
      if(!goal){s.status='destination blocked';s.walking=false;break;}
      if(s.x===goal.x&&s.y===goal.y){if(hop){let next;try{next=map(hop.to);}catch{next=null;}const back=next&&links(next).find(l=>l.target===s.zone),arrival=next?.floor&&nearest(next.floor,hop.exit.arrival??next.floor.entries?.[s.zone]??back??next.floor.entrance??next.floor.spawn,3);if(!arrival){s.status='arrival blocked';s.walking=false;break;}if(records.some(o=>o.id!==r.id&&o.state.zone===hop.to&&o.state.x===arrival.x&&o.state.y===arrival.y)){s.status='arrival occupied';break;}Object.assign(s,arrival,{zone:hop.to,edition:next.edition,status:'travelling'});if((next.players??[]).some(p=>p.online))break;continue;}
       if(b.kind==='patrol'){s.patrol=(s.patrol??0)+1;if(s.patrol>=b.points.length*b.loops){delete s.patrol;s.block++;}}else s.block++;continue;
      }
      const blocked=new Set(records.filter(o=>o.id!==r.id&&o.state.zone===s.zone&&!o.state.walking).map(o=>key(o.state))),walk=path(f,s,goal,blocked);if(!walk?.length){s.status='path blocked';s.walking=false;break;}const p=walk[0],at=stepAt-advance*delay;s.trail=extendTrail({...s,moved:at-delay},[{...p,t:at}]);s.facing=p.x!==s.x?(p.x>s.x?2:3):(p.y>s.y?0:1);s.x=p.x;s.y=p.y;s.status='travelling';
     }s.step=stepAt; // Retain fractional time so a 50 ms coordinator tick does not round 187.5 ms walking up to 200 ms. Watched rooms never bank a catch-up burst.
    }}
   }
   db.prepare('UPDATE world_npc_routines SET state=?,updated=? WHERE id=?').run(JSON.stringify(s),time,r.id);
  }
 } // The coordinator calls this inside its quest transaction; both zone snapshots observe the same committed transfer.
 return {all,get,save,project,tick,has:id=>{const r=get(id);return !!r&&enabled(r);},template:()=>structuredClone(BRITTANY_ROUTINE),positions:zone=>project(zone,[]).filter(p=>!p.walking).map(({x,y})=>({x,y})),preview:(routine,gameMs,realMs)=>activeRoutine(normalizeRoutine(routine,base.catalog()).entries,gameMs,realMs)};
}
