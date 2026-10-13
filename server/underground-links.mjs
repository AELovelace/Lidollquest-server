import {fullDungeons} from './full-dungeons.mjs';
import {CATACOMBS,reconcileCatacombReservations} from './catacombs.mjs';

const route=id=>fullDungeons.find(d=>d.config.zone_id===id);
const links=d=>[...(d?.config.endpoints??[]),...(d?.config.catacombs?.reserved??[])];
export function undergroundLinked(a,b){
 const from=route(a),to=route(b);
 return !!from?.config.enabled&&!!to?.config.enabled&&links(from).some(e=>e.zone===b)&&links(to).some(e=>e.zone===a);
} // Only authored reciprocal dungeon connections can transfer a character.

export function upgradeUndergroundFloor(f,ready){
 let changed=false;
 if(['castle-dungeon','littlebig-sewers'].includes(f.route)&&ready(CATACOMBS,f)){
  for(const e of f.exits??[])if(e.zone==='arcadia-foundry'){e.zone=CATACOMBS;e.name='Memorial Galleries';changed=true;}
  if(f.entries?.['arcadia-foundry']){f.entries[CATACOMBS]=f.entries['arcadia-foundry'];delete f.entries['arcadia-foundry'];changed=true;}
  if(changed){f.connectionVersion=1;f.geometryVersion=(f.geometryVersion??0)+1;}
 }
 return reconcileCatacombReservations(f,ready)||changed;
} // Saved exits retain their cells, terrain, encounter identities and personal claims.

export function normalizeUndergroundReturn(s){
 const v=s.dive;if(!v||!['castle-dungeon','littlebig-sewers'].includes(v.route))return false;
 const home=v.route==='castle-dungeon'?'princess-rose-garden':'littlebig-clockwork';let changed=false;
 for(const k of ['returnZone','hubOrigin'])if(v[k]==='arcadia-foundry'){v[k]=home;changed=true;}
 if(v.origin==='arcadia-foundry'){v.origin=CATACOMBS;changed=true;}
 if(changed)v.hubEntryZone=v.zone;
 return changed;
} // Old Arcadia visits finish in place and receive a valid home only when they leave.
