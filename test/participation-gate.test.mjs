import test from 'node:test';
import assert from 'node:assert/strict';
import {participationContext,participationSaysJoin} from '../server/participation-gate.mjs';

test('participation context bounds history and profile without copying private persona data',()=>{
 const body=participationContext({name:'Elowen',online:{persona:'secret story',participation:{role:'paladin',interests:['travel']}}},
  {message:'How are you?',playerName:'Doll',history:Array.from({length:8},(_,i)=>({role:i%2?'npc':'player',content:'x'.repeat(300)})),
   conversation:true,hired:true,nearbyNames:['Elowen','Astra']});
 assert.equal(body.recent_turns.length,4);assert.equal(body.recent_turns[0].text.length,240);
 assert.deepEqual(body.nearby_names,['Elowen','Astra']);assert.equal(body.candidate.role,'paladin');
 assert.equal(body.recent_turns[1].speaker,'Elowen');assert.equal(JSON.stringify(body).includes('secret story'),false);
});
for (const model of ['lidoll/decider-multitask-v2','lidoll/decider-multitask-v3']) test('gate accepts '+model+' and rejects mismatched release policies',()=>{
 const body={decision:'join',join:true,join_probability:.8,policy:'routing-participation-multitask-v1',model};
 assert.equal(participationSaysJoin(body),true);
 assert.equal(participationSaysJoin({...body,decision:'quiet',join:false,join_probability:.1}),false);
 for(const changes of [{policy:'participation-sociable-v1-schema_first'},{model:'lidoll/decider-chat-0-1'},{model:'unknown'},{join:false},{join_probability:1.1}]){
  assert.throws(()=>participationSaysJoin({...body,...changes}),/Invalid participation/);
 }
}); // Both known models remain usable during staggered upgrades and rollback.
test('gate requires a consistent response from the participation model',()=>{
 const body={decision:'join',join:true,join_probability:.75,policy:'participation-sociable-v1-schema_first',model:'lidoll/decider-chat-0-1'};
 assert.equal(participationSaysJoin(body),true);
 assert.equal(participationSaysJoin({...body,decision:'quiet',join:false,join_probability:.2}),false);
 for(const changes of [{join:false},{model:'lidoll/decider0-1'},{join_probability:NaN},{decision:'YES'},{policy:'game-chat-v3'}]){
  assert.throws(()=>participationSaysJoin({...body,...changes}),/Invalid participation/);
 }
});
