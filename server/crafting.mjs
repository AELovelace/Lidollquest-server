import {currentCraftingData} from './crafting-store.mjs';
import {loseDignity} from './dignity.mjs';
import {readFileSync} from 'node:fs';
import {createLootRoller,createBaseGenerator,RARITY_ORDER} from './loot.mjs';
import {seeded} from './dive-generation.mjs';
import {addToInventory,slotsUsed,stackable,setStackTokens,stackTokens} from './loadout.mjs';
import {brewPotion,potionFromId,alchemyKey} from './alchemy-brew.mjs';

export const craftingData=JSON.parse(readFileSync(new URL('./crafting-data.json',import.meta.url),'utf8'));
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'crafting_failed'});};
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const dignityChange=(p,value,tuning)=>value<0?loseDignity(p,-value,tuning):(p.shame=clamp((p.shame??1024)+value,0,1024)); // Match ordinary consumable Dignity changes.
export const materialKey=parts=>Object.entries(parts).sort(([a],[b])=>a.localeCompare(b)).map(([id,n])=>id+':'+n).join('|');
export function validateMaterials(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>32)fail('Choose materials and quantities.');
 const result={};for(const [id,n] of Object.entries(value)){if(!/^[a-z0-9_]+$/.test(id)||!Number.isSafeInteger(n)||n<1||n>512)fail('Material quantities must be whole numbers from 1 to 512.');result[id]=n;}
 if(!Object.keys(result).length)fail('Choose some ingredients.');return result;
} // A normalized multiset makes ingredient order irrelevant without dropping duplicate units.
export function validateCrafting(data){
 const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
 const bad=message=>{throw Object.assign(Error(message),{status:400,code:'invalid_crafting_content'});};
 const identity=id=>typeof id==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id);
 const strings=(v,label)=>{if(!Array.isArray(v)||v.some(s=>typeof s!=='string'||!s.trim()||s.length>64))bad(label+' must be a list of nonempty names.');};
 const numeric=(v,label,min=0,max=100000)=>{if(!Number.isFinite(v)||v<min||v>max)bad(label+' must be a number from '+min+' to '+max+'.');};
 if(!object(data)||!['recipes','cooking'].every(k=>Array.isArray(data[k]))||!['materials','culinary','regions','wildlife','tuning','catalysts'].every(k=>object(data[k])))throw Object.assign(Error('Crafting sections must keep their list or object structure.'),{status:400});
 if(data.recipes.some(r=>!object(r))||data.cooking.some(r=>!object(r)||!Array.isArray(r.tags)))throw Object.assign(Error('Recipe rows must be objects with valid ingredients or tags.'),{status:400});
 const ids=new Set(),keys=new Set();for(const r of data.recipes){const k=r.discipline+':'+materialKey(validateMaterials(r.ingredients));if(ids.has(r.id)||keys.has(k))bad('Ambiguous crafting recipe: '+r.id);ids.add(r.id);keys.add(k);}
 for(const r of data.cooking)if(r.tags.length<2||r.tags.length>3)bad('Cooking needs two or three ingredients.');
 const catalog=craftingCatalog(data),known=id=>typeof id==='string'&&Object.hasOwn(catalog,id);
 for(const section of ['materials','culinary','regions','wildlife','catalysts'])for(const [id,row] of Object.entries(data[section])){if(!identity(id)||!(section==='culinary'?Array.isArray(row):object(row)))bad('Invalid '+section+' entry: '+id);}
 for(const [id,row] of Object.entries(data.materials)){if(row.item_id!==id||row.category!=='ingredient'||row.stackable!==true||typeof row.name!=='string'||!row.name.trim())bad('Material identity, name, category or stackability is invalid: '+id);numeric(row.value,id+' value');strings(row.cooking_tags??[],id+' cooking tags');if(!RARITY_ORDER.includes(row.rarity))bad('Choose a material rarity: '+id);}
 for(const [id,row] of Object.entries(data.culinary)){if(!known(id))bad('Unknown culinary ingredient: '+id);strings(row,id+' tags');}
 const cookingIds=new Set();for(const row of data.cooking){if(!identity(row.id)||cookingIds.has(row.id))bad('Cooking recipe IDs must be unique: '+row.id);cookingIds.add(row.id);strings(row.tags,row.id+' tags');if(!['','weapon','defense','magic','stamina','gather'].includes(row.buff)||typeof row.kitchen!=='boolean')bad('Invalid cooking bonus or kitchen requirement: '+row.id);numeric(row.difficulty,row.id+' difficulty',1,1000);}
 for(const r of data.recipes){if(!/^[a-z0-9_]+$/.test(r.id)||!['smithing','tailoring','refining'].includes(r.discipline))bad('Invalid crafting recipe identity.');if(Object.keys(r.ingredients).some(id=>!known(id)))bad('Unknown recipe material: '+r.id);if(r.discipline==='smithing'&&(!Array.isArray(r.variants)||!r.variants.length||r.variants.some(id=>!known(id))))bad('Invalid weapon variants: '+r.id);if(r.discipline==='refining'&&(!known(r.output)||!Number.isSafeInteger(r.quantity)||r.quantity<1||r.quantity>512))bad('Invalid refining output.');if(r.discipline!=='refining'&&(!Number.isInteger(r.floor)||r.floor<0||r.floor>4||!Number.isInteger(r.catalysts)||r.catalysts<0||r.catalysts>3||!(r.difficulty>0)))bad('Invalid recipe rarity, catalyst budget or difficulty.');}
 for(const r of data.recipes){if(!identity(r.id))bad('Invalid recipe ID.');if(r.station!==undefined&&!['forge','sewing_table'].includes(r.station))bad('Choose a valid recipe station.');if(r.discipline==='smithing'&&r.variants.some(id=>catalog[id]?.category!=='weapon'))bad('Smithing variants must be weapons.');if(r.discipline==='tailoring'&&!craftingBases(data).garments.some(g=>g.id===r.family))bad('Unknown tailoring garment: '+r.family);if(r.discipline!=='refining')numeric(r.difficulty,r.id+' difficulty',1,1000);}
 for(const r of Object.values(data.regions)){strings(r.nodes,'Region resources');strings(r.rare??[],'Rare resources');strings(r.animals,'Region animals');if(r.nodes.some(id=>!known(id))||(r.rare??[]).some(id=>!known(id))||r.animals.some(id=>!Object.hasOwn(data.wildlife,id)))bad('Region references unknown materials or wildlife.');}
 for(const row of Object.values(data.wildlife)){if(!(row.hp>0)||!['neutral','predator'].includes(row.temperament))bad('Invalid wildlife health or temperament.');for(const drops of [row.defeat_drops,row.charm_drops])for(const [id,n] of Object.entries(drops??{}))if(!known(id)||!Number.isInteger(n)||n<1||n>512)bad('Invalid wildlife drop.');}
 for(const row of Object.values(data.wildlife)){if(!identity(row.enemy_id)||typeof row.name!=='string'||!row.name.trim())bad('Wildlife needs a name and enemy ID.');for(const key of ['hp','str','def','dex','exp'])numeric(row[key],key,key==='hp'?1:0);numeric(row.spell_cast_chance,'Spell chance',0,100);strings(row.enemy_spells,'Enemy spells');for(const key of ['defeat_drops','charm_drops'])if(!object(row[key]))bad('Wildlife drops must be item quantities.');}
 for(const [id,row] of Object.entries(data.catalysts)){if(!known(id))bad('Unknown catalyst item: '+id);strings(row.disciplines,'Catalyst disciplines');if(!row.disciplines.length||row.disciplines.some(d=>!['smithing','tailoring'].includes(d)))bad('Choose smithing or tailoring for a catalyst.');if(row.effect&&!['burn','lifesteal','chain_lightning'].includes(row.effect))bad('Unknown catalyst weapon effect.');if(row.stat&&!['def_mod','wet_resist','atk','def','dex_mod','tum_resist'].includes(row.stat))bad('Unknown catalyst bonus stat.');if(!row.effect&&!row.stat)bad('A catalyst needs an effect or a bonus stat.');if(row.stat)numeric(row.amount,'Catalyst bonus',-100,100);}
 for(const key of ['weights_low','weights_high','meal_bonus','gather_bonus','meal_duration'])if(!Array.isArray(data.tuning[key])||data.tuning[key].length!==5||data.tuning[key].some(n=>!Number.isFinite(n)||n<0))bad('Invalid five-tier tuning: '+key);
 for(const key of ['weights_low','weights_high'])if(Math.abs(data.tuning[key].reduce((a,b)=>a+b,0)-100)>.001)bad('Rarity weights must total 100.');
 if(!(data.tuning.xp_base>0)||!(data.tuning.xp_per_level>0)||data.tuning.burn_min<0||data.tuning.burn_max>100||data.tuning.burn_min>data.tuning.burn_max)bad('Invalid XP or cooking bounds.');
 for(const [key,value] of Object.entries(data.tuning))if(!Array.isArray(value))numeric(value,'Crafting '+key);
 return true;
}
validateCrafting(craftingData);
export function craftingCatalog(data=craftingData){
 const result={...data.items,...data.materials};
 for(const [id,name] of [['crafted_longsword','Longsword'],['crafted_greatblade','Greatblade']])result[id]={...data.items.short_sword,item_id:id,name,base_name:name,atk:15,pool_template:false};
 for(const style of data.bases.styles){const id='style_'+style.id;result[id]={item_id:id,name:style.name+' Trim',category:'ingredient',stackable:true,value:12,style:style.id,desc:'Selects the '+style.name+' appearance when tailoring.'};}
 return result;
}
export const craftCatalog=craftingCatalog();
export function craftingFields(p){for(const skill of ['smithing','tailoring','cooking','alchemy']){p[skill+'_level']=clamp(Math.floor(Number(p[skill+'_level'])||1),1,100);p[skill+'_xp']=Math.max(0,Number(p[skill+'_xp'])||0);}p.crafting_journal??={};p.alchemy_journal??={};return p;}
function award(p,skill,amount,data){const t=data.tuning; p[skill+'_xp']+=amount;while(p[skill+'_level']<100&&p[skill+'_xp']>=t.xp_base+t.xp_per_level*p[skill+'_level']){p[skill+'_xp']-=t.xp_base+t.xp_per_level*p[skill+'_level'];p[skill+'_level']++;}if(p[skill+'_level']===100)p[skill+'_xp']=0;}
export function craftingRarity(skill,rnd,data=craftingData,floor=0){const t=clamp((skill-1)/99,0,1),weights=data.tuning.weights_low.map((w,i)=>w+(data.tuning.weights_high[i]-w)*t);let n=rnd(1000000)/1000000*weights.reduce((a,b)=>a+b,0);for(let i=0;i<5;i++)if((n-=weights[i])<0)return Math.max(floor,i);return 4;}
const tags=(id,data)=>data.culinary[id]??data.materials[id]?.cooking_tags??[];
function tagMatch(wanted,available){if(!wanted.length)return true;return available.some((set,i)=>set.includes(wanted[0])&&tagMatch(wanted.slice(1),available.filter((_,j)=>j!==i)));}
export function cookingRecipe(ids,data=craftingData){const matches=data.cooking.filter(r=>r.tags.length===ids.length&&tagMatch(r.tags,ids.map(id=>tags(id,data))));if(matches.length>1)fail('This cooking combination matches conflicting recipes.');return matches[0]??{id:'mixed_meal',buff:'',difficulty:10,kitchen:false};}
export function cookedFood(recipe,tier,data=craftingData){
 const row=data.cooking.find(r=>r.id===recipe)??(recipe==='mixed_meal'?{id:recipe,buff:''}:null);if(!row||!Number.isInteger(tier)||tier<0||tier>4)return null;
 const drink=recipe==='floral_tea',snack=['bread','berry_tart'].includes(recipe),name=recipe.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
 const item={item_id:'cooked__'+recipe+'__'+tier,name:RARITY_ORDER[tier]+' '+name,category:drink?'drink':'food',is_snack:snack,rarity:RARITY_ORDER[tier],value:Math.round((snack?12:18)*(1+tier*.35)),hp_restore:recipe==='mixed_meal'?0:10+tier*4,stamina_restore:8+tier*3,hunger_restore:drink?0:snack?125:167,thirst_restore:drink?167:0,tum_instant:drink?0:3,wet_instant:drink?3:0,pressure_turns:5,tum_per_turn:drink?0:4,wet_per_turn:drink?4:0,tum_target_gain:drink?0:20,wet_target_gain:drink?20:0,desc:'Prepared '+name+'.',cooked:{recipe,tier}};
 if(row.buff)item.meal_buff={kind:row.buff,amount:row.buff==='gather'?data.tuning.gather_bonus[tier]:data.tuning.meal_bonus[tier],turns:data.tuning.meal_duration[tier]};return item;
} // IDs describe the complete food roll so equal meals stack and reconstruct without client fields.
export function craftingBases(data=craftingData){return {...data.bases,garments:[...data.bases.garments,{id:'hat',name:'Hat',category:'head',def:1,value:12,desc:'A sewn {style_lower} hat.'},{id:'sash',name:'Sash',category:'accessory',def:0,value:10,desc:'A {style_lower} sash.'}]};} // Reconstruction and first creation share the same garment catalogue.
export function resolveCraftItem(id,data=currentCraftingData()){if(id.startsWith('cooked__')){const [,r,t]=id.split('__');return cookedFood(r,Number(t),data);}return craftingCatalog(data)[id]??potionFromId(data.alchemy,id)??createBaseGenerator(craftingBases(data)).fromId(id);}
function tailorBase(recipe,style,rnd,data){
 const extra=[{id:'hat',name:'Hat',category:'head',def:1,value:12,desc:'A sewn {style_lower} hat.'},{id:'sash',name:'Sash',category:'accessory',def:0,value:10,desc:'A {style_lower} sash.'}];
 const bases={...data.bases,garments:[...data.bases.garments,...extra]},garment=recipe.family;
 const legal=bases.styles.filter(s=>s.enabled!==false&&(!s.garments||s.garments.includes('*')||s.garments.includes(garment)));
 const chosen=style?legal.find(s=>s.id===style):legal[rnd(legal.length)];if(!chosen)fail('That style cannot dress this garment.');return createBaseGenerator(bases).fromId('gen_'+chosen.id+'_'+garment);
}
export function planCraft(loadout,input,key,{data=currentCraftingData(),loot=data.loot,alchemy=data.alchemy}={}){
 const materials=validateMaterials(input.materials),skill=input.discipline,ids=Object.entries(materials).flatMap(([id,n])=>Array(n).fill(id));
 const p=craftingFields(structuredClone(loadout.player_info)),rnd=seeded(key+':craft'),catalog=craftingCatalog(data),level=p[skill+'_level'];
 const recipe=data.recipes.find(r=>r.discipline===skill&&materialKey(r.ingredients)===materialKey(materials));
 const journalKey=skill+':'+materialKey(materials),first=!p.crafting_journal[journalKey],consumed={...materials};let item,xp=0,burnt=false,message='',colour='';
 if(skill==='alchemy'){
  if(input.station!=='cauldron'&&input.station!=='alchemy_kit')fail('Use a cauldron or alchemy kit.');
  const result=brewPotion(alchemy,catalog,ids,p.alchemy_level,()=>rnd(1000000)/1000000,{kit:input.station==='alchemy_kit',journal:p.alchemy_journal});
  item=result.item;xp=result.xp;burnt=result.mishap;message=result.text??'';colour=result.colour??'';
  if(!burnt)p.alchemy_journal[alchemyKey(ids)]=colour;
  else for(const [field,value] of Object.entries(result.effects??{})){if(field==='wet_instant')p.wet=clamp((p.wet??0)+value,0,100);if(field==='tum_instant'&&!loadout.world?.wet_only_mode)p.tum=clamp((p.tum??0)+value,0,100);if(field==='shame_delta')dignityChange(p,value,loot.tuning);} // Mishaps use the same field names and Dignity rules as the client.
 }else if(skill==='cooking'){
  if(!['kitchen','campfire'].includes(input.station))fail('Use a kitchen or campfire.');
  if(ids.length<2||ids.length>3||ids.some(id=>!tags(id,data).length))fail('Choose two or three edible ingredients.');
  const dish=cookingRecipe(ids,data);if(dish.kitchen&&input.station!=='kitchen')fail('This recipe needs a kitchen.');
  burnt=rnd(10000)<clamp(data.tuning.burn_base+dish.difficulty-level,data.tuning.burn_min,data.tuning.burn_max)*100;
  item=burnt?structuredClone(catalog.burnt_scraps):cookedFood(dish.id,craftingRarity(level,rnd,data),data);
  xp=experience(dish.difficulty,level,first,burnt,data);message=burnt?'The food burned.':'Prepared '+item.name+'.';
 }else{
  if(!recipe)fail('That material combination is not a recipe.');
  const station=recipe.station??(skill==='smithing'?'forge':'sewing_table');if(input.station!==station)fail('Use the correct crafting station.');
  if(skill==='refining')item={...catalog[recipe.output],quantity:recipe.quantity};
  else {
   const catalysts=input.catalysts??[];if(!Array.isArray(catalysts)||catalysts.length>recipe.catalysts||new Set(catalysts).size!==catalysts.length)fail('Too many or duplicate catalysts.');
   for(const id of catalysts){if(!data.catalysts[id]?.disciplines.includes(skill))fail('That catalyst is incompatible.');consumed[id]=(consumed[id]??0)+1;}
   let style='';if(input.style){if(skill!=='tailoring'||!catalog[input.style]?.style)fail('Choose a tailoring style ingredient.');style=catalog[input.style].style;consumed[input.style]=(consumed[input.style]??0)+1;}
   const base=skill==='tailoring'?tailorBase(recipe,style,rnd,data):structuredClone(catalog[recipe.variants[rnd(recipe.variants.length)]]);
   if(!base)fail('The recipe has no valid output.');base.pool_template=false;
   item=createLootRoller(loot,data.bases).roll(base,key,{level:Math.floor(loadout.player_info.level??1),exactLevel:true,rarity:RARITY_ORDER[craftingRarity(level,rnd,data,recipe.floor)],reserved:catalysts.length});
   item.crafted={recipe:recipe.id,discipline:skill,catalysts:[...catalysts]};item.weapon_properties=[];
   for(const id of catalysts){const cat=data.catalysts[id],stat=cat.stat==='def_mod'&&item.category!=='panties'?'def':cat.stat;if(cat.effect)item.weapon_properties.push(cat.effect);if(stat)item[stat]=(item[stat]??0)+cat.amount;if(stat==='wet_resist'&&!['panties','plug'].includes(item.category))item.crafting_wet_bonus=cat.amount;item.loot.bonus.push({id:'catalyst_'+id,guaranteed:true,stats:stat?{[stat]:cat.amount}:{},effect:cat.effect??''});}
   if(catalysts.length)item.desc+=' Guaranteed: '+catalysts.map(id=>catalog[id].name).join(', ')+'.';
   xp=experience(recipe.difficulty,level,first,false,data);
  }
 }
 if(item&&!stackable(item)&&slotsUsed(loadout.inventory)>=99)fail('Make room in your inventory first.');
 for(const [id,n] of Object.entries(consumed)){const have=loadout.inventory.filter(i=>i.item_id===id).reduce((s,i)=>s+(i.quantity??1),0);if(have<n)fail('Missing '+(catalog[id]?.name??id)+'.');}
 if(!burnt)p.crafting_journal[journalKey]={discipline:skill,materials,recipe:recipe?.id??(skill==='cooking'?cookingRecipe(ids,data).id:colour)};
 if(skill!=='refining')award(p,skill,xp,data);
 return {item,player_info:p,consumed,xp,burnt,message:message||(item?'Created '+item.name+'.':'Craft complete.'),journalKey};
} // All validation and rolls precede mutation; the command transaction owns actual consumption.
function experience(difficulty,skill,first,burnt,data){return Math.max(1,Math.round(difficulty*(first?data.tuning.first_mult:1)*(skill-difficulty>data.tuning.grey_margin?data.tuning.grey_mult:1)*(burnt?.5:1)));}
export function applyCraft(loadout,result,{mint=item=>item,spend=()=>{},verified=null}={}){
 const inventory=structuredClone(loadout.inventory);
 for(const [id,count] of Object.entries(result.consumed)){let left=count;for(let i=inventory.length-1;i>=0&&left;i--){const row=inventory[i];if(row.item_id!==id)continue;const tokens=stackTokens(row),eligible=verified?tokens.filter(t=>verified.has(t)):tokens,used=Math.min(left,verified?eligible.length:(row.quantity??1)),spent=eligible.slice(-used);if(!used)continue;for(const token of spent)spend(token);left-=used;const remaining=(row.quantity??1)-used;if(!remaining)inventory.splice(i,1);else{row.quantity=remaining;setStackTokens(row,tokens.filter(t=>!spent.includes(t)));}}}
 if(result.item){const count=result.item.quantity??1;for(let i=0;i<count;i++)addToInventory(inventory,mint({...structuredClone(result.item),quantity:1}));}
 if(inventory.length>512)fail('Your inventory has too many separate stacks.');loadout.inventory=inventory;loadout.player_info=result.player_info;
 return result;
}
