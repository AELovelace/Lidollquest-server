// Content-hash snapshot caching ("snapshot diet").
// A zone snapshot is ~140 KB, and most of it (room geometry, merchant shelves,
// the avatar catalog) is identical from one 500 ms poll to the next. A client
// that opts in lists the short hashes it already holds in `known`; any piece
// whose hash is listed is replaced by a tiny stub the client fills back in
// from its own copy. Because the key is a hash of the content itself, a changed
// piece (new day's stock, level-up, new district month) always gets a new key
// and is sent in full. Clients that never send `known` get the classic response.
import {createHash} from 'node:crypto';

export const CACHED_SECTIONS=Object.freeze(['avatars','rpp','questNpcLinks','dungeons','dignityTuning','alchemy']); // Top-level snapshot keys that rarely change and that no client code edits in place.
const KEY=/^[0-9a-f]{16}$/,MAX_KNOWN=128; // 16 hex chars of SHA-1; a client holds ~40 pieces at most.

export function cacheKey(value){return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0,16);} // Same content -> same key, on every server and after restarts.

export function parseKnown(value){ // `known` query value -> Set of keys, or null when the client did not opt in.
 if(typeof value!=='string')return null; // Absent parameter: an older client or gateway, so send the classic response.
 const keys=value.split(',').filter(k=>KEY.test(k));
 return new Set(keys.slice(0,MAX_KNOWN)); // Malformed or excess entries are ignored; they only cost a full resend.
}

export function elide(result,known){ // Mutates a freshly built snapshot for an opted-in client and returns it.
 if(!known||!result||typeof result!=='object')return result;
 if(Array.isArray(result.zones))result.zones=result.zones.map(zone=>{
  const key=cacheKey(zone);
  return known.has(key)?{id:zone.id,cacheKey:key,cached:true}:{...zone,cacheKey:key}; // Stub keeps the id so lookups by id never break; full entries carry their key so the client can store them.
 });
 const keys={};
 for(const name of CACHED_SECTIONS){
  if(result[name]===undefined||result[name]===null)continue; // Nothing to cache (companion view, older paths).
  const key=cacheKey(result[name]);keys[name]=key;
  if(known.has(key))delete result[name]; // Listed in cacheKeys but absent: "use your copy".
 }
 result.cacheKeys=keys;
 return result;
}
