import {readFileSync} from 'node:fs';
import {DEFAULT_TUNING} from './loot.mjs';
import {loadoutCrawlFree} from './faith-blessing.mjs'; // Sula's devout crawl at walking pace. // Shipped move_delay_ms / crawl_move_delay_ms, used when a tuning key is missing or malformed.

const gear=JSON.parse(readFileSync(new URL('./combat-data.json',import.meta.url),'utf8')).crawl_equipment??{};

export function crawlEquipment(loadout){ // Equipped IDs remain separate from the bag; only worn definitions enforce the stance.
 for(const [slot,id] of Object.entries(loadout?.player_info??{}))if(slot.startsWith('equipped_')&&Object.hasOwn(gear,id))return gear[id];
 return '';
}

export function isCrawling(loadout){ // Old imports without a world block remain standing unless exhausted or restrained.
 return loadout?.world?.crawling===true||loadout?.player_info?.stamina<=0||crawlEquipment(loadout)!=='';
}

export function syncCrawl(loadout){ // Persist forced stance so reconnects and the client HUD show the same condition.
 if(isCrawling(loadout))setCrawling(loadout,true);
}

export function setCrawling(loadout,value){ // Legacy imports need the full world shape before the game can restore a new knockdown.
 loadout.world={turn_count:0,wet_only_mode:false,pending_popup_turns:0,pending_popup_title:'',pending_popup_text:'',...loadout.world,crawling:value};
}

export function standBlockReason(loadout){ // Failed recovery never consumes an action or enemy response.
 const item=crawlEquipment(loadout);
 if(item)return item+' prevents standing. Remove it first.';
 return loadout?.player_info?.stamina<=0?'Too exhausted to stand. Recover stamina first.':'';
}

const delayKey=(tuning,key)=>{const n=Number(tuning?.[key]);return Number.isFinite(n)&&n>0?n:DEFAULT_TUNING[key];}; // A missing or malformed key falls back to the shipped default, never to zero.
export function moveDelays(tuning=null){return {walk:delayKey(tuning,'move_delay_ms'),crawl:delayKey(tuning,'crawl_move_delay_ms')};} // Both live cooldowns at once, for the zone snapshot (moveDelayMs / crawlMoveDelayMs).
export function moveBurst(tuning=null){const n=Math.floor(Number(tuning?.move_burst_steps));return Number.isFinite(n)&&n>=1?Math.min(12,n):DEFAULT_TUNING.move_burst_steps;} // Queued steps one walk batch may deliver at once (snapshot moveBurstSteps).
export function paceStep(moved,at,delay,burst=1){ // Step clock for queued walking: `moved` is the virtual time of the last committed step. Returns the new value, or null when this step would be too fast.
 const next=Math.max(moved+delay,at); // Each step claims the next delay slot; an idle player's slot starts from now, so pauses are never banked beyond the burst.
 return next-at<=(burst-1)*delay?next:null; // burst 1 is exactly the old rule (now - moved >= delay); a larger burst lets a batch arrive early by up to (burst-1) steps.
}
export function movementDelay(loadout,tuning=null){const d=moveDelays(tuning);return isCrawling(loadout)&&!loadoutCrawlFree(loadout)?d.crawl:d.walk;} // Milliseconds the server demands between online steps. Shared NPC clocks stay unchanged; only the crawler is slowed.
