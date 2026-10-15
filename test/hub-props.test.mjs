import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createQuestService} from '../server/service.mjs';

// 2026-10-15: the Map Editor's Terrain brush "Prop" saved a blocked cell in hubs, but hub movement only checked walls and fixtures.
test('a prop painted in a hub room blocks walking there on the server, like a wall',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-props-')),filename=join(dir,'quest.sqlite');let time=Date.parse('2026-10-15T12:00:00Z');
 const token='p'.repeat(43);let id;
 const service=createQuestService({filename,walletClient:{authenticate:async t=>({owner:t,id:t,client:'lidollquest',coins:0})},now:()=>time,authTtlMs:0,log:()=>{}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
 const read=async()=>(await fetch(base+'/zones?character_id='+id,{headers:{Authorization:'Bearer '+token}})).json();
 const send=async input=>{time+=1000;const r=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:r.status,data:await r.json()};};
 const command=async(action,extra={})=>{const s=await read();return send({action,request_id:randomUUID(),controller:'w',character_id:id,revision:s.character.revision,...extra});};
 try{
  id=(await send({action:'create',name:'Walker',request_id:randomUUID(),controller:'w'})).data.character.id;
  const zone='utopia-arcanum-tower';
  await command('enter',{zone:'utopia-arcanum',quest_version:1,content_version:1,flow_version:1,follower_version:1,loadout:{player_info:{playerHealth:50,playerHealthMax:50},inventory:[]}});
  const lobby=await read(),door=lobby.zones.find(z=>z.id===lobby.zone).portals.find(p=>p.target===zone);
  service.db.prepare('UPDATE quest_presence SET x=?,y=? WHERE character_id=?').run(door.x,door.y,id);
  assert.equal((await command('hub_visit',{zone})).status,200);
  service.db.prepare('UPDATE quest_presence SET x=12,y=15 WHERE character_id=?').run(id);
  const view=service.zones.world.paintMap(zone);
  service.db.exec('BEGIN IMMEDIATE');service.zones.world.act({action:'world_patch_apply',zone,edition:view.edition,revision:view.revision,patch_revision:view.patch?.revision??0,ops:[{kind:'cells',cells:[{x:13,y:15,prop:1}]}]});service.db.exec('COMMIT');
  const room=(await read()).zones.find(z=>z.id===zone);assert.equal(room.props?.[15]?.[13],1,'the room definition the client collides with carries the prop');
  const moved=await command('move',{direction:'east'});
  assert.deepEqual([moved.data.position?.x??(await read()).position.x,(await read()).position.y],[12,15],'the prop cell stops the walk');
 }finally{await new Promise(r=>service.server.close(r));rmSync(dir,{recursive:true,force:true});}
});
