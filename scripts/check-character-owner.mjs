import {DatabaseSync} from 'node:sqlite';

// Read-only. Answers one question: does the account_id MommyBot sends own a character here?
// Usage: node scripts/check-character-owner.mjs <account_id> [database-path]
const wanted=(process.argv[2]??'').trim().toLowerCase();
const filename=process.argv[3]??process.env.LIDOLLQUEST_DB??'data/quest.sqlite';
const mask=value=>{
 const text=String(value??'');
 return text.length<=10?text.slice(0,2)+'...':text.slice(0,6)+'...'+text.slice(-4)+' ('+text.length+' chars)';
}; // Enough to compare two servers by eye, never enough to reuse.

let db=null;
try{
 db=new DatabaseSync(filename,{readOnly:true});
 const rows=db.prepare('SELECT owner,COUNT(*) AS characters FROM quest_characters GROUP BY owner ORDER BY characters DESC').all();
 console.log('Characters on this server are owned by '+rows.length+' account(s):');
 for(const row of rows)console.log('  '+mask(row.owner)+' - '+row.characters+' character(s)');
 if(!wanted)console.log('\nPass the account_id from MommyBot check-mmo-character.mjs to compare it against these.');
 else if(rows.some(row=>String(row.owner).toLowerCase()===wanted)){
  console.log('\nMATCH: that account_id owns characters here, so /lidollmmo should find them.');
  console.log('Look at account suspension and the deployed build instead.');
 }else{
  console.log('\nNO MATCH: no character here is owned by '+mask(wanted)+'.');
  console.log('If it is certainly the same tracker account, the two services are being handed different account_id');
  console.log('values for it. They ask the tracker with different client_id values (lidollquest vs lidollbot), so a');
  console.log('tracker that issues per-application account IDs produces exactly this. Compare the masked IDs above');
  console.log('against the one MommyBot printed before changing any configuration.');
 }
}catch(error){
 console.error('FAIL: could not read '+filename+' ('+(error.code??error.message)+').');
 console.error('Run as the game-server account from its release directory, or pass the database path.');
 process.exitCode=1;
}finally{ try{ db?.close(); }catch{ /* Nothing was modified, so a failed close changes no state. */ } }
