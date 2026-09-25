// Short-lived memory of successful LiDollID logins for the gameplay gateway.
// Every step, poll and chat line used to wait on a tracker round-trip before the
// command even started; a player walking sends several of those per second.
// Suspensions are still checked locally on every request (gm.suspended), failed
// logins are never remembered, and the /gm panel keeps authenticating every time.
export const DEFAULT_AUTH_CACHE_MS=30000; // How long one successful login is reused; QUEST_AUTH_CACHE_MS overrides it, 0 disables.

export function authCacheMs(value=process.env.QUEST_AUTH_CACHE_MS){ // Parses the env setting; blank or invalid falls back to the default.
 if(value===undefined||value===null||String(value).trim()==='')return DEFAULT_AUTH_CACHE_MS;
 const ms=Number(value);if(!Number.isSafeInteger(ms)||ms<0||ms>600000)throw Error('QUEST_AUTH_CACHE_MS must be a whole number of milliseconds from 0 to 600000.'); // Ten minutes at most: a revoked grant must not keep playing for long.
 return ms;
}

export function createAuthCache(authenticate,{ttlMs=DEFAULT_AUTH_CACHE_MS,clock=()=>performance.now(),max=4096}={}){
 const entries=new Map(); // token -> {promise, expires}; the promise is shared so simultaneous requests make one tracker call.
 function prune(){const at=clock();for(const [token,entry] of entries)if(entry.expires<=at)entries.delete(token);while(entries.size>=max)entries.delete(entries.keys().next().value);} // Drop expired logins first, then the oldest, so memory stays bounded.
 async function lookup(token){ // Returns {verified, fresh}; fresh is true only when this call reached the tracker.
  if(ttlMs<=0)return {verified:await authenticate(token),fresh:true}; // Cache disabled: behave exactly like the old gateway.
  const cached=entries.get(token);
  if(cached&&cached.expires>clock())return {verified:{...await cached.promise},fresh:false}; // Copy so request code cannot edit the shared identity.
  if(entries.size>=max)prune();
  const promise=authenticate(token),entry={promise,expires:clock()+ttlMs};entries.set(token,entry);
  try{return {verified:{...await promise},fresh:true};}
  catch(error){if(entries.get(token)===entry)entries.delete(token);throw error;} // A rejected or expired grant is asked again on the very next request.
 }
 return {lookup,forget:token=>entries.delete(token),size:()=>entries.size}; // forget: drop one grant early, e.g. after the tracker answers 401 for it.
}
