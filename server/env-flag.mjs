// On/off switches from server.env, read the forgiving way: TRUE, True, yes, on and 1 all mean on;
// FALSE, no, off and 0 all mean off. Anything else (including unset or blank) falls back to the
// default, so a typo never silently flips a security switch the unsafe way.
const ON = new Set(['true', '1', 'yes', 'on']);   // spellings that switch a flag on
const OFF = new Set(['false', '0', 'no', 'off']); // spellings that switch a flag off

export function envFlag(name, fallback = false, env = process.env) {
 const value = String(env[name] ?? '').trim().toLowerCase(); // case and stray spaces never matter
 if (ON.has(value)) return true;                              // explicitly on
 if (OFF.has(value)) return false;                            // explicitly off
 return fallback;                                             // unset or unreadable: keep the documented default
}
