import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createQuestService} from '../server/service.mjs';

// The GM panel's own Ambient Life tab (2026-10-15): separate from Companions, with its own tuning, status and export.
test('the Ambient Life tab has its own knobs; Companions no longer lists them',async()=>{
 const staff='s'.repeat(43),service=createQuestService({log:()=>{},walletClient:{authenticate:async token=>({owner:'staff',gamemaster:token===staff,client:'lidollquest',coins:0,scope:'social:read'})}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port,auth={Authorization:'Bearer '+staff};
 const action=async body=>{const r=await fetch(base+'/gm/action',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),...body})});return {status:r.status,data:await r.json()};};
 try{
  const page=await (await fetch(base+'/gm')).text();assert.match(page,/id="tab-ambient"/);assert.match(page,/id="panel-ambient"/);new Function(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const ambient=await (await fetch(base+'/gm/ambient',{headers:auth})).json();
  assert.equal(ambient.settings.ambient_enabled,'off');assert.ok(Object.keys(ambient.bounds).every(k=>k.startsWith('ambient_')));assert.ok(ambient.ambient,'live status is included');
  const companions=await (await fetch(base+'/gm/companions',{headers:auth})).json();
  assert.ok(!Object.keys(companions.bounds).some(k=>k.startsWith('ambient_')),'companion tuning no longer shows ambient knobs');assert.equal(companions.ambient,undefined);
  assert.equal((await action({action:'ambient_settings',values:{ambient_enabled:'on',ambient_chance:0.5}})).status,200);
  const after=await (await fetch(base+'/gm/ambient',{headers:auth})).json();assert.equal(after.settings.ambient_enabled,'on');assert.equal(after.ambient.enabled,true,'applies at once');
  assert.equal((await action({action:'ambient_settings',values:{slip_chance:0.5}})).status,400,'only ambient keys are accepted here');
 }finally{await new Promise(r=>service.server.close(r));}
});
