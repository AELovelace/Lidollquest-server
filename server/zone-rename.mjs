// Zone ids were renamed on 2026-09-25 so the id says what the zone is (see zone-categories.mjs): the eleven
// overworlds went from `dive-<name>` to `overworld-<name>`, and the four campaign full dungeons from `dive-<name>`
// to `dungeon-<name>`. Instanced Dives keep `dive-<name>`, and route ids (dustbreak-crossing, frostveil-taiga...)
// never changed. Two jobs live here:
//  1. migrateZoneIds(db): a one-time rewrite of every saved copy of the old ids (presence rows, chat areas,
//     character saves, placements, town maps, GM content...). It runs at service start, before anything reads them.
//  2. currentZoneId(id): older game clients and bookmarked GM links may still send an old id; it maps it forward.
const OVERWORLDS=['desert','tundra','taiga','high-desert','haunted-woods','autumnal-plains','farmstead','seafoam-coast','emberfall-caldera','obsidian-spa','spooky-mansion']; // Open wilderness maps.
const FULL_DUNGEONS=['castle-dungeon','auto-nursery','regression-school','regression-hospital']; // Campaign full dungeons (full-dungeons-data.json).
export const ZONE_RENAMES=Object.freeze(Object.fromEntries([...OVERWORLDS.map(name=>['dive-'+name,'overworld-'+name]),...FULL_DUNGEONS.map(name=>['dive-'+name,'dungeon-'+name])])); // old id -> new id, all fifteen.

export const currentZoneId=id=>typeof id==='string'?ZONE_RENAMES[id]??id:id; // A renamed zone's old id becomes its new one; anything else passes through untouched.

const MIGRATION='2026-09-25-zone-id-prefixes'; // Row name in schema_migrations once the rewrite has committed.
const SKIP=new Set(['gm_audit','schema_migrations']); // The audit log keeps the ids as they were when each action happened.
const quote=name=>'"'+name.replaceAll('"','""')+'"'; // SQL identifier quoting for table and column names read from the schema.
const text=value=>"'"+value.replaceAll("'","''")+"'"; // SQL string literal.

export function migrateZoneIds(db,{log=console.warn}={}){ // Returns the number of rows changed (0 when already applied or nothing to do).
 db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY,applied INTEGER NOT NULL)'); // One row per one-time data migration.
 if(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(MIGRATION))return 0; // Already done on this database.
 const pairs=Object.entries(ZONE_RENAMES);
 // Every form an id takes inside stored text: a JSON string ("dive-desert"), a JSON string inside a JSON string
 // (\"dive-desert\"), an id used as a key prefix ("dive-desert:npc"), and one between colons inside a key
 // ("visited:dive-castle-dungeon:boss"). The delimiters keep dive-high-desert and dive-desert apart, and never
 // touch unrelated words.
 const forms=pairs.flatMap(([from,to])=>[['"'+from+'"','"'+to+'"'],['\\"'+from+'\\"','\\"'+to+'\\"'],['"'+from+':','"'+to+':'],['\\"'+from+':','\\"'+to+':'],[':'+from+':',':'+to+':']]);
 const rewrite=column=>`CASE ${column} ${pairs.map(([from,to])=>`WHEN ${text(from)} THEN ${text(to)}`).join(' ')} ELSE ${forms.reduce((sql,[from,to])=>`replace(${sql},${text(from)},${text(to)})`,column)} END`; // Exact ids swap whole; ids inside JSON swap in place.
 const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().filter(t=>!SKIP.has(t.name)&&!/^CREATE VIRTUAL/i.test(t.sql??'')); // Real tables only.
 let changed=0;
 db.exec('BEGIN IMMEDIATE');
 try{
  for(const table of tables){
   const columns=db.prepare(`PRAGMA table_info(${quote(table.name)})`).all().filter(c=>/TEXT|CHAR|CLOB|^$/i.test(c.type??'')); // Text-affinity columns, including untyped ones.
   for(const c of columns){
    const column=quote(c.name);
    changed+=Number(db.prepare(`UPDATE ${quote(table.name)} SET ${column}=${rewrite(column)} WHERE typeof(${column})='text' AND (${pairs.map(([from])=>`${column} LIKE ${text('%'+from+'%')}`).join(' OR ')})`).run().changes); // Only rows that mention an old overworld id are rewritten (dive-quarters rows stay untouched).
   }
  }
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(MIGRATION,Date.now());
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;} // All or nothing: a half-renamed world would strand players between ids.
 if(changed)log('zone_rename_migrated',MIGRATION,changed+' rows');
 return changed;
}
