// Browser-local stand-in for the authenticated GM API behind the statically hosted public quest editor.
// scripts/build-public-quest-editor.mjs injects the shipped catalogue (window.LIDOLL_PUBLIC_CATALOG) and the server's own
// validators (window.LIDOLL_PUBLIC_RULES) ahead of this file, so drafts here obey the same rules as the live Story Workshop.
function createPublicWorkshopApi({snapshot,rules,storage,now=()=>Date.now()}){
 const KEY='lidollquest.public-quest-editor.v1',groups={quest:'quests',npc:'npcs',orb:'orbs'},clone=v=>JSON.parse(JSON.stringify(v));
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
 const spells=Object.fromEntries(snapshot.spells.map(id=>[id,true])),equipment=Object.fromEntries(snapshot.items.map(i=>[i.id,i])),sprites=new Set(snapshot.sprites);
 const blank=()=>({flows:{},records:{quest:{},npc:{},orb:{}},flags:{}});
 function read(){let v=null;try{v=JSON.parse(storage.getItem(KEY));}catch{}const s=blank();if(v&&typeof v==='object'){s.flows=v.flows??{};s.flags=v.flags??{};for(const kind of Object.keys(groups))s.records[kind]=v.records?.[kind]??{};}return s;}
 function write(s){try{storage.setItem(KEY,JSON.stringify(s));}catch{fail('This browser blocks site storage, so drafts cannot be kept here. Export a bundle to keep your work.');}}
 const flags=s=>[...Object.values(s.flags).sort((a,b)=>a.id<b.id?-1:1),...snapshot.engineFlags];
 const flowRow=f=>({id:f.id,revision:f.revision,draft:clone(f.draft),published:null,history:[]});
 const record=(kind,id,r)=>({kind,id,revision:r.revision,draft:clone(r.draft),published:null,history:[]});
 const view=()=>({npcs:clone(snapshot.engineNpcs),orbs:[],quests:[],monsters:clone(snapshot.monsters),zones:clone(snapshot.zones),sprites:[...snapshot.sprites],items:clone(snapshot.items)});
 function catalog(){
  const s=read();
  return {enabled:false,publicEditor:true,nodes:rules.FLOW_NODES,faith:snapshot.faith,
   records:{sheets:[],sheetSchemas:{},storyInventory:{},revision:0,enabled:false,...Object.fromEntries(Object.entries(groups).map(([kind,group])=>[group,Object.entries(s.records[kind]).map(([id,r])=>record(kind,id,r))])),
    questCatalog:snapshot.questCatalog,monsters:snapshot.monsters.map(m=>({kind:'monster',id:m.id,revision:0,draft:clone(m),published:clone(m),history:[]})),zones:[],compiledSprites:[...snapshot.sprites],spells:[...snapshot.spells],equipment:clone(snapshot.items),assets:[]},
   flags:flags(s),flagReferences:{},flows:Object.values(s.flows).map(flowRow),...view(),assets:[],placements:[]};
 } // Shipped monsters count as published so battles and kill objectives can reference them; everything authored here stays a draft.
 const assetRef=value=>{if(value===null||value==='')return '';if(typeof value!=='string'||!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)||!sprites.has(value))fail('Choose a compiled sprite. Uploaded artwork is added in the live GM console.');return value;};
 function validateOrb(value){
  const text=(v,max=4000)=>typeof v==='string'&&v.length<=max?v:fail('Invalid orb text.'),integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max?v:fail('Use a whole number between '+min+' and '+max+'.');
  const rgb=value.bg_color??[10,14,8];if(!Array.isArray(rgb)||rgb.length!==3||rgb.some(n=>!Number.isInteger(n)||n<0||n>255))fail('Use a background colour of three 0-255 numbers.');
  const colour=typeof value.colour==='string'&&/^#[0-9a-fA-F]{6}$/.test(value.colour)?value.colour.toLowerCase():fail('Pick the orb colour as #rrggbb.');
  const requires=value.requires??'';if(requires!==''&&(!/^[a-z][a-z0-9_-]{1,79}$/.test(requires)||requires===value.id))fail('Choose another orb that must be read first, or none.');
  const pages=value.pages??[];if(!Array.isArray(pages)||pages.length>64||pages.some(p=>!p||typeof p!=='object'||Array.isArray(p)))fail('Use up to 64 scene pages.');
  const names=new Set(pages.map((p,i)=>p.id??String(i)));if(names.size!==pages.length)fail('Scene page IDs must be unique.');
  const next=v=>Number.isInteger(v)?(v>=0&&v<pages.length?(pages[v].id??String(v)):fail('Scene choice points to an unknown page.')):v==null||v==='close'||names.has(v)?v:fail('Scene choice points to an unknown page.');
  const out={id:value.id,title:text(value.title??'',100).trim()||fail('Give the orb a title.'),colour,bg_color:[...rgb],type_speed:integer(value.type_speed??2,1,10),repeatable:!!value.repeatable,hidden_until_revealed:!!value.hidden_until_revealed,requires,retired:!!value.retired,note:text(value.note??'',400),
   pages:pages.map((p,i)=>({id:text(p.id??String(i),80),text:text(p.text??''),next:next(p.next),...(p.sprite?{sprite:assetRef(p.sprite)}:{}),...(p.sprite_side?{sprite_side:text(p.sprite_side,20)}:{}),...(p.sprite_index!=null?{sprite_index:integer(p.sprite_index,0,10000)}:{}),...(p.title_override?{title_override:text(p.title_override,100)}:{})}))};
  out.story_conditions=rules.validateFlagCondition(value.story_conditions);
  if(!out.pages.length||out.pages.some(p=>!p.text.trim()))fail('Write at least one page, and no empty pages.');
  return out;
 } // Follows the live orb rules closely enough for drafting; the live console re-validates every imported record on save.
 function change(s,a){
  if(a.kind==='monster')fail('Monsters are tuned in the live GM console. Reference the shipped monsters from Battle blocks and kill objectives instead.');
  if(!groups[a.kind]||typeof a.id!=='string'||!/^[a-z][a-z0-9_-]{1,79}$/.test(a.id))fail('Unknown content kind or ID.');
  const old=s.records[a.kind][a.id]??null;if((old?.revision??0)!==(a.revision??0))fail('This draft changed. Refresh before editing.',409);
  const entry={...(a.entry??old?.draft??{}),id:a.id},body=a.kind==='orb'?validateOrb(entry):rules.validateQuestContent(a.kind,entry,{assetRef,spells,equipment,look:value=>rules.validateSpriteLook(value,snapshot.spriteLab.catalog)}); // Offline drafts receive the same layer, colour and accessory checks as live saves.
  s.records[a.kind][a.id]={revision:(old?.revision??0)+1,draft:body};
 }
 function bundle(s,assets){const seen=new Set();for(const a of assets){const key=a.kind+':'+a.id;if(seen.has(key))fail('A bundle contains duplicate assets.');seen.add(key);change(s,a);}}
 function definition(s,entry,publish,assets){
  const v=view(),map={npc:'npcs',orb:'orbs',quest:'quests',monster:'monsters',zone:'zones'};
  for(const a of assets){const group=map[a.kind];if(!group)fail('Unknown asset kind.');v[group]=v[group].filter(x=>x.id!==a.id).concat({...a.entry,id:a.id});}
  return rules.validateFlow(entry,{catalog:v,flags:flags(s),publish});
 }
 const node=r=>r.definition.flow.nodes.find(n=>n.id===r.state.node);
 function next(r,port){const edge=r.definition.flow.edges.find(e=>e.from===r.state.node&&e.port===port);if(!edge)fail('This story has a missing connection.');r.state.node=edge.to;r.state.step++;}
 function run(r,s,outcome){
  for(let budget=0;budget<256;budget++){
   const n=node(r);if(!n)break;
   if(n.type==='end'){r.state.done=true;break;}
   if(['dialogue','narrative','choice'].includes(n.type))break;
   if(n.type==='piety_check'){next(r,rules.pietyMatches(s,n.piety)?'match':'no_match');continue;}
   if(n.type==='condition'){next(r,rules.storyFlagsMatch(s,n.conditions)?'match':'no_match');continue;}
   if(n.type==='objective'){const ready=n.operation==='flag'?rules.storyFlagsMatch(s,n.conditions):!!outcome;if(!ready)break;next(r,'complete');continue;}
   if(n.type==='battle'){if(!outcome)break;next(r,['victory','defeat','retreat'].includes(outcome)?outcome:'retreat');outcome=null;continue;}
   if(['reveal_orb','hide_orb'].includes(n.type)){s.orbVisibility??={};s.orbVisibility[n.ref]=n.type==='reveal_orb';}
   if(n.type==='set_flag'||n.type==='clear_flag')rules.setStoryFlag(s,n.flag,n.type==='set_flag',r.definition.flags);
    if(n.type==='music'){if(n.mode==='keep')s.storyMusic={track:n.track,volume:n.volume};else if(n.mode==='clear')delete s.storyMusic;} // Mirrors story-flows.mjs storyMusic; the offline editor plays no audio.
   next(r,'next');
  }
 } // The same walk as the server's simulation mode: pages pause, checks branch, actions pass straight through.
 function preview(s,input){
  const {flow,issues}=definition(s,input.entry,true,input.assets??[]);
  const memory={orbVisibility:Object.fromEntries(Object.entries(input.orbVisibility??{}).filter(([id,value])=>typeof value==='boolean'&&flow.nodes.some(n=>['reveal_orb','hide_orb'].includes(n.type)&&n.ref===id))),faith:input.faith,fullDungeon:{flags:{...input.flags}},loadout:{player_info:{...input.stats,playerHealth:input.stats?.health??0},childish:input.stats?.childish??0}};
  const r={definition:{flow,flags:flags(s)},state:{node:input.node??flow.nodes.find(n=>['entry','npc_entry'].includes(n.type))?.id??flow.bindings[0]?.entry??flow.nodes.find(n=>rules.triggerTypes.includes(n.type))?.id,step:0,done:false}};
  if(!flow.nodes.some(n=>n.id===r.state.node))fail('Choose a preview entry.');
  run(r,memory,input.outcome??null);
  return {node:node(r),state:r.state,flags:memory.fullDungeon.flags,orbVisibility:memory.orbVisibility,issues};
 }
 function flagSave(s,input){
  const d=input.entry;if(!d||!rules.flagId(d.id)||!/^story_[a-z0-9_]{1,74}$/.test(d.id))fail('Authored flag IDs must start with story_.');
  const old=s.flags[d.id]??null;if((old?.revision??0)!==input.revision)fail('This flag changed. Reload it.');
  if(typeof d.name!=='string'||!d.name.trim()||d.name.length>100||typeof (d.description??'')!=='string'||(d.description??'').length>1000)fail('Give the flag a name and short description.');
  const saved={id:d.id,name:d.name,description:d.description??'',retired:!!d.retired,engineOwned:false,revision:(old?.revision??0)+1};
  s.flags[d.id]=saved;write(s);return saved;
 }
 function act(input){
  if(!input||typeof input!=='object'||typeof input.action!=='string')fail('Unknown action.');
  const s=read();
  switch(input.action){
   case 'flow_save':{
    const old=s.flows[input.id]??null,revision=(old?.revision??0)+1;if((old?.revision??0)!==input.revision)fail('This flow changed. Reload before saving.');
    const assets=input.assets??[];if(!Array.isArray(assets)||assets.length>64)fail('Save at most 64 related assets.');
    bundle(s,assets);const {flow,issues}=definition(s,{...input.entry,id:input.id},false,assets);
    s.flows[flow.id]={id:flow.id,revision,draft:flow};write(s);return {...flowRow(s.flows[flow.id]),issues};
   } // Drafts and the flow commit together, as the live transaction does; a validation failure writes nothing.
   case 'flow_validate':return definition(s,input.entry,false,input.assets??[]);
   case 'flow_preview':return preview(s,input);
   case 'flow_assets_save':{const assets=input.assets;if(!Array.isArray(assets)||!assets.length||assets.length>64)fail('Choose between 1 and 64 shared assets.');bundle(s,assets);write(s);return {assets:assets.map(a=>({kind:a.kind,id:a.id})),published:false};}
   case 'flow_flag_save':return flagSave(s,input);
   case 'flow_references':return [];
   case 'flow_publish':case 'flow_rollback':case 'flow_assets_publish':fail('Publishing happens in the live GM console: export your bundle and hand it to a gamemaster.');
   default:fail('Only the live GM console can do this ('+input.action+'). Export your bundle and hand it to a gamemaster.');
  }
 }
 return async function api(path,body){
  const url=new URL(path,'https://public-quest-editor.invalid');
  if(url.pathname==='/gm/whoami')return {owner:'public',serverTime:now()};
  if(url.pathname==='/gm/flows')return catalog();
  if(url.pathname==='/gm/sprite-lab')return clone(snapshot.spriteLab); // Shipped artwork stays local; designing an NPC needs no account or network.
  if(url.pathname==='/gm/action'&&body)return {ok:true,result:act(body)};
  if(url.pathname==='/gm/asset')fail('Artwork previews are only available in the live GM console.');
  if(url.pathname==='/gm/map')fail('Map placement happens in the live GM console after a gamemaster imports your bundle.');
  fail('This request needs the live GM console: '+url.pathname);
 }; // Same call shape as the authenticated fetch wrapper, so the editor code is identical in both deployments.
}
if(typeof window!=='undefined'&&window.LIDOLL_PUBLIC_CATALOG&&window.LIDOLL_PUBLIC_RULES)window.LIDOLL_STATIC_API=createPublicWorkshopApi({snapshot:window.LIDOLL_PUBLIC_CATALOG,rules:window.LIDOLL_PUBLIC_RULES,storage:window.localStorage});
