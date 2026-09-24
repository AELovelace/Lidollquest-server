// Story Orbs tab: write orb stories (world-content kind 'orb'), preview them, and scatter chains onto a zone map.
// Shares the panel helpers (el, clear, $, api, say, worldAction, worldButton, worldField, worldSelect, contentData, loadWorld).
let orbEdit=null,orbSearchText='',orbChain=[];
const orbRows=()=>contentData?.orbs??[];
const orbPublished=()=>orbRows().filter(r=>r.published&&!r.published.retired);
function orbColour(key){return orbRows().find(r=>r.id===key)?.published?.colour??'#ffdc3c';}
const orbHex=rgb=>'#'+rgb.map(n=>Number(n).toString(16).padStart(2,'0')).join('');
const orbRgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
function orbToPages(pages){return pages.map(p=>({text:p.text??'',sprite:p.sprite??''}));}
function orbFromPages(pages){return pages.map((p,i)=>({id:'p'+(i+1),text:p.text,next:i+1<pages.length?'p'+(i+2):'close',...(p.sprite?{sprite:p.sprite}:{})}));}
function renderOrbLibrary(){
 const host=$('orbList');clear(host);
 for(const row of orbRows().filter(r=>(r.draft.title+' '+r.id).toLowerCase().includes(orbSearchText))){
  const b=worldButton((row.draft.retired?'(retired) ':'')+row.draft.title+(row.published?'':' (draft)'),()=>editOrb(row),host);
  b.style.borderLeft='10px solid '+(row.draft.colour??'#ffdc3c');
 }
 renderOrbGenerator();
}
function editOrb(row){
 if(orbEdit?.dirty&&!confirm('Discard unsaved orb edits?'))return;
 const d=structuredClone(row.draft);
 orbEdit={row:structuredClone(row),d,pages:orbToPages(d.pages),preview:0,dirty:false};
 renderOrb();
}
function newOrb(){
 const id='orb_'+Date.now();
 editOrb({id,revision:0,history:[],draft:{id,title:'A glowing orb',colour:'#ffdc3c',bg_color:[10,14,8],type_speed:2,repeatable:false,requires:'',retired:false,note:'',pages:[{id:'p1',text:'Write what the player finds here.',next:'close'}]}});
}
function orbDirty(){orbEdit.dirty=true;const s=$('orbSaveState');if(s)s.textContent='Unsaved changes';renderOrbPreview();}
function renderOrb(){
 const s=orbEdit,d=s.d,host=$('orbEditor');clear(host);
 host.appendChild(el('h2',null,d.title));
 const status=el('p',null,s.dirty?'Unsaved changes':'Revision '+s.row.revision+(s.row.published?' · published':' · not published yet'));status.id='orbSaveState';host.appendChild(status);
 const grid=el('div','ench');host.appendChild(grid);
 const id=worldField(grid,'Stable ID',d.id);id.disabled=!!s.row.revision;id.oninput=()=>{d.id=id.value.trim();orbDirty();};
 const title=worldField(grid,'Title (shown on the story box and above the orb)',d.title);title.oninput=()=>{d.title=title.value;orbDirty();};
 const glow=worldField(grid,'Orb glow colour',d.colour,'color');glow.oninput=()=>{d.colour=glow.value;orbDirty();};
 const bg=worldField(grid,'Story box background',orbHex(d.bg_color),'color');bg.oninput=()=>{d.bg_color=orbRgb(bg.value);orbDirty();};
 const speed=worldField(grid,'Typewriter speed (1 slow - 10 fast)',d.type_speed,'number');speed.min=1;speed.max=10;speed.oninput=()=>{d.type_speed=Number(speed.value);orbDirty();};
 const repeat=worldField(grid,'Repeatable (stays lit after reading)',d.repeatable,'checkbox');repeat.onchange=()=>{d.repeatable=repeat.checked;orbDirty();};
 const others=[{id:'',name:'Nothing - always lit'},...orbPublished().filter(r=>r.id!==d.id).map(r=>({id:r.id,name:r.published.title}))];
 const requires=worldSelect(grid,'Must read first (stays dark until then)',others,d.requires??'');requires.onchange=()=>{d.requires=requires.value;orbDirty();};
 const retired=worldField(grid,'Retired (hidden from the world)',d.retired,'checkbox');retired.onchange=()=>{d.retired=retired.checked;orbDirty();};
 const note=worldField(host,'GM note (never shown to players)',d.note??'','textarea');note.oninput=()=>{d.note=note.value;orbDirty();};
 host.appendChild(el('h3',null,'Pages'));
 const sprites=[{id:'',name:'No portrait'},...(contentData.compiledSprites??[]).slice().sort().map(v=>({id:v})),...(contentData.assets??[]).map(a=>({id:a.id,name:'Uploaded / generated: '+a.id}))];
 s.pages.forEach((page,i)=>{
  const box=el('fieldset');box.appendChild(el('legend',null,'Page '+(i+1)));host.appendChild(box);
  const text=worldField(box,'Text',page.text,'textarea');text.rows=5;text.oninput=()=>{page.text=text.value;s.preview=i;orbDirty();};
  const art=worldSelect(box,'Portrait',sprites,page.sprite);art.onchange=()=>{page.sprite=art.value;orbDirty();};
  const row=el('div','row');box.appendChild(row);
  if(i>0)worldButton('Move up',()=>{[s.pages[i-1],s.pages[i]]=[s.pages[i],s.pages[i-1]];orbDirty();renderOrb();},row);
  if(i+1<s.pages.length)worldButton('Move down',()=>{[s.pages[i+1],s.pages[i]]=[s.pages[i],s.pages[i+1]];orbDirty();renderOrb();},row);
  if(s.pages.length>1)worldButton('Remove page',()=>{s.pages.splice(i,1);s.preview=0;orbDirty();renderOrb();},row);
 });
 worldButton('Add page',()=>{s.pages.push({text:'',sprite:''});orbDirty();renderOrb();},host);
 host.appendChild(el('h3',null,'Preview'));
 const preview=el('div');preview.id='orbPreview';host.appendChild(preview);renderOrbPreview();
 const actions=el('div','row');host.appendChild(actions);
 for(const [label,publish] of [['Save draft',false],['Publish',true]])worldButton(label,()=>saveOrb(publish),actions);
 if(s.row.history?.length){
  const history=worldSelect(host,'Published history',s.row.history.map(h=>({id:String(h.revision),name:'Revision '+h.revision+' · '+new Date(h.created).toLocaleString()})),String(s.row.history[0].revision));
  worldButton('Restore this revision',async()=>{const saved=await worldAction('content_rollback',{kind:'orb',id:d.id,revision:s.row.revision,target_revision:Number(history.value)});await reloadOrbs();orbEdit=null;editOrb(saved);say('ok','Orb restored.');},host);
 }
}
function renderOrbPreview(){
 const host=$('orbPreview');if(!host||!orbEdit)return;clear(host);
 const d=orbEdit.d,pages=orbEdit.pages,i=Math.min(orbEdit.preview,pages.length-1),page=pages[i];
 const orb=el('div');orb.style.cssText='width:28px;height:28px;border-radius:50%;margin:4px 0 8px;background:radial-gradient(circle,#fff 0 25%,'+d.colour+' 45%,transparent 72%);box-shadow:0 0 14px '+d.colour;host.appendChild(orb);
 const box=el('div');box.style.cssText='padding:14px;border-radius:8px;white-space:pre-wrap;max-width:640px;color:#f4ecf6;background:'+orbHex(d.bg_color)+';border:2px solid '+d.colour;host.appendChild(box);
 const head=el('strong',null,d.title);head.style.color=d.colour;box.appendChild(head);box.appendChild(el('div',null,page?.text??''));
 const nav=el('div','row');host.appendChild(nav);nav.appendChild(el('span',null,'Page '+(i+1)+' of '+pages.length+' '));
 if(i>0)worldButton('Previous',()=>{orbEdit.preview=i-1;renderOrbPreview();},nav);
 if(i+1<pages.length)worldButton('Next',()=>{orbEdit.preview=i+1;renderOrbPreview();},nav);
}
async function saveOrb(publish){
 const s=orbEdit,entry={...structuredClone(s.d),pages:orbFromPages(s.pages)};
 const saved=await worldAction(publish?'content_publish':'content_save',{kind:'orb',id:s.d.id,revision:s.row.revision,entry});
 s.row=saved;s.d=structuredClone(saved.draft);s.pages=orbToPages(s.d.pages);s.dirty=false;
 await reloadOrbs();renderOrb();say('ok',publish?'Orb published. Placed copies update right away.':'Orb draft saved.');
}
async function reloadOrbs(){contentData=await api('/gm/content');renderOrbLibrary();if(typeof renderPlacementControls==='function'&&mapData)renderPlacementControls();}
function renderOrbGenerator(){
 const zone=$('orbScatterZone'),picked=zone.value;clear(zone);
 for(const z of contentData?.worldZones??[]){const o=el('option',null,z.name+(z.category?' ('+z.category+')':''));o.value=z.id;zone.appendChild(o);}
 if(picked)zone.value=picked;
 const pick=$('orbScatterPick');clear(pick);
 for(const r of orbPublished()){const o=el('option',null,r.published.title);o.value=r.id;pick.appendChild(o);}
 orbChain=orbChain.filter(key=>orbPublished().some(r=>r.id===key));
 const list=$('orbScatterList');clear(list);
 orbChain.forEach((key,i)=>{const li=el('li',null,(orbPublished().find(r=>r.id===key)?.published.title??key)+' ');li.style.color=orbColour(key);worldButton('Remove',()=>{orbChain.splice(i,1);renderOrbGenerator();},li);list.appendChild(li);});
}
function orbChainFrom(key){
 // Walk "must read first" links back to the start, then forward, so the whole chain lands in reading order.
 const live=orbPublished().map(r=>r.published),seen=new Set();let first=live.find(o=>o.id===key);
 while(first?.requires&&!seen.has(first.id)){seen.add(first.id);const before=live.find(o=>o.id===first.requires);if(!before)break;first=before;}
 const chain=[];let at=first;while(at&&!chain.includes(at.id)){chain.push(at.id);at=live.find(o=>o.requires===at.id);}
 return chain;
}
$('orbSearch').oninput=()=>{orbSearchText=$('orbSearch').value.toLowerCase();renderOrbLibrary();};
$('orbNew').onclick=()=>{if(!contentData)return say('err','Open the tab again once the library has loaded.');newOrb();};
$('orbScatterAdd').onclick=()=>{const key=$('orbScatterPick').value;if(key&&!orbChain.includes(key))orbChain.push(key);renderOrbGenerator();};
$('orbScatterChain').onclick=()=>{for(const key of orbChainFrom($('orbScatterPick').value))if(!orbChain.includes(key))orbChain.push(key);renderOrbGenerator();};
$('orbScatter').onclick=async()=>{try{
 if(!orbChain.length)throw Error('Add at least one published orb to the chain.');
 const zone=$('orbScatterZone').value,map=await api('/gm/map?zone='+encodeURIComponent(zone));
 if(!map.floor)throw Error('That map is not ready yet.');
 const result=await worldAction('world_scatter_orbs',{zone,edition:map.edition,revision:map.revision,orbs:[...orbChain],lifetime:$('orbScatterLifetime').value});
 $('orbScatterStatus').textContent='Placed '+orbChain.length+' orb(s) in '+zone+'. The zone now has '+result.placements.filter(p=>p.kind==='orb').length+' orb(s). Open Zones to see or remove them.';
 orbChain=[];renderOrbGenerator();if(mapData?.id===zone){mapData=result;renderWorldMap();}
}catch(e){worldError(e);}};
$('tab-orbs').addEventListener('click',()=>{void loadWorld().then(renderOrbLibrary).catch(worldError);});
