// Welcome tutorial: a short GM-editable page flow shown once to each new character in their first hub (title, up to
// eight pages, optional link buttons to the wiki / store / Discord). The client reads `welcome` (the content) and
// `welcomeDue` (show it now?) from the snapshot and sends `welcome_done` when the player closes it. Settings follow
// tutor.mjs: a key/value table merged over code defaults, cached in memory, edited from the /gm Welcome tab.
const fail=(status,message,code='welcome_unavailable')=>{throw Object.assign(Error(message),{status,code});}; // Same rejection shape as tutor.mjs and the rest of the service.
const oneLine=v=>String(v??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim(); // Titles, headings and labels: one line, no control characters.
const multiLine=v=>String(v??'').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g,' ').split('\n').map(l=>l.replace(/[ \t]+/g,' ').trim()).join('\n').replace(/\n{3,}/g,'\n\n').trim(); // Bodies keep line breaks; every other control character is stripped.
export const WELCOME_LIMITS=Object.freeze({title:60,heading:60,body:600,label:24,pages:8}); // Shared with the GM panel's maxlength attributes and the wiki page.
const ALLOWED_HOSTS=['lidoll.dev','discord.gg']; // Buttons may only open our own site (and subdomains) or the Discord invite.

export function welcomeLinks(){ // Where the buttons point; deployments override through the environment.
 return {wiki:process.env.LIDOLLQUEST_WIKI_URL||'https://lidoll.dev/wiki/',store:process.env.LIDOLLQUEST_STORE_URL||'https://lidoll.dev/tracker/store/',discord:process.env.LIDOLLQUEST_DISCORD_URL||'https://discord.gg/mZFRQvZ9d3'};
}

export function allowedButtonUrl(value){ // https:// and a host on the allow-list (or a subdomain of lidoll.dev); returns the normalised URL or null.
 let url;try{url=new URL(String(value??''));}catch(error){return null;}
 if(url.protocol!=='https:')return null;
 const host=url.hostname.toLowerCase();
 if(!ALLOWED_HOSTS.some(h=>host===h||(h==='lidoll.dev'&&host.endsWith('.'+h))))return null; // Exact match, or something.lidoll.dev; discord.gg has no subdomains we trust.
 return url.href.length<=300?url.href:null;
}

export function defaultPages(links=welcomeLinks()){ // The shipped four pages; `links` is injected so tests can pin the URLs.
 return [
  {heading:'Welcome, little adventurer',body:'This is a shared kingdom. You will meet other players in the hub towns, form parties with them and explore the dungeon dives together. Your character has Needs and Dignity to look after, and accidents happen to everyone here; that is part of the story, not the end of it.',button:null},
  {heading:'Getting around',body:'Walk with the arrow keys or click a tile to go there. Press E to talk to people and use things, T to chat, and open the MENU for your Wardrobe, your items and your party.\nPip the tutor stands near the spawn in every hub and answers questions about how things work.',button:null},
  {heading:'The Player Wiki',body:'Everything about needs, the gods, the hubs, loot and crafting lives in the Player Wiki. The button below opens it in a new tab whenever you want to look something up.',button:{label:'Open the wiki',url:links.wiki}},
  {heading:'Help us draw more',body:'LiDollQuest is free and run by a tiny team. Diamond and coin packs in the store pay for new artwork and keep the servers up. No pressure at all: playing and telling your friends helps too.',button:{label:'Visit the store',url:links.store}},
 ];
}
export const WELCOME_DEFAULTS=Object.freeze({enabled:true,show_to_existing:false,title:'Welcome to LiDollQuest',pages:defaultPages()});

export function createWelcome(db,{now=Date.now,live=null}={}){ // `live` is accepted for parity with tutor.mjs; the welcome text has no Story Workshop sheet yet.
 db.exec(`CREATE TABLE IF NOT EXISTS quest_welcome_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT '');`);
 db.prepare('INSERT OR IGNORE INTO quest_welcome_settings(key,value,updated,actor) VALUES (?,?,?,?)').run('installed',JSON.stringify(now()),now(),''); // Feature epoch: characters created before this never see the tutorial unless show_to_existing is on.
 const installed=JSON.parse(db.prepare('SELECT value FROM quest_welcome_settings WHERE key=?').get('installed').value); // Read back so a restart keeps the original epoch.

 let cached=null; // Settings are read on every snapshot, so keep them in memory until a GM changes them.
 function settings(){
  if(cached)return cached;
  const out={...WELCOME_DEFAULTS};
  for(const row of db.prepare('SELECT key,value FROM quest_welcome_settings').all())if(Object.hasOwn(WELCOME_DEFAULTS,row.key))out[row.key]=JSON.parse(row.value); // `installed` is not a setting and stays out of the merge.
  cached=out;return out;
 }
 function content(){ // What the client renders; null while the tutorial is switched off.
  const s=settings();if(!s.enabled)return null;
  return {title:s.title,pages:s.pages.map(p=>({heading:p.heading,body:p.body,button:p.button?{label:p.button.label,url:p.button.url}:null}))};
 }
 function due(c,state){ // Show it to this character now? Enabled, never seen, and either new since install or the GM opted everyone in.
  const s=settings();if(!s.enabled||!c||!state||state.welcomeSeen)return false;
  return s.show_to_existing||(c.created??0)>=installed;
 }
 function markSeen(state){if(!state.welcomeSeen)state.welcomeSeen=now();return state;} // Idempotent: a replayed welcome_done keeps the first timestamp.

 function gmView(){return {settings:settings(),defaults:WELCOME_DEFAULTS,links:welcomeLinks(),installed,limits:WELCOME_LIMITS};}

 function validatePage(input,index){ // One page from the GM panel -> stored shape, or a 400 naming the page.
  const at='Page '+(index+1)+': ';
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,at+'each page must be an object.','welcome_invalid');
  const heading=oneLine(input.heading);if(!heading||heading.length>WELCOME_LIMITS.heading)fail(400,at+'heading must be 1-'+WELCOME_LIMITS.heading+' characters.','welcome_invalid');
  const body=multiLine(input.body);if(!body||body.length>WELCOME_LIMITS.body)fail(400,at+'body must be 1-'+WELCOME_LIMITS.body+' characters.','welcome_invalid');
  let button=null;
  if(input.button!==undefined&&input.button!==null){
   if(typeof input.button!=='object'||Array.isArray(input.button))fail(400,at+'button must be null or {label,url}.','welcome_invalid');
   const label=oneLine(input.button.label);if(!label||label.length>WELCOME_LIMITS.label)fail(400,at+'button label must be 1-'+WELCOME_LIMITS.label+' characters.','welcome_invalid');
   const url=allowedButtonUrl(input.button.url);if(!url)fail(400,at+'button links must start with https:// and point at lidoll.dev (or a subdomain) or discord.gg.','welcome_invalid');
   button={label,url};
  }
  return {heading,body,button};
 }
 function gmSet(input,actor=''){ // GM panel: switches, title and the whole page list. Takes effect on the next snapshot.
  if(!input||typeof input!=='object')fail(400,'Nothing to change.','welcome_invalid');
  const next={};
  if(input.enabled!==undefined){if(typeof input.enabled!=='boolean')fail(400,'enabled must be true or false.','welcome_invalid');next.enabled=input.enabled;}
  if(input.show_to_existing!==undefined){if(typeof input.show_to_existing!=='boolean')fail(400,'show_to_existing must be true or false.','welcome_invalid');next.show_to_existing=input.show_to_existing;}
  if(input.title!==undefined){const title=oneLine(input.title);if(!title||title.length>WELCOME_LIMITS.title)fail(400,'Title: 1-'+WELCOME_LIMITS.title+' characters.','welcome_invalid');next.title=title;}
  if(input.pages!==undefined){
   if(!Array.isArray(input.pages)||input.pages.length<1||input.pages.length>WELCOME_LIMITS.pages)fail(400,'Pages: send 1-'+WELCOME_LIMITS.pages+' pages.','welcome_invalid');
   next.pages=input.pages.map(validatePage); // Replaces the whole list; there is no per-page patching.
  }
  if(!Object.keys(next).length)fail(400,'Nothing to change.','welcome_invalid');
  const put=db.prepare('INSERT INTO quest_welcome_settings(key,value,updated,actor) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated,actor=excluded.actor');
  for(const [k,v] of Object.entries(next))put.run(k,JSON.stringify(v),now(),actor);
  cached=null;return settings();
 }
 function reset(actor=''){ // Back to the code defaults; the install epoch is kept so older characters stay excluded.
  db.prepare('DELETE FROM quest_welcome_settings WHERE key<>?').run('installed');
  cached=null;return settings();
 }

 return {settings,content,due,markSeen,gmView,gmSet,reset,installed,invalidate(){cached=null;}};
}
