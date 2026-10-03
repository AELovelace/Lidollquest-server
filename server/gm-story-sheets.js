function authorshipLabel(row){return row?.authorship?.builtin?' [Built-in] ['+(row.authorship.needs_reauthoring?'Needs human re-authoring':'Human re-authored')+']':'';}
function contentAuthorship(host,a){
 const row=cat.records[groups[a.kind]]?.find(r=>r.id===a.id),review=row?.authorship;if(!review?.builtin)return;
 const badge=el('p',authorshipLabel(row).trim(),host);badge.className=review.needs_reauthoring?'issue':'hint';badge.dataset.authorship=review.needs_reauthoring?'pending':'complete';
 el('p','Built-in origin stays marked after editing. Saving or publishing does not complete human re-authoring.',host).className='hint';
 button(host,review.needs_reauthoring?'Mark human re-authoring complete':'Mark as needing human re-authoring',async()=>{
  await action('flow_content_authorship',{kind:a.kind,id:a.id,revision:review.revision,complete:review.needs_reauthoring});
  await refresh();properties();say('Re-authoring status updated. Content drafts and publication are unchanged.');
 });
} // Keep the editorial checklist separate from unsaved canvas edits and pinned quest definitions.
// Shipped source sheets share the workshop canvas, draft bundle, undo, publication and rollback.
const sheetLabels={native_npc:'NPC conversation',fixture:'Resident / service NPC',narrative:'Story scene',npc_services:'NPC services',presentation:'Shared interaction text',npc_event:'Resident story scene',follower:'Companion conversation',tutor:'Tutorial guide'};
function sheetFocus(){
 const a=contentAsset();let value=a.entry.body,schema=cat.records.sheetSchemas[a.entry.category];
 for(const key of workspace.sheetPath??[]){value=value?.[key];schema=Array.isArray(schema?.sample)?schema.item:schema?.fields?.[key];}
 if(value===undefined){workspace.sheetPath=[];return sheetFocus();}return {value,schema};
} // The breadcrumb points into the same canonical draft, so pages and effects are never detached copies.
function sheetOpen(path){workspace.sheetPath=path;selected=new Set(['root']);pending=null;draw();properties();}
function sheetGraph(){
 const {value}=sheetFocus(),nodes=[],edges=[],positions=workspace.positions;
 const add=(id,data,key,x,y)=>{const label=id==='root'?(workspace.sheetPath?.at(-1)??contentAsset().entry.name):data?.label??data?.name??data?.title??(typeof data?.text==='string'?'Page '+(Number(key)+1):data?.id??String(key));positions[JSON.stringify(workspace.sheetPath)+id]??={x,y};const pos=positions[JSON.stringify(workspace.sheetPath)+id];const n={id,role:'sheet',type:'sheet',label:String(label),text:typeof data==='string'?data:data?.text??data?.line??'',data,key,outputs:[]};for(const axis of ['x','y'])Object.defineProperty(n,axis,{get:()=>pos[axis],set:v=>{pos[axis]=v;}});nodes.push(n);return n;};
 add('root',value,null,0,0);
 if(value&&typeof value==='object')for(const [i,[key,data]] of Object.entries(value).filter(([,v])=>v&&typeof v==='object').entries()){
  add('field:'+key,data,key,320+(i%3)*310,Math.floor(i/3)*420);edges.push({from:'root',port:key,to:'field:'+key,locked:true});
 }
 if(Array.isArray(value))for(const [i,data] of value.entries())if(data===null||typeof data!=='object'){add('field:'+i,data,String(i),320+(i%3)*310,Math.floor(i/3)*240);edges.push({from:'root',port:String(i),to:'field:'+i,locked:true});}
 if(Array.isArray(value))for(const [i,p] of value.entries())if(p&&typeof p==='object'){
  const source=nodes.find(n=>n.id==='field:'+i);
  for(const [port,owner,key] of [['next',p,'next'],...(p.actions??[]).flatMap((a,j)=>[['choice '+(j+1),a,'next'],...Object.keys(a.skill_check??{}).filter(k=>k.endsWith('_next')).map(k=>['choice '+(j+1)+' '+k,a.skill_check,k])]),...Object.keys(p.skill_check??{}).filter(k=>k.endsWith('_next')).map(k=>[k,p.skill_check,k])]){
   const to=owner[key],index=value.findIndex((v,j)=>v?.id===to||j===to);if(index>=0)edges.push({from:source.id,port,to:'field:'+index});
   if(Object.hasOwn(owner,key))source.outputs.push({id:port,set:dest=>{owner[key]=dest.data.id??Number(dest.key);}});
  }
 }
 return {nodes,edges,layout:workspace.layout};
} // Chapters keep large NPC sheets navigable; page links remain visible beside ownership links.
function sheetDefault(schema){
 if(schema.types.includes('array'))return [];
 if(schema.fields?.success_next)return {stat:'CHA',difficulty:10,success_next:'close',partial_next:'close',failure_next:'close',state_modifiers:[],success_effects:[],partial_effects:[],failure_effects:[]};
 if(schema.fields?.type&&schema.fields?.message)return {type:'log',message:'New outcome.'};
 return copy(schema.sample??(schema.types.includes('object')?{}:schema.types.includes('number')?0:schema.types.includes('boolean')?false:''));
} // Newly added checks and effects never inherit another NPC's gifts or once-only receipt keys.
function sheetConnect(to){const g=sheetGraph(),source=g.nodes.find(n=>n.id===pending?.from),dest=g.nodes.find(n=>n.id===to),output=source?.outputs.find(o=>o.id===pending?.port);if(!output||!dest||dest.id==='root')return;checkpoint();output.set(dest);pending=null;changed();properties();}
function sheetForm(host,value,schema,path){
 if(Array.isArray(value)){
  el('p',value.length+' entries. Open a card to edit its pages, choices or effects.',host);
  button(host,'Add entry',()=>{checkpoint();let v=sheetDefault(schema.item);if(v&&typeof v==='object'&&schema.item.fields?.text&&schema.item.fields?.next)v={id:uid('page'),text:'New page.',next:'close',...(schema.item.fields.actions?{actions:[]}:{})};else if(v&&typeof v==='object'&&schema.item.fields?.label&&schema.item.fields?.next)v={label:'New choice',next:'close'};else if(schema.item.fields?.label&&schema.item.fields?.campaign_effects)v={label:'New service',text:'Service completed.',campaign_effects:[]};value.push(v);changed();properties();});
  return;
 }
 for(const [key,v] of Object.entries(value??{})){
  if(v&&typeof v==='object'){button(host,'Open '+key.replaceAll('_',' '),()=>sheetOpen([...path,key]));continue;}
  const control=field(host,key.replaceAll('_',' '),value,key,typeof v==='boolean'?'checkbox':typeof v==='number'?'number':/text|line|message|description/.test(key)?'textarea':'text',key==='default_tree'?Object.keys(contentAsset().entry.body).filter(k=>k.startsWith('dialogue_')&&k!=='dialogue_flag_branches'&&Array.isArray(contentAsset().entry.body[k])):null);
  if(key==='id')control.readOnly=true; // IDs anchor page links and accepted story state.
 }
 const missing=Object.keys(schema.fields??{}).filter(k=>!Object.hasOwn(value,k));
 if(missing.length){const state={key:missing[0]};field(host,'Add supported field',state,'key','text',missing);button(host,'Add field',()=>{checkpoint();value[state.key]=sheetDefault(schema.fields[state.key]);changed();properties();});}
} // Only schema-supported fields are offered; no raw JSON or executable scripts are needed.
function sheetProperties(){
 const a=contentAsset(),host=$('properties'),focus=sheetFocus(),node=sheetGraph().nodes.find(n=>selected.has(n.id))??sheetGraph().nodes[0],path=[...(workspace.sheetPath??[])];host.replaceChildren();
 el('h2',a.entry.name,host);el('p',sheetLabels[a.entry.category]+' · '+a.entry.zone,host);
 contentAuthorship(host,a);
 button(host,'Sheet overview',()=>sheetOpen([]));if(path.length)button(host,'Up one level',()=>sheetOpen(path.slice(0,-1)));
 el('p',['Overview',...path].join(' / '),host).className='hint';
 const row=cat.records.sheets.find(r=>r.id===a.id);if(row?.sourceChanged)el('p','The shipped default changed after this draft was created. Review the default before adopting any changes; your edits are preserved.',host).className='issue';
 if(!path.length&&node.id==='root'){
  el('p','Source: '+a.entry.source+' / '+a.entry.key,host).className='hint';
  const linked=cat.records.quests.filter(r=>JSON.stringify(r.draft).includes(JSON.stringify(a.entry.npc_ref))&&a.entry.npc_ref);for(const q of linked)button(host,'Quest: '+q.draft.name,()=>editAsset('quest',q));
  button(host,'Compare shipped default',async()=>{const entry=await action('flow_sheet_default',{id:a.id});const box=modal();el('h2','Shipped default and current draft',box);for(const [title,value] of [['Shipped default',entry.body],['Current draft',a.entry.body]]){el('h3',title,box);el('pre',JSON.stringify(value,null,2),box);}button(box,'Restore shipped default as draft',()=>{if(!confirm('Replace this sheet draft with the shipped default?'))return;checkpoint();a.entry=entry;changed();properties();$('modal').close();});});
 }
 if(node.id!=='root'){
  const target=node.key;path.push(target);const schema=Array.isArray(focus.value)?focus.schema.item:focus.schema.fields[target];
  if(node.data&&typeof node.data==='object'){button(host,'Open '+node.label,()=>sheetOpen(path));sheetForm(host,node.data,schema,path);}
  else field(host,'Value',focus.value,target,typeof node.data==='number'?'number':typeof node.data==='boolean'?'checkbox':'textarea');
  if(Array.isArray(focus.value)){
   const index=Number(target);button(host,'Move earlier',()=>{if(!index)return;checkpoint();[focus.value[index-1],focus.value[index]]=[focus.value[index],focus.value[index-1]];selected=new Set(['field:'+(index-1)]);changed();properties();});
   button(host,'Remove entry',()=>{checkpoint();focus.value.splice(index,1);selected=new Set(['root']);changed();properties();});
  }
 }else sheetForm(host,focus.value,focus.schema,path);
 const revisions=row?.history??[];if(revisions.length){const state={revision:String(revisions[0].revision)};field(host,'Published revision',state,'revision','text',revisions.map(r=>({id:String(r.revision),name:'Revision '+r.revision})));button(host,'Restore revision as draft',async()=>{if(!confirm('Replace this sheet draft with the selected published revision?'))return;const result=await action('flow_sheet_history',{id:a.id,target_revision:Number(state.revision)});checkpoint();a.entry=result;changed();properties();});}
 el('p','Saving keeps a draft. Publishing changes future interactions; active conversations and accepted quests retain their saved definitions.',host).className='hint';
} // Restore goes through the ordinary draft/publish review, never publishes merely by selecting history.
function sheetLibrary(host,q){
 const rows=cat.records.sheets??[],matches=rows.filter(r=>(r.draft.name+' '+r.draft.zone+' '+r.draft.key+' '+r.draft.category+authorshipLabel(r)).toLowerCase().includes(q));
 const box=el('details',undefined,host);box.id='includedStories';box.open=true;el('summary','Included online stories · '+matches.length,box);
 el('p',rows.length+' converted source sheets · '+cat.records.quests.length+' quest sheets. Open a region below, or search by character, scene or zone. These sheets are separate from the saved-flow selector.',box).className='hint';
 if(!Array.isArray(cat.records.sheets))el('p','This server has not loaded the converted story catalogue. Update and restart the game server, then reload this workshop.',box).className='issue';
 else if(!matches.length)el('p',q?'No included stories match this search. Clear the search to see all regions.':'No included stories are available from this server.',box).className='hint';
 for(const zone of [...new Set(matches.map(r=>r.draft.zone))].sort()){
  const region=el('details',undefined,box);region.open=!!q;el('summary',cat.zones.find(z=>z.id===zone)?.name??zone,region);
  for(const r of matches.filter(r=>r.draft.zone===zone)){const b=button(region,r.draft.name+' · '+sheetLabels[r.draft.category]+authorshipLabel(r)+(r.revision?' [edited]':''),()=>editAsset('sheet',r));b.className='library reference';}
 }
} // The catalogue is independent of saved drafts; untouched shipped interactions are visible too.
function revealIncludedStories(){
 if(!cat)return say('The story catalogue is still loading. Try again when the workshop is ready.');
 $('search').value='';library();
 const box=$('includedStories'),summary=box.querySelector('summary');box.open=true;
 summary.tabIndex=0;summary.focus({preventScroll:true});box.scrollIntoView({block:'nearest'});
 say('Included online stories: open a region and select a sheet. Included quests are in the quest section below.');
} // Browsing clears only the library filter; current canvas edits and draft recovery stay intact.
$('openIncludedStories').onclick=()=>attempt(revealIncludedStories);
