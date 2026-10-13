import {seeded,inside,walkable} from './dive-generation.mjs';
import {validateFullDungeon} from './full-dungeon-generation.mjs';

export const CATACOMBS='dungeon-honeydew-catacombs-1';
const key=p=>p.x+','+p.y;
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'dungeon_conflict'});};
export const isCatacombs=zone=>/^dungeon-honeydew-catacombs-[123]$/.test(zone??'');

export function generateCatacombs(data,edition){
 const c=data.config,level=c.catacombs.level,rnd=seeded(c.route+':'+edition+':catacombs-v1'),W=80,H=80;
 const f={route:c.route,edition,depth:1,theme:'catacombs',width:W,height:H,generatorVersion:1,contentVersion:data.version,geometryVersion:1,mechanismRevision:0,
  walls:Array.from({length:H},()=>Array(W).fill(1)),props:Array.from({length:H},()=>Array(W).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[],fixtures:[],traps:[],puzzles:[],exits:[],entries:{},safeRooms:[]};
 const open=(x,y)=>{if(x<1||y<1||x>=W-1||y>=H-1)throw Error('Catacomb border breached');f.walls[y][x]=0;};
 function hall(points){for(let i=1;i<points.length;i++){let [x,y]=points[i-1];const [tx,ty]=points[i];while(true){open(x,y);open(x+1,y);open(x,y+1);open(x+1,y+1);if(x===tx&&y===ty)break;if(x!==tx)x+=Math.sign(tx-x);else y+=Math.sign(ty-y);}}} // Two-wide passages leave room for party movement.
 function chamber(cx,cy,w,h,type){const r={x:cx-Math.floor(w/2),y:cy-Math.floor(h/2),w,h,cx,cy,type};for(let y=r.y;y<r.y+h;y++)for(let x=r.x;x<r.x+w;x++)open(x,y);f.rooms.push(r);return r;}
 for(let row=0;row<3;row++)for(let col=0;col<4;col++)chamber(10+20*col,12+25*row,9+2*rnd(2),9,'gallery-'+(row*4+col));
 const edges=[],hauntSites=[];
 for(let i=0;i<12;i++)for(const j of [i%4<3?i+1:-1,i<8?i+4:-1])if(j>=0){
  const a=f.rooms[i],b=f.rooms[j],bend=rnd(2)?3:-3;
  hall(a.cy===b.cy?[[a.cx,a.cy],[a.cx+7,a.cy],[a.cx+7,a.cy+bend],[b.cx-7,b.cy+bend],[b.cx-7,b.cy],[b.cx,b.cy]]:[[a.cx,a.cy],[a.cx,a.cy+10],[a.cx+bend,a.cy+10],[b.cx+bend,b.cy-10],[b.cx,b.cy-10],[b.cx,b.cy]]);
  edges.push([i,j]);
  if((i===7&&j===11)||(i===5&&j===9))hauntSites.push({x:a.cx+bend,y:a.cy+12}); // Optional cross-passages carry visible threshold markers.
 } // The twelve-chamber lattice has six independent loops before either secret opens.
 const fixture=(id,kind,name,sprite,x,y,extra={})=>{const v={id,kind,name,sprite,x,y,span_w:1,span_h:1,solid:true,...extra};f.fixtures.push(v);if(v.solid)f.props[y][x]=1;return v;};
 const reserved=[],puzzles=[],refuges=[];
 const portal=(zone,name,index)=>{const r=f.rooms[index];f.exits.push({zone,name,x:r.cx,y:r.cy,style:'stairs'});f.entries[zone]={x:r.cx,y:r.cy+1};f.safeRooms.push({...r});f.decorations.push({x:r.cx,y:r.cy,sprite:zone==='honeydew-lantern'||(isCatacombs(zone)&&Number(zone.at(-1))<level)?'sprCatacombStairsUp':'sprCatacombStairs',solid:false});};
 for(const e of c.endpoints)portal(e.zone,e.name,e.room);
 for(const e of c.catacombs.reserved??[]){const r=f.rooms[e.room],p={target:e.zone,name:e.name,x:r.cx,y:r.cy,arrival:{x:r.cx,y:r.cy+1},active:false};reserved.push(p);f.safeRooms.push({...r});fixture('reserved-'+e.zone,'catacomb_seal',e.name+' — sealed',e.zone.includes('mana')?'sprCatacombDoorMana':'sprCatacombDoorSteam',r.cx,r.cy,{target:e.zone});}
 f.entrance={...Object.values(f.entries)[0]};
 if(level<3){const r=f.rooms[level===1?0:5];refuges.push({...r});f.safeRooms.push({...r});fixture('refuge-cot','bed','Caretaker cot','sprBed',r.cx-3,r.cy-2,{bed:'objBedCot'});fixture('refuge-toilet','toilet','Caretaker toilet',data.service_profiles.toilet.sprite,r.cx+3,r.cy-2,{style:'porcelain'});fixture('refuge-shrine','catacomb_detail','Quiet refuge','sprCatacombShrine',r.cx,r.cy-3,{text:'Warm candlelight holds the chill at bay. Rest here; the dead will not follow.'});}
 for(let n=0;n<2;n++){
  const left=10+n*40,right=left+20,r=chamber(left+10,75,7,5,'secret-'+n),symbols=['Leaf','Bell','Star','Key'];
  hall([[left,62],[left,75],[right,75],[right,62]]);
  const doors=[left,left+1,right,right+1].map(x=>({x,y:70}));for(const p of doors){f.props[p.y][p.x]=1;f.walls[p.y][p.x]=1;} // Closed crypt masonry also blocks both client and server fog rays.
  const order=[0,1,2,3];for(let i=3;i>0;i--){const j=rnd(i+1);[order[i],order[j]]=[order[j],order[i]];}
  const host=f.rooms[8+n*2],id='memorial-'+n;
  puzzles.push({id,order,progress:0,solved:false,doors,room:12+n});
  for(let i=0;i<4;i++)fixture(id+'-candle-'+i,'catacomb_candle',symbols[i]+' memorial candle','sprCatacombCandle'+i,host.cx-3+i*2,host.cy-3,{puzzle:id,symbol:i,lit:false});
  fixture(id+'-epitaph','catacomb_detail','Read the memorial','sprCatacombEpitaph',host.cx-3,host.cy+3,{text:'Remember them in this order: '+order.map(i=>symbols[i]).join(', then ')+'. Light each named candle once. A mistaken flame begins the remembrance anew.'});
  for(const x of [left,right])fixture(id+'-door-'+x,'catacomb_door','Sealed memorial crypt','sprCatacombDoor',x,70,{puzzle:id});
  f.chests.push({id:'memorial-treasure-'+n,x:r.cx,y:r.cy,requires_memorial:id});
 }
 const crypts=[4,6].map((i,n)=>({...f.rooms[i],id:'chill-'+n})),haunts=hauntSites.map((p,n)=>({id:'haunt-'+n,...p}));
 for(const r of crypts)fixture(r.id+'-warning','catacomb_detail','Warning: Grave Chill','sprCatacombEpitaph',r.cx,r.y-1,{text:'Frost gathers beyond this threshold. Entering this crypt brings twelve steps of Grave Chill. A refuge will lift it.'});
 for(const h of haunts){open(h.x+2,h.y-2);fixture(h.id+'-warning','catacomb_detail','Warning: restless apparition','sprCatacombEpitaph',h.x+2,h.y-2,{text:'A pale figure waits on the marked stone. Crossing it will startle you. You can walk around it.'});f.decorations.push({...h,sprite:'sprCatacombShrine',solid:false});}
 const memorial=f.rooms[5];fixture('floor-memorial','catacomb_detail',['The village remembers','Roots among the names','The erased memorial'][level-1],'sprCatacombEpitaph',memorial.cx-3,memorial.cy+3,{text:[
  'Honeydew families once carried candles here each autumn. Familiar village names fill the first rows. Farther down, the dates remain but nobody visits the names.',
  'The caretaker has tied the fallen tablets to the roots that displaced them. The dead have no use for straight corridors, but the living still need a way home.',
  'These names were not lost to time. Every letter was patiently carved away. Beyond the vault waits the Keeper; you may leave the silence undisturbed.'
 ][level-1]}); // Environmental lore carries the floor story without quest prerequisites.
 const occupied=new Set([...f.fixtures,...f.exits,...Object.values(f.entries),...f.chests,...haunts].map(key));
 const safe=p=>f.safeRooms.some(r=>inside(r,p.x,p.y));
 function take(room){const cells=[];for(let y=room.y+1;y<room.y+room.h-1;y++)for(let x=room.x+1;x<room.x+room.w-1;x++){const p={x,y};if(walkable(f,x,y)&&!safe(p)&&!occupied.has(key(p)))cells.push(p);}if(!cells.length)throw Error('Catacomb content has no space');const p=cells[rnd(cells.length)];occupied.add(key(p));return p;} // Reserve content before decorative dressing.
 const combatRooms=f.rooms.slice(0,12).filter(r=>!f.safeRooms.some(s=>s.cx===r.cx&&s.cy===r.cy));
 for(let i=0;i<4;i++)f.chests.push({id:'treasure-'+i,...take(combatRooms[i%combatRooms.length])});
 for(let i=0;i<6;i++)f.pickups.push({id:'supply-'+i,kind:i%2?'potion':'food',sprite:'sprItem',...take(combatRooms[i%combatRooms.length])});
 const pool=data.enemy_types.map(e=>e.enemy_id);
 for(let i=0;i<12;i++){const p=take(combatRooms[i%combatRooms.length]),type=pool[i%pool.length];f.enemies.push({id:'enemy-'+i,type,...p,spawn:{...p},definition:structuredClone(data.enemies[type]),roaming:true,engaged:null,respawnAt:0});}
 if(level===3){const p=take(f.rooms[11]),type='keeper_unspoken_names';f.enemies.push({id:'catacomb-keeper',type,...p,spawn:{...p},definition:structuredClone(data.enemies[type]),roaming:false,engaged:null,respawnAt:0});f.chests.push({id:'keeper-relic',...take(f.rooms[11]),item_id:'remembrance_locket',rarity:'rare',no_enchant:true,requires_encounter:'catacomb-keeper'});} // The named reward never rolls an equipment curse.
 const detail=['sprCatacombSarcophagus','sprCatacombBoneNiche','sprCatacombPillar','sprCatacombUrn'];
 for(const reward of [...f.chests,...f.pickups])reward.no_enchant=true; // These tombs never add an equipment curse to a personal reward.
 for(const r of combatRooms)for(let i=0;i<3;i++)f.decorations.push({...take(r),sprite:detail[rnd(detail.length)],solid:false});
 const avoid=[...f.exits,...Object.values(f.entries),...reserved,...reserved.map(p=>p.arrival)],eligible=[],mist=Array.from({length:H},()=>Array(W).fill('0'));
 for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++)if(walkable(f,x,y)&&!safe({x,y})&&!avoid.some(p=>Math.max(Math.abs(p.x-x),Math.abs(p.y-y))<=3))eligible.push({x,y});
 for(let i=eligible.length-1;i>0;i--){const j=rnd(i+1);[eligible[i],eligible[j]]=[eligible[j],eligible[i]];}
 const count=Math.ceil(eligible.length*c.catacombs.mist_coverage);for(const p of eligible.slice(0,count))mist[p.y][p.x]='1';
 f.mist={version:1,rows:mist.map(r=>r.join('')),tiles:count};
 f.catacombs={version:1,level,edges,puzzles,reserved,refuges,crypts,haunts,lighting:c.catacombs.lighting};
 validateFullDungeon(f);return f;
} // Pure generation supplies workers, previews and the live service with identical maps.

export function catacombInteract(f,fix,revision){
 if(fix.kind==='catacomb_detail')return fix.text;
 if(fix.kind==='catacomb_seal')return 'This passage remains sealed.';
 const q=f.catacombs.puzzles.find(q=>q.id===fix.puzzle);if(!q)fail('Unknown memorial.');
 if(fix.kind==='catacomb_door')return q.solved?'The memorial passage is open.':'The epitaph names the order of remembrance.';
 if(revision!==f.mechanismRevision)fail('The memorial changed. Refresh before acting.');
 if(q.solved)return 'The remembrance is complete. The passage remains open.';
 const correct=fix.symbol===q.order[q.progress];q.progress=correct?q.progress+1:0;q.solved=q.progress===4;
 for(const candle of f.fixtures.filter(v=>v.kind==='catacomb_candle'&&v.puzzle===q.id)){candle.lit=q.order.slice(0,q.progress).includes(candle.symbol);candle.sprite='sprCatacombCandle'+candle.symbol+(candle.lit?'Lit':'');}
 if(q.solved){for(const p of q.doors){f.props[p.y][p.x]=0;f.walls[p.y][p.x]=0;}for(const door of f.fixtures.filter(v=>v.kind==='catacomb_door'&&v.puzzle===q.id)){door.solid=false;door.sprite='sprCatacombDoorOpen';door.name='Open memorial passage';}}
 f.mechanismRevision++;f.geometryVersion++;
 return q.solved?'The candles answer together. The crypt and its passage open.':correct?'A memorial candle catches.':'The flames fade. Begin the remembrance again.';
} // Monotonic solved doors cannot close on another visitor.

export function catacombStep(f,s,personal,x,y,now=Date.now()){
 if(!f.catacombs||s.run||s.dungeonScene||s.pendingDefeat)return;
 const a=f.catacombs,p=s.loadout.player_info;personal.catacombs??={crypts:[],haunts:[]};const memory=personal.catacombs;
 const add=(wet,tum)=>{p.wet=Math.min(100,Math.max(0,p.wet??0)+wet);if(!s.loadout.world?.wet_only_mode)p.tum=Math.min(100,Math.max(0,p.tum??0)+tum);};
 const notice=text=>{s.dive.lootNotice=text;s.dive.lootNoticeAt=now;};
 if(a.refuges.some(r=>inside(r,x,y))){delete s.graveChill;return;}
 if(s.graveChill?.steps>0){add(2,1);if(--s.graveChill.steps===0)delete s.graveChill;}
 const crypt=a.crypts.find(r=>inside(r,x,y));
 if(crypt&&!memory.crypts.includes(crypt.id)){memory.crypts.push(crypt.id);if(!s.graveChill){s.graveChill={steps:12};notice('Grave Chill: twelve steps of pressure. A refuge will lift it.');}} // Crossing another marked crypt during chill consumes its trigger without stacking or a delayed refresh.
 const haunt=a.haunts.find(p=>p.x===x&&p.y===y);
 if(haunt&&!memory.haunts.includes(haunt.id)){memory.haunts.push(haunt.id);add(15,8);notice('The apparition turns toward you. A sudden fright grips your body.');}
} // Personal receipts prevent retries and other players from repeating a haunting.

export function reconcileCatacombReservations(f,ready){
 if(!f.catacombs)return false;let changed=false;
 for(const p of f.catacombs.reserved){if(p.active||!ready(p.target,f))continue;
  if(p.target==='dungeon-mana-tunnels')p.name='Mana Caves ? Utopia'; // Saved reservations keep their cells while receiving the shipped display name.
  p.active=true;f.exits.push({x:p.x,y:p.y,zone:p.target,name:p.name,style:'stairs'});f.entries[p.target]={...p.arrival};
  const fix=f.fixtures.find(v=>v.id==='reserved-'+p.target);fix.solid=false;fix.kind='scenery';fix.name=p.name;fix.sprite='sprCatacombDoorOpen';f.props[p.y][p.x]=0;changed=true;
 }
 if(changed){f.geometryVersion++;f.mechanismRevision++;}return changed;
} // Future routes activate their reserved cells without regenerating terrain or rewards.
