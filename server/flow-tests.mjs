import {withGameContext,contextualApi} from './game-context.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'flow_test_conflict'});};
const quote=name=>'"'+name.replaceAll('"','""')+'"';
export function createFlowTests(db,{flows,now,build}){
 const running=new Map();
 const row=id=>db.prepare('SELECT * FROM story_flow_tests WHERE id=?').get(id??'');
 function reap(){for(const [id,test] of running){if((row(id)?.expires??0)>now())continue;test.api.close();test.db.close();running.delete(id);}db.prepare('DELETE FROM story_flow_tests WHERE expires<=?').run(now());}
 function create(id,owner,overrides={},entry=null){reap();const definition=flows.testDefinition(id);const key=randomUUID();if(entry!==null&&!definition.flow.nodes.some(n=>n.id===entry&&['entry','npc_entry','flag_entry','objective_entry'].includes(n.type)))fail('Choose an entry block for this test.');definition.entry=entry;
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides)||Object.keys(overrides).length>512||Object.entries(overrides).some(([id,value])=>typeof value!=='boolean'||!flows.flags().some(f=>f.id===id&&!f.retired)))fail('Choose defined flags and boolean values for test overrides.');definition.flags={...overrides};
  if(db.prepare('SELECT COUNT(*) AS n FROM story_flow_tests WHERE owner=? AND expires>?').get(owner,now()).n>=5)fail('End an existing test first (five sessions per GM).');
  db.prepare('INSERT INTO story_flow_tests VALUES (?,?,?,?,?)').run(key,owner,'',JSON.stringify(definition),now()+1800000);return {id:key,expires:now()+1800000};
 }
 function selected(owner,character){reap();return db.prepare("SELECT * FROM story_flow_tests WHERE owner=? AND character_id=? AND expires>? ORDER BY expires DESC LIMIT 1").get(owner,character??'',now());}
 function dump(test){const tables={};for(const {name} of test.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='story_flow_tests'").all())tables[name]=test.db.prepare('SELECT * FROM '+quote(name)).all();return tables;}
 function restore(target,tables){target.exec('PRAGMA foreign_keys=OFF');target.exec('BEGIN');try{for(const [name,rows] of Object.entries(tables)){if(!target.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))continue;target.exec('DELETE FROM '+quote(name));for(const r of rows){const keys=Object.keys(r);target.prepare('INSERT INTO '+quote(name)+' ('+keys.map(quote).join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>r[k]));}}target.exec('COMMIT');}catch(e){target.exec('ROLLBACK');throw e;}target.exec('PRAGMA foreign_keys=ON');}
 function persist(record,test){const changes=test.db.prepare('SELECT total_changes() AS n').get().n;if(test.savedChanges===changes)return;const body=JSON.parse(record.body);body.tables=dump(test);body.coins=test.coins;db.prepare('UPDATE story_flow_tests SET body=? WHERE id=?').run(JSON.stringify(body),record.id);test.savedChanges=changes;}
 function instance(record){let test=running.get(record.id);if(test)return test;const body=JSON.parse(record.body),memory=new DatabaseSync(':memory:');test={db:memory,coins:body.coins??0};
  const context={};test.api=contextualApi(withGameContext(context,()=>build(memory,record.owner,()=>({coins:test.coins}),(_owner,currency,amount)=>{if(currency==='coins')test.coins+=amount;})),context);
  if(body.tables)restore(memory,body.tables);test.api.world.invalidate();running.set(record.id,test);return test;
 } // Every simulated service has its own SQLite database and a local wallet stub.
 function start(identity,c,input){if(!identity.gamemaster)fail('Only gamemasters can start isolated tests.');const record=row(input.test_code);if(!record||record.owner!==identity.owner||record.expires<=now())fail('This test code is missing or expired.');if(record.character_id&&record.character_id!==c.id)fail('This test belongs to another character.');
  const s=JSON.parse(c.state);if(s.run||s.pendingDefeat||s.pendingPurchase||s.dungeonScene||flows.active(c))fail('Finish the current interaction first.');
  const present=db.prepare('SELECT * FROM quest_presence WHERE character_id=?').get(c.id);if(!present||present.controller!==input.controller)fail('Enter this character with the current controller first.');
  const existing=selected(identity.owner,c.id);if(existing&&existing.id!==record.id)fail('End the current test first.');const test=instance(record),body=JSON.parse(record.body);
  if(!record.character_id){
   // Copy only this character and authored/world definitions; no real accounts, parties or receipts enter the sandbox.
   const copy={...c},state=JSON.parse(c.state);state.fullDungeon??={};state.fullDungeon.flags={...state.fullDungeon.flags,...body.flags};copy.state=JSON.stringify(state); // Overrides are written only to the sandbox copy.
   const tables={quest_characters:[copy],quest_presence:[{...present,grant_id:"flow-test",seen:now()}]};
   for(const name of ['world_content','world_content_history','world_assets','story_flag_definitions','world_placements','world_placement_maps','dive_editions','world_hub_maps','hub_district_editions','hub_district_current','hub_district_controls'])tables[name]=db.prepare('SELECT * FROM '+quote(name)).all();
   for(const name of ['dive_progress','online_quests','online_quest_claims','quest_item_origins','orb_reads','orb_visibility'])tables[name]=db.prepare('SELECT * FROM '+quote(name)+' WHERE character_id=?').all(c.id);
   for(const name of ['dive_editions','world_hub_maps'])for(const r of tables[name]){const map=JSON.parse(r.content);for(const foe of map.enemies??[])foe.engaged=null;r.content=JSON.stringify(map);}
   restore(test.db,tables);test.api.world.invalidate();test.api.world.testAssets(body.assets??[],identity.owner);test.api.world.flows.gm({action:'flow_publish',id:body.flow.id,revision:0,entry:body.flow},identity.owner);
   test.api.world.flows.beginTest(c.id,body.flow,body.entry);record.character_id=c.id;db.prepare('UPDATE story_flow_tests SET character_id=? WHERE id=?').run(c.id,record.id);persist(record,test);
  }
  return view(record,test.api.read('',c.id));
 }
 const view=(record,result)=>({...result,flowTest:{id:record.id,expires:record.expires,isolated:true}});
 function read(identity,id){const record=selected(identity.owner,id);if(!record)return null;if(!identity.gamemaster)fail('Your GM role is required to continue this test.');const test=instance(record);const result=test.api.read('',id);persist(record,test);return view(record,result);}
 function act(identity,input){const record=selected(identity.owner,input.character_id);if(!record)return null;if(input.test_session&&input.test_session!==record.id)fail('This test session changed. Refresh first.');if(!identity.gamemaster)fail('Your GM role is required to continue this test.');if(input.action==='flow_test_stop'){db.prepare('UPDATE story_flow_tests SET expires=? WHERE id=?').run(now(),record.id);const test=running.get(record.id);test?.api.close();test?.db.close();running.delete(record.id);return {ended:true};}
  const test=instance(record),result=test.api.act('',input);persist(record,test);return view(record,result);
 }
 return {create,start,read,act,close(){for(const test of running.values()){test.api.close();test.db.close();}running.clear();}};
}
