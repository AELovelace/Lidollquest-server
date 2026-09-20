import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const defaultScenes=JSON.parse(readFileSync(new URL('./defeat-scenes.json',import.meta.url),'utf8'));
export const compiledArtwork=JSON.parse(readFileSync(new URL('./monster-artwork.json',import.meta.url),'utf8'));
const scenesByHash=new Map();
export const defaultSceneRefs=Object.fromEntries(Object.entries(defaultScenes).map(([id,scene])=>{const hash=createHash('sha256').update(JSON.stringify(scene)).digest('hex');scenesByHash.set(hash,scene);return [id,hash];}));
export function registerDefaultScenes(db){
 db.exec('CREATE TABLE IF NOT EXISTS world_default_scenes(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
 const insert=db.prepare('INSERT OR IGNORE INTO world_default_scenes VALUES (?,?)');for(const hash of new Set(Object.values(defaultSceneRefs)))insert.run(hash,JSON.stringify(scenesByHash.get(hash)));
 for(const row of db.prepare('SELECT id,body FROM world_default_scenes').all())if(!scenesByHash.has(row.id))scenesByHash.set(row.id,JSON.parse(row.body)); // Old living monsters retain the defaults from their original release.
}
export function pinDefeat(enemy){
 if(enemy.defeat)return enemy;const scene=scenesByHash.get(enemy.defeat_ref??defaultSceneRefs[enemy.enemy_id]);
 return scene?{...enemy,defeat:structuredClone(scene),defeat_inherited:true}:enemy; // Copy presentation only when combat begins, not into every map monster.
}
export function publicEnemy(enemy){const {defeat,defeat_ref,defeat_inherited,defeat_equipment,...visible}=enemy;return visible;} // Only the settled scene crosses the gateway; combat definitions/effects stay pinned server-side.
export function publicCombatState(state){return state?.run?.enemy?{...state,run:{...state.run,enemy:publicEnemy(state.run.enemy)}}:state;}

export function resolvedDefeat(scenes,receipt,outcome){
 if(scenes?.schema!==2)return scenes; // Published v1 scenes retain their existing wire format.
 let hash=0;for(const c of receipt)hash=(hash*31+c.charCodeAt(0))%65521;
 const pick=group=>{if(!group)return undefined;const dialogue=group.dialogues[hash%group.dialogues.length],aftermath=group.aftermaths[hash%group.aftermaths.length];return {title:aftermath?.title??'After the battle',dialogue:dialogue?.pages??[],aftermath:aftermath?.pages??[],dialogue_variant:dialogue?.id,aftermath_variant:aftermath?.id};};
 return Object.fromEntries(['first','repeat'].map(kind=>[kind,pick(outcome==='charm_backfire'&&scenes.charm?scenes.charm:scenes[kind])])); // Resolve once into the compatible client shape, using the durable encounter receipt.
}
