// GM fixture moves (Map Editor "Select / move" on hubs): furniture and services such as the vanity mirror, the cauldron
// and its crafting stations, beds, changers and toilets. They are stored as `fixture` ops in the floor patch layer
// (floor-patches.mjs) but applied here, after zones.mjs has decorated the room (crafting stations, hubMirrors), because
// several of these fixtures do not exist yet when the patch layer runs. Each move keeps the fixture's id, so every
// service check (beside a cauldron, at a mirror) follows it. A move that no longer fits the layout (a monthly district
// reroll, a later wall) is skipped and reported, and the fixture stays where the room put it.
import {reachableTiles} from './crafting-service.mjs';
import {cauldronFixture,toiletFixture,changerFixture} from './hub-districts.mjs';
import {MIRROR_SPRITE} from './hub-mirrors.mjs';
import {readFileSync} from 'node:fs';

// Furniture a GM can place on a hub from the Map Editor (fixture "add" ops, applied by floor-patches.mjs before decoration).
// Each entry builds the same fixture the hub generators use, so the client and every service check treat it like the real thing.
const strip=({id,x,y,...rest})=>rest; // Templates carry no id or position: the patch op supplies both.
const BEDS=JSON.parse(readFileSync(new URL('./hub-data.json',import.meta.url),'utf8')).beds??[];
export const FURNITURE={
 vanity:{label:'Vanity mirror (free Wardrobe saves)',make:()=>({name:'Vanity Mirror',kind:'mirror',sprite:MIRROR_SPRITE,span_w:2,span_h:2,solid:true})},
 cauldron:{label:'Cauldron (brewing; a forge, sewing table and kitchen appear beside the first one if the hub has none)',make:()=>strip(cauldronFixture(0,0))},
 kitchen:{label:'Kitchen (cooking)',make:()=>({name:'Kitchen',kind:'kitchen',span_w:1,span_h:1,solid:true})},
 forge:{label:'Forge (smithing)',make:()=>({name:'Forge',kind:'forge',span_w:1,span_h:1,solid:true})},
 sewing_table:{label:'Sewing table (tailoring)',make:()=>({name:'Sewing Table',kind:'sewing_table',span_w:1,span_h:1,solid:true})},
 toilet:{label:'Toilet',make:()=>strip(toiletFixture('',0,0))},
 outhouse:{label:'Outhouse',make:()=>strip(toiletFixture('',0,0,'outhouse'))},
 changer:{label:'Auto-Changing Station',make:()=>strip(changerFixture('',0,0))},
 bank:{label:'Bank counter',make:()=>({name:'Bank',kind:'bank',span_w:1,span_h:1,solid:true})},
 dumpster:{label:'Dumpster',make:()=>({name:'Dumpster',kind:'dumpster',sprite:'sprCityTrashCan',span_w:1,span_h:1,solid:true})},
 ...Object.fromEntries(BEDS.map(bed=>['bed:'+bed.id,{label:'Bed: '+bed.name,make:()=>({name:bed.name,kind:'bed',bed:bed.id,sprite:bed.sprite,span_w:1,span_h:1,solid:true})}])) // Descriptor beds: the client applies that campaign bed's rest rules (scrOnlineHubs).
};
export const furnitureFixture=(key,id,x,y)=>{const t=FURNITURE[key];return t?{...t.make(),id,x,y}:null;};
export const furnitureCatalog=()=>Object.entries(FURNITURE).map(([key,t])=>{const f=t.make();return {key,label:t.label,kind:f.kind,sprite:f.sprite??'',style:f.style??'',bed:f.bed??'',span_w:f.span_w??1,span_h:f.span_h??1};}); // For the Map Editor's Place tool (/gm/content).

export const MOVABLE_FIXTURES=new Set(['bed','toilet','changer','cauldron','reagents','forge','sewing_table','kitchen','mirror','altar','bank','dumpster']); // Not shops or NPCs: merchants belong to storefronts and residents to their stories.
const SERVICES=new Set([...MOVABLE_FIXTURES,'shop','npc','pad','curse-remover']); // Fixtures a player must be able to stand beside.
const key=(x,y)=>x+','+y;
const footprint=f=>{const cells=[];for(let dy=0;dy<(f.span_h??1);dy++)for(let dx=0;dx<(f.span_w??1);dx++)cells.push({x:f.x+dx,y:f.y+dy});return cells;};
const beside=(reach,f)=>footprint(f).some(c=>reach.has(key(c.x,c.y))||[[0,-1],[-1,0],[1,0],[0,1]].some(([dx,dy])=>reach.has(key(c.x+dx,c.y+dy)))); // On or orthogonally next to any tile of it.

export function fixtureMoveProblem(z,fixture,x,y){ // null when the fixture may stand with its top-left on x,y; otherwise the reason, in GM words.
 if(!Number.isInteger(x)||!Number.isInteger(y))return 'Choose a whole tile.';
 const w=fixture.span_w??1,h=fixture.span_h??1;
 if(x<1||y<1||x+w>(z.width??20)-1||y+h>(z.height??12)-1)return 'It must sit inside the outer wall.';
 const others=(z.fixtures??[]).filter(f=>f!==fixture),moved={...fixture,x,y},cells=footprint(moved);
 const lifted=new Set(reachableTiles({...z,fixtures:others}).map(p=>key(p.x,p.y))); // Floor a player could reach with the fixture picked up.
 if(!cells.every(c=>lifted.has(key(c.x,c.y))))return 'Every tile under it must be open floor a player can reach.';
 const doors=[z.spawn,z.entrance,z.exit,...(z.portals??[]),...(z.exits??[])].filter(Boolean);
 if(cells.some(c=>doors.some(p=>Math.abs(p.x-c.x)+Math.abs(p.y-c.y)<=1)))return 'Keep it off doorways, pads and the arrival tile.';
 if(fixture.solid===false)return null; // Walk-through fixtures cannot block anyone.
 const before=reachableTiles(z),after=new Set(reachableTiles({...z,fixtures:[...others,moved]}).map(p=>key(p.x,p.y))),under=new Set(cells.map(c=>key(c.x,c.y)));
 if(before.some(p=>!under.has(key(p.x,p.y))&&!after.has(key(p.x,p.y))))return 'That would cut off part of the room.';
 const reachBefore=new Set(before.map(p=>key(p.x,p.y)));
 for(const f of [...others,moved])if(SERVICES.has(f.kind)&&(f===moved||beside(reachBefore,f))&&!beside(after,f))return (f===moved?'It':(f.name||f.kind))+' could no longer be reached.';
 return null;
}

const cache=new Map(); // room layout + ops -> {moves, skipped}: the flood fills run once per layout, not per snapshot.
export function applyFixtureMoves(z,ops){ // -> the room with GM fixture moves applied; skipped moves join z.patchSkipped for the Map Editor.
 const live=(ops??[]).filter(op=>op.kind==='fixture'&&(op.op??'move')==='move'&&(!Array.isArray(op.editions)||op.editions.includes(z.edition)||op.editions.includes(z.district?.layoutKey)));
 if(!live.length)return z;
 const cacheKey=z.id+':'+(z.district?.layoutKey??'')+':'+JSON.stringify(live.map(op=>[op.id,op.match.id,op.to.x,op.to.y]))+':'+JSON.stringify((z.fixtures??[]).map(f=>[f.id,f.kind,f.x,f.y]));
 let hit=cache.get(cacheKey);
 if(!hit){
  const work={...z,fixtures:[...(z.fixtures??[])]},moves={},skipped=[];
  for(const op of live){ // In order, so a fixture moved twice ends where the last move put it.
   const i=work.fixtures.findIndex(f=>f.id===op.match.id&&f.kind===op.match.kind);
   if(i<0||!MOVABLE_FIXTURES.has(work.fixtures[i].kind)){skipped.push({id:op.id,reason:'No '+op.match.kind+' "'+op.match.id+'" in this layout.'});continue;}
   const problem=fixtureMoveProblem(work,work.fixtures[i],op.to.x,op.to.y);if(problem){skipped.push({id:op.id,reason:(work.fixtures[i].name||op.match.kind)+': '+problem});continue;}
   work.fixtures[i]={...work.fixtures[i],x:op.to.x,y:op.to.y};moves[op.match.id]={x:op.to.x,y:op.to.y};
  }
  hit={moves,skipped};if(cache.size>200)cache.clear();cache.set(cacheKey,hit);
 }
 const fixtures=(z.fixtures??[]).map(f=>hit.moves[f.id]&&MOVABLE_FIXTURES.has(f.kind)?{...f,...hit.moves[f.id]}:f);
 return {...z,fixtures,...(hit.skipped.length?{patchSkipped:[...(z.patchSkipped??[]),...hit.skipped]}:{})};
}
