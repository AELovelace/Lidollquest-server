// Shared content is projected onto the canvas; edits write to the original bundle record.
// These cards are authoring views, never new executable flow node types.
let workspace=null;
const contentKinds=['quest','npc','orb'];
const blockNames={root:'Settings',stage:'Quest stage',objective:'Objective',completion_flags:'Set flag on completion',branch:'Quest branch',page:'Dialogue page',action:'Player choice',reaction:'Greeting reaction',complete:'Rewards / complete',failed:'Quest failed',close:'End conversation'};
function contentAsset(){return workspace?assets.find(a=>a.kind===workspace.kind&&a.id===workspace.id):null;}
function graph(){return contentAsset()?contentGraph():flow;} // Existing canvas gestures share the active graph's positions.
function contentGraph(){
 const a=contentAsset(),d=a.entry,nodes=[],edges=[],positions=workspace.positions;
 const add=(id,role,data,parent=null,x=0,y=0)=>{
  positions[id]??={x,y};const n={id,role,type:role,data,parent,label:['failed','complete','close'].includes(role)?blockNames[role]:data.name??data.label??blockNames[role],text:data.text??'',outputs:[]};
  for(const key of ['x','y'])Object.defineProperty(n,key,{get:()=>positions[id][key],set:value=>{positions[id][key]=value;}});
  nodes.push(n);return n;
 }; // Keep layout outside canonical definitions so saving never changes runtime fields.
 const link=(n,port,to,set=null)=>{edges.push({from:n.id,port,to,locked:!set});if(set)n.outputs.push({id:port,set});};
 const root=add('root','root',d);
 if(a.kind==='quest'){
  const stages=d.stages??[],dest=key=>['complete','failed'].includes(key)?key:'stage:'+key;
  if(stages.length)link(root,'start',dest(stages[0].id),to=>{const i=stages.findIndex(s=>s.id===to.data.id);stages.unshift(stages.splice(i,1)[0]);});
  stages.forEach((s,i)=>{
   const stage=add('stage:'+s.id,'stage',s,d,320+i*650,0);
   if(!s.branches?.length)link(stage,'next',dest(s.next),to=>{s.next=to.role==='stage'?to.data.id:to.role;});
   (s.objectives??[]).forEach((o,j)=>{const n=add(stage.id+':objective:'+o.id,'objective',o,s,stage.x,260+j*240);n.label=(o.token?'Token ':o.type==='collect'?'Pickup ':'')+(o.text||o.type+' '+(o.target||''));link(stage,'objective '+(j+1),n.id);
    if(o.on_complete_flags?.length){const effect=add(n.id+':completion','completion_flags',{text:o.on_complete_flags.map(id=>cat.flags.find(f=>f.id===id)?.name??id).join('\n')},o,n.x+260,n.y+120);link(n,'on completed',effect.id);}
   }); // Completion actions stay visibly attached to their objective, independent of the stage's exit route.
   (s.branches??[]).forEach((b,j)=>{const n=add(stage.id+':branch:'+b.id,'branch',b,s,stage.x+280,260+j*240);link(stage,b.label||'branch',n.id);link(n,'next',dest(b.to),to=>{b.to=to.role==='stage'?to.data.id:to.role;});});
  });
  add('complete','complete',d.rewards??{},d,320+stages.length*650,0);
  add('failed','failed',d,d,320+stages.length*650,250);
 }else{
  const pages=d[a.kind==='npc'?'dialogue':'pages']??[],dest=key=>key==='close'?'close':'page:'+(Number.isInteger(key)?pages[key]?.id:key);
  if(pages.length)link(root,'greeting',dest(d.story_default||pages[0].id),to=>{if(a.kind==='npc')d.story_default=to.data.id;else{const i=pages.indexOf(to.data);pages.unshift(pages.splice(i,1)[0]);}});
  pages.forEach((p,i)=>{
   const n=add('page:'+p.id,'page',p,d,320+i*320,0);n.label='Page '+(i+1); // Readable labels let editors follow the prose while stable IDs stay in the inspector.
   if(!p.actions?.length)link(n,'next',dest(p.next??'close'),to=>{p.next=to.role==='close'?'close':to.data.id;});
   (p.actions??[]).forEach((c,j)=>{const choice=add(n.id+':action:'+j,'action',c,p,n.x,260+j*240);link(n,c.label||'choice',choice.id);link(choice,'next',dest(c.next??'close'),to=>{c.next=to.role==='close'?'close':to.data.id;});});
  });
  (d.story_reactions??[]).forEach((r,i)=>{const n=add('reaction:'+i,'reaction',r,d,0,260+i*240);n.label='Greeting reaction '+(i+1);link(root,'reaction '+(i+1),n.id);if(r.page)link(n,'page',dest(r.page),to=>{r.page=to.data.id;r.entry='';});else n.outputs.push({id:'page',set:to=>{r.page=to.data.id;r.entry='';}});});
  add('close','close',{},d,320+pages.length*320,0);
 }
 return {nodes,edges,layout:workspace.layout};
}
function workspaceChrome(){
 const a=contentAsset();$('backToFlow').hidden=!a;$('workspaceTitle').textContent=a?(a.entry.name??a.entry.title??a.id)+' · '+a.kind+' blocks':'Story flow';
 $('workspaceHint').textContent=a?'Select one block to edit it. Changes stay in the shared draft.':'Choose shared content to edit its blocks.';
 $('save').textContent=a?'Save content drafts':'Save draft';$('publish').textContent=a?'Publish content…':'Publish…';
 for(const id of ['rollback','play','test'])$(id).disabled=!!a;
 $('validate').textContent=a?'Check blocks':'Validate';
} // The save target is always visible; content editing cannot accidentally save the unrelated flow.
function openContent(a){
 activeAsset=null;$('modal').close();pending=null;issues=[];previewRequest++;previewNode=null;$('preview').hidden=true;
 const url=new URL(location.href);url.searchParams.set('kind',a.kind);url.searchParams.set('id',a.id);url.searchParams.delete('new');window.history.replaceState(null,'',url);
 workspace={kind:a.kind,id:a.id,positions:{},layout:{x:30,y:40,zoom:.8}};selected=new Set(['root']);library();draw();properties();
}
function closeContent(){workspace=null;activeAsset=null;pending=null;issues=[];selected.clear();const url=new URL(location.href);for(const key of ['kind','id','new'])url.searchParams.delete(key);window.history.replaceState(null,'',url);library();draw();properties();}
function contentPalette(){
 const kind=contentAsset().kind;
 return kind==='quest'?{stage:'Quest stage',objective:'Objective',pickup:'Collect item pickup',token:'Collect quest token',delivery:'Deliver quest token',completion_flags:'Set flag on completion',branch:'Quest branch'}:
  kind==='npc'?{page:'Dialogue page',action:'Player choice',reaction:'Greeting reaction'}:{page:'Narrative page'};
}
function contentAdd(type,x,y,target=''){
 const a=contentAsset(),d=a.entry,g=contentGraph(),n=g.nodes.find(n=>selected.has(n.id));
 if(type==='completion_flags'){
  if(!['objective','completion_flags'].includes(n?.role))throw Error('Select the objective that should set this flag.');
  const o=n.role==='objective'?n.data:n.parent,flag=cat.flags.find(f=>!f.engineOwned&&!f.retired&&f.id.startsWith('story_')&&!o.on_complete_flags?.includes(f.id));
  if((o.on_complete_flags?.length??0)>=16)throw Error('An objective can set up to 16 flags.');
  if(!flag)return createCompletionFlag(o);
  checkpoint();o.on_complete_flags??=[];o.on_complete_flags.push(flag.id);selected=new Set([n.role==='objective'?n.id+':completion':n.id]);changed();properties();return;
 } // Adding this action requires an explicit owning objective, just like choices require a page.
 const parent=n?.role==='stage'||n?.role==='page'?n.data:n?.parent;
 if(['objective','pickup','token','delivery','branch'].includes(type)&&!d.stages?.includes(parent))throw Error('Select the quest stage that should own this block first.');
 if(type==='action'&&!d.dialogue?.includes(parent))throw Error('Select the dialogue page for this choice first.');
 checkpoint();let key;
 if(type==='stage'){
  const s=templates.stages(),anchor=n?.role==='branch'?n.data:null;s.name='Stage '+((d.stages?.length??0)+1);d.stages??=[];
  if(anchor){s.next=anchor.to;anchor.to=s.id;d.stages.push(s);}else if(d.stages.includes(parent)&&!parent.branches?.length){s.next=parent.next;parent.next=s.id;d.stages.splice(d.stages.indexOf(parent)+1,0,s);}else if(!d.stages.length)d.stages.push(s);else{const last=d.stages.at(-1);if(last.branches?.length){s.next=last.branches[0].to;last.branches[0].to=s.id;}else{s.next=last.next;last.next=s.id;}d.stages.push(s);}
  key='stage:'+s.id;
 }else if(['objective','pickup','token','delivery'].includes(type)){
  const o=templates.objectives();if(type!=='objective'){o.type=type==='delivery'?'deliver':'collect';o.token=type!=='pickup';o.target=target||(o.token?uid('token'):cat.items[0]?.id??'');o.text=type==='delivery'?'Deliver the quest token.':o.token?'Collect the quest token.':'Collect the item.';}
  parent.objectives??=[];parent.objectives.push(o);key='stage:'+parent.id+':objective:'+o.id;
 }else if(type==='branch'){const b=templates.branches();b.to=parent.next;parent.branches??=[];parent.branches.push(b);key='stage:'+parent.id+':branch:'+b.id;
 }else if(type==='page'){
  const pages=d[a.kind==='npc'?'dialogue':'pages']??=[],p=templates[a.kind==='npc'?'dialogue':'pages']();
  if(pages.includes(parent)&&!parent.actions?.length){p.next=parent.next;parent.next=p.id;}pages.push(p);d[a.kind==='npc'?'dialogue':'pages']=pages;if(a.kind==='npc'&&!d.story_default)d.story_default=p.id;key='page:'+p.id;
 }else if(type==='action'){const c=templates.actions();c.next=parent.next??'close';parent.actions??=[];parent.actions.push(c);key='page:'+parent.id+':action:'+(parent.actions.length-1);
 }else if(type==='reaction'){d.story_reactions??=[];d.story_reactions.push({conditions:{all:[],any:[],none:[]},page:d.story_default??d.dialogue[0]?.id??'',entry:''});key='reaction:'+(d.story_reactions.length-1);}
 if(key&&Number.isFinite(x)&&Number.isFinite(y))workspace.positions[key]={x,y};selected=new Set([key]);changed();library();properties();
} // New stages splice into the selected route, and objectives belong to an explicit stage.
function contentConnect(to){
 const g=contentGraph(),source=g.nodes.find(n=>n.id===pending?.from),dest=g.nodes.find(n=>n.id===to),output=source?.outputs.find(p=>p.id===pending?.port);
 if(!output||!dest)return;
 const allowed=source.role==='root'?(contentAsset().kind==='quest'?['stage']:['page']):source.role==='reaction'?['page']:['stage','branch'].includes(source.role)?['stage','complete','failed']:['page','close'];
 if(!allowed.includes(dest.role))throw Error('Connect this output to '+allowed.map(k=>blockNames[k]).join(' or ')+'.');
 if(source.id===dest.id&&source.role==='stage')throw Error('Quest stages cannot loop back to themselves.');
 checkpoint();output.set(dest);pending=null;changed();properties();
} // Connections update native next/to/default fields, preserving canonical quest and conversation semantics.
function tokenOptions(){
 const found=new Map();
 for(const p of cat.placements??[])if(p.kind==='token')found.set(p.content,{id:p.content,name:p.name||p.content});
 const quests=new Map((cat.records.quests??[]).map(r=>[r.id,r.draft]));for(const a of assets)if(a.kind==='quest')quests.set(a.id,a.entry);
 for(const q of quests.values())for(const s of q.stages??[])for(const o of s.objectives??[])if(o.token&&o.target&&!found.has(o.target))found.set(o.target,{id:o.target,name:o.target});
 return [...found.values()];
} // Targets come from saved placements and current quest drafts, including edits in this browser tab.
function pickupLibrary(host,q){
 const box=el('details',undefined,host);box.open=!!q;el('summary','Pickups & quest tokens',box);
 for(const [kind,rows] of [['token',tokenOptions()],['pickup',cat.items??[]]])for(const row of rows.filter(r=>(r.id+' '+(r.name??'')).toLowerCase().includes(q))){
  const b=button(box,(kind==='token'?'Token: ':'Item: ')+(row.name??row.id),()=>{if(contentAsset()?.kind!=='quest')throw Error('Open a quest and select a stage to add this pickup objective.');contentAdd(kind,undefined,undefined,row.id);});
  b.className='library reference';b.draggable=true;b.ondragstart=e=>e.dataTransfer.setData('application/x-lidoll-flow',JSON.stringify({kind,id:row.id}));
 }
}
function contentSelect(parent,label,obj,key,options){
 const opts=[{id:'',name:'Choose…'},...options];if(obj[key]&&!opts.some(o=>o.id===obj[key]))opts.push({id:obj[key],name:obj[key]+' (current reference)'});
 return field(parent,label,obj,key,'text',opts);
} // Preserve existing native or draft references even when they are absent from a filtered catalogue.
function contentProperties(){
 const a=contentAsset(),d=a.entry,host=$('properties'),g=contentGraph(),n=g.nodes.find(n=>selected.has(n.id))??g.nodes[0];host.replaceChildren();
 el('h2',blockNames[n.role],host);el('p',a.kind+' · '+a.id,host).className='hint';
 if(n.role==='root'){
  if(a.kind==='orb'){field(host,'Hidden until revealed',d,'hidden_until_revealed','checkbox');el('p','Place this orb on the map, then use Reveal orb or Hide orb in a story flow to control its visibility for each character. Reading requirements still apply.',host).className='hint';}
  for(const key of Object.keys(d))if(!['stages','dialogue','pages','story_reactions','rewards','story_default','reset_flags'].includes(key)){
   if(key==='hidden_until_revealed'&&a.kind==='orb')continue;
   if(key==='id'){field(host,'Stable ID',d,key).readOnly=true;continue;}
   if(['givers','quests','prerequisites'].includes(key)){
    const options=referenceOptions(key==='givers'?'npcs':'quests').filter(v=>key!=='prerequisites'||v.id!==a.id);
    contentReferences(host,{givers:'Quest givers',quests:'Offered quests',prerequisites:'Requires completed quests'}[key],d,key,options);continue;
   }
   if(key==='turn_in'){
    const box=el('fieldset',undefined,host);el('legend','Claim rewards',box);field(box,'Where',d.turn_in,'mode','text',[{id:'npc',name:'Return to NPC'},{id:'journal',name:'From journal'}]);contentSelect(box,'Turn-in NPC',d.turn_in,'npc',referenceOptions('npcs'));continue;
   }
   if(key==='repeat'&&a.kind==='quest'){field(host,'Repeat policy',d,key,'text',['once','daily','weekly','cooldown']).addEventListener('change',properties);continue;}
   form(host,{get [key](){return d[key];},set [key](v){d[key]=v;}});
  }
  if(a.kind==='quest')resetFlagProperties(host,d); // Existing drafts also show the optional reset controls without rewriting their schema.
  el('p','Add stages, pages, objectives and choices using the blocks on the left.',host).className='hint';
  if(['npc','orb'].includes(a.kind))button(host,'Save and copy pages to a story flow',async()=>{await saveAssetBundle(false);closeContent();seed(a);});
 }else if(n.role==='objective')objectiveProperties(host,n.data);
 else if(n.role==='completion_flags')completionFlagProperties(host,n.parent);
 else if(n.role==='complete')form(host,n.data);
 else if(n.role==='failed')field(host,'Failure message',d,'failure_text','textarea');
 else if(n.role!=='close'){
  for(const key of Object.keys(n.data)){
   if(['objectives','branches','actions','next','to','page','entry'].includes(key))continue;
   if(key==='quest'){contentSelect(host,'Journal quest',n.data,key,referenceOptions('quests'));continue;}
   if(key==='effect'){field(host,'Quest action',n.data,key,'text',['none','offer','turn_in','branch']);continue;}
   if(key==='mode'){field(host,'Objectives required',n.data,key,'text',[{id:'all',name:'All objectives'},{id:'any',name:'Any objective'}]);continue;}
   if(key==='id'){const id=field(host,'Stable ID',n.data,key);id.readOnly=true;continue;}
   if(['name','text','label'].includes(key)){field(host,{name:'Name',text:n.role==='stage'?'Journal instructions':'Player-facing text',label:'Choice label'}[key],n.data,key,key==='text'?'textarea':'text');continue;}
   form(host,{get [key](){return n.data[key];},set [key](v){n.data[key]=v;}});
  }
  if(n.role==='action'&&!Object.hasOwn(n.data,'branch'))field(host,'Branch ID (branch action)',n.data,'branch');
  if(n.role==='reaction')field(host,'Flow entry (instead of dialogue page)',n.data,'entry').addEventListener('change',()=>{if(n.data.entry)n.data.page='';changed();});
 }
 for(const output of n.outputs){
  const choices=g.nodes.filter(v=>n.role==='root'?(a.kind==='quest'?v.role==='stage':v.role==='page'):n.role==='reaction'?v.role==='page':['stage','branch'].includes(n.role)?['stage','complete','failed'].includes(v.role):['page','close'].includes(v.role));
  const state={to:g.edges.find(e=>e.from===n.id&&e.port===output.id)?.to??''};const input=field(host,'Connect '+output.id,state,'to','text',[{id:'',name:'Choose destination'},...choices.map(v=>({id:v.id,name:v.role==='page'?v.label+' · '+(v.text||'Empty page').slice(0,45):v.label}))]);
  input.onchange=()=>attempt(()=>{pending={from:n.id,port:output.id};contentConnect(input.value);});
 }
 if(n.role==='stage')for(const [type,label] of Object.entries(contentPalette()).filter(([k])=>!['stage','completion_flags'].includes(k)))button(host,'+ '+label,()=>contentAdd(type));
 if(n.role==='completion_flags')button(host,'Delete completion action',contentRemove);
 if(n.role==='page'&&a.kind==='npc')button(host,'+ Player choice',()=>contentAdd('action'));
 if(n.role==='reaction'){const index=d.story_reactions.indexOf(n.data);button(host,'Move reaction earlier',()=>{if(index>0){checkpoint();[d.story_reactions[index-1],d.story_reactions[index]]=[d.story_reactions[index],d.story_reactions[index-1]];selected=new Set(['reaction:'+(index-1)]);changed();properties();}});}
 if(['stage','objective','branch','page','action','reaction'].includes(n.role)){button(host,'Duplicate block',contentDuplicate);button(host,'Delete block',contentRemove);}
 button(host,'Content settings',()=>{selected=new Set(['root']);draw();properties();});
 const summary=el('details',undefined,host);el('summary','Shared publication bundle',summary);el('ul',undefined,summary).id='assetBundleList';assetBundleSummary();el('p','',host).id='assetStatus';
}
function objectiveProperties(host,o){
 const id=field(host,'Stable ID',o,'id');id.readOnly=true;
 field(host,'Objective type',o,'type','text',cat.records.questCatalog.objectiveTypes).addEventListener('change',()=>{if(o.type==='state'){o.field??='health';o.op??='gte';o.value??=1;}if(o.type==='equipment')o.slot??='';if(!['collect','deliver'].includes(o.type))o.token=false;changed();properties();});
 field(host,'Player instructions',o,'text','textarea');
 if(['collect','deliver'].includes(o.type))field(host,'Quest token (instead of inventory item)',o,'token','checkbox').addEventListener('change',()=>{changed();library();properties();});
 const opts=['collect','deliver'].includes(o.type)?o.token?tokenOptions():cat.items:o.type==='kill'?referenceOptions('monsters'):o.type==='talk'?referenceOptions('npcs'):o.type==='equipment'?cat.items:o.type==='interact'?[...referenceOptions('orbs'),...(cat.placements??[]).filter(p=>p.kind==='interact').map(p=>({id:p.content,name:p.name}))]:[];
 if(!['state','timer'].includes(o.type)){
  if(opts?.length)contentSelect(host,o.token?'Token target':'Target',o,'target',opts).addEventListener('change',()=>{library();properties();});
  else field(host,'Target ID',o,'target');
  if(o.token){const advanced=el('details',undefined,host);el('summary','Create / rename token target',advanced);field(advanced,'Token target ID',o,'target').addEventListener('change',()=>{library();properties();});}
 }
 contentSelect(host,'Zone restriction',o,'zone',cat.zones);const count=field(host,o.type==='timer'?'Seconds':'Required count',o,'count','number');count.min=1;count.step=1;
 field(host,'Credit',o,'sharing','text',['personal','party']);
 if(o.type==='deliver')contentSelect(host,'Delivery NPC',o,'npc',referenceOptions('npcs'));
 if(o.type==='equipment')field(host,'Equipment slot (empty = any)',o,'slot');
 if(o.type==='state'){field(host,'Character field',o,'field','text',cat.records.questCatalog.stateFields);field(host,'Comparison',o,'op','text',['gte','lte','eq']);field(host,'Required value',o,'value','number');}
 o.conditions??=[];arrayForm(host,o,'conditions');
 completionFlagProperties(host,o);
 if(o.token||['interact','visit'].includes(o.type))button(host,'Show / place objective on map',()=>openMap(o.target,{kind:o.token?'token':o.type==='visit'?'location':'interact',zone:o.zone||undefined,content:o.target,name:o.text||o.target}));
 if(o.token)el('p','Accept the quest before collecting. Each placement counts once per stage; place distinct tokens for a count above one.',host).className='hint';
}
function resetFlagProperties(host,d){
 const box=el('fieldset',undefined,host);el('legend','Clear flags when this quest resets',box);
 const enabled=['daily','weekly'].includes(d.repeat),options=cat.flags.filter(f=>!f.engineOwned&&!f.retired&&f.id.startsWith('story_'));
 el('p','Choose up to 16 story flags. After rewards are claimed, clear them once at the next UTC daily or Monday weekly reset, including while offline. Empty means no flags reset. Use flags dedicated to this quest.',box).className='hint';
 if(!enabled)el('p','Choose a daily or weekly repeat policy to add reset flags. Remove selected flags before saving another repeat policy.',box).className='hint';
 for(let i=0;i<(d.reset_flags?.length??0);i++){
  contentSelect(box,'Reset flag '+(i+1),d.reset_flags,i,options);
  button(box,'Remove reset flag '+(i+1),()=>{checkpoint();d.reset_flags.splice(i,1);if(!d.reset_flags.length)delete d.reset_flags;changed();properties();});
 }
 const available=options.find(f=>!d.reset_flags?.includes(f.id));
 button(box,'+ Add reset flag',()=>{checkpoint();d.reset_flags??=[];d.reset_flags.push(available.id);changed();properties();}).disabled=!enabled||!available||(d.reset_flags?.length??0)>=16;
 button(box,'+ Create reset flag',()=>editFlag(null,f=>{checkpoint();d.reset_flags??=[];d.reset_flags.push(f.id);changed();properties();})).disabled=!enabled||(d.reset_flags?.length??0)>=16;
} // Reset targets belong to quest Settings; undo, recovery and publication use the same canonical draft.
function completionFlagProperties(host,o){
 const box=el('fieldset',undefined,host);el('legend','On completed → Set flag',box);
 el('p','Sets these flags to true the first time this objective is met, without waiting for the stage or reward claim. Choose an existing flag or create one here.',box).className='hint';
 for(let i=0;i<(o.on_complete_flags?.length??0);i++){
  contentSelect(box,'Completion flag '+(i+1),o.on_complete_flags,i,cat.flags.filter(f=>!f.engineOwned&&!f.retired&&f.id.startsWith('story_')));
  button(box,'Remove completion flag '+(i+1),()=>{checkpoint();o.on_complete_flags.splice(i,1);if(!o.on_complete_flags.length)delete o.on_complete_flags;changed();properties();});
 }
 button(box,'+ Set flag on completion',()=>contentAdd('completion_flags'));
 button(box,'+ Create completion flag',()=>createCompletionFlag(o)).disabled=(o.on_complete_flags?.length??0)>=16;
} // Both the objective inspector and its connected action block edit the same canonical target list.
function createCompletionFlag(o){
 if((o.on_complete_flags?.length??0)>=16)throw Error('An objective can set up to 16 flags.');
 editFlag(null,f=>{checkpoint();o.on_complete_flags??=[];o.on_complete_flags.push(f.id);changed();properties();});
} // A freshly named flag is saved and attached without leaving the objective's workspace.
function contentReferences(host,label,obj,key,options){
 const box=el('fieldset',undefined,host);el('legend',label,box);
 for(let i=0;i<obj[key].length;i++){contentSelect(box,label+' '+(i+1),obj[key],i,options);button(box,'Remove '+(i+1),()=>{checkpoint();obj[key].splice(i,1);changed();properties();});}
 button(box,'Add '+label.toLowerCase(),()=>{checkpoint();obj[key].push(options.find(o=>!obj[key].includes(o.id))?.id??'');changed();properties();});
} // Named references keep quest-giver and prerequisite editing free of memorized content IDs.
function contentRemove(){
 const a=contentAsset(),d=a.entry,g=contentGraph(),targets=g.nodes.filter(n=>selected.has(n.id));
 if(pending){say('Reconnect this route to another stage or an ending. Ownership links are removed by deleting their child block.');pending=null;return;}
 if(targets.length!==1)throw Error('Select one content block to delete.');const n=targets[0];if(n.role==='completion_flags'){checkpoint();delete n.parent.on_complete_flags;selected=new Set([n.id.slice(0,-':completion'.length)]);changed();properties();return;}if(!['stage','objective','branch','page','action','reaction'].includes(n.role))throw Error('Settings and ending blocks stay in the content graph.');
 checkpoint();
 if(n.role==='stage'){
  const replacement=!n.data.branches?.length&&n.data.next!==n.data.id?n.data.next:'complete';d.stages=d.stages.filter(s=>s!==n.data);
  for(const s of d.stages){if(s.next===n.data.id)s.next=replacement;for(const b of s.branches??[])if(b.to===n.data.id)b.to=replacement;}
 }else if(n.role==='page'){
  const key=a.kind==='npc'?'dialogue':'pages',pages=d[key];for(const p of pages)for(const v of [p,...(p.actions??[])])if(Number.isInteger(v.next))v.next=pages[v.next]?.id??'close';
  d[key]=pages.filter(p=>p!==n.data);for(const p of d[key])for(const v of [p,...(p.actions??[])])if(v.next===n.data.id)v.next='close';
  if(d.story_default===n.data.id)d.story_default=d[key][0]?.id??'';d.story_reactions=(d.story_reactions??[]).filter(r=>r.page!==n.data.id);
 }else{const key={objective:'objectives',branch:'branches',action:'actions',reaction:'story_reactions'}[n.role],array=n.parent[key];array.splice(array.indexOf(n.data),1);if(n.role==='branch'&&!array.length)n.parent.next=n.data.to;}
 selected=new Set(['root']);changed();library();properties();
} // Deleting stages/pages repairs incoming routes; undo restores the complete original record.
function contentDuplicate(){
 const a=contentAsset(),d=a.entry,g=contentGraph(),targets=g.nodes.filter(n=>selected.has(n.id));if(targets.length!==1)throw Error('Select one content block to duplicate.');const n=targets[0];
 if(!['stage','objective','branch','page','action','reaction'].includes(n.role))throw Error('Select a stage, objective, page, choice or reaction to duplicate.');checkpoint();const value=copy(n.data);let key;
 if(n.role==='stage'){value.id=uid('stage');value.name+=' copy';for(const o of value.objectives??[])o.id=uid('objective');for(const b of value.branches??[])b.id=uid('branch');d.stages.splice(d.stages.indexOf(n.data)+1,0,value);if(n.data.branches?.length)n.data.branches[0].to=value.id;else n.data.next=value.id;key='stage:'+value.id;
 }else if(n.role==='page'){value.id=uid('page');d[a.kind==='npc'?'dialogue':'pages'].push(value);key='page:'+value.id;
 }else{const prop={objective:'objectives',branch:'branches',action:'actions',reaction:'story_reactions'}[n.role],array=n.parent[prop];if(value.id)value.id=uid(n.role);array.push(value);key=n.role==='objective'||n.role==='branch'?'stage:'+n.parent.id+':'+n.role+':'+value.id:n.role==='action'?'page:'+n.parent.id+':action:'+(array.length-1):'reaction:'+(array.length-1);}
 workspace.positions[key]={x:n.x+45,y:n.y+80};selected=new Set([key]);changed();properties();
}
function checkContentBlocks(report=true){
 const a=contentAsset(),g=contentGraph(),errors=[],seen=new Set(),stack=new Set();
 const problem=(n,message)=>errors.push({severity:'error',node:n.id,message});
 if(a.kind==='quest'&&a.entry.reset_flags?.length){
  if(!['daily','weekly'].includes(a.entry.repeat))problem(g.nodes[0],'Reset flags require a daily or weekly repeat policy.');
  if(a.entry.reset_flags.length>16)problem(g.nodes[0],'A quest can reset up to 16 flags.');
  for(const id of a.entry.reset_flags)if(!cat.flags.some(f=>f.id===id&&!f.retired&&!f.engineOwned&&id.startsWith('story_')))problem(g.nodes[0],'Choose an active authored reset flag.');
 }
 const visit=id=>{if(stack.has(id)){if(a.kind==='quest')problem(g.nodes.find(n=>n.id===id),'Quest stages cannot form a loop.');return;}if(seen.has(id))return;seen.add(id);stack.add(id);for(const e of g.edges.filter(e=>e.from===id))visit(e.to);stack.delete(id);};visit('root');
 for(const n of g.nodes){
  if(n.role==='stage'&&!seen.has(n.id))problem(n,'Connect this stage to the starting route.');
  if(n.role==='stage'&&!n.data.objectives?.length)problem(n,'Add an objective to this stage.');
  if(n.role==='objective'){
   if(!Number.isSafeInteger(n.data.count)||n.data.count<1)problem(n,'Use a positive whole-number count.');
   if(!['state','timer'].includes(n.data.type)&&!n.data.target&&!n.data.zone)problem(n,'Choose the objective target.');
   if(n.data.type==='deliver'&&!n.data.npc)problem(n,'Choose a delivery NPC.');
   for(const id of n.data.on_complete_flags??[])if(!cat.flags.some(f=>f.id===id&&!f.retired&&!f.engineOwned&&id.startsWith('story_')))problem(n,'Choose an active authored completion flag.');
  }
  if(n.role==='action'&&n.data.effect!=='none'&&!n.data.quest)problem(n,'Choose the quest for this action.');
 }
 for(const e of g.edges)if(!g.nodes.some(n=>n.id===e.to))problem(g.nodes.find(n=>n.id===e.from),'Choose an existing destination.');
 if(a.kind==='quest'&&!a.entry.stages?.length)problem(g.nodes[0],'Add a quest stage.');
 if(a.kind==='npc'&&!a.entry.dialogue?.length)problem(g.nodes[0],'Add a dialogue page.');
 issues=errors;draw();if(report)say(errors.length?errors.map(i=>i.message).join(' · '):'Block checks passed. Server validation also runs when saving or publishing.',!!errors.length);return errors;
} // Local feedback points to the affected cards; server publication remains the authoritative validation.
function rebaseContentHistory(bundle){
 for(const history of [undo,redo])for(let i=0;i<history.length;i++){
  const s=JSON.parse(history[i]);for(const a of s.assets??[])if(bundle.some(saved=>saved.kind===a.kind&&saved.id===a.id)){const row=cat.records[groups[a.kind]]?.find(r=>r.id===a.id);if(row)a.revision=row.revision;}history[i]=JSON.stringify(s);
 }
} // Undo after our own successful save uses the new revision; unrelated refreshed drafts retain conflict protection.
function mapPickupList(host,state){
 const box=el('details',undefined,host);el('summary','Quest token targets',box);
 for(const token of tokenOptions())button(box,token.name+' · '+token.id,()=>{
  state.kind='token';state.content=token.id;state.name=token.name;
  for(const [label,key] of [['Placement kind','kind'],['Content / objective ID','content'],['Label for objective','name']]){const wrap=[...host.querySelectorAll('label')].find(n=>n.firstChild?.textContent===label);if(wrap)wrap.querySelector('input,select').value=state[key];}
  say('Selected token '+token.id+'. Click a free tile to place it.');
 });
 const generated=el('details',undefined,host);el('summary','Generated item pickups on this map',generated);
 for(const p of mapData?.floor?.pickups??[])el('p',(p.name??p.item_id??p.item??p.content??p.id??'Pickup')+' · '+p.x+', '+p.y,generated);
 if(!mapData?.floor?.pickups?.length)el('p','No generated item pickups on this map.',generated);
} // Inventory pickups stay owned by map generation; authored token placements use the shared target IDs.
