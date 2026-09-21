import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createQuestZones} from '../server/zones.mjs';
import {gmZones} from '../server/gm.mjs';
import {routeCategory,ZONE_CATEGORY} from '../server/zone-categories.mjs';

const DIVES=['dive-quarters','dive-dungeon','dive-nursery','dive-school','dive-forest','dive-mansion','dive-hospital']; // Instanced boss routes.
const OVERWORLD=['dive-desert','dive-tundra','dive-taiga','dive-high-desert']; // Open wilderness linked by trails.

function fixture(){ // Minimal in-memory server with one character standing in a court lobby.
 const db=new DatabaseSync(':memory:'),quiet={log:()=>{}};
 const api=createQuestZones(db,{now:()=>Date.parse('2026-09-21T12:00:00Z'),roll:()=>0,grant:owner=>({owner,id:owner,client:'lidollquest'}),wallet:()=>({coins:0}),adjust:()=>{},diveOptions:quiet,desertOptions:quiet,tundraOptions:quiet,taigaOptions:quiet,highDesertOptions:quiet});
 const id=api.act('doll',{action:'create',name:'Doll',controller:'window',request_id:randomUUID()}).character.id; // Create the test character.
 const revision=api.read('doll',id).character.revision;
 api.act('doll',{action:'enter',zone:'honeydew-lantern',controller:'window',request_id:randomUUID(),character_id:id,revision,combat_version:3}); // Stand in a court lobby.
 return api.read('doll',id);
}

test('authored route data only accepts dive or overworld, defaulting to dive',()=>{
 assert.equal(routeCategory({route:'legacy'}),ZONE_CATEGORY.DIVE); // Older exports without the key stay instanced Dives.
 assert.equal(routeCategory({route:'wild',zone_category:'overworld'}),ZONE_CATEGORY.OVERWORLD);
 assert.throws(()=>routeCategory({route:'court',zone_category:'safe'}),/invalid zone_category/); // Safe zones are hubs, never Dive routes.
 assert.throws(()=>routeCategory({route:'typo',zone_category:'overwold'}),/invalid zone_category/);
});

test('snapshots label dives, overworld and safe zones',()=>{
 const s=fixture();
 assert.equal(s.zoneCategory,ZONE_CATEGORY.SAFE); // The player is standing in a court.
 const routes=Object.fromEntries(s.dungeons.map(d=>[d.id,d.category]));
 for(const id of DIVES)assert.equal(routes[id],ZONE_CATEGORY.DIVE,id);
 for(const id of OVERWORLD)assert.equal(routes[id],ZONE_CATEGORY.OVERWORLD,id);
 assert.ok(s.zones.length&&s.zones.every(z=>z.category===ZONE_CATEGORY.SAFE)); // Every hub definition sent to the client is a safe zone.
 assert.equal(s.dive.category,ZONE_CATEGORY.DIVE);assert.equal(s.desert.category,ZONE_CATEGORY.OVERWORLD); // Route summaries carry it too.
});

test('the GM zone catalogue shows every playable zone category',()=>{
 const byId=Object.fromEntries(gmZones.map(z=>[z.id,z.category]));
 for(const id of DIVES)assert.equal(byId[id],ZONE_CATEGORY.DIVE,id);
 for(const id of OVERWORLD)assert.equal(byId[id],ZONE_CATEGORY.OVERWORLD,id);
 assert.ok(gmZones.filter(z=>z.kind!=='chat'&&!z.id.startsWith('dive-')).every(z=>z.category===ZONE_CATEGORY.SAFE)); // Courts and RP rooms.
});
