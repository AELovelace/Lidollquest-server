import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

test('64 maximum-sized custom rooms keep inactive geometry out of player snapshots',async()=>{
 const token='s'.repeat(43),service=createQuestService({log:()=>{},walletClient:{authenticate:async()=>({owner:'capacity',id:'session',client:'lidollquest',gamemaster:true,coins:0,scope:''})}});
 let current;
 try{
  await service.prepare();await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+service.server.address().port;
  const action=async(action,extra={})=>{const response=await fetch(base+'/zones/action',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),controller:'test',...(current?.character?{character_id:current.character.id,revision:current.character.revision}:{}),action,...extra})});current=await response.json();assert.equal(response.status,200,JSON.stringify(current));return current;};
  await action('create',{name:'Capacity'});
  await action('enter',{zone:'utopia-arcanum',combat_version:3,content_version:1,loadout:{player_info:{level:1,playerHealth:100,playerHealthMax:100},inventory:[]}});
  for(let i=0;i<8;i++){
   const id='capacity-'+i,rooms=Array.from({length:8},(_,n)=>({id:'room-'+n,name:'Room '+n,width:48,height:48}));
   service.zones.world.places.act({action:'world_place_save',id,revision:0,entry:{name:id,home:'utopia-arcanum',rooms}},'test');
   service.zones.world.places.act({action:'world_place_publish',id,revision:1},'test');
  }
  await action('gm_warp_zone',{zone:'utopia-arcanum-place-capacity-0-room-0'});
  const rooms=current.zones.filter(r=>r.id.includes('-place-capacity-'));
  assert.equal(rooms.length,64);assert.equal(rooms.filter(r=>r.walls.length).length,1);
  assert.ok(rooms.every(r=>!Object.hasOwn(r,'authoring')),'authoring history does not ride in player snapshots');
  const bytes=Buffer.byteLength(JSON.stringify(rooms)),inactive=Buffer.byteLength(JSON.stringify(rooms.filter(r=>!r.walls.length)));
  assert.ok(bytes<256*1024);assert.ok(inactive<64*1024);
  console.log('Custom-room snapshot budget:',JSON.stringify({rooms:64,activeDimensions:'48x48',roomBytes:bytes,inactiveBytes:inactive,totalResponseBytes:Buffer.byteLength(JSON.stringify(current))}));
 }finally{service.server.closeAllConnections();await new Promise(r=>service.server.close(r));}
});
