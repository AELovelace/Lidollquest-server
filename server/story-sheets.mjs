import {createHash} from 'node:crypto';

const clone=structuredClone;
const fail=message=>{throw Object.assign(Error(message),{status:400,code:'story_sheet_invalid'});};
const sheetIds=new Map(); // [category,zone,key] text -> id. The id is a pure hash, so remembering it is always safe; NPC fixtures ask for it 3x per room on every lookup.
export const sheetId=(category,zone,key)=>{const text=JSON.stringify([category,zone,key]);let id=sheetIds.get(text);if(id)return id;id='sheet_'+createHash('sha256').update(text).digest('hex').slice(0,24);if(sheetIds.size>=20000)sheetIds.clear();sheetIds.set(text,id);return id;}; // Same 24-hex id as before; the size cap only stops unbounded growth.
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'); // Identity ignores wording, so content updates never change saved references.
const forbidden=new Set(['__proto__','prototype','constructor']);
export const sheetEffectTypes=['wet','wet_delta','tum','tum_delta','excitement','inco_up','incontinence_delta','stamina_heal','stamina_delta','hunger_delta','thirst_delta','wet_tum','shame','shame_delta','shame_relief','set_wet','heal','damage','str_drain','stat_buff','stamina_drain','excitement_down','inco_down','forced_inco','diaper_wet_delta','flag','counter','log','face','dud','give_item','force_equip_item','replace_diaper','release_campaign_curse','gold','xp','spawn_enemy'];
function normalizePages(raw){
 const pages=raw.map((p,i)=>typeof p==='string'?{id:'page_'+i,text:p}:{...clone(p),id:p.id??'page_'+i});
 const dest=v=>Number.isInteger(v)&&v>=0?(pages[v]?.id??v):v;
 for(const [i,p] of pages.entries()){
  p.next=dest(p.close_on_continue?'close':p.next??pages[i+1]?.id??'close');
  for(const key of ['gate_pass','gate_fail'])if(p[key]!==undefined)p[key]=dest(p[key]);
  for(const a of p.actions??[]){a.next=dest(a.next??'close');if(a.skill_check)for(const result of ['success','partial','failure'])if(a.skill_check[result+'_next']!==undefined)a.skill_check[result+'_next']=dest(a.skill_check[result+'_next']);}
 }
 return pages;
} // Explicit stable page links preserve behavior when authors rearrange or insert pages.
export function sheetSchema(values){
 const types=[...new Set(values.map(v=>v===null?'null':Array.isArray(v)?'array':typeof v))];
 const objects=values.filter(v=>v&&typeof v==='object'&&!Array.isArray(v)),arrays=values.filter(Array.isArray);
 return {types,...(objects.length?{fields:Object.fromEntries([...new Set(objects.flatMap(Object.keys))].filter(k=>!forbidden.has(k)).map(k=>[k,sheetSchema(objects.filter(v=>Object.hasOwn(v,k)).map(v=>v[k]))]))}:{}),...(arrays.length?{item:arrays.some(a=>a.length)?sheetSchema(arrays.flat()):{types:['string']}}:{}),sample:clone(values[0])};
} // Shapes come from shipped declarative data, not executable callbacks or client-supplied schemas.
function checkShape(value,schema,path='Content',depth=0){
 if(depth>24)fail(path+': nesting is too deep.');
 const type=value===null?'null':Array.isArray(value)?'array':typeof value;
 if(!schema.types.includes(type))fail(path+': expected '+schema.types.join(' or ')+'.');
 if(type==='string'&&(value.length>16000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)))fail(path+': invalid or overlong text.');
 if(type==='number'&&(!Number.isFinite(value)||Math.abs(value)>1000000))fail(path+': number is out of range.');
 if(type==='array'){if(value.length>512)fail(path+': use at most 512 entries.');value.forEach((v,i)=>checkShape(v,schema.item,path+' / '+i,depth+1));}
 if(type==='object')for(const [k,v] of Object.entries(value)){if(forbidden.has(k)||!schema.fields?.[k])fail(path+': unsupported field '+k+'.');checkShape(v,schema.fields[k],path+' / '+k,depth+1);}
}
function checkPages(pages,label,legacyShop=false){
 if(!Array.isArray(pages)||!pages.length)fail(label+': keep at least one page.');
 const ids=pages.map((p,i)=>typeof p==='string'?'page_'+i:p.id??'page_'+i);
 if(new Set(ids).size!==ids.length)fail(label+': page IDs must be unique.');
 const target=v=>{if(v===undefined||v===null||v==='close'||legacyShop&&v==='SHOP'||v===-1)return;if(Number.isInteger(v)?v<0||v>=pages.length:!ids.includes(v))fail(label+': missing page '+v+'.');};
 for(const p of pages){if(typeof p==='string')continue;target(p.next);for(const k of ['gate_pass','gate_fail'])target(p[k]);
  if((p.actions?.length??0)>8)fail(label+': a page supports at most eight choices.');
  for(const a of p.actions??[]){if(!a.label?.trim())fail(label+': choices need labels.');target(a.next);if(a.skill_check){if(!['str','def','dex','int','wis','cha','con','luk'].includes(String(a.skill_check.stat).toLowerCase()))fail(label+': choose a supported check stat.');for(const outcome of ['success','partial','failure'])target(a.skill_check[outcome+'_next']);}}
 }
} // Validate every destination, including skill-check branches which the legacy page importer omitted.
export function createStorySheets({look=null}={}){ // look: {slots, validate} from sprite-looks.mjs lets resident sheets carry a Sprite Lab look.
 const lookCategories=new Set(['fixture','follower','tutor','native_npc']); // Every character sheet uses the same validated Workshop appearance.
 const sources=new Map(),schemas=new Map();
 function register(category,zone,key,body,{name=body.name??body.title??key,source='',npc_ref=''}={}){
  const id=sheetId(category,zone,key);if(sources.has(id))return id;
  body=clone(body);
  if(category==='native_npc'){
   body.story_routing??={childish_mid:4,childish_high:7,visible_wet:true,visible_tum:true};
   for(const [key,value] of Object.entries(body))if(key.startsWith('dialogue_')&&key!=='dialogue_flag_branches'&&Array.isArray(value))body[key]=normalizePages(value);
  }
  if(['narrative','npc_event'].includes(category)&&Array.isArray(body.beats))body.beats=normalizePages(body.beats);
  sources.set(id,{id,name,zone,category,key,source,npc_ref,source_hash:hash(body),body:clone(body)});schemas.delete(category);return id;
 } // First registration is the shipped baseline; observing an edited map can never replace it.
 function schema(category){
  if(!schemas.has(category)){
   const examples=[...sources.values()].filter(s=>s.category===category).map(s=>s.body);
   if(category==='fixture')examples.push({topic_label:'Talk.',topics:[{id:'topic',text:'A new conversation.',next:'close',actions:[{label:'Goodbye.',next:'close'}]}]});
   if(lookCategories.has(category)&&look){const per=value=>Object.fromEntries(look.slots.map(slot=>[slot,value]));examples.push({look:{version:1,slots:per(''),colors:per([[255,255,255]]),strength:per([1]),enabled:per([true]),visible:per(true),facing:0}},{look:null});} // The shape only; validate() below checks the layers themselves.
   schemas.set(category,sheetSchema(examples));
  }
  return schemas.get(category);
 } // A safe topic template lets even a one-line resident grow pages without exposing client callbacks.
 function validate(value){
  const base=sources.get(value.id);if(!base)fail('This shipped sheet is not registered.');
  for(const k of ['category','zone','key','source','npc_ref'])if(value[k]!==base[k])fail('The sheet source and identity cannot change.');
  if(typeof value.name!=='string'||!value.name.trim()||value.name.length>160)fail('Give the sheet a name.');
  if(Buffer.byteLength(JSON.stringify(value))>240*1024)fail('Keep one sheet below 240 KiB.');
  checkShape(value.body,schema(base.category));
  const b=value.body;
  if(base.category==='native_npc'){
   const trees=Object.keys(b).filter(k=>k.startsWith('dialogue_')&&k!=='dialogue_flag_branches'&&Array.isArray(b[k]));
   if(!trees.includes(b.default_tree))fail('Choose an existing default dialogue tree.');
   if(!b.story_routing||b.story_routing.childish_mid>b.story_routing.childish_high)fail('Greeting thresholds must be in ascending order.');
   if(!['covered_showing','childish'].includes(b.dialogue_mode)&&b.dialogue_mode!==base.body.dialogue_mode)fail('Choose a supported greeting mode.');
   for(const tree of trees)checkPages(b[tree],tree,true);
   for(const branch of b.dialogue_flag_branches??[])for(const tree of [branch.tree,...Object.values(branch.tree_childish??{})].filter(Boolean))if(!trees.includes(tree))fail('Greeting refers to a missing tree: '+tree);
   if(b.diaper_change&&(!Array.isArray(b.diaper_change.diaper_pool)||!b.diaper_change.diaper_pool.length||b.diaper_change.chance_percent<0||b.diaper_change.chance_percent>100))fail('Care needs a nonempty supply pool and a chance between 0 and 100.');
  }
  if(['narrative','npc_event'].includes(base.category))checkPages(b.beats,'Narrative');
  if(base.category==='fixture'&&(!b.name?.trim()||typeof b.line!=='string'))fail('NPC sheets require a name and greeting.');
  if(base.category==='fixture'&&b.topics?.length)checkPages(b.topics,'Resident conversation');
  if(base.category==='fixture')for(const p of b.topics??[])if(!p.id||typeof p.id!=='string'||p.next==='SHOP'||p.next===-1)fail('Resident pages need stable IDs and named destinations.');
  if(['follower','tutor'].includes(base.category)&&(!b.name?.trim()||typeof b.fallback!=='string'))fail('Give this character a name and fallback reply.');
  if(base.category==='follower'&&(!Array.isArray(b.aliases)||!Array.isArray(b.talk_lines)||typeof b.persona!=='string'||typeof b.hire_text!=='string'))fail('Keep the companion voice, aliases and hire text.');
  if(base.category==='tutor'&&(!/^[A-Za-z][A-Za-z '\-]{0,23}$/.test(b.name)||typeof b.greeting!=='string'||b.greeting.length>300))fail('Guide names use 1–24 letters, spaces, apostrophes or hyphens; greetings use at most 300 characters.');
  const effects=v=>{if(!v||typeof v!=='object')return;for(const [key,child] of Object.entries(v)){if((key==='campaign_effects'||key.endsWith('_effects'))&&Array.isArray(child))for(const e of child)if(!sheetEffectTypes.includes(e.type))fail('Unsupported effect: '+e.type);effects(child);}};effects(b);
  if(base.category==='presentation')for(const [key,original] of Object.entries(base.body))for(const token of original.match(/\{\w+\}/g)??[])if(!b[key]?.includes(token))fail(key+': keep the '+token+' placeholder.');
  const body=clone(b);if(lookCategories.has(base.category)){if(b.look==null)delete body.look;else body.look=look?look.validate(b.look):fail('Sprite Lab looks are not available here.');} // Registered layers, slot fit, colours and the accessory limit.
  return {...clone(base),name:value.name,body,source_hash:value.source_hash??base.source_hash};
 } // Preserve explicit source provenance for later update comparisons instead of overwriting edited drafts.
 return {sources,register,validate,schema,inventory:()=>[...sources.values()].map(({body,...s})=>s)};
}
