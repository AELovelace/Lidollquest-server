// Blessing lookups that combat.mjs and crawl.mjs can import without a cycle (faith.mjs itself imports crawl.mjs).
// zones.mjs stamps loadout.faith = {god, piety, locked} from character state on every commit (importLoadout never accepts
// a client-sent `faith`), so a fight or a step can read the follower's blessing straight from the loadout.
import {readFileSync} from 'node:fs';

export const godsData=JSON.parse(readFileSync(new URL('./gods-data.json',import.meta.url),'utf8')); // python/export_online_gods.py
export const GODS=Object.freeze(Object.fromEntries(godsData.gods.map(g=>[g.id,g])));
const num=v=>Number.isFinite(Number(v))?Number(v):0;

export function faithBlessing(faith,key){ // A blessing number scaled by piety: melee_pct 20 at piety 50 -> 10. 0 without a god, or while locked (Orin).
 const god=faith?GODS[faith.god]:null;if(!god||faith.locked)return 0;
 return num(god.blessing[key])*Math.max(0,Math.min(1,num(faith.piety)/godsData.settings.piety_max));
}
export const loadoutBlessing=(loadout,key)=>faithBlessing(loadout?.faith,key); // Same, from the stamped combat loadout.

export function faithCrawlFree(faith){ // Sula: crawling costs no speed or damage once piety reaches crawl_free_min_piety.
 const god=faith?GODS[faith.god]:null;
 return !!god&&!faith.locked&&god.blessing.crawl_free_min_piety!==undefined&&num(faith.piety)>=god.blessing.crawl_free_min_piety;
}
export const loadoutCrawlFree=loadout=>faithCrawlFree(loadout?.faith);

export function blessedDef(loadout){ // Nyx: DEF raised by def_pct at full piety.
 const def=num(loadout?.player_info?.def);return Math.floor(def*(1+loadoutBlessing(loadout,'def_pct')/100));
}
