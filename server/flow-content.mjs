import {validatePietyCheck} from './flow-faith.mjs';
import {validateConditions} from './quest-content.mjs';
import {validateFlagCondition,flagId} from './story-flags.mjs';
import {triggerTypes} from './flow-triggers.mjs';
const fail=message=>{throw Object.assign(Error(message),{status:400,code:'flow_invalid'});};
const id=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,79}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)?v:fail('Use a stable lowercase ID.');
const text=(v='',max=4000)=>typeof v==='string'&&v.length<=max?v:fail('Text is too long.');
const list=(v=[],max=256)=>Array.isArray(v)&&v.length<=max?v:fail('Too many entries.');
export const FLOW_NODES={
 entry:['next'],npc_entry:['next'],flag_entry:['next'],objective_entry:['next'],dialogue:['next'],narrative:['next'],choice:[],condition:['match','no_match'],piety_check:['match','no_match'],set_flag:['next'],clear_flag:['next'],quest:['next'],objective:['complete'],battle:['victory','defeat','retreat'],reward:['next'],effect:['next'],travel:['next'],spawn:['next'],reveal_orb:['next'],hide_orb:['next'],end:[]
};
export function flowPorts(node){return node.type==='choice'?node.choices.map(c=>c.id):FLOW_NODES[node.type]??[];}
export function battleMonsters(node){return node.monsters??(node.ref?[node.ref]:[]);} // Old single-monster stories remain valid without migrating saved runs.
export function validateFlow(input,{catalog=null,flags=[],publish=false}={}){
 if(!input||typeof input!=='object')fail('Choose a flow.');if(input.schema!==undefined&&input.schema!==1)fail('Unsupported flow schema.');
 const flow={schema:1,id:id(input.id),name:text(input.name,100),description:text(input.description),retired:!!input.retired,repeatable:!!input.repeatable,nodes:[],edges:[],bindings:[],layout:{}};
 const issues=[];const problem=(node,message)=>issues.push({severity:'error',node,message});if(!flow.name.trim())problem(null,'Give the flow a name.');
 for(const n of list(input.nodes)){
  if(!Object.hasOwn(FLOW_NODES,n.type))fail('Unknown flow block.');
  const node={id:id(n.id),type:n.type,asset_kind:["npc","orb","quest","monster","zone"].includes(n.asset_kind)?n.asset_kind:"",label:text(n.label,100),text:text(n.text,16000),sprite:text(n.sprite,100),ref:text(n.ref,160),operation:text(n.operation,40),branch:text(n.branch,80),flag:text(n.flag,120),conditions:validateFlagCondition(n.conditions),choices:[],effects:[],rewards:{},x:Number.isFinite(n.x??input.layout?.nodes?.[n.id]?.x)?Math.max(-100000,Math.min(100000,n.x??input.layout.nodes[n.id].x)):0,y:Number.isFinite(n.y??input.layout?.nodes?.[n.id]?.y)?Math.max(-100000,Math.min(100000,n.y??input.layout.nodes[n.id].y)):0};
  if(node.type==='npc_entry'){node.repeatable=n.repeatable!==false;if(!node.ref)problem(node.id,'Choose the NPC whose dialogue this entry replaces.');}
  if(node.type==='piety_check')node.piety=validatePietyCheck(n.piety);
  if(node.type==='flag_entry'&&!flags.some(f=>f.id===node.flag&&!f.retired))problem(node.id,'Choose an active flag for this entry.');
  if(node.type==='objective_entry'){
   node.stage=text(n.stage,80);node.objective=text(n.objective,80);
   if(!node.ref||!node.stage||!node.objective)problem(node.id,'Choose a quest, stage and objective for this entry.');
   if(catalog&&!catalog.quests?.find(q=>q.id===node.ref&&!q.retired)?.stages?.find(stage=>stage.id===node.stage)?.objectives?.some(o=>o.id===node.objective))problem(node.id,'This objective entry needs an existing quest objective.');
  }
  if(node.type==='battle'){node.monsters=list(battleMonsters(n),3).map(id);node.ref=node.monsters[0]??'';if(!node.monsters.length)problem(node.id,'Add 1 to 3 monsters to this battle.');} // Repeated IDs intentionally create separate enemies.
  node.choices=list(n.choices,8).map(c=>({id:id(c.id),label:text(c.label,160),conditions:validateFlagCondition(c.conditions),requirements:validateConditions(c.requirements)}));
  if(new Set(node.choices.map(c=>c.id)).size!==node.choices.length)fail('Choice IDs must be unique.');
  node.effects=list(n.effects,16).map(e=>{if(!['heal','damage','wet','tum','shame_delta','stamina_drain','excitement_down','inco_down','give_item','force_equip_item','replace_diaper'].includes(e.type))fail('Choose a supported character effect.');if(!Number.isSafeInteger(e.amount??0)||Math.abs(e.amount??0)>10000)fail('Use a bounded whole-number effect.');return {type:e.type,amount:e.amount??0,item:text(e.item,100)};});
  for(const key of ['xp','coins','rpp']){const v=n.rewards?.[key]??0;if(!Number.isSafeInteger(v)||v<0||v>100000)fail('Use a bounded positive reward.');node.rewards[key]=v;}
  node.rewards.items=list(n.rewards?.items,16).map(i=>{if(!Number.isSafeInteger(i.count)||i.count<1||i.count>100)fail('Use 1 to 100 items.');return {id:id(i.id),count:i.count};});
  if(['set_flag','clear_flag'].includes(node.type)&&(!flagId(node.flag)||!node.flag.startsWith('story_')||!flags.some(f=>f.id===node.flag&&!f.retired)))problem(node.id,'Choose an active authored flag.');
  for(const key of [...node.conditions.all,...node.conditions.any,...node.conditions.none,...node.choices.flatMap(c=>[...Object.values(c.conditions).flat(),...c.requirements.flatMap(r=>Object.values(r.flags??{}).flat())])])if(key.startsWith('story_')&&!flags.some(f=>f.id===key&&!f.retired))problem(node.id,'Unknown story flag: '+key);
  if(node.effects.some(e=>['give_item','force_equip_item','replace_diaper'].includes(e.type)&&!e.item))problem(node.id,'Choose an item for each item effect.');
  if(node.type==='choice'&&!node.choices.length)problem(node.id,'Add at least one choice.');
  if(['dialogue','narrative','choice'].includes(node.type)&&!node.text.trim())problem(node.id,'Write the player-facing text.');
  if(node.type==='quest'&&!['accept','claim','abandon','branch'].includes(node.operation))problem(node.id,'Choose a quest operation.');
  if(node.type==='objective'&&!['quest','flag'].includes(node.operation))problem(node.id,'Choose what this block waits for.');
  if(node.type==='quest'&&node.operation==='branch'&&!node.branch)problem(node.id,'Choose a quest branch.');
  if(catalog){const groups={npc_entry:'npcs',reveal_orb:'orbs',hide_orb:'orbs',battle:'monsters',spawn:'monsters',quest:'quests',travel:'zones'};const group=node.type==='objective'&&node.operation==='quest'?'quests':groups[node.type];if(group&&!catalog[group]?.some(r=>r.id===node.ref&&!r.retired))problem(node.id,'Choose a published '+group+' reference or include its draft in the publication bundle.');if(node.sprite&&!catalog.sprites?.includes(node.sprite))problem(node.id,'Choose available artwork.');for(const item of [...node.rewards.items,...node.effects.filter(e=>e.item).map(e=>({id:e.item}))])if(!catalog.items?.some(i=>i.id===item.id))problem(node.id,'Choose an existing item: '+item.id);}
  if(node.type==='battle'&&catalog)for(const ref of node.monsters)if(!catalog.monsters?.some(r=>r.id===ref&&!r.retired))problem(node.id,'Choose an active monster or include its draft in the publication bundle: '+ref);
  flow.nodes.push(node);
 }
 if(new Set(flow.nodes.map(n=>n.id)).size!==flow.nodes.length)fail('Block IDs must be unique.');
 for(const e of list(input.edges,2048))flow.edges.push({from:id(e.from),port:id(e.port),to:id(e.to)});
 const nodes=new Map(flow.nodes.map(n=>[n.id,n])),outputs=new Set();
 for(const edge of flow.edges)if(['npc_entry',...triggerTypes].includes(nodes.get(edge.to)?.type))problem(edge.to,'Automatic entry blocks start a scene; connect from their next output, not into them.');
 for(const e of flow.edges){if(!nodes.has(e.from)||!nodes.has(e.to)||!flowPorts(nodes.get(e.from)).includes(e.port))problem(e.from,'A connection has an invalid block or output.');const key=e.from+':'+e.port;if(outputs.has(key))problem(e.from,'An output may have only one destination.');outputs.add(key);}
 for(const n of flow.nodes)for(const port of flowPorts(n))if(!outputs.has(n.id+':'+port))problem(n.id,'Connect the '+port+' output.');
 for(const b of list(input.bindings,64)){if(!['npc','orb','zone','objective'].includes(b.kind))fail('Choose an interaction trigger.');const binding={kind:b.kind,ref:text(b.ref,160),entry:id(b.entry),conditions:validateFlagCondition(b.conditions)};flow.bindings.push(binding);for(const k of Object.values(binding.conditions).flat())if(k.startsWith('story_')&&!flags.some(f=>f.id===k&&!f.retired))problem(binding.entry,'Unknown story flag: '+k);if(!nodes.has(binding.entry))problem(binding.entry,'Choose an existing entry block.');if(catalog){const group={npc:'npcs',orb:'orbs',zone:'zones',objective:'quests'}[binding.kind];if(!catalog[group]?.some(r=>r.id===binding.ref&&!r.retired))problem(binding.entry,'Choose an existing trigger.');}}
 for(const b of flow.bindings.filter(b=>b.kind==='npc'))for(const r of catalog?.npcs?.find(n=>n.id===b.ref)?.story_reactions??[])if(r.entry&&!nodes.has(r.entry))problem(b.entry,'NPC story reaction refers to a missing flow entry: '+r.entry);
 const roots=[...flow.bindings.map(b=>b.entry),...flow.nodes.filter(n=>['entry','npc_entry',...triggerTypes].includes(n.type)).map(n=>n.id)];
 if(!flow.nodes.length||!roots.length)problem(null,'Add an entry block.');
 const seen=new Set(),visit=key=>{if(seen.has(key))return;seen.add(key);for(const e of flow.edges.filter(e=>e.from===key))visit(e.to);};roots.forEach(visit);
 for(const n of flow.nodes)if(!seen.has(n.id))issues.push({severity:'warning',node:n.id,message:'This block is unreachable.'});
 const pauses=new Set(['dialogue','narrative','choice','battle','end']),done=new Set(),stack=new Set();
 function cycle(key){if(stack.has(key)){problem(key,'Automatic blocks cannot form a loop.');return;}if(done.has(key)||pauses.has(nodes.get(key)?.type))return;stack.add(key);for(const e of flow.edges.filter(e=>e.from===key))cycle(e.to);stack.delete(key);done.add(key);}flow.nodes.forEach(n=>cycle(n.id));
 flow.layout={nodes:Object.fromEntries(flow.nodes.map(n=>[n.id,{x:n.x,y:n.y}])),zoom:Math.max(.2,Math.min(2,Number(input.layout?.zoom)||1)),x:Number(input.layout?.x)||0,y:Number(input.layout?.y)||0};
 for(const n of flow.nodes){delete n.x;delete n.y;} // Canvas positions are editor metadata, separate from executable nodes.
 if(Buffer.byteLength(JSON.stringify(flow))>512*1024)fail('Keep a flow below 512 KiB.');
 if(publish&&issues.some(i=>i.severity==='error'))fail(issues.filter(i=>i.severity==='error').map(i=>(i.node?i.node+': ':'')+i.message).join('\n'));
 return {flow,issues};
} // Publication validates executable structure; incomplete drafts retain actionable diagnostics.
