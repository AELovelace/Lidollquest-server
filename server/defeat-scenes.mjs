import {readFileSync} from 'node:fs';
export const defaultScenes=JSON.parse(readFileSync(new URL('./defeat-scenes.json',import.meta.url),'utf8'));
export const compiledArtwork=JSON.parse(readFileSync(new URL('./monster-artwork.json',import.meta.url),'utf8'));

export function resolvedDefeat(scenes,receipt,outcome){
 if(scenes?.schema!==2)return scenes; // Published v1 scenes retain their existing wire format.
 let hash=0;for(const c of receipt)hash=(hash*31+c.charCodeAt(0))%65521;
 const pick=group=>{if(!group)return undefined;const dialogue=group.dialogues[hash%group.dialogues.length],aftermath=group.aftermaths[hash%group.aftermaths.length];return {title:aftermath?.title??'After the battle',dialogue:dialogue?.pages??[],aftermath:aftermath?.pages??[],dialogue_variant:dialogue?.id,aftermath_variant:aftermath?.id};};
 return Object.fromEntries(['first','repeat'].map(kind=>[kind,pick(outcome==='charm_backfire'&&scenes.charm?scenes.charm:scenes[kind])])); // Resolve once into the compatible client shape, using the durable encounter receipt.
}
