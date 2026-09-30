// Authoritative counterpart of scrAlchemy and python/alchemy_brew.py. No inventory mutation here.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const pick=(rows,random)=>{const total=rows.reduce((s,[,w])=>s+w,0);if(total<=0)return undefined;let n=random()*total;for(const [id,w] of rows)if((n-=w)<0)return id;return rows.at(-1)?.[0];};
export const alchemyKey=ids=>[...ids].sort().join('+'); // Repeated ingredients retain their quantities.
export function buildPotion(table,s){
 const b=table.brewing,a=b.adjectives,special=b.specials[s.special];
 if(!b.colours[s.colour]||!b.rarity_value_mult[s.rarity]||!Number.isInteger(s.potency)||s.potency<1||s.potency>Math.ceil(b.potency.max*10)||s.adjectives.some(k=>!a[k])||new Set(s.adjectives).size!==s.adjectives.length||s.adjectives.length>16||(s.special&&!special))throw Error('Invalid potion signature');
 let potency=s.potency/10;for(const id of s.adjectives)potency*=a[id].potency_mult??1;
 const fields={};for(const [key,value] of Object.entries(b.colours[s.colour].effects))fields[key]=typeof value==='boolean'?value:Math.round(value*potency);
 if(special)for(const [key,value] of Object.entries(special.effects))fields[key]=(special.scale??[]).includes(key)&&typeof value!=='boolean'?Math.round(value*potency):value;
 for(const id of s.adjectives){const row=a[id];
  for(const [key,value] of Object.entries(row.add??{})){if(['hp_restore','mp_restore','stamina_restore'].includes(key)&&fields[key]===-1)continue;fields[key]=(fields[key]??0)+value;}
  for(const [key,value] of Object.entries(row.pressure??{}))fields[key]=key==='pressure_turns'?Math.max(fields[key]??0,value):(fields[key]??0)+value;
  if(row.burst){const tummy=s.adjectives.includes('rumbly')||s.colour==='brown';fields.active_effect={source:'',...row.burst,wet_per_turn:0,tum_per_turn:0,wet_force:!tummy,tum_force:tummy,inco_set:-1,inco_delta:0,inco_restore:-1,grossout_reset:false,started:false};}
  if(row.duration_mult&&fields.continence_turns!==undefined)fields.continence_turns=Math.round(fields.continence_turns*row.duration_mult);
 }
 for(const id of s.adjectives)if(a[id].pressure_mult!==undefined)for(const key of ['wet_instant','tum_instant','wet_per_turn','tum_per_turn','wet_target_gain','tum_target_gain'])if(fields[key]!==undefined)fields[key]=Math.round(fields[key]*a[id].pressure_mult);
 const name=[...s.adjectives.map(id=>a[id].name),table.colors.find(c=>c.id===s.colour).name,'Potion'].join(' ')+(special?' '+special.title:'');
 if(fields.active_effect)fields.active_effect.source=name;
 const item_id='brewed_potion__'+[s.colour,s.rarity,s.potency,s.adjectives.join('-')||'none',s.special||'none'].join('__');
 return {item_id,category:'drink',name,desc:[b.colours[s.colour].desc,...(special?[special.desc]:[]),...s.adjectives.map(id=>a[id].desc)].join(' '),atk:0,def:0,hp_restore:0,value:Math.max(1,Math.round(b.base_value*potency*b.rarity_value_mult[s.rarity]*.8**s.adjectives.filter(id=>a[id].bad).length*(special?1.5:1))),childish:0,rarity:s.rarity,brewed:{...s,special:s.special??''},...fields};
} // A signature always rebuilds identical effects, price and stack identity.
export function potionFromId(table,id){
 if(!id.startsWith('brewed_potion__'))return null;
 const parts=id.slice(15).split('__');if(parts.length!==5)return null;
 try{return buildPotion(table,{colour:parts[0],rarity:parts[1],potency:Number(parts[2]),adjectives:parts[3]==='none'?[]:parts[3].split('-'),special:parts[4]==='none'?null:parts[4]});}catch{return null;}
}
export function brewPotion(table,items,ids,skill,random,{kit=false,journal={}}={}){
 const b=table.brewing,rows=ids.map(id=>items[id]?.alchemy);
 if(ids.length<b.min_ingredients||ids.length>b.max_ingredients||rows.some(row=>!row))throw Error('Choose two or three alchemy ingredients.');
 const catalyst=rows.some(r=>r.role==='catalyst'),difficulty=clamp(rows.reduce((sum,r)=>sum+r.tier*b.difficulty.per_tier,0)+(catalyst?b.difficulty.catalyst_bonus:0),b.difficulty.min,b.difficulty.max);
 const first=!journal[alchemyKey(ids)],xp=bad=>Math.max(1,Math.round(difficulty*b.skill.xp_per_difficulty*(first?b.skill.first_brew_mult:1)*(skill-difficulty>b.skill.grey_margin?b.skill.grey_mult:1)*(bad?b.skill.mishap_mult:1)));
 const m=b.mishap;if(random()<clamp(m.base+(difficulty-skill)*m.per_point,m.min,m.max)+(kit?m.kit_penalty:0)){const mishap=b.mishaps[Math.floor(random()*b.mishaps.length)];return {mishap:true,effects:mishap,text:mishap.text,xp:xp(true)};}
 const pigments={},leans={};for(const row of rows){for(const [k,v] of Object.entries(row.pigments))pigments[k]=(pigments[k]??0)+v*(row.role==='liquid'?b.liquid_pigment_mult:1);for(const [k,v] of Object.entries(row.traits))leans[k]=(leans[k]??0)+v;}
 const recipe=b.secret_recipes.find(r=>alchemyKey(r.ingredients)===alchemyKey(ids));
 const colors=table.colors.map(c=>c.id),top=Math.max(...colors.map(c=>pigments[c]??0)),total=Object.values(pigments).reduce((s,v)=>s+v,0);
 let colour=recipe?.colour??(total<=0||colors.filter(c=>(pigments[c]??0)===top).length>1||top/total<b.muddy_share?'brown':colors.find(c=>pigments[c]===top));
 const q=b.quality,quality=clamp(skill*q.skill_weight+rows.reduce((s,r)=>s+r.tier,0)/rows.length*q.tier_weight+(random()*2-1)*q.jitter-(kit?q.kit_penalty:0),1,100);
 let rarity='common';for(const row of b.rarity_thresholds)if(quality>=row.min)rarity=row.name;
 const order=b.rarity_thresholds.map(t=>t.name);if(recipe&&order.indexOf(rarity)<order.indexOf(recipe.min_rarity))rarity=recipe.min_rarity;
 const potency=Math.round((b.potency.min+quality/100*(b.potency.max-b.potency.min))*10),chosen=[];
 const bad=b.bad_chance,lean=Object.entries(leans).reduce((s,[k,v])=>s+(b.adjectives[k]?(b.adjectives[k].bad?v:-v):0),0);
 const chance=clamp(bad.at_skill_1+(bad.at_skill_100-bad.at_skill_1)*clamp((skill-1)/99,0,1)+bad.lean_per_point*lean+(kit?bad.kit_penalty:0),bad.min,bad.max);
 const adjective=(want,exclude=[])=>pick(Object.keys(b.adjectives).sort().filter(k=>b.adjectives[k].bad===want&&!chosen.includes(k)&&!exclude.includes(k)).map(k=>[k,Math.max(0,b.adjectives[k].weight+b.lean_weight*(leans[k]??0))]),random);
 const [lo,hi]=b.adjective_slots[rarity],slots=lo+Math.floor(random()*(hi-lo+1));
 for(let n=0;n<slots;n++){const id=adjective(random()<chance);if(!id)continue;chosen.push(id);if(id==='stinky'){const [a,z]=b.stinky_extra_bad,count=a+Math.floor(random()*(z-a+1));for(let j=0;j<count;j++){const extra=adjective(true,['stinky']);if(extra)chosen.push(extra);}}}
 const forced=recipe?.force_adjectives??[];for(const id of forced)if(!chosen.includes(id))chosen.push(id);
 if(chosen.includes('pure'))for(let n=0;n<(b.adjectives.pure.cancels_bad??1);n++){const index=chosen.findLastIndex(id=>b.adjectives[id].bad&&!forced.includes(id));if(index>=0)chosen.splice(index,1);}
 let special=recipe?.special??null;
 if(!special&&catalyst&&order.indexOf(rarity)>=order.indexOf(b.special.min_rarity)&&random()<(rarity==='legendary'?b.special.legendary_catalyst_chance:b.special.catalyst_chance))special=pick(Object.keys(b.specials).sort().map(k=>[k,b.specials[k].weight]),random);
 if(chosen.includes('volatile')){const other=colors.filter(c=>c!==colour);colour=other[Math.floor(random()*other.length)];}
 const signature={colour,rarity,potency,adjectives:chosen.sort(),special};
 return {mishap:false,item:buildPotion(table,signature),colour,xp:xp(false)};
} // Randomness is injected so retries and cross-runtime fixtures can replay the same roll sequence.
