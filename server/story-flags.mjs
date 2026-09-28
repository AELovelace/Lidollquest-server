// Story memory belongs to the server character, alongside the existing dungeon flags.
const fail=message=>{throw Object.assign(Error(message),{status:400,code:'story_flag_invalid'});};
export const flagId=value=>typeof value==='string'&&/^[a-z][a-z0-9_:.-]{0,119}$/.test(value)&&!['constructor','prototype','__proto__'].includes(value);
export function validateFlagCondition(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))fail('Choose story flag conditions.');
 const out={};for(const key of ['all','any','none']){const list=value[key]??[];if(!Array.isArray(list)||list.length>32||list.some(v=>!flagId(v)))fail('Choose valid story flags.');out[key]=[...new Set(list)];}return out;
}
export function storyFlagsMatch(state,condition={}){
 const flags=state?.fullDungeon?.flags??{},has=id=>Object.hasOwn(flags,id)&&!!flags[id];
 return (condition.all??[]).every(has)&&(!(condition.any?.length)||condition.any.some(has))&&(condition.none??[]).every(id=>!has(id));
} // Missing flags are false; reading conditions never creates or changes character memory.
export function setStoryFlag(state,id,value,definitions){
 if(!flagId(id)||!id.startsWith('story_')||!definitions.some(d=>d.id===id&&!d.retired))fail('Choose an active authored flag. Engine achievements cannot be edited.');
 if(typeof value!=='boolean')fail('Story flags are true or false.');
 state.fullDungeon??={flags:{},counters:{},once:{}};state.fullDungeon.flags??={};state.fullDungeon.flags[id]=value;
}

export function storyRequirementsMatch(state,requirements=[]){
 const p=state.loadout?.player_info??{};
 return requirements.every(c=>{if(c.flags)return storyFlagsMatch(state,c.flags);const value=c.field==='childish'?state.loadout?.childish??0:c.field==='health'?p.playerHealth??0:Number(p[c.field]??0);return c.op==='eq'?value===c.value:c.op==='lte'?value<=c.value:value>=c.value;});
} // Imported dialogue choices retain the same numeric and flag requirements as ordinary quests.
