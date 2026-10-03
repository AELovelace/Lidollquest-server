import {DatabaseSync} from 'node:sqlite';
import {cacheStatements} from './statement-cache.mjs';

export function openZoneSnapshotDatabase(filename){
 const db=new DatabaseSync(filename,{readOnly:true});
 const execute=db.exec.bind(db),prepare=db.prepare.bind(db);let bootstrap=true;
 db.exec=sql=>{if(!bootstrap)return execute(sql);}; // The coordinator alone installs schemas and runs startup migrations; shared module constructors only discover existing tables here.
 db.prepare=sql=>{const statement=prepare(sql);return new Proxy(statement,{get(target,key){if(key==='run')return (...args)=>bootstrap?{changes:0,lastInsertRowid:0}:target.run(...args);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
 cacheStatements(db);
 return {db,ready(){bootstrap=false;}}; // After construction, SQLite itself rejects every write, even if a future snapshot accidentally calls a mutating helper.
}
