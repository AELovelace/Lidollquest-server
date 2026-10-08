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
export function moveDelays(tuning=null){return {walk:delayKey(tuning,'move_delay_ms')/0.8,crawl:delayKey(tuning,'crawl_move_delay_ms')/0.8};} // Player speed is 80% of the tuned base pace, including existing live overrides; snapshots advertise these effective intervals.
export function moveBurst(tuning=null){const n=Math.floor(Number(tuning?.move_burst_steps));return Number.isFinite(n)&&n>=1?Math.min(12,n):DEFAULT_TUNING.move_burst_steps;} // Queued steps one walk batch may deliver at once (snapshot moveBurstSteps).
export function paceStep(moved,at,delay,burst=1){ // Step clock for queued walking: `moved` is the virtual time of the last committed step. Returns the new value, or null when this step would be too fast.
 const next=Math.max(moved+delay,at); // Each step claims the next delay slot; an idle player's slot starts from now, so pauses are never banked beyond the burst.
 return next-at<=(burst-1)*delay?next:null; // burst 1 is exactly the old rule (now - moved >= delay); a larger burst lets a batch arrive early by up to (burst-1) steps.
}
export function paceSingle(moved,at,delay,burst=1){ // Step clock for one ordinary `move` (doors, chests, stairs, pads, the classic path). Returns the slot to store as `moved`, or null when too fast.
 return paceStep(moved,at,delay,burst); // Same allowance as a walk step. A late batch re-anchors the clock to its own arrival, so the chest/door bump timed on the client's schedule always looked early; the burst absorbs that lag (and ordinary jitter) while the average pace stays capped at one step per delay.
}
export const TRAIL_STEPS=16,TRAIL_WINDOW=2000; // Walking trail kept per presence row, and how far back (ms) a snapshot shares it. A 500 ms poll plus a slow reply fits well inside the window.
export function extendTrail(p,steps){ // p: the presence row before this move; steps: [{x,y,t}] committed in order (t = the paced step clock). Returns the new quest_presence.trail JSON.
 let prev=null;try{prev=p.trail?JSON.parse(p.trail):null;}catch{prev=null;} // A malformed trail just restarts; it is presentation only.
 const tail=prev?.z===p.zone&&Array.isArray(prev.s)?prev.s:[],last=tail[tail.length-1];
 const start=last&&last[0]===p.x&&last[1]===p.y?tail:[[p.x,p.y,p.moved]]; // Continue only from where the avatar actually stood; a teleport since (any write that skips extendTrail) restarts from this tile.
 return JSON.stringify({z:p.zone,s:[...start,...steps.map(q=>[q.x,q.y,q.t])].slice(-TRAIL_STEPS)}); // {z: zone, s: [[x, y, server ms], ...]}
}
export function trailView(row,zone,at){ // Snapshot peer fields {trailAt, trail:[x, y, msBeforeTrailAt, ...]} for a player who stepped in the last TRAIL_WINDOW ms, else null.
 if(!row.trail)return null;let t;try{t=JSON.parse(row.trail);}catch{return null;}
 const s=Array.isArray(t?.s)?t.s:[],last=s[s.length-1];
 if(t.z!==zone||!last||last[0]!==row.x||last[1]!==row.y||last[2]<at-TRAIL_WINDOW)return null; // Stale (resting) or invalidated by a teleport/room change: the plain x/y is the whole story.
 const first=Math.max(0,s.findIndex(q=>q[2]>=at-TRAIL_WINDOW)-1); // Keep one older step as the anchor the first recent step walked from.
 return {trailAt:last[2],trail:s.slice(first).flatMap(q=>[q[0],q[1],last[2]-q[2]])}; // Flat and relative keeps it ~3 small numbers per step on the wire.
}
export function movementDelay(loadout,tuning=null){const d=moveDelays(tuning);return isCrawling(loadout)&&!loadoutCrawlFree(loadout)?d.crawl:d.walk;} // Milliseconds the server demands between online steps. Shared NPC clocks stay unchanged; only the crawler is slowed.
