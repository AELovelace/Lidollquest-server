// Zone categories split the online world into three kinds of place:
//  - dive:      small instanced boss routes (Princess' Quarters, Dungeon, Regression School, Haunted Mansion...).
//               Players go in, clear the floor, defeat the boss, then leave.
//  - overworld: large open wilderness (Tundra, Taiga, Dustbreak Desert, High Desert) linked by trails.
//  - safe:      the courts and their RP rooms (lobbies, gardens, beds, shops, dive halls, districts).
// Zone ids: instanced Dives keep `dive-<name>`; overworlds use `overworld-<name>` and campaign full dungeons
// `dungeon-<name>` (both renamed from `dive-<name>` on 2026-09-25; zone-rename.mjs migrates saved rows once and
// still accepts the old ids from older clients). Full dungeons keep the overworld category (duels, roaming).
// The category is what callers should branch on; isRouteZoneId() only answers "is this a Dive-engine zone id".
export const ZONE_CATEGORY=Object.freeze({DIVE:'dive',OVERWORLD:'overworld',SAFE:'safe'}); // The only three categories a zone can have.
const CATEGORIES=new Set(Object.values(ZONE_CATEGORY)); // Lookup set used to validate authored data.
export const isRouteZoneId=id=>typeof id==='string'&&/^(dive|overworld|dungeon)-/.test(id); // Dive-engine zone ids (instanced Dives, overworlds, full dungeons), by prefix, for code that runs before the engine map exists.

export function routeCategory(config){ // Reads the authored `zone_category` of a Dive-engine route config.
 const value=config?.zone_category??ZONE_CATEGORY.DIVE; // Routes exported before categories existed are instanced Dives.
 if(value===ZONE_CATEGORY.SAFE||!CATEGORIES.has(value))throw Error('Route '+(config?.route??'?')+' has invalid zone_category '+value+'; use dive or overworld.'); // Safe zones are hubs, never Dive-engine routes.
 return value; // Either 'dive' or 'overworld'.
}

export function createZoneCategories(engines){ // Builds a classifier over the live route map (zone id -> engine exposing `category`).
 return id=>engines.get(id)?.category??ZONE_CATEGORY.SAFE; // Anything that is not a Dive-engine route is a court, RP room or district.
}
