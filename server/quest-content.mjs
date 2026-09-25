// Declarative online content: neither dialogue nor objective conditions can contain executable code.
export const objectiveTypes=['talk','visit','interact','collect','deliver','kill','equipment','state','timer'];
export const questStats=['str','def','dex','int','cha','playerHealthMax'];
export const stateFields=['shame','wet','tum','health','incontinence','excitement','stamina','childish','forced_inco_turns','had_wet_accident','had_tum_accident'];
const fail=message=>{throw Object.assign(Error(message),{status:400,code:'quest_content_invalid'});};
const text=(v,max=4000)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008]/.test(v)?v:fail('Invalid quest text.');
const id=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{1,79}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)?v:fail('Use a stable lowercase ID.');
const num=(v,min=0,max=1000000)=>Number.isSafeInteger(v)&&v>=min&&v<=max?v:fail(`Use a whole number between ${min} and ${max}.`);
const list=(v,max=64)=>Array.isArray(v)&&v.length<=max?v:fail(`Use at most ${max} entries.`);
const choose=(v,values)=>values.includes(v)?v:fail('Unknown quest option: '+v);
const unique=rows=>{if(new Set(rows.map(r=>r.id)).size!==rows.length)fail('IDs must be unique.');return rows;};
export function validateConditions(value=[]){return list(value,16).map(c=>({field:choose(c.field,stateFields),op:choose(c.op??'gte',['gte','lte','eq']),value:num(c.value,-1000000),...(c.item?{item:id(c.item)}:{})}));}
export function validateQuestContent(kind,v,{assetRef,spells,equipment}){
 const out={id:id(v.id),name:text(v.name??'',100),description:text(v.description??''),retired:!!v.retired};
 if(kind==='npc'){
  out.sprite=assetRef(v.sprite??'');out.battle_sprite=assetRef(v.battle_sprite??'');out.wander_radius=num(v.wander_radius??0,0,8);
  out.quests=list(v.quests??[],32).map(id);out.dialogue=unique(list(v.dialogue??[]).map((p,i)=>({id:id(p.id??'page_'+i),text:text(p.text??''),next:p.next??'close',actions:list(p.actions??[],8).map(a=>({label:text(a.label??'',160),next:a.next??'close',effect:choose(a.effect??'none',['none','offer','turn_in','branch']),...(a.quest?{quest:id(a.quest)}:{}),...(a.branch?{branch:id(a.branch)}:{}),conditions:validateConditions(a.conditions)}))})));
  const names=new Set(out.dialogue.map(p=>p.id));for(const p of out.dialogue)for(const link of [p,...p.actions]){if(Number.isInteger(link.next))link.next=out.dialogue[link.next]?.id;if(link.next!=='close'&&!names.has(link.next))fail('Dialogue points to an unknown page.');if(link.effect&&link.effect!=='none'&&!link.quest)fail('Choose a quest for this dialogue action.');}
 }else{
  if(v.offer_line!==undefined)out.offer_line=text(v.offer_line);if(v.complete_line!==undefined)out.complete_line=text(v.complete_line); // Preserve authored side-quest offer and outcome dialogue in pinned definitions.
  out.prerequisites=list(v.prerequisites??[],32).map(id);out.conditions=validateConditions(v.conditions);
  out.failure_text=text(v.failure_text??'This quest could not be completed.');
  out.repeat=choose(v.repeat??'once',['once','daily','weekly','cooldown']);out.cooldown_seconds=num(v.cooldown_seconds??86400,1,31536000);
  out.timer={mode:choose(v.timer?.mode??'online',['online','realtime']),seconds:num(v.timer?.seconds??0,0,31536000)};
  out.turn_in={mode:choose(v.turn_in?.mode??'npc',['npc','journal']),npc:v.turn_in?.npc?text(v.turn_in.npc,160):''};
  out.givers=list(v.givers??[],32).map(x=>text(x,160));
  out.stages=unique(list(v.stages??[],64).map(s=>({id:id(s.id),name:text(s.name??'',100),text:text(s.text??''),mode:choose(s.mode??'all',['all','any']),next:s.next??'complete',objectives:unique(list(s.objectives??[],32).map(o=>({id:id(o.id),type:choose(o.type,objectiveTypes),text:text(o.text??'',500),target:text(o.target??'',160),npc:text(o.npc??'',160),zone:text(o.zone??'',100),count:num(o.count??1,1),sharing:choose(o.sharing??'personal',['personal','party']),conditions:validateConditions(o.conditions),...(o.type==='state'?{field:choose(o.field,stateFields),op:choose(o.op??'gte',['gte','lte','eq']),value:num(o.value??0,-1000000)}:{}),...(o.type==='equipment'?{slot:text(o.slot??'',40)}:{}),token:!!o.token}))),branches:unique(list(s.branches??[],8).map(b=>({id:id(b.id),label:text(b.label??'',160),to:b.to??'complete',conditions:validateConditions(b.conditions)})))})));
  const names=new Set(out.stages.map(s=>s.id)),visited=new Set(),active=new Set();
  function walk(key){if(key==='complete'||key==='failed')return;if(!names.has(key))fail('Stage destination does not exist.');if(active.has(key))fail('Quest stages cannot form a cycle.');if(visited.has(key))return;active.add(key);const s=out.stages.find(v=>v.id===key);for(const next of s.branches.length?s.branches.map(b=>b.to):[s.next])walk(next);active.delete(key);visited.add(key);}
  if(out.stages.length){walk(out.stages[0].id);if(visited.size!==names.size)fail('Every stage must be reachable.');}
  const r=v.rewards??{};out.rewards={xp:num(r.xp??0),coins:num(r.coins??0),rpp:num(r.rpp??0),items:list(r.items??[],32).map(i=>({id:id(i.id),count:num(i.count??1,1,100)})),spells:list(r.spells??[],32).map(id),stats:{},equipment:list(r.equipment??[],16).map(id)};
  if(r.dignity!==undefined)out.rewards.dignity=num(r.dignity,-1024,1024); // Signed campaign quest Dignity rewards, applied by the server once.
  for(const [key,value] of Object.entries(r.stats??{})){choose(key,questStats);out.rewards.stats[key]=num(value,-200,200);}
  for(const item of [...out.rewards.items.map(i=>i.id),...out.rewards.equipment])if(!Object.hasOwn(equipment,item))fail('Choose existing equipment or items.');
  for(const spell of out.rewards.spells)if(!Object.hasOwn(spells,spell))fail('Choose existing spells.');
 }
 if(Buffer.byteLength(JSON.stringify(out))>256*1024)fail('Keep each definition below 256 KiB.');return out;
} // Incomplete drafts are allowed; publication additionally checks references and required content.
export function checkQuestReferences(kind,body,live){
 const quests=live.quests??{},npcs=live.npcs??{},available=(map,key)=>map[key]&&!map[key].retired;
 const quest=key=>{if(key!==body.id&&!available(quests,key))fail('Publish the referenced quest first: '+key);};
 if(body.retired)return;
 if(!body.name.trim())fail('A published definition needs a name.');
 if(kind==='npc'){if(!body.dialogue.length)fail('Add at least one dialogue page.');for(const key of body.quests)quest(key);for(const p of body.dialogue)for(const a of p.actions)if(a.quest)quest(a.quest);return;}
 if(!body.stages.length||body.stages.some(s=>!s.objectives.length))fail('Add at least one objective to every stage.');
 for(const key of body.prerequisites){if(key===body.id)fail('A quest cannot require itself.');quest(key);}
 const walk=(key,seen=new Set())=>{if(key===body.id)fail('Quest prerequisites cannot form a cycle.');if(seen.has(key))return;seen.add(key);for(const next of quests[key]?.prerequisites??[])walk(next,seen);};for(const key of body.prerequisites)walk(key);
 for(const key of [...body.givers,...(body.turn_in.mode==='npc'?[body.turn_in.npc]:[])])if(key&&!key.includes(':')&&!available(npcs,key))fail('Publish the referenced NPC first: '+key);
 if(!body.givers.length&&body.turn_in.mode!=='npc'&&!Object.values(npcs).some(n=>!n.retired&&n.quests.includes(body.id)))fail('Choose at least one quest giver. Players accept quests by talking to NPCs.');
 if(body.turn_in.mode==='npc'&&!body.turn_in.npc)fail('Choose a turn-in NPC.');
 for(const s of body.stages)for(const o of s.objectives){if(['kill','talk','interact','collect','deliver','equipment'].includes(o.type)&&!o.target)fail('Choose an objective target.');if(o.type==='kill'&&!available(live.monsters,o.target))fail('Publish the objective monster first.');}
} // Cross-references are checked at publication rather than while authors are assembling drafts.
