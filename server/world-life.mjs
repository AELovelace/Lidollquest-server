import {createHash} from 'node:crypto';
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'world_life_conflict'});};
const number=(v,min,max,label)=>{if(!Number.isFinite(v)||v<min||v>max)fail(label+' must be between '+min+' and '+max+'.');return v;};
const rgb=v=>{if(!Array.isArray(v)||v.length!==3||v.some(c=>!Number.isInteger(c)||c<0||c>255))fail('Choose an RGB colour.');return [...v];};
export function nightAmount(minute){const m=((minute%1440)+1440)%1440;return m<300||m>=1260?1:m<420?(420-m)/120:m<1080?0:(m-1080)/180;} // Dawn 05–07, dusk 18–21, with continuous light between schedule boundaries.
export function lightTheme(zone,f={}){
 const id=zone+' '+(f.theme??'');let sprite='sprTownEnvLampPost',color=[255,212,140];
 if(/utopia|mana/.test(id)){sprite='sprUtopiaEnvRuneLamp';color=[160,206,255];}
 else if(/arcadia|factory|brassworks/.test(id)){sprite='sprArcadiaEnvGasLamp';color=[255,185,100];}
 else if(/littlebig|clockwork|sewer/.test(id)){sprite='sprCityLamp';color=[235,226,199];}
 else if(/forest|woods|taiga|plains|coast|desert/.test(id)){sprite='sprForestEnvLanternPost';color=[255,218,153];}
 const underground=/^(dive|dungeon)-/.test(zone),indoor=!!f.parent;
 return {enabled:true,exposure:underground?0:indoor?.2:1,nightAlpha:.32,tint:[14,18,40],sprite,color,radius:4,strength:1,auto:true,sources:[]};
} // Profiles are shared by the live renderer, the block workshop and portable mod exports.
export function tileLight(f,source,x,y){
 const distance=Math.hypot(x-source.x,y-source.y);if(distance>source.radius)return 0;
 let ax=source.x,ay=source.y,dx=Math.abs(x-ax),dy=-Math.abs(y-ay),sx=ax<x?1:-1,sy=ay<y?1:-1,error=dx+dy;
 while(ax!==x||ay!==y){const e=2*error;if(e>=dy){error+=dy;ax+=sx;}if(e<=dx){error+=dx;ay+=sy;}if((ax!==x||ay!==y)&&f.walls?.[ay]?.[ax])return 0;}
 return source.strength*Math.min(1,Math.max(0,(source.radius+.5-distance)/1.5));
} // A circular footprint of complete tiles, with a two-ring falloff and opaque walls.
export function createWorldLife(db,{now=Date.now,readOnly=false}={}){
 db.exec('CREATE TABLE IF NOT EXISTS world_day_clock(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS world_zone_lighting(zone TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL)');
 if(!readOnly)db.prepare('INSERT OR IGNORE INTO world_day_clock VALUES (1,0,?)').run(JSON.stringify({anchor:now(),gameMs:8*3600000,dayMinutes:60,paused:false}));
 const clockRow=db.prepare('SELECT * FROM world_day_clock WHERE id=1'),lightRow=db.prepare('SELECT * FROM world_zone_lighting WHERE zone=?'),cache=new Map();
 function clock(at=now()){const row=clockRow.get(),c=row?JSON.parse(row.body):{anchor:at,gameMs:8*3600000,dayMinutes:60,paused:false},rate=c.paused?0:1440/c.dayMinutes,gameMs=c.gameMs+(at-c.anchor)*rate,minute=((gameMs/60000)%1440+1440)%1440;return {...c,revision:row?.revision??0,serverTime:at,gameMs,rate,day:Math.floor(gameMs/86400000),minute,night:nightAmount(minute)};}
 function setClock(input){if(readOnly)fail('Read-only snapshot.');const c=clock();if(input.revision!==c.revision)fail('The world clock changed. Refresh first.');const dayMinutes=number(Number(input.dayMinutes),5,10080,'Real minutes per game day'),minute=input.minute===undefined?c.minute:number(Number(input.minute),0,1439.999,'Game minute'),body={anchor:now(),gameMs:Math.floor(c.gameMs/86400000)*86400000+minute*60000,dayMinutes,paused:input.paused===true};db.prepare('UPDATE world_day_clock SET revision=revision+1,body=? WHERE id=1').run(JSON.stringify(body));return clock();} // Re-anchor before changing speed so the clock never jumps unintentionally.
 function profile(zone,f={}){const row=lightRow.get(zone);return {...lightTheme(zone,f),...(row?JSON.parse(row.body):{}),revision:row?.revision??0};}
 function save(zone,input,f){if(readOnly)fail('Read-only snapshot.');const old=profile(zone,f);if(input.revision!==old.revision)fail('Zone lighting changed. Refresh first.');const p=input.profile??{},sprite=String(p.sprite??old.sprite);if(!/^spr[A-Za-z0-9_]{1,63}$/.test(sprite))fail('Choose a shipped lamp sprite.');const out={enabled:p.enabled!==false,auto:p.auto!==false,exposure:number(Number(p.exposure??old.exposure),0,1,'Daylight exposure'),nightAlpha:number(Number(p.nightAlpha??old.nightAlpha),0,.65,'Night shade'),tint:rgb(p.tint??old.tint),color:rgb(p.color??old.color),radius:number(Number(p.radius??old.radius),1,12,'Lamp radius'),strength:number(Number(p.strength??old.strength),0,1,'Lamp strength'),sprite,sources:[]};
  if(!Array.isArray(p.sources??[])||(p.sources??[]).length>128)fail('Use at most 128 custom lights.');const ids=new Set();
  out.sources=(p.sources??[]).map((s,i)=>{if(!Number.isInteger(s.x)||!Number.isInteger(s.y)||s.x<1||s.y<1||s.x>=f.width-1||s.y>=f.height-1||f.walls?.[s.y]?.[s.x])fail('Place lamps on open terrain inside the zone.');const id=String(s.id??'light-'+i);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||ids.has(id))fail('Lamp IDs must be unique.');ids.add(id);const art=String(s.sprite??sprite);if(!/^spr[A-Za-z0-9_]{1,63}$/.test(art))fail('Choose a lamp sprite.');return {id,x:s.x,y:s.y,sprite:art,color:rgb(s.color??out.color),radius:number(Number(s.radius??out.radius),1,12,'Lamp radius'),strength:number(Number(s.strength??out.strength),0,1,'Lamp strength'),nightOnly:s.nightOnly!==false};});
  db.prepare('INSERT INTO world_zone_lighting VALUES (?,?,?) ON CONFLICT(zone) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(zone,old.revision+1,JSON.stringify(out));cache.clear();return profile(zone,f);
 }
 function lighting(zone,f){if(!f)return null;const p=profile(zone,f);if(!p.enabled)return {...p,customSources:p.sources,sources:[],key:zone+':off'};const fixtures=(f.fixtures??[]).filter(v=>!(v.kind==='npc'&&v.roaming===true)); // A strolling resident must never move a lamp or invalidate its cached mask.
  const key=createHash('sha1').update(JSON.stringify([zone,p,f.width,f.height,f.walls,f.props,fixtures,f.entrance,f.entries,f.doors,f.portals,f.exits,f.authoredPlacements,f.geometryVersion])).digest('hex');if(cache.has(key))return cache.get(key);
  const sources=[...p.sources],occupied=q=>fixtures.some(v=>q.x>=v.x&&q.x<v.x+(v.span_w??1)&&q.y>=v.y&&q.y<v.y+(v.span_h??1)),open=(x,y)=>x>0&&y>0&&x<f.width-1&&y<f.height-1&&!f.walls?.[y]?.[x]&&!f.props?.[y]?.[x];
  if(p.auto){for(const v of fixtures)if(/Lamp|Lantern/.test(v.sprite??''))sources.push({id:'fixture-'+v.id,x:v.x,y:v.y,sprite:v.sprite,existing:true,radius:p.radius,strength:p.strength,color:p.color,nightOnly:p.exposure>0});
   const protectedPoints=[f.entrance,f.spawn,...Object.values(f.entries??{}),...(f.portals??[]),...(f.exits??[]),...(f.chests??[]),...(f.pickups??[]),...(f.authoredPlacements??[])].filter(Boolean);
   for(let cy=3;cy<f.height-2&&sources.length<128;cy+=10)for(let cx=3;cx<f.width-2&&sources.length<128;cx+=10){let chosen=null;for(let dy=-2;dy<=2&&!chosen;dy++)for(let dx=-2;dx<=2&&!chosen;dx++){const q={x:cx+dx,y:cy+dy};if(open(q.x,q.y)&&!occupied(q)&&!protectedPoints.some(v=>Math.abs(v.x-q.x)+Math.abs(v.y-q.y)<3)&&!sources.some(v=>Math.hypot(v.x-q.x,v.y-q.y)<6))chosen=q;}if(chosen)sources.push({id:'auto-'+cx+'-'+cy,...chosen,sprite:p.sprite,color:p.color,radius:p.radius,strength:p.strength,nightOnly:p.exposure>0});}
  }
  const out={...p,key,customSources:p.sources,sources};if(cache.size>128)cache.clear();cache.set(key,out);return out;
 } // Generated lights are presentation fixtures: never add collision or seal a route.
 return {clock,setClock,profile,save,lighting,export:()=>({version:1,clock:clock(),zones:db.prepare('SELECT zone,body FROM world_zone_lighting').all().map(r=>({zone:r.zone,...JSON.parse(r.body)}))})};
}
