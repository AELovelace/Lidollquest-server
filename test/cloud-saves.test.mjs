import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createCloudSaves,CLOUD_CHUNK} from '../server/cloud-saves.mjs';
test('cloud saves stage privately, resume chunks, enforce owners/revisions and retain three committed versions',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,revision INTEGER)');db.prepare('INSERT INTO quest_characters VALUES (?,?,?)').run('char','owner',8);let now=100;
 let api=createCloudSaves(db,{now:()=>now});
 const prepare=(id,base,padding='')=>{const data=Buffer.from(JSON.stringify({online_character:'char',online_account:'owner',version:33,player_info:{name:'Doll',level:3},inventory:[],room_data:{},current_room:'Room5_Town',padding}));return {data,input:{action:'begin',request_id:id,character_id:'char',base_revision:base,bytes:data.length,checksum:createHash('sha1').update(data).digest('hex')}};};
 const upload=p=>{api.act('owner',p.input);for(let part=0;part<Math.ceil(p.data.length/CLOUD_CHUNK);part++)api.act('owner',{...p.input,action:'chunk',part,data:p.data.subarray(part*CLOUD_CHUNK,(part+1)*CLOUD_CHUNK).toString('base64')});return api.act('owner',{...p.input,action:'commit'});};
 try{
  const p=prepare('first',0,'a'.repeat(CLOUD_CHUNK));api.act('owner',p.input);assert.deepEqual(api.read('owner',{}).saves,[]);
  assert.throws(()=>api.act('owner',prepare('second-device',0).input),e=>e.code==='cloud_upload_busy');
  assert.throws(()=>api.act('other',p.input),/not found/);
  assert.throws(()=>api.act('owner',{...p.input,action:'commit'}),/incomplete/);
  api.act('owner',{...p.input,action:'chunk',part:0,data:p.data.subarray(0,CLOUD_CHUNK).toString('base64')});
  api=createCloudSaves(db,{now:()=>now});assert.deepEqual(api.act('owner',p.input).parts,[0]);
  assert.equal(upload(p).revision,1);assert.equal(upload(p).revision,1);
  const chunk=api.read('owner',{character_id:'char',part:'0',revision:'1'});assert.equal(Buffer.from(chunk.data,'base64').length,CLOUD_CHUNK);
  assert.throws(()=>upload(prepare('conflict',0)),e=>e.code==='cloud_conflict');
  for(let v=1;v<=3;v++)assert.equal(upload(prepare('next'+v,v)).revision,v+1);
  assert.deepEqual(api.read('owner',{character_id:'char',history:'1'}).versions.map(v=>v.revision),[4,3,2]);
  assert.throws(()=>api.read('other',{character_id:'char'}),/not found/);
  const stale=prepare('expired',4);api.act('owner',stale.input);now+=86400001;assert.throws(()=>api.act('owner',{...stale.input,action:'commit'}),/expired/);
  const corrupt=prepare('bad',4);corrupt.input.checksum='0'.repeat(40);assert.throws(()=>upload(corrupt),/checksum/);
  assert.equal(api.read('owner',{character_id:'char'}).revision,4);
 }finally{db.close();}
});

test('private uploads survive a database restart and reject oversized, credential-bearing and mismatched saves',()=>{
 mkdirSync('artifacts',{recursive:true});const filename=resolve(mkdtempSync(resolve('artifacts/cloud-')),'quest.sqlite');
 let db=new DatabaseSync(filename);db.exec('CREATE TABLE quest_characters(id TEXT PRIMARY KEY,owner TEXT,revision INTEGER)');db.prepare('INSERT INTO quest_characters VALUES (?,?,?)').run('char','owner',8);
 let api=createCloudSaves(db,{maxBytes:CLOUD_CHUNK});const save={online_character:'char',online_account:'owner',version:33,player_info:{name:'Doll',level:3},inventory:[],room_data:{},current_room:'Room5_Town'};
 const begin=(id,value)=>{const data=Buffer.from(JSON.stringify(value)),input={action:'begin',character_id:'char',request_id:id,base_revision:0,bytes:data.length,checksum:createHash('sha1').update(data).digest('hex')};api.act('owner',input);api.act('owner',{...input,action:'chunk',part:0,data:data.toString('base64')});return input;};
 try{
  const input=begin('resume',save);db.close();db=new DatabaseSync(filename);api=createCloudSaves(db,{maxBytes:CLOUD_CHUNK});assert.equal(api.read('owner',{}).saves.length,0);
  assert.deepEqual(api.act('owner',input).parts,[0]);assert.equal(api.act('owner',{...input,action:'commit'}).revision,1);
  assert.throws(()=>api.act('owner',{...input,request_id:'oversized',bytes:CLOUD_CHUNK+1,base_revision:1}),/metadata/);
  db.prepare('DELETE FROM quest_cloud_versions').run();
  for(const [id,value] of [['secret',{...save,access_token:'secret'}],['wrong-owner',{...save,online_account:'someone-else'}],['invalid',{...save,inventory:null}],['shared-room',{...save,current_room:'rmOnlineDive'}]]){
   const bad=begin(id,value);assert.throws(()=>api.act('owner',{...bad,action:'commit'}),e=>e.status===400);assert.equal(api.read('owner',{}).saves.length,0);
   db.exec('DELETE FROM quest_cloud_chunks; DELETE FROM quest_cloud_uploads'); // Each corrupt-file scenario starts with its own private transfer.
  }
 }finally{db.close();}
});
