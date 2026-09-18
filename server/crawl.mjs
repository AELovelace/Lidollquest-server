import {readFileSync} from 'node:fs';

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

export function movementDelay(loadout){return isCrawling(loadout)?400:200;} // Shared NPC clocks stay unchanged; only the crawler moves at half speed.
