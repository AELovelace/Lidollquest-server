export const descriptionLimit=2000;
export function cleanDescription(value){
 return value.normalize('NFC').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069#]/g,' ').trim();
} // Keep paragraphs as plain text while removing controls interpreted differently by game and browser clients.
export function descriptionFields(state){
 return {description:typeof state.description==='string'?Array.from(cleanDescription(state.description)).slice(0,descriptionLimit).join(''):'',description_revision:Number.isSafeInteger(state.description_revision)?state.description_revision:0};
} // Older characters have an empty description; public projections expose only these two profile fields.
