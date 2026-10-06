export const DEFAULT_ZONE_CAPACITY=256; // One default for admission, coordinator snapshots and worker snapshots.

export function parseZoneCapacity(value){ // Read QUEST_ZONE_CAPACITY without silently accepting a typo or truncating a fraction.
 if(value===undefined||value===null||String(value).trim()==='')return DEFAULT_ZONE_CAPACITY;
 const text=String(value).trim(),capacity=Number(text);
 if(!/^[1-9]\d*$/.test(text)||!Number.isSafeInteger(capacity))throw Error('QUEST_ZONE_CAPACITY must be a positive safe integer.');
 return capacity;
}
