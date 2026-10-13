import {seeded,inside,walkable} from './dive-generation.mjs';
import {validateFullDungeon} from './full-dungeon-generation.mjs';

export const MANA_CAVES='dungeon-mana-tunnels'; // Keep the identity already reserved by saved Catacombs editions.
const key=p=>p.x+','+p.y;
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'dungeon_conflict'});};

export function generateManaCaves(data,edition){
 const c=data.config,m=c.mana_caves,rnd=seeded(c.route+':'+edition+':mana-v1'),W=80,H=80;
 const f={route:c.route,edition,depth:1,theme:'mana_caves',width:W,height:H,generatorVersion:1,contentVersion:data.version,geometryVersion:1,mechanismRevision:0,
  walls:Array.from({length:H},()=>Array(W).fill(1)),props:Array.from({length:H},()=>Array(W).fill(0)),rooms:[],enemies:[],chests:[],pickups:[],decorations:[],fixtures:[],traps:[],puzzles:[],exits:[],entries:{},safeRooms:[]};
 const open=(x,y)=>{if(x<1||y<1||x>=W-1||y>=H-1)throw Error('Mana cave border breached');f.walls[y][x]=0;};
 function hall(points){for(let i=1;i<points.length;i++){let [x,y]=points[i-1];const [tx,ty]=points[i];while(true){for(const [dx,dy] of [[0,0],[1,0],[0,1],[1,1]])open(x+dx,y+dy);if(x===tx&&y===ty)break;if(x!==tx)x+=Math.sign(tx-x);else y+=Math.sign(ty-y);}}} // Two-wide winding routes accommodate a party in either direction.
 function chamber(cx,cy,w,h,type){const r={x:cx-Math.floor(w/2),y:cy-Math.floor(h/2),w,h,cx,cy,type};for(let y=r.y;y<r.y+h;y++)for(let x=r.x;x<r.x+w;x++)open(x,y);f.rooms.push(r);return r;}
 const regions=['Tapped Galleries','Resonant Hollows','Resonant Hollows','Buried Veins'];
 for(let row=0;row<4;row++)for(let col=0;col<3;col++){
  const r=chamber([12,38,65][col],[10,28,46,66][row],9,9,['tapped','resonant','resonant','buried'][row]);r.region=regions[row];
  for(const dx of [-1,1])for(let y=r.y+2;y<r.y+r.h-2;y++)if(rnd(3)!==0)open(dx<0?r.x-1:r.x+r.w,y); // Ragged cavern shoulders never interrupt the guaranteed chamber core.
 }
 const edges=[];
 for(let i=0;i<12;i++)for(const j of [i%3<2?i+1:-1,i<9?i+3:-1])if(j>=0){
  const a=f.rooms[i],b=f.rooms[j],bend=rnd(2)?2:-2;
  hall(a.cy===b.cy?[[a.cx,a.cy],[a.cx+7,a.cy],[a.cx+7,a.cy+bend],[b.cx-7,b.cy+bend],[b.cx-7,b.cy],[b.cx,b.cy]]:[[a.cx,a.cy],[a.cx,a.cy+6],[a.cx+bend,a.cy+6],[b.cx+bend,b.cy-6],[b.cx,b.cy-6],[b.cx,b.cy]]);edges.push([i,j]);
 } // Seventeen edges on twelve main chambers give six independent loops before puzzles.
 const fixture=(id,kind,name,sprite,x,y,extra={})=>{const v={id,kind,name,sprite,x,y,span_w:1,span_h:1,solid:true,...extra};f.fixtures.push(v);if(v.solid)f.props[y][x]=1;return v;};
 for(const [index,e] of c.endpoints.entries()){
  const r=f.rooms[index===0?0:11];f.exits.push({...e,x:r.cx,y:r.cy});f.entries[e.zone]={x:r.cx,y:r.cy+1};f.safeRooms.push({...r,x:r.x-1,w:r.w+2});f.decorations.push({x:r.cx,y:r.cy,sprite:'sprManaStairs',solid:false});
 }
 f.entrance={...f.entries['utopia-arcanum']};
 const refuge=f.safeRooms[0];
 fixture('survey-cot','bed','Survey station cot','sprBed',9,8,{bed:'objBedCot'});
 fixture('survey-changer','changer','Survey station changer','sprUtopiaChanger',15,8);
 fixture('survey-notes','mana_detail','Survey station log','sprManaTablet',12,7,{text:'Utopia lies upstairs to the northwest. The southern veins reach Honeydew\'s buried memorials. Both main trails remain open. Rest and change here before setting out.'});
 const puzzles=[],seams=[];
 for(const [n,[left,right,y,hostIndex]] of [[12,38,19,3],[38,65,37,5],[12,38,56,9]].entries()){
  const cx=Math.floor((left+right)/2),r=chamber(cx,y,9,5,'resonance-alcove');hall([[left,y],[right,y]]);
  const doors=[cx-5,cx+5].flatMap(x=>[{x,y},{x,y:y+1}]);for(const p of doors){f.walls[p.y][p.x]=1;f.props[p.y][p.x]=1;}
  const order=[0,1,2,3];for(let i=3;i>0;i--){const j=rnd(i+1);[order[i],order[j]]=[order[j],order[i]];}
  const id='resonance-'+n,host=f.rooms[hostIndex];puzzles.push({id,order,progress:0,solved:false,doors,room:f.rooms.length-1});
  for(let i=0;i<4;i++)fixture(id+'-crystal-'+i,'mana_crystal',m.symbols[i]+' resonance crystal','sprManaCrystal'+i,host.cx-3+i*2,host.cy-3,{puzzle:id,symbol:i,lit:false});
  fixture(id+'-inscription','mana_detail','Read the survey inscription','sprManaTablet',host.cx-3,host.cy+3,{text:'The crystals answer in this order: '+order.map(i=>m.symbols[i]).join(', then ')+'. Touch each once. A wrong note simply starts the sequence again.'});
  for(const x of [cx-5,cx+5])fixture(id+'-door-'+x,'mana_door','Resonance barrier','sprManaDoor',x,y,{puzzle:id});
  f.chests.push({id:'resonance-cache-'+n,x:r.cx,y:r.cy-1,requires_resonance:id});
  const seam={id:'seam-'+n,x:r.cx,y:r.cy+1};seams.push(seam);f.decorations.push({...seam,sprite:'sprManaSeam',solid:false});
  fixture(id+'-warning','mana_detail','Warning: resonance seam','sprManaTablet',r.cx+2,r.cy-1,{text:'The cracked stone below releases a pressure pulse when crossed: +12 bladder pressure, +6 bowel pressure, once per visitor this edition. Walk around the marked seam to avoid it.'});
 }
 const sanctuary=chamber(75,56,7,9,'prism-sanctuary');hall([[65,56],[75,56]]);
 fixture('guardian-warning','mana_detail','The Unbound Prism','sprManaTablet',70,55,{text:'Something vast sings beyond this passage. The guardian is optional; both surface routes remain open. Only those who participate in its defeat may claim its pendant.'});open(70,55);
 const occupied=new Set([...f.fixtures,...f.exits,...Object.values(f.entries),...f.chests,...seams].map(key)),safe=p=>f.safeRooms.some(r=>inside(r,p.x,p.y));
 function take(r){const cells=[];for(let y=r.y+1;y<r.y+r.h-1;y++)for(let x=r.x+1;x<r.x+r.w-1;x++)if(walkable(f,x,y)&&!safe({x,y})&&!occupied.has(x+','+y))cells.push({x,y});if(!cells.length)throw Error('Mana cave content has no space');const p=cells[rnd(cells.length)];occupied.add(key(p));return p;} // Content identities and claims remain stable for an edition.
 const combatRooms=f.rooms.slice(0,12).filter(r=>!safe({x:r.cx,y:r.cy}));
 for(let i=0;i<6;i++)f.chests.push({id:'mana-cache-'+i,...take(combatRooms[i%combatRooms.length])});
 for(let i=0;i<8;i++)f.pickups.push({id:'mana-supply-'+i,kind:i%2?'potion':'food',sprite:'sprItem',...take(combatRooms[i%combatRooms.length])});
 for(let i=0;i<16;i++){const r=combatRooms[i%combatRooms.length],pool=m.enemy_pools[r.type],type=pool[rnd(pool.length)],p=take(r);f.enemies.push({id:'mana-enemy-'+i,type,...p,spawn:{...p},definition:structuredClone(data.enemies[type]),roaming:true,engaged:null,respawnAt:0});}
 const p=take(sanctuary),type='unbound_prism';f.enemies.push({id:'unbound-prism',type,...p,spawn:{...p},definition:structuredClone(data.enemies[type]),roaming:false,engaged:null,respawnAt:0});
 f.chests.push({id:'prismatic-pendant',...take(sanctuary),item_id:'prismatic_pendant',rarity:'rare',requires_encounter:'unbound-prism'});
 for(const reward of [...f.chests,...f.pickups])reward.no_enchant=true;
 for(const r of combatRooms)for(let i=0;i<3;i++)f.decorations.push({...take(r),sprite:r.type==='tapped'?'sprManaConduit':r.type==='buried'?'sprManaMemorial':'sprManaCluster',solid:false});
 const avoid=[...f.exits,...Object.values(f.entries)],interactions=f.fixtures,eligible=[],mist=Array.from({length:H},()=>Array(W).fill('0'));
 for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++)if(walkable(f,x,y)&&!safe({x,y})&&!avoid.some(p=>Math.max(Math.abs(p.x-x),Math.abs(p.y-y))<=3)&&!interactions.some(p=>Math.abs(p.x-x)+Math.abs(p.y-y)<=1))eligible.push({x,y});
 const centers=Array.from({length:12},()=>eligible[rnd(eligible.length)]);
 eligible.sort((a,b)=>Math.min(...centers.map(p=>(p.x-a.x)**2+(p.y-a.y)**2))-Math.min(...centers.map(p=>(p.x-b.x)**2+(p.y-b.y)**2))||a.y-b.y||a.x-b.x); // Persist coherent mist pockets rather than isolated random pixels.
 const count=Math.ceil(eligible.length*m.mist_coverage);for(const p of eligible.slice(0,count))mist[p.y][p.x]='1';
 f.mist={version:1,rows:mist.map(r=>r.join('')),tiles:count};
 f.manaCaves={version:1,regions,edges,puzzles,seams,refuges:[refuge],lighting:m.lighting};
 validateFullDungeon(f);return f;
} // Seeded generation is shared by workers, previews, and the live service.

export function manaInteract(f,fix,revision){
 if(fix.kind==='mana_detail')return fix.text;
 const q=f.manaCaves.puzzles.find(q=>q.id===fix.puzzle);if(!q)fail('Unknown resonance puzzle.');
 if(fix.kind==='mana_door')return q.solved?'The resonance passage is open.':'The survey inscription describes the crystal sequence.';
 if(revision!==f.mechanismRevision)fail('The crystals changed. Refresh before acting.');
 if(q.solved)return 'The crystals remain in harmony. The passage stays open.';
 const correct=fix.symbol===q.order[q.progress];q.progress=correct?q.progress+1:0;q.solved=q.progress===4;
 for(const crystal of f.fixtures.filter(v=>v.kind==='mana_crystal'&&v.puzzle===q.id)){crystal.lit=q.order.slice(0,q.progress).includes(crystal.symbol);crystal.sprite='sprManaCrystal'+crystal.symbol+(crystal.lit?'Lit':'');}
 if(q.solved){for(const p of q.doors){f.walls[p.y][p.x]=0;f.props[p.y][p.x]=0;}for(const door of f.fixtures.filter(v=>v.kind==='mana_door'&&v.puzzle===q.id)){door.solid=false;door.name='Open resonance passage';door.sprite='sprManaDoorOpen';}f.geometryVersion++;}
 f.mechanismRevision++;
 return q.solved?'The crystals sing together. A cache and connecting passage open.':correct?'The crystal answers with a clear note.':'The notes fade. Begin the sequence again.';
} // Revision checks serialize shared interactions; solved barriers never close.

export function manaStep(f,s,personal,x,y,now=Date.now()){
 if(!f.manaCaves||s.run||s.dungeonScene||s.pendingDefeat)return;
 const seam=f.manaCaves.seams.find(p=>p.x===x&&p.y===y);if(!seam)return;
 personal.manaSeams??=[];if(personal.manaSeams.includes(seam.id))return;personal.manaSeams.push(seam.id);
 const p=s.loadout.player_info;p.wet=Math.min(100,(p.wet??0)+12);if(!s.loadout.world?.wet_only_mode)p.tum=Math.min(100,(p.tum??0)+6);
 s.dive.lootNotice='The resonance seam releases a sudden pressure pulse.';s.dive.lootNoticeAt=now;
} // Existing authoritative movement receipts and ordinary accident resolution own the effect.
