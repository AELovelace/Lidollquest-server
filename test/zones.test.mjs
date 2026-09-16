import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones,questZones} from '../server/zones.mjs';
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE wallet(owner TEXT PRIMARY KEY,coins INTEGER NOT NULL);CREATE TABLE awards(id TEXT PRIMARY KEY,owner TEXT,amount INTEGER)');let instant=1000000,owner='alice',token='token-a';
 const zones=createQuestZones(db,{now:()=>instant,roll:()=>0,grant:()=>({owner,id:token,client:'lidollquest'}),wallet:o=>({coins:db.prepare('SELECT coins FROM wallet WHERE owner=?').get(o)?.coins??0}),adjust:(o,asset,n,id)=>{db.prepare('INSERT INTO awards VALUES (?,?,?)').run(id,o,n);db.prepare('INSERT INTO wallet VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET coins=coins+excluded.coins').run(o,n);}});
 const command=(action,c,extra={})=>({action,character_id:c?.id,revision:c?.revision,controller:'window-a',request_id:randomUUID(),...extra});
 const act=(action,c,extra)=>{instant+=500;const input=command(action,c,extra);return zones.act(token,input);};
 return {db,zones,act,command,advance:ms=>instant+=ms,as:(name,id=name)=>{owner=name;token=id;}};
}
test('exactly one distinct zone per hub; character ownership, input and single-window control are enforced',()=>{
 const f=fixture();try{
  assert.equal(questZones.length,2);assert.equal(new Set(questZones.map(z=>z.hub)).size,2);
  const c=f.act('create',null,{name:'Alice'}).character;
  assert.throws(()=>f.act('enter',c,{zone:'honeydew-bramble'}),e=>e.status===400);
  let a=f.act('enter',c,{zone:questZones[0].id});assert.equal(a.position.x,10);
  assert.throws(()=>f.act('enter',a.character,{zone:questZones[0].id,controller:'other-window'}),e=>e.status===409);
  assert.throws(()=>f.act('move',a.character,{direction:'east',amount:999}),e=>e.status===400);
  assert.throws(()=>f.act('move',a.character,{direction:'__proto__'}),e=>e.status===400);
  a=f.act('move',a.character,{direction:'east'});assert.equal(a.position.x,11);
  f.as('bob');assert.throws(()=>f.zones.read('bob',c.id),e=>e.status===404);
 }finally{f.db.close();}
});
test('arena state determines rewards; retries, stale revisions and reconnects cannot duplicate them',()=>{
 const f=fixture();try{
  let c=f.act('create',null,{name:'Alice'}).character;c=f.act('enter',c,{zone:questZones[0].id}).character;c=f.act('start',c).character;
  assert.throws(()=>f.act('cashout',c),e=>e.status===409);
  while(c.run.phase==='fight')c=f.act('attack',c).character;
  assert.equal(c.run.pot,5);const input=f.command('cashout',c),result=f.zones.act('token-a',input);assert.equal(result.coins,5);
  assert.equal(f.zones.act('token-a',input).coins,5);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM awards').get().n,1);
  assert.equal(f.zones.act('token-a',Object.fromEntries(Object.entries(input).reverse())).coins,5,'Property order after a journal reload cannot change a receipt');
  assert.throws(()=>f.zones.act('token-a',{...input,request_id:randomUUID()}),e=>e.status===409);
  assert.throws(()=>f.act('start',result.character),e=>e.status===429);
 }finally{f.db.close();}
});
test('progressive fights apply handicaps, and forfeiting cannot bank unfinished rewards',()=>{
 const f=fixture();try{
  let c=f.act('create',null,{name:'Runner'}).character;c=f.act('enter',c,{zone:questZones[1].id}).character;c=f.act('start',c).character;
  while(c.run.phase==='fight')c=f.act('attack',c).character;
  c=f.act('continue',c).character;assert.equal(c.run.stage,2);assert.equal(c.run.attack,10);assert.equal(c.run.handicaps.length,1);
  c=f.act('flee',c).character;assert.equal(c.lastResult.coins,0);assert.equal(f.zones.read('token-a',c.id).coins,0);
  assert.throws(()=>f.act('attack',c),e=>e.status===409);
 }finally{f.db.close();}
});
test('presence and chat are zone-scoped, expire, and enforce message limits',()=>{
 const f=fixture();try{
  let a=f.act('create',null,{name:'Alice'}).character;a=f.act('enter',a,{zone:questZones[0].id}).character;
  for(let i=0;i<5;i++)a=f.act('chat',a,{text:'Hi #there\nfriend'}).character;
  assert.throws(()=>f.act('chat',a,{text:'Spam'}),e=>e.status===429);
  f.as('bob');let b=f.act('create',null,{name:'Bob'}).character;b=f.act('enter',b,{zone:questZones[0].id}).character;
  let view=f.zones.read('bob',b.id);assert.equal(view.peers.length,2);assert.equal(view.chat.length,5);assert.equal(view.chat[0].text.includes('#'),false);
  b=f.act('leave',b).character;b=f.act('enter',b,{zone:questZones[1].id}).character;view=f.zones.read('bob',b.id);assert.equal(view.peers.length,1);assert.equal(view.chat.length,0);
  f.advance(31000);assert.equal(f.zones.read('bob',b.id).zone,null);assert.throws(()=>f.act('heartbeat',b),e=>e.status===409);
 }finally{f.db.close();}
});
test('account-wide daily reward cap spans characters and zero rewards cannot be replayed tomorrow',()=>{
 const f=fixture();try{
  let c=f.act('create',null,{name:'Budget'}).character;c=f.act('enter',c,{zone:questZones[0].id}).character;
  f.db.prepare('INSERT INTO quest_reward_days VALUES (?,?,?)').run('alice',0,248);
  c=f.act('start',c).character;while(c.run.phase==='fight')c=f.act('attack',c).character;
  const input=f.command('cashout',c);assert.equal(f.zones.act('token-a',input).coins,2);
  f.advance(86400000);assert.equal(f.zones.act('token-a',input).coins,2);
 }finally{f.db.close();}
});
