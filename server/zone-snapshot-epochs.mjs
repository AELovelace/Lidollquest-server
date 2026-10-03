const domains={content:['world_content','world_content_history'],districts:['hub_district_editions','hub_district_current','hub_district_controls'],guilds:['quest_guilds','quest_guild_members','quest_guild_weeks'],tutor:['quest_tutor_settings']};

export function installZoneSnapshotEpochs(db){
 db.exec('CREATE TABLE IF NOT EXISTS zone_snapshot_epochs(domain TEXT PRIMARY KEY,revision INTEGER NOT NULL)');
 for(const [domain,tables] of Object.entries(domains)){
  db.prepare('INSERT OR IGNORE INTO zone_snapshot_epochs VALUES (?,0)').run(domain);
  for(const table of tables)for(const event of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS snapshot_epoch_${table}_${event} AFTER ${event} ON ${table} BEGIN UPDATE zone_snapshot_epochs SET revision=revision+1 WHERE domain='${domain}'; END`);
 }
} // Internal table names only. Epochs commit/roll back with the data change, so readers never combine a new cache marker with old data.
