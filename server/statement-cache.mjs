// Prepared-statement cache for node:sqlite. The server calls db.prepare(sql) inline at ~850 sites, and node:sqlite compiles
// the SQL afresh every time: compiling a small join costs ~24 µs while running it costs ~3 µs. Wrapping prepare() once per
// database lets every call site keep its inline SQL while reusing one compiled statement per distinct SQL text.
//
// Safe because every caller finishes a statement within one synchronous .get()/.all()/.run() (node:sqlite resets it after
// each call), and nothing uses .iterate() or per-statement settings.
// Schema changes: a reused statement keeps the column list it was compiled with (a cached `SELECT *` would silently miss a
// column added later by ALTER TABLE), so any CREATE/ALTER/DROP, whether through exec() or prepare(), empties the cache.
// PRAGMA and DDL text is never cached, so checks like PRAGMA table_info always compile fresh.
const CACHEABLE=/^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i; // Plain data statements only.
const SCHEMA=/\b(CREATE|ALTER|DROP)\s/i; // Text that can change tables or columns (boot-time migrations, zone renames).
const LIMIT=2000; // Dynamic SQL only varies by table name today; the cap just stops a future template from growing without bound.

export function cacheStatements(db){
 if(db.statementCache)return db; // Idempotent: service.mjs and createQuestZones may both install it on the same handle.
 const compile=db.prepare.bind(db),run=db.exec.bind(db),cache=new Map(); // The original prepare/exec, and SQL text -> compiled statement.
 db.prepare=sql=>{
  if(typeof sql!=='string'||!CACHEABLE.test(sql)){if(SCHEMA.test(String(sql)))cache.clear();return compile(sql);} // PRAGMA, DDL, BEGIN...: always fresh; DDL also forgets every cached statement.
  let statement=cache.get(sql);if(statement)return statement; // Hit: skip the compile entirely.
  statement=compile(sql); // Miss: compile once (a syntax error throws here and is never cached).
  if(cache.size>=LIMIT)cache.clear(); // Crude but bounded; a refill costs one compile per hot statement.
  cache.set(sql,statement);return statement;
 };
 db.exec=sql=>{if(SCHEMA.test(String(sql)))cache.clear();return run(sql);}; // BEGIN/COMMIT/ROLLBACK pass straight through; CREATE TABLE IF NOT EXISTS at boot just empties a near-empty cache.
 Object.defineProperty(db,'statementCache',{value:cache}); // Lets tests see how many statements are cached.
 return db;
}
