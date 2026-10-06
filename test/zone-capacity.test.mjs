import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {parseZoneCapacity} from '../server/zone-capacity.mjs';
import {createQuestZones,questZones} from '../server/zones.mjs';

test('zone capacity defaults to 256 and rejects malformed environment values',()=>{
 for(const value of [undefined,null,'','  '])assert.equal(parseZoneCapacity(value),256);
 for(const value of [1,64,128,256,' 512 '])assert.equal(parseZoneCapacity(value),Number(value));
 for(const value of [0,-1,1.5,'no','128players','1e3','Infinity','9007199254740992'])assert.throws(()=>parseZoneCapacity(value),/QUEST_ZONE_CAPACITY/);
});

for(const capacity of [256,128])test(`zone admission and peer visibility share capacity ${capacity}`,()=>{
 const db=new DatabaseSync(':memory:');let owner='alice';
 const zones=createQuestZones(db,{...(capacity===256?{}:{zoneCapacity:capacity}),now:()=>1000000,grant:()=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{}});
 const act=(action,c,extra={})=>zones.act(owner,{action,character_id:c?.id,revision:c?.revision,controller:'capacity-test',request_id:randomUUID(),...extra}); // Exercise the normal admission path with deterministic active leases.
 try{
  let c=act('create',null,{name:'Alice'}).character;c=act('enter',c,{zone:questZones[0].id}).character;
  const character=db.prepare('INSERT INTO quest_characters(id,owner,name,created,revision,state,creation_id) SELECT ?,?,name,created,revision,state,creation_id FROM quest_characters WHERE id=?');
  const presence=db.prepare('INSERT INTO quest_presence(owner,character_id,zone,grant_id,controller,x,y,seen,moved) SELECT ?,?,zone,grant_id,controller,x,y,seen,moved FROM quest_presence WHERE character_id=?');
  for(let i=1;i<capacity;i++){const id='crowd-'+i;character.run(id,id,c.id);presence.run(id,id,c.id);} // Populate the remaining seats without hundreds of unrelated creation requests.
  assert.equal(zones.read(owner,c.id).peers.length,capacity,'all admitted players are visible, including those beyond 64');
  c=act('enter',c,{zone:questZones[0].id}).character; // An existing occupant may reconnect when the zone is full.
  owner='overflow';const outsider=act('create',null,{name:'Overflow'}).character;
  assert.throws(()=>act('enter',outsider,{zone:questZones[0].id}),/full/);
  db.prepare('UPDATE quest_presence SET seen=0 WHERE owner=?').run('crowd-1');
  const admitted=act('enter',outsider,{zone:questZones[0].id});assert.equal(admitted.peers.length,capacity,'an expired lease frees one seat');
 }finally{zones.close();db.close();}
});
