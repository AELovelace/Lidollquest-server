// This module shares the authenticated panel closure; authored text always uses textContent.
let monsterEditorState=null,monsterSearch='',monsterJobs=[];
const monsterSteps=['Basics','Combat','Artwork','Defeat scenes','Review'];
const artCache=new Map();
function renderMonsterList(){
 const list=$('monsterList');clear(list);
 if(!$('monsterSearch')){const search=el('input');search.id='monsterSearch';search.placeholder='Search monsters';search.setAttribute('aria-label','Search monsters');list.before(search);search.oninput=()=>{monsterSearch=search.value.toLowerCase();renderMonsterList();};
  worldButton('Recover unsaved draft',()=>{const saved=sessionStorage.getItem('gm-monster-draft');if(!saved)throw Error('No unsaved draft on this browser.');const state=JSON.parse(saved);editMonster(state.row,true,state);},list.parentElement);}
 for(const row of contentData.monsters.filter(r=>(r.draft.name+' '+r.id).toLowerCase().includes(monsterSearch)))worldButton(row.draft.name+(row.draft.retired?' (retired)':''),()=>editMonster(row),list);
}
function sceneModel(value){
 if(value?.schema===2)return structuredClone(value);
 const result={schema:2};for(const kind of ['first','repeat']){const v=value?.[kind]??{};result[kind]={dialogues:[{id:kind,pages:structuredClone(v.dialogue??[])}],aftermaths:[{id:'aftermath',title:v.title??'After the battle',pages:structuredClone(v.aftermath??[])}]};}return result;
}
function editMonster(row,force=false,recover=null){
 if(!force&&monsterEditorState?.dirty&&!confirm('Discard unsaved changes to the current monster?'))return;
 monsterDraft=structuredClone(row);
 monsterEditorState=recover??{row:monsterDraft,d:structuredClone(row.draft),step:0,wizard:!contentData.monsters.some(r=>r.id===row.draft.id),dirty:false,sceneKind:'first',sceneSection:'dialogues',variant:0,page:0};
 monsterDraft=monsterEditorState.row;renderMonsterEditor();
}
function monsterChanged(){const s=monsterEditorState;s.dirty=true;sessionStorage.setItem('gm-monster-draft',JSON.stringify(s));if($('monsterSaveState'))$('monsterSaveState').textContent='Unsaved changes';}
window.addEventListener('beforeunload',event=>{if(monsterEditorState?.dirty){event.preventDefault();event.returnValue='';}});
async function saveMonster(publish=false){
 const s=monsterEditorState,snapshot=JSON.stringify(s.d),revision=s.row.revision;
 const saved=await worldAction(publish?'content_publish':'content_save',{kind:'monster',id:s.d.id,revision,entry:structuredClone(s.d)});
 if(s!==monsterEditorState)return saved;
 s.row=saved;monsterDraft=saved;if(JSON.stringify(s.d)===snapshot){s.d=structuredClone(saved.draft);s.dirty=false;sessionStorage.removeItem('gm-monster-draft');}else monsterChanged();
 contentData=await api('/gm/content');renderMonsterList();say('ok',publish?'Monster published.':'Draft saved.');return saved; // A failed revision check leaves the local form intact.
}
function bindMonster(parent,label,key,type='text'){const s=monsterEditorState,input=worldField(parent,label,s.d[key],type);input.oninput=()=>{s.d[key]=type==='checkbox'?input.checked:type==='number'?Number(input.value):input.value;monsterChanged();};return input;}
function renderMonsterEditor(){
 const s=monsterEditorState,d=s.d,host=$('monsterEditor');clear(host);host.appendChild(el('h2',null,d.name||'New monster'));
 const status=el('p',null,s.dirty?'Unsaved changes':s.row.revision?'Draft saved · revision '+s.row.revision:s.wizard?'New draft':'Game default ? no override');status.id='monsterSaveState';host.appendChild(status);
 const nav=el('div','row');nav.setAttribute('aria-label',s.wizard?'Creation steps':'Monster sections');host.appendChild(nav);
 monsterSteps.forEach((label,i)=>{const b=worldButton((s.wizard?(i+1)+'. ':'')+label,()=>{s.step=i;renderMonsterEditor();},nav);b.setAttribute('aria-current',s.step===i?'step':'false');});
 const panel=el('section');panel.id='monsterStep';host.appendChild(panel);
 if(s.step===0){const grid=el('div','ench');panel.appendChild(grid);const id=bindMonster(grid,'ID','id');id.disabled=!!s.row.revision||contentData.monsters.some(r=>r.id===d.id);bindMonster(grid,'Name','name');bindMonster(grid,'Roams by default','roaming','checkbox');panel.appendChild(el('p',null,'Publishing makes this monster available to zone pools and manual placement. It does not spawn it automatically.'));}
 if(s.step===1){const grid=el('div','ench');panel.appendChild(grid);for(const [key,label] of Object.entries({hp:'Health',str:'Strength',def:'Defense',dex:'Dexterity',exp:'Experience reward',spell_cast_chance:'Spell chance (0–1)'}))bindMonster(grid,label,key,'number');const spells=el('div','slots');panel.appendChild(spells);for(const id of contentData.spells){const input=worldField(spells,id,(d.enemy_spells??[]).includes(id),'checkbox');input.onchange=()=>{d.enemy_spells=contentData.spells.filter(v=>v===id?input.checked:(d.enemy_spells??[]).includes(v));monsterChanged();};}}
 if(s.step===2)renderMonsterArtwork(panel);
 if(s.step===3)renderMonsterScenes(panel);
 if(s.step===4){panel.appendChild(el('h3',null,'Publication review'));panel.appendChild(el('p',null,`${d.name} (${d.id}) · HP ${d.hp} · STR ${d.str} · DEF ${d.def} · DEX ${d.dex} · XP ${d.exp}`));panel.appendChild(el('p',null,'Spells: '+((d.enemy_spells??[]).join(', ')||'None')+' · Cast chance '+d.spell_cast_chance));
  for(const [key,label] of [['sprite','Map sprite — 32×32'],['battle_sprite','Battle portrait']]){panel.appendChild(el('h4',null,label));monsterArtPreview(panel,d[key],key==='sprite');}
  const scenes=sceneModel(d.defeat??s.row.default_defeat);panel.appendChild(el('p',null,d.defeat?'Admin override scenes':'Game default scenes'));
  for(const kind of ['first','repeat','charm'])if(scenes[kind]){const group=scenes[kind];panel.appendChild(el('p',null,`${kind}: ${group.dialogues.length} dialogue variants, ${group.aftermaths.length} aftermath variants. Equipment: ${(d.defeat_equipment?.[kind]??[]).join(', ')||'None'}`));worldButton('Preview '+kind,()=>previewWorldScene(group.dialogues[0]?.pages??[],0,group.aftermaths[0]?.pages??[]),panel);}
  worldButton('Publish',async()=>{await saveMonster(true);s.wizard=false;renderMonsterEditor();},panel);
 }
 const controls=el('div','row');host.appendChild(controls);worldButton('Save draft',async()=>{await saveMonster();renderMonsterEditor();},controls);
 if(s.step>0)worldButton('Back',()=>{s.step--;renderMonsterEditor();},controls);
 if(s.step<4)worldButton(s.wizard?'Save and continue':'Next',async()=>{if(s.wizard)await saveMonster();s.step++;renderMonsterEditor();},controls);
 worldButton('Duplicate',()=>{const value=structuredClone(d);value.id='new_'+Date.now();value.enemy_id=value.id;value.name+=' copy';if(!value.defeat&&s.row.default_defeat)value.defeat=structuredClone(s.row.default_defeat);editMonster({id:value.id,revision:0,draft:value,history:[]},true);},controls);
 worldButton(d.retired?'Restore monster':'Retire monster',()=>{d.retired=!d.retired;monsterChanged();renderMonsterEditor();},controls);
 const history=worldSelect(controls,'Published history',(s.row.history??[]).map(h=>({id:String(h.revision),name:'Revision '+h.revision})),s.row.history?.[0]?.revision);
 worldButton('Restore revision',async()=>{if(!history.value)throw Error('No published revision to restore.');if(!confirm('Restore and publish this revision? Unsaved edits will be replaced.'))return;const saved=await worldAction('content_rollback',{kind:'monster',id:d.id,revision:s.row.revision,target_revision:Number(history.value)});contentData=await api('/gm/content');editMonster(saved,true);renderMonsterList();},controls);
 worldButton('Reload server draft',()=>{if(s.dirty&&!confirm('Discard unsaved changes and reload the server draft?'))return;const row=contentData.monsters.find(r=>r.id===d.id);return loadWorld().then(()=>editMonster(contentData.monsters.find(r=>r.id===d.id)??row,true));},controls);
}
async function monsterArtPreview(parent,id,map=false,zoom=1){
 const box=el('div','monster-art');parent.appendChild(box);if(!id){box.textContent='No artwork selected';return;}
 try{if(!artCache.has(id))artCache.set(id,api('/gm/asset?id='+encodeURIComponent(id)).catch(e=>{artCache.delete(id);throw e;}));const art=await artCache.get(id);if(!box.isConnected)return;
  const canvas=el('canvas');canvas.width=map?32:160;canvas.height=map?32:160;canvas.style.width=canvas.width*zoom+'px';canvas.style.height=canvas.height*zoom+'px';box.appendChild(canvas);const image=new Image();image.onload=()=>{const ctx=canvas.getContext('2d'),w=art.width/art.frames;ctx.imageSmoothingEnabled=false;const paint=()=>{if(!canvas.isConnected)return;ctx.clearRect(0,0,canvas.width,canvas.height);const frame=map&&art.frames===36?4+Math.floor(Date.now()/2000)%4*8+Math.floor(Date.now()/125)%8:map?Math.floor(Date.now()/125)%art.frames:0;const scale=Math.min(canvas.width/w,canvas.height/art.height);ctx.drawImage(image,frame*w,0,w,art.height,(canvas.width-w*scale)/2,canvas.height-art.height*scale,w*scale,art.height*scale);if(map&&art.frames>1)requestAnimationFrame(paint);};paint();};image.src='data:image/png;base64,'+art.png;
 }catch(e){box.textContent='Artwork unavailable: '+e.message;}
}
function renderMonsterArtwork(panel){
 const s=monsterEditorState,d=s.d,grid=el('div','ench');panel.appendChild(grid);
 for(const [key,label] of [['sprite','Map sprite (32×32)'],['battle_sprite','Battle portrait']]){const box=el('div');grid.appendChild(box);const options=[{id:'',name:'No artwork'},...(contentData.compiledSprites??[]).map(id=>({id})),...contentData.assets.filter(a=>key==='sprite'?a.frames===36||a.frames===1:a.frames===1).map(a=>({id:a.id,name:a.id.slice(0,24)}))];if(d[key]&&!options.some(a=>a.id===d[key]))options.push({id:d[key]});const select=worldSelect(box,label,options,d[key]);const preview=el('div');box.appendChild(preview);const show=()=>{clear(preview);monsterArtPreview(preview,d[key],key==='sprite');if(key==='sprite'){preview.appendChild(el('small',null,'4× preview'));monsterArtPreview(preview,d[key],true,4);}};select.onchange=()=>{d[key]=select.value;monsterChanged();show();};show();
  const upload=worldField(box,'Upload PNG','','file');upload.accept='image/png';const format=key==='sprite'?worldSelect(box,'PNG format',[{id:'1',name:'Single image'},{id:'36',name:'36-frame horizontal strip'}],'1'):null;
  upload.onchange=async()=>{try{const file=upload.files[0];if(!file)return;if(file.size>900000)throw Error('Use a PNG below 900 KB.');const png=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});const asset=await worldAction('art_upload',{png,frames:Number(format?.value??1)});contentData.assets.push(asset);d[key]=asset.id;monsterChanged();renderMonsterEditor();}catch(e){worldError(e);}};
 }
 panel.appendChild(el('h3',null,'Generate artwork'));panel.appendChild(el('p',null,'Generate a four-direction design first. Approve it before spending credits on animation and portrait candidates.'));
 const prompt=worldField(panel,'Describe this monster',s.prompt??d.name,'textarea');prompt.maxLength=2000;prompt.oninput=()=>{s.prompt=prompt.value;monsterChanged();};
 worldButton('Generate design',async()=>{await saveMonster();await worldAction('art_generate',{monster:d.id,revision:s.row.revision,prompt:prompt.value});await refreshMonsterJobs();},panel);
 worldButton('Refresh artwork progress',refreshMonsterJobs,panel);const jobs=el('div');jobs.id='monsterArtJobs';panel.appendChild(jobs);renderMonsterJobs(jobs);void refreshMonsterJobs().catch(worldError);
}
async function refreshMonsterJobs(){const result=await api('/gm/jobs');monsterJobs=result.jobs;const host=$('monsterArtJobs');if(host)renderMonsterJobs(host);}
function renderMonsterJobs(host){
 clear(host);const s=monsterEditorState;for(const job of monsterJobs.filter(j=>j.monster===s.d.id&&(j.content_kind??'monster')==='monster'))renderArtworkJob(host,job,true);
}
function renderArtworkJob(host,job,inside=false){
 const section=el('section');host.appendChild(section);section.appendChild(el('h4',null,job.prompt));section.appendChild(el('p',null,job.status+' · '+job.stage+(job.error?' · '+job.error:'')));
 const action=async(kind,extra={})=>{await worldAction(kind,{id:job.id,job_revision:job.job_revision,...extra});await refreshMonsterJobs();if(!inside)await loadArtJobs();if(job.content_kind==='npc')await npcJobs();};
 if(job.design){section.appendChild(el('p',null,'Design: south · north · east · west'));monsterArtPreview(section,job.design.id);}
 if(job.status==='awaiting_approval')worldButton('Approve design and generate animation + portraits',()=>action('art_approve'),section);
 if(job.walking)monsterArtPreview(section,job.walking.id,true,4);
 for(const portrait of job.portraits??[]){monsterArtPreview(section,portrait.id);if(inside&&job.walking)worldButton('Use this portrait and walking sprite',async()=>{await saveMonster();const saved=await worldAction('art_assign',{id:job.id,job_revision:job.job_revision,revision:monsterEditorState.row.revision,portrait:portrait.id});const s=monsterEditorState;s.row=saved;s.d=structuredClone(saved.draft);s.dirty=false;sessionStorage.removeItem('gm-monster-draft');contentData=await api('/gm/content');renderMonsterEditor();},section);}
 if(['failed','needs_review'].includes(job.status))worldButton(job.status==='needs_review'?'Review and resubmit paid stage':'Retry failed stage',()=>{if(job.status==='needs_review'&&!confirm('Check PixelLab job history and usage first. Submit a new paid job for this stage?'))return;return action('art_retry',{confirm_resubmit:job.status==='needs_review'});},section);
 if(['queued','running','awaiting_approval','needs_review','failed'].includes(job.status))worldButton('Cancel',()=>action('art_cancel'),section);
 if(!inside&&job.content_kind==='npc')worldButton('Open NPC',async()=>{await loadWorld();$('tab-npcs').click();editAuthor('npc',contentData.npcs.find(r=>r.id===job.monster));authorEditors.npc.step=1;renderAuthor('npc');},section);
 if(!inside&&job.monster&&job.content_kind!=='npc')worldButton('Open monster',async()=>{await loadWorld();$('tab-monsters').click();editMonster(contentData.monsters.find(r=>r.id===job.monster));monsterEditorState.step=2;renderMonsterEditor();},section);
}
function renderMonsterScenes(panel){
 const s=monsterEditorState,scenes=sceneModel(s.d.defeat??s.row.default_defeat),source=el('p',null,s.d.defeat?'Admin override':'Game default');panel.appendChild(source);
 const changed=()=>{s.d.defeat=scenes;source.textContent='Admin override';monsterChanged();};
 worldButton('Restore default',()=>{delete s.d.defeat;monsterChanged();renderMonsterEditor();},panel);
 const nav=el('div','row');panel.appendChild(nav);const kinds=Object.keys(scenes).filter(k=>k!=='schema');if(!kinds.includes(s.sceneKind))s.sceneKind='first';
 const kind=worldSelect(nav,'Outcome',kinds.map(id=>({id})),s.sceneKind);kind.onchange=()=>{s.sceneKind=kind.value;s.variant=0;s.page=0;renderMonsterEditor();};
 const section=worldSelect(nav,'Scene phase',[{id:'dialogues',name:'Dialogue'},{id:'aftermaths',name:'Aftermath'}],s.sceneSection);section.onchange=()=>{s.sceneSection=section.value;s.variant=0;s.page=0;renderMonsterEditor();};
 const group=scenes[s.sceneKind],variants=group[s.sceneSection];s.variant=Math.min(s.variant,variants.length-1);
 const layout=el('div','scene-workspace'),variantList=el('div'),pageList=el('div'),form=el('div');layout.append(variantList,pageList,form);panel.appendChild(layout);
 variants.forEach((v,i)=>worldButton(v.id,()=>{s.variant=i;s.page=0;renderMonsterEditor();},variantList));
 worldButton('Add variant',()=>{variants.push({id:'variant_'+Date.now(),pages:[],...(s.sceneSection==='aftermaths'?{title:'After the battle'}:{})});s.variant=variants.length-1;s.page=0;changed();renderMonsterEditor();},variantList);
 const variant=variants[s.variant],pages=variant.pages;
 worldButton('Remove variant',()=>{if(variants.length===1)throw Error('Keep at least one variant.');variants.splice(s.variant,1);s.variant=0;s.page=0;changed();renderMonsterEditor();},variantList);
 const variantName=worldField(variantList,'Variant name',variant.id);variantName.oninput=()=>{variant.id=variantName.value;changed();};
 if(s.sceneSection==='aftermaths'){const title=worldField(variantList,'Aftermath title',variant.title);title.oninput=()=>{variant.title=title.value;changed();};}
 pages.forEach((p,i)=>{p.id??='page_'+i;worldButton((i+1)+'. '+(p.text.slice(0,32)||p.id),()=>{s.page=i;renderMonsterEditor();},pageList);});
 const rerender=()=>{changed();renderMonsterEditor();};
 worldButton('Add page',()=>{pages.push({id:'page_'+Date.now(),text:'',next:'close'});s.page=pages.length-1;rerender();},pageList);
 s.page=Math.min(s.page,Math.max(0,pages.length-1));const page=pages[s.page];
 if(page){form.appendChild(el('small',null,'Page ID: '+page.id));const text=worldField(form,'Text',page.text,'textarea');text.rows=8;text.maxLength=4000;text.oninput=()=>{page.text=text.value;changed();};
  const options=[{id:'',name:'Next page'},{id:'close',name:'End phase'},...pages.map((p,i)=>({id:p.id,name:(i+1)+'. '+(p.text.slice(0,32)||p.id)}))];
  const dest=v=>Number.isInteger(v)?pages[v]?.id:v??'';
  const next=worldSelect(form,'Continue to',options,dest(page.next));next.onchange=()=>{page.next=next.value||null;changed();};
  for(const a of page.actions??[]){const row=el('div','row');form.appendChild(row);const label=worldField(row,'Choice',a.label),target=worldSelect(row,'Go to',options,dest(a.next));label.oninput=()=>{a.label=label.value;changed();};target.onchange=()=>{a.next=target.value||null;changed();};worldButton('Remove choice',()=>{page.actions.splice(page.actions.indexOf(a),1);rerender();},row);}
  worldButton('Add choice',()=>{page.actions??=[];page.actions.push({label:'Continue',next:'close'});rerender();},form);
  if(s.sceneSection==='aftermaths'){const fx=worldField(form,'Effects (JSON, applied once when this aftermath plays: wet_delta, tum_delta, set_wet, set_tum, shame_delta (negative costs Dignity), hunger_delta, thirst_delta, stamina_delta, diaper_wet_delta, diaper_tum_delta)',page.effects?JSON.stringify(page.effects):'');fx.onchange=()=>{const raw=fx.value.trim();if(!raw){delete page.effects;changed();return;}const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Effects must be a JSON object, e.g. {"wet_delta":20}.');page.effects=parsed;changed();};} // The service validates keys and ranges on save (world-content.mjs sceneEffects).
  for(const [label,offset] of [['Move up',-1],['Move down',1]])worldButton(label,()=>{const target=s.page+offset;if(target<0||target>=pages.length)return;[pages[s.page],pages[target]]=[pages[target],pages[s.page]];s.page=target;rerender();},form);
  worldButton('Duplicate page',()=>{pages.splice(s.page+1,0,{...structuredClone(page),id:'page_'+Date.now()});s.page++;rerender();},form);
  worldButton('Delete page',()=>{if(pages.some(p=>p!==page&&(p.next===page.id||(p.actions??[]).some(a=>a.next===page.id))))throw Error('Redirect incoming choices before deleting this page.');pages.splice(s.page,1);rerender();},form);
 }
 worldButton('Preview page',()=>previewWorldScene(pages,s.page),panel);
 worldButton('Preview scene',()=>previewWorldScene(group.dialogues[s.sceneSection==='dialogues'?s.variant:0]?.pages??[],0,group.aftermaths[s.sceneSection==='aftermaths'?s.variant:0]?.pages??[]),panel);
 if(s.sceneKind!=='charm'){const chosen=new Set(s.d.defeat_equipment?.[s.sceneKind]??[]),items=el('div');panel.appendChild(items);const pick=worldSelect(items,'Add forced equipment',[{id:'',name:'Choose equipment'},...contentData.equipment],'');const set=()=>{s.d.defeat_equipment??={};s.d.defeat_equipment[s.sceneKind]=[...chosen];monsterChanged();renderMonsterEditor();};pick.onchange=()=>{if(pick.value)chosen.add(pick.value);set();};for(const id of chosen)worldButton('Remove '+(contentData.equipment.find(i=>i.id===id)?.name??id),()=>{chosen.delete(id);set();},items);}
}
function previewWorldScene(pages,start=0,aftermath=null){
 const dialog=el('dialog'),title=el('h3'),body=el('p'),choices=el('div','row'),controls=el('div','row');dialog.className='scene-preview';dialog.append(title,body,choices,controls);document.body.appendChild(dialog);const history=[];let state={phase:0,index:start},error='';
 const close=()=>{dialog.close();dialog.remove();};dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 function show(){clear(choices);title.textContent=state.phase===0?'Dialogue preview':state.phase===1?'Aftermath preview':'Preview complete';const source=state.phase===0?pages:aftermath,beat=source?.[state.index];
  if(error){body.textContent=error;return;}if(state.phase===2){body.textContent='End of scene. No equipment or gameplay effects were applied.';return;}
  if(!beat){body.textContent='This phase has no pages.';worldButton('Continue',()=>go('close'),choices);return;}body.textContent=beat.text;
  if(beat.actions?.length)for(const a of beat.actions)worldButton(a.label,()=>go(a.next),choices);else worldButton('Continue',()=>go(beat.next),choices);
 }
 function go(next){history.push({...state});const source=state.phase===0?pages:aftermath;let index=next==null?state.index+1:Number.isInteger(next)?next:source.findIndex(p=>p.id===next);if(next==='close'||next==null&&index>=source.length){state=state.phase===0&&aftermath!==null?{phase:1,index:0}:{phase:2,index:0};}else if(index<0||index>=source.length)error='This choice points to an unavailable page: '+next;else state.index=index;show();}
 worldButton('Back',()=>{if(history.length){state=history.pop();error='';show();}},controls);worldButton('Restart',()=>{state={phase:0,index:start};history.length=0;error='';show();},controls);worldButton('Close preview',close,controls);dialog.showModal();show();
}
setInterval(()=>{if(token&&$('monsterArtJobs'))void refreshMonsterJobs().catch(worldError);},5000); // Poll only progress, leaving form fields and selected candidates alone.
