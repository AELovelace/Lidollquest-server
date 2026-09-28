import {GODS,godsData} from './faith-blessing.mjs';

export const flowFaithCatalog={max:godsData.settings.piety_max,gods:Object.values(GODS).map(({id,name})=>({id,name}))};
export function validatePietyCheck(value={}){
 const check={god:value?.god??'',op:value?.op??'gte',value:value?.value??50};
 if(!value||typeof value!=='object'||Array.isArray(value)||(check.god!==''&&!Object.hasOwn(GODS,check.god))||!['gte','lte','eq'].includes(check.op)||!Number.isInteger(check.value)||check.value<0||check.value>flowFaithCatalog.max)throw Object.assign(Error('Choose a valid patron, comparison, and whole-number piety threshold from 0 to '+flowFaithCatalog.max+'.'),{status:400,code:'flow_invalid'});
 return check;
} // Keep the editor, publication and server runner on the existing faith range and patron IDs.
export function pietyMatches(state,check){
 const faith=state?.faith,sworn=typeof faith?.god==='string'&&Object.hasOwn(GODS,faith.god);
 if(check.god&&(!sworn||faith.god!==check.god))return false;
 const value=sworn&&Number.isFinite(faith.piety)?Math.max(0,Math.min(flowFaithCatalog.max,faith.piety)):0;
 return check.op==='eq'?value===check.value:check.op==='lte'?value<=check.value:value>=check.value;
} // Read authoritative character.faith only; an absent patron counts as zero, never as a forged loadout value.
