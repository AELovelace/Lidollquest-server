 // Included inside the GM panel closure: use its authenticated api, DOM helpers and status banner.
 var craftData=null,craftDrafts={},craftSelected={},craftControl=0,craftBusy=false;
 var craftLabels={recipes:'Equipment and refining recipes',materials:'Materials',culinary:'Culinary ingredient tags',cooking:'Cooking recipes',regions:'Gathering regions',wildlife:'Wildlife',tuning:'Crafting balance',catalysts:'Catalysts'};
 var craftTiers=['Common','Uncommon','Rare','Epic','Legendary'];
 function craftSection(){return $('craftSection').value;}
 function craftDirtySections(){return craftData?Object.keys(craftDrafts).filter(k=>JSON.stringify(craftDrafts[k])!==JSON.stringify(craftData.data[k])):[];}
 function craftChanged(){
  var dirty=craftDirtySections();$('craftDirty').textContent=dirty.length?'Unsaved: '+dirty.map(k=>craftLabels[k]).join(', '):'All changes saved';
  $('craftRevision').textContent='Revision '+craftData.revision;$('craftJson').value=JSON.stringify(craftDrafts[craftSection()],null,2);
 } // Drafts stay in memory while switching sections; saves and conflicts never discard another section's work.
 function craftItems(category){
  var rows=new Map((craftData.options.items||[]).map(r=>[r.id,r]));
  Object.entries(craftDrafts.materials).forEach(([id,r])=>rows.set(id,{id,name:r.name,category:r.category}));
  return Array.from(rows.values()).filter(r=>!category||r.category===category).sort((a,b)=>a.id.localeCompare(b.id));
 }
 function craftOptions(input,choices,value){
  var rows=choices.map(r=>typeof r==='string'?{id:r,name:r.replace(/_/g,' ')}:r);
  if(value!==undefined&&!rows.some(r=>String(r.id)===String(value)))rows.unshift({id:value,name:String(value)+' (current)'});
  rows.forEach(r=>{var o=el('option',null,r.name+(r.name!==String(r.id)&&r.id?' ('+r.id+')':''));o.value=r.id;input.appendChild(o);});input.value=value??'';
 } // Keep an existing authored value visible even if a different draft has removed its reference.
 function craftField(parent,label,value,set,kind='text',choices=null,path=label){
  var wrap=el('div'),id='craftField'+(++craftControl),caption=el('label',null,label),input=el(choices?'select':kind==='textarea'?'textarea':'input');
  caption.htmlFor=id;input.id=id;input.dataset.field=path;if(choices)craftOptions(input,choices,value);else if(kind==='checkbox'){input.type='checkbox';input.checked=value===true;}else{if(kind!=='textarea'){input.type=kind; if(kind==='number')input.step='any';}input.value=value??'';}
  input.addEventListener(choices||kind==='checkbox'?'change':'input',function(){set(kind==='checkbox'?input.checked:kind==='number'?(input.value===''?null:Number(input.value)):input.value);craftChanged();});
  wrap.append(caption,input);parent.appendChild(wrap);return input;
 } // All controls have visible labels; typed setters preserve unrelated authored fields.
 function craftListField(parent,label,values,set,choices=null,numeric=false){
  var box=el('fieldset'),legend=el('legend',null,label);box.appendChild(legend);parent.appendChild(box);
  function render(){while(box.children.length>1)box.lastChild.remove();values.forEach((value,i)=>{var row=el('div','row');
   craftField(row,label+' '+(i+1),value,v=>{values[i]=v;set(values.slice());},numeric?'number':'text',choices,label+'.'+i);
   var remove=el('button','sm','Remove');remove.type='button';remove.addEventListener('click',()=>{values.splice(i,1);set(values.slice());craftChanged();render();});row.appendChild(remove);box.appendChild(row);
  });var add=el('button','sm','Add '+label.toLowerCase());add.type='button';add.addEventListener('click',()=>{values.push(numeric?0:choices?.[0]?.id??choices?.[0]??'');set(values.slice());craftChanged();render();});box.appendChild(add);}
  render();
 } // Ingredient tags and variants use individual rows instead of comma-separated or JSON entry.
 function craftQuantities(parent,label,value,set){
  var box=el('fieldset');box.appendChild(el('legend',null,label));parent.appendChild(box);
  function render(){while(box.children.length>1)box.lastChild.remove();Object.entries(value).forEach(([id,n])=>{var row=el('div','row');
   craftField(row,'Item',id,next=>{if(next!==id&&Object.hasOwn(value,next)){say('err','That ingredient is already listed.');render();return;}var amount=value[id];delete value[id];value[next]=amount;set({...value});render();},'text',craftItems(),label+'.item');
   craftField(row,'Quantity',n,next=>{value[id]=next;set({...value});},'number',null,label+'.quantity');
   var remove=el('button','sm','Remove');remove.addEventListener('click',()=>{delete value[id];set({...value});craftChanged();render();});row.appendChild(remove);box.appendChild(row);
  });var add=el('button','sm','Add '+label.toLowerCase());add.addEventListener('click',()=>{var item=craftItems().find(r=>!Object.hasOwn(value,r.id));if(item){value[item.id]=1;set({...value});craftChanged();render();}});box.appendChild(add);}
  render();
 } // Quantity maps cannot silently overwrite a duplicate ingredient.
 function craftEntries(){var section=craftSection(),value=craftDrafts[section];return section==='tuning'?[['balance',value]]:Array.isArray(value)?value.map((r,i)=>[String(i),r]):Object.entries(value);}
 function craftRenderList(){
  var list=$('craftList'),query=$('craftSearch').value.toLowerCase().trim();clear(list);
  craftEntries().forEach(([key,row])=>{var id=row.id||key,name=row.name||id;if(query&&!JSON.stringify([id,row]).toLowerCase().includes(query))return;
   var b=el('button',null,name);b.type='button';b.dataset.craftEntry=key;b.style.cssText='display:block;width:100%;text-align:left;margin-bottom:6px';b.setAttribute('aria-pressed',String(craftSelected[craftSection()]===key));
   if(row.discipline)b.appendChild(el('small',null,' — '+row.discipline));b.addEventListener('click',()=>{craftSelected[craftSection()]=key;craftRenderList();craftRenderForm();});list.appendChild(b);
  });if(!list.children.length)list.appendChild(el('p','note','No entries match. Clear the search or add an entry.'));
 }
 function craftRenderForm(){
  var section=craftSection(),key=craftSelected[section],found=craftEntries().find(r=>r[0]===key),form=$('craftForm');clear(form);
  $('craftCopy').disabled=$('craftDelete').disabled=!found||section==='tuning';$('craftNew').disabled=section==='tuning';
  if(!found){$('craftTitle').textContent='Choose an entry';return;}var row=found[1];$('craftTitle').textContent=row.name||row.id||craftLabels[section]+' / '+key;
  function field(key,label,kind='text',choices=null){return craftField(form,label,row[key],v=>{if(key==='station'&&v==='')delete row[key];else row[key]=v;},kind,choices,key);}
  function list(key,label,choices=null){craftListField(form,label,(row[key]||[]).slice(),v=>row[key]=v,choices);}
  function quantities(key,label){craftQuantities(form,label,{...(row[key]||{})},v=>row[key]=v);}
  if(section==='tuning'){
   Object.entries(row).forEach(([k,v])=>{if(Array.isArray(v)){var group=el('fieldset');group.appendChild(el('legend',null,k.replace(/_/g,' ')));v.forEach((n,i)=>craftField(group,craftTiers[i],n,next=>row[k][i]=next,'number',null,k+'.'+i));form.appendChild(group);}else field(k,k.replace(/_/g,' '),'number');});return;
  }
  if(Array.isArray(craftDrafts[section]))field('id','ID');
  else{var identity=craftField(form,'ID',key,()=>{});identity.readOnly=true;form.appendChild(el('p','note','IDs stay fixed because other content may reference them. Duplicate to choose a new ID.'));}
  if(section==='recipes'){
   field('discipline','Discipline','text',['smithing','tailoring','refining']).addEventListener('change',craftRenderForm);
   quantities('ingredients','Ingredients');
   field('station','Station','text',[{id:'',name:'Discipline default'},'forge','sewing_table']);
   if(row.discipline==='refining'){field('output','Output','text',craftItems());field('quantity','Output quantity','number');}
   else{field('family','Family','text',row.discipline==='tailoring'?craftData.options.garments:null);field('grade','Grade','text',['standard','reinforced','refined','masterwork']);
    if(row.discipline==='smithing')list('variants','Weapon variants',craftItems('weapon'));
    field('floor','Minimum rarity','number',craftTiers.map((name,id)=>({id,name})));field('catalysts','Catalyst slots (0–3)','number');field('difficulty','Difficulty','number');}
  }else if(section==='materials'){
   field('name','Name');field('desc','Description','textarea');field('value','Coin value','number');field('rarity','Rarity','text',craftTiers.map(t=>t.toLowerCase()));list('cooking_tags','Cooking tags');
  }else if(section==='culinary'){
   craftListField(form,'Cooking tags',row.slice(),v=>craftDrafts.culinary[key]=v);
  }else if(section==='cooking'){
   list('tags','Required tags');field('buff','Meal bonus','text',[{id:'',name:'None'},'weapon','defense','magic','stamina','gather']);field('difficulty','Difficulty','number');field('kitchen','Kitchen required','checkbox');
  }else if(section==='regions'){
   list('nodes','Resources',craftItems());list('rare','Rare resources',craftItems());list('animals','Animals',Object.entries(craftDrafts.wildlife).map(([id,r])=>({id,name:r.name})));
  }else if(section==='wildlife'){
   field('name','Name');field('enemy_id','Enemy ID');field('temperament','Temperament','text',['neutral','predator']);
   ['hp','str','def','dex','exp','spell_cast_chance'].forEach(k=>field(k,k.replace(/_/g,' '),'number'));list('enemy_spells','Enemy spells');quantities('defeat_drops','Defeat drops');quantities('charm_drops','Charm drops');
  }else if(section==='catalysts'){
   list('disciplines','Disciplines',['smithing','tailoring']);field('effect','Weapon effect','text',[{id:'',name:'None'},'burn','lifesteal','chain_lightning']);field('stat','Bonus stat','text',[{id:'',name:'None'},'def_mod','wet_resist','atk','def','dex_mod','tum_resist']);field('amount','Bonus amount','number');
  }
 } // Each section has a purpose-built form; unknown authored properties remain in its cloned draft.
 function renderCraft(){
  if(!craftData)return;var entries=craftEntries(),section=craftSection();if(!entries.some(r=>r[0]===craftSelected[section]))craftSelected[section]=entries[0]?.[0];craftRenderList();craftRenderForm();craftChanged();
 }
 async function loadCraft(){
  if(craftBusy)return;craftBusy=true;
  try{var next=await api('/gm/crafting'),section=craftSection();craftData=next;craftDrafts=structuredClone(next.data);clear($('craftSection'));
   Object.keys(craftLabels).forEach(k=>{var option=el('option',null,craftLabels[k]);option.value=k;$('craftSection').appendChild(option);});if(section)$('craftSection').value=section;renderCraft();say('ok','Crafting content loaded.');
  }catch(error){say('err',error.message);}finally{craftBusy=false;}
 }
 function craftAdd(copy){
  var section=craftSection(),entries=craftEntries(),current=entries.find(r=>r[0]===craftSelected[section]);if(section==='tuning')return;
  var id=window.prompt('New '+craftLabels[section].toLowerCase()+' ID (lowercase letters, digits, underscores):',copy?(current?.[1]?.id||current?.[0]||'entry')+'_copy':'');if(id===null)return;id=id.trim();
  if(!/^[a-z][a-z0-9_]{1,63}$/.test(id)||['constructor','prototype','__proto__'].includes(id)){say('err','Use a lowercase letter followed by letters, digits or underscores.');return;}
  if(entries.some(([k,r])=>(Array.isArray(craftDrafts[section])?r.id:k)===id)){say('err','That ID already exists.');return;}
  var defaults={recipes:{id,discipline:'smithing',ingredients:{wood:1,steel:1},family:'dagger',variants:['iron_dagger'],grade:'standard',floor:0,catalysts:1,difficulty:10},materials:{item_id:id,name:id.replace(/_/g,' '),category:'ingredient',stackable:true,value:1,rarity:'common',desc:'',cooking_tags:[]},culinary:[],cooking:{id,tags:['',''],buff:'',difficulty:10,kitchen:false},regions:{nodes:[],rare:[],animals:[]},wildlife:{enemy_id:'wild_'+id,name:id.replace(/_/g,' '),wildlife:true,temperament:'neutral',hp:18,str:3,def:1,dex:5,exp:5,enemy_spells:[],spell_cast_chance:0,defeat_drops:{},charm_drops:{}},catalysts:{disciplines:['smithing'],effect:'burn'}};
  var row=copy&&current?structuredClone(current[1]):defaults[section];if(Array.isArray(craftDrafts[section])){row.id=id;craftDrafts[section].push(row);craftSelected[section]=String(craftDrafts[section].length-1);}else{if(section==='materials')row.item_id=id;if(section==='wildlife')row.enemy_id='wild_'+id;craftDrafts[section][id]=row;craftSelected[section]=id;}
  $('craftSearch').value='';renderCraft();
 } // New IDs are explicit; copies retain hidden fields but still pass whole-content validation before saving.
 $('tab-crafting').addEventListener('click',()=>{if(!craftData)loadCraft();});
 $('craftReload').addEventListener('click',()=>{if(!craftDirtySections().length||window.confirm('Discard all unsaved crafting drafts and reload?'))loadCraft();});
 $('craftSection').addEventListener('change',()=>{$('craftSearch').value='';renderCraft();});$('craftSearch').addEventListener('input',craftRenderList);
 $('craftNew').addEventListener('click',()=>craftAdd(false));$('craftCopy').addEventListener('click',()=>craftAdd(true));
 $('craftDelete').addEventListener('click',()=>{var section=craftSection(),key=craftSelected[section];if(section==='tuning'||!window.confirm('Delete this entry from the draft? Save validates its references.'))return;if(Array.isArray(craftDrafts[section]))craftDrafts[section].splice(Number(key),1);else delete craftDrafts[section][key];renderCraft();});
 $('craftSave').addEventListener('click',async()=>{
  if(!craftData||craftBusy)return;var section=craftSection(),submitted=structuredClone(craftDrafts[section]);craftBusy=true;$('craftSave').disabled=true;
  try{var result=await api('/gm/action',{method:'POST',body:{action:'crafting_save',section,value:submitted,revision:craftData.revision,reason:$('craftReason').value}});
   var fresh=result.result||result; // Unwrap the action envelope before updating the revision and saved baseline.
   if(!fresh.data)fresh=await api('/gm/crafting');
   Object.keys(craftDrafts).forEach(k=>{if(k!==section&&JSON.stringify(craftDrafts[k])===JSON.stringify(craftData.data[k]))craftDrafts[k]=structuredClone(fresh.data[k]);});craftData=fresh;
   $('craftReason').value='';renderCraft();say('ok','Crafting section saved.');
  }catch(error){say('err',error.message+' Your draft is still here.');}finally{craftBusy=false;$('craftSave').disabled=false;}
 });
 $('craftApplyJson').addEventListener('click',()=>{var section=craftSection(),previous=craftDrafts[section],raw=$('craftJson').value;try{var value=JSON.parse(raw),array=['recipes','cooking'].includes(section);if(!value||typeof value!=='object'||Array.isArray(value)!==array)throw Error('Keep this section’s '+(array?'list':'object')+' structure.');craftDrafts[section]=value;renderCraft();}catch(error){craftDrafts[section]=previous;renderCraft();$('craftJson').value=raw;say('err','JSON could not be applied: '+error.message);}}); // Malformed advanced rows must not corrupt the working forms.
 $('craftExport').addEventListener('click',()=>{if(!craftData)return;var url=URL.createObjectURL(new Blob([JSON.stringify(Object.assign({version:1},craftDrafts),null,2)+'\n'],{type:'application/json'})),link=el('a');link.href=url;link.download='crafting.json';link.click();URL.revokeObjectURL(url);});
 window.addEventListener('beforeunload',event=>{if(craftDirtySections().length){event.preventDefault();event.returnValue='';}}); // Warn before closing a tab containing unsaved forms.
