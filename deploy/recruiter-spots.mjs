// Read-only diagnostic: where each diamond recruiter stands on the LIVE saved floors, next to that floor's stairs/arrival tiles.
// Usage on the VM:  cd /opt/lidollquest-server/current && sudo -u lidollquest-server /usr/bin/node-24 deploy/recruiter-spots.mjs /var/lib/lidollquest-server/quest.sqlite
// Opens the database read-only, so it is safe while the server runs.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createFollowers,followerData} from '../server/followers.mjs';
import {diveData} from '../server/dive.mjs';
import {campaignDives} from '../server/hubs.mjs';
import {fullDungeons} from '../server/full-dungeons.mjs';
import {pathTo} from '../server/dive-generation.mjs';

const file=process.argv[2];if(!file){console.error('Pass the quest.sqlite path.');process.exit(1);} // Never guess the live database location.
const live=new DatabaseSync(file,{readOnly:true}); // Read-only handle: this script cannot change a single row.
const scratch=new DatabaseSync(':memory:'),followers=createFollowers(scratch); // Placement needs a followers instance; give it a throwaway DB, not the live one.
const mansion=JSON.parse(readFileSync(new URL('../server/spooky-mansion-data.json',import.meta.url),'utf8'));
const datasets=[diveData,...campaignDives,...fullDungeons,mansion]; // Every kind of home zone a recruiter can have.
const pt=p=>p?`(${p.x},${p.y})`:'-'; // Compact tile printer.
for(const [id,npc] of Object.entries(followerData)){
 const zone=npc.online.home_zone,data=datasets.find(d=>(d.config.zone_id??'dive-quarters')===zone); // Same lookup the placement test uses.
 if(!data){console.log(id,zone,'NO DATASET');continue;}
 const route=data.config.route,row=live.prepare('SELECT edition,content FROM dive_editions WHERE route=? AND depth=1 ORDER BY starts DESC,updated DESC LIMIT 1').get(route); // Newest floor, same order latest() uses.
 if(!row){console.log(id,zone,'route',route,'NO FLOOR');continue;}
 const f=JSON.parse(row.content),at=followers.placement(id,zone,f); // Exactly what snapshots show (minus GM placement occupancy).
 const steps=at&&f.entrance?pathTo(f,f.entrance,at,60)?.length??'unreachable':'-'; // Walking distance, not straight-line.
 console.log(`${id} | ${zone} | edition ${row.edition} | ${f.width}x${f.height} | recruiter ${pt(at)} (${steps} steps from entrance)`);
 console.log(`   entrance ${pt(f.entrance)}  spawn ${pt(f.spawn)}`);
 console.log(`   entries  ${Object.entries(f.entries??{}).map(([z,p])=>z+' '+pt(p)).join(', ')||'-'}`);
 console.log(`   exits    ${(f.exits??[]).map(e=>(e.zone??'?')+' '+pt(e)+(e.style?' '+e.style:'')).join(', ')||'-'}`);
 console.log(`   portals  ${(f.portals??[]).map(p=>(p.target??p.zone??'?')+' '+pt(p)).join(', ')||'-'}`);
}
live.close();scratch.close();
