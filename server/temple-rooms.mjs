// The five temples (FAITH_DESIGN.md). Four stand on town squares as annex rooms (kind 'temple'); Sable's is a fixed room in
// Rose Court's Castle district (hub-districts.mjs def.temple). Every temple holds its god's altar (kind 'altar': faith_pray),
// the holy person (npc, service 'dedicate': faith_dedicate) and pews. Authored with tileLBCInterior indices like the other rooms.
import {GODS} from './faith-blessing.mjs';

export const TEMPLE_ROOM_EXIT=Object.freeze({x:0,y:6,w:1,h:2,style:'gap',side:'left'}); // Every temple annex leaves through its left wall.
const cap=s=>s[0].toUpperCase()+s.slice(1);
const THEME={orthain:{floor:9,wall:16},sula:{floor:31,wall:11},nyx:{floor:34,wall:13},sable:{floor:32,wall:18},orin:{floor:36,wall:14}}; // Stone for Orthain, soft pink for Sula, polished for Nyx, dark for Sable, rough boards for Orin.

export const altarFixture=(godId,x,y)=>({id:'altar',name:'Altar of '+GODS[godId].name,kind:'altar',god:godId,sprite:'sprAltar'+cap(godId),x,y,span_w:2,span_h:1,solid:true}); // Pray here: your standing with this god.
export const priestFixture=(godId,x,y)=>{const g=GODS[godId];return {id:'priest',name:g.priest.name,kind:'npc',avatar:g.priest.avatar,service:'dedicate',god:godId,x,y,span_w:1,span_h:1,solid:true,line:g.priest.line};}; // Swear yourself to this god.
export const pewFixture=(id,x,y)=>({id,name:'',kind:'scenery',sprite:'sprTemplePew',x,y,span_w:2,span_h:1,solid:true});
export const brazierFixture=(id,x,y)=>({id,name:'',kind:'scenery',sprite:'sprTempleBrazier',x,y,span_w:1,span_h:1,solid:true});

export function templeRoom(godId){ // 20x14: the altar at the head of the nave, the priest beside it, two banks of pews, braziers in the corners.
 const W=20,H=14,t=THEME[godId]??THEME.orin;
 const walls=Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>x===0||y===0||x===W-1||y===H-1?1:0));
 for(let dy=0;dy<TEMPLE_ROOM_EXIT.h;dy++)walls[TEMPLE_ROOM_EXIT.y+dy][0]=0; // The doorway.
 const floors=walls.map(row=>row.map(w=>w?0:t.floor)),decorTiles=walls.map(row=>row.map(()=>0));
 for(let x=1;x<W-1;x++)for(const y of [6,7])floors[y][x]=35; // The aisle from the door to the altar's nave.
 for(let y=2;y<H-1;y++)floors[y][9]=floors[y][10]=35; // The nave itself.
 decorTiles[3][9]=decorTiles[3][10]=25; // A rug before the altar.
 const wallTiles=walls.map((row,y)=>row.map((w,x)=>w?((x+y)%3===0?t.wall+1:t.wall):0));
 const pews=[];for(const y of [9,11])for(const x of [4,6,13,15])pews.push(pewFixture(`pew-${x}-${y}`,x,y));
 return {width:W,height:H,spawn:{x:1,y:7},exit:{...TEMPLE_ROOM_EXIT},walls,floors,wallTiles,decorTiles,tilesets:{wall:'tileLBCInterior',floor:'tileLBCInterior',decor:'tileLBCInterior'},authored:true,temple:godId,
  fixtures:[altarFixture(godId,9,2),priestFixture(godId,12,3),...pews,brazierFixture('brazier-1',1,1),brazierFixture('brazier-2',18,1),brazierFixture('brazier-3',1,12),brazierFixture('brazier-4',18,12)]};
}
