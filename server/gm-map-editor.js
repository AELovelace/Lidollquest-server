(()=>{'use strict'; // The GM Map Editor pop-out (/gm/map-editor). Spliced after tile-painter.mjs, so tileAt/paintPlan/walkableCell/reachableCells are in scope. Credentials come from the panel's stored grant and never leave this window.
const $=id=>document.getElementById(id),TILE=32;
const el=(tag,text,parent,cls)=>{const e=document.createElement(tag);if(text!==undefined&&text!==null)e.textContent=text;if(cls)e.className=cls;if(parent)parent.append(e);return e;};
const clear=node=>{while(node.firstChild)node.removeChild(node.firstChild);};
const say=(text,error=false)=>{$('status').textContent=text;$('status').className=error?'error':'';};
const attempt=fn=>Promise.resolve().then(fn).catch(e=>say(e.message??String(e),true));
function grantToken(){let grant;try{grant=JSON.parse(localStorage.getItem('lidollquest.gm.grant'));}catch{}if(!grant?.token)throw Error('Sign in using Advanced GM tools, then reload this window.');return grant.token;}
async function liveApi(path,body,raw=false){const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+grantToken(),...(body?{'Content-Type':'application/json'}:{})},cache:'no-store',...(body?{body:JSON.stringify(body)}:{})});if(raw){if(!r.ok){const data=await r.json().catch(()=>({}));throw Error(data.error_description??data.error??'Request failed');}return r;}const data=await r.json();if(!r.ok)throw Error(data.error_description??data.message??data.error??'Request failed');return data;}
const action=(name,payload={})=>liveApi('/gm/action',{...payload,action:name,request_id:crypto.randomUUID()}).then(r=>r.result);
const params=new URL(location.href).searchParams;
const state={zone:params.get('zone')??'',focus:params.get('focus')??'',content:null,manifest:null,map:null,plan:null,reach:null,tool:'inspect',zoom:1,pan:{x:0,y:0},hover:null,drag:null,pending:[],undone:[],selection:null,clipboard:null,route:null,paths:null,timer:null,images:new Map(),base:null,baseKey:'',opts:{kind:'npc',definition:'',sprite:'sprItem',target:'',name:'',lifetime:'persistent',aggressive:false,respawning:false,remove:false,brush:'wall',brushSize:1,floorTile:1,wallTile:10,scenerySprite:'',spanW:1,spanH:1,solid:true,toilet:false,eraser:false,spawnTarget:'entrance',layer:'cover',layerValue:'1',craterR:9,exitZone:'',exitMode:'move',newZone:'',newStyle:'gap'}};
const TOOLS=[{id:'inspect',name:'Select / move'},{id:'place',name:'Place content'},{id:'terrain',name:'Terrain brush',patch:true},{id:'scenery',name:'Scenery stamp',patch:true},{id:'safe',name:'Safe room',patch:true,dive:true},{id:'spawn',name:'Arrival spawn',patch:true},{id:'layers',name:'Biome layers',patch:true,dive:true,layers:true},{id:'exits',name:'Exits & pads',patch:true,dive:true},{id:'route',name:'NPC routes'}];
const ROUTE_COLOURS=['#ffdc3c','#7fe0c0','#ff8fc4','#77bbff'];
const clockText=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'),clockMinutes=v=>{const [h,m]=String(v).split(':').map(Number);return (h*60+m)||0;};
const LAYER_NAMES={cover:'Cover (tall grass / shelter)',wash:'Wash (riverbed)',shore:'Shoreline',mist:'Pink Mist',crater:'Crater'};
const supportedLayers=()=>Object.keys(LAYER_NAMES).filter(k=>state.plan?.supports[k]);

function art(name){ // An HTMLImageElement for a sprite name, loading it through /gm/asset once; null until it arrives (the draw is retried on load).
 if(typeof name!=='string'||!name)return null;const known=state.images.get(name);if(known!==undefined)return known instanceof HTMLImageElement&&known.complete?known:null;
 if(state.manifest&&!name.startsWith('managed-')&&!state.manifest.sprites[name]&&!(state.manifest.compiled??[]).includes(name)&&!(state.content?.assets??[]).some(a=>a.id===name)){state.images.set(name,null);return null;} /* No artwork anywhere for this name: draw the marker instead of a 404. */
 state.images.set(name,'loading');
 liveApi('/gm/asset?id='+encodeURIComponent(name)).then(record=>{const img=new Image();img.onload=()=>{state.images.set(name,img);state.baseKey='';schedule();};img.onerror=()=>state.images.set(name,null);img.dataset.frames=String(record.frames??1);img.dataset.xorigin=String(record.xorigin??0);img.dataset.yorigin=String(record.yorigin??0);img.src='data:image/png;base64,'+record.png;}).catch(()=>state.images.set(name,null));
 return null;
}
const spriteMeta=name=>state.manifest?.sprites?.[name]??null; // Size and origin for shipped art; compiled monster art has no origin (0,0).
const columnsOf=name=>Math.max(1,Math.floor((spriteMeta(name)?.width??320)/TILE));

function effectiveFloor(){ // The server floor with pending (unsent) patch ops previewed on a copy, so the GM sees the result before applying.
 const base=state.map?.floor;if(!base)return null;if(!state.pending.length)return base;
 const f={...base,walls:base.walls.map(r=>[...r]),props:(base.props??[]).map(r=>[...r]),floors:base.floors?.map(r=>[...r]),wallTiles:base.wallTiles?.map(r=>[...r]),decorTiles:base.decorTiles?.map(r=>[...r]),decorations:[...(base.decorations??[])],fixtures:[...(base.fixtures??[])],safeRooms:[...(base.safeRooms??[])],entries:{...(base.entries??{})},exits:(base.exits??[]).map(e=>({...e})),cover:base.cover?[...base.cover]:undefined,wash:base.wash?[...base.wash]:undefined,shore:base.shore?[...base.shore]:undefined,mist:base.mist?{...base.mist,rows:[...(base.mist.rows??[])]}:undefined,crater:base.crater?{...base.crater}:undefined};
 for(const op of state.pending)previewOp(f,op);return f;
}
function previewOp(f,op){ // Client-side mirror of floor-patches.mjs apply(): good enough for the preview; the server is the authority.
 if(op.kind==='cells')for(const c of op.cells){if(!(c.y in f.walls)||!(c.x in f.walls[c.y]))continue;if(c.wall!==undefined)f.walls[c.y][c.x]=c.wall;if(c.prop!==undefined&&f.props[c.y])f.props[c.y][c.x]=c.prop;if(c.floor!==undefined&&f.floors?.[c.y])f.floors[c.y][c.x]=c.floor;if(c.wallTile!==undefined&&f.wallTiles?.[c.y])f.wallTiles[c.y][c.x]=c.wallTile;if(c.decor!==undefined&&f.decorTiles?.[c.y])f.decorTiles[c.y][c.x]=c.decor;}
 else if(op.kind==='decoration'){const d=op.decoration;if(op.op==='remove'){const m=op.match;f.decorations=f.decorations.filter(p=>!(p.sprite===m.sprite&&p.x===m.x&&p.y===m.y));f.fixtures=f.fixtures.filter(p=>!(p.sprite===m.sprite&&p.x===m.x&&p.y===m.y)||p.id&&m.id&&p.id!==m.id);if(f.props.length)for(const p of state.map.floor.decorations??[])if(p.sprite===m.sprite&&p.x===m.x&&p.y===m.y&&p.solid)for(let dy=0;dy<p.span_h;dy++)for(let dx=0;dx<p.span_w;dx++)if(f.props[p.y+dy])f.props[p.y+dy][p.x+dx]=0;}
  else if(state.plan?.supports.decorations){f.decorations.push({...d});if(d.solid)for(let dy=0;dy<d.span_h;dy++)for(let dx=0;dx<d.span_w;dx++)if(f.props[d.y+dy])f.props[d.y+dy][d.x+dx]=1;}
  else f.fixtures.push({id:'patch-'+op.id,name:'',kind:d.toilet?'toilet':'scenery',sprite:d.sprite,x:d.x,y:d.y,span_w:d.span_w,span_h:d.span_h,solid:d.solid!==false});}
 else if(op.kind==='safeRoom'){if(op.op==='remove')f.safeRooms=f.safeRooms.filter(r=>!(r.x===op.rect.x&&r.y===op.rect.y&&r.w===op.rect.w&&r.h===op.rect.h));else f.safeRooms.push({...op.rect});}
 else if(op.kind==='spawn'){if(op.entrance){if(state.plan?.supports.decorations)f.entrance={...op.entrance};else f.spawn={...op.entrance};}if(op.entries)Object.assign(f.entries,op.entries);}
 else if(op.kind==='layer'){const W=f.width,setCell=(rows,c,v)=>{const row=String(rows[c.y]??'').padEnd(W,'0').slice(0,W);rows[c.y]=row.slice(0,c.x)+v+row.slice(c.x+1);};
  if(op.layer==='cover'||op.layer==='wash'){f[op.layer]??=Array.from({length:f.height},()=>'0'.repeat(W));for(const c of op.cells)setCell(f[op.layer],c,String(c.v));}
  else if(op.layer==='mist'&&f.mist){for(const c of op.cells)setCell(f.mist.rows,c,String(c.v)==='1'?'1':'0');}
  else if(op.layer==='shore'&&f.shore){for(const r of op.rows)f.shore[r.y]=r.edge;}
  else if(op.layer==='crater'&&f.crater)f.crater={...f.crater,...op.crater};}
 else if(op.kind==='exit'&&op.op==='add'){const vertical=op.side==='left'||op.side==='right';if(op.style==='gap'){const w=vertical?1:2,h=vertical?2:1,inward={left:[1,0],right:[-1,0],top:[0,1],bottom:[0,-1]}[op.side]??[0,0],rect={x:vertical?op.to.x:op.to.x,y:vertical?op.to.y:op.to.y};for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++){const cx=rect.x+dx,cy=rect.y+dy;if(f.walls[cy]){f.walls[cy][cx]=0;if(f.walls[cy+inward[1]])f.walls[cy+inward[1]][cx+inward[0]]=0;}}f.exits.push({id:'patch-'+op.id,zone:op.zone,name:op.name,style:'gap',side:op.side,...rect,w,h});}else f.exits.push({id:'patch-'+op.id,zone:op.zone,name:op.name,style:'warp',x:op.to.x,y:op.to.y});}
 else if(op.kind==='exit'){const exit=f.exits.find(e=>op.exit?e.id===op.exit:e.zone===op.zone);if(!exit)return;if(exit.style==='gap'){const vertical=exit.side==='left'||exit.side==='right',w=exit.w??1,h=exit.h??1,inward={left:[1,0],right:[-1,0],top:[0,1],bottom:[0,-1]}[exit.side]??[0,0];for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)if(f.walls[exit.y+dy])f.walls[exit.y+dy][exit.x+dx]=1;const rect={x:vertical?exit.x:op.to.x,y:vertical?op.to.y:exit.y};for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++){const x=rect.x+dx,y=rect.y+dy;if(f.walls[y]){f.walls[y][x]=0;if(f.walls[y+inward[1]])f.walls[y+inward[1]][x+inward[0]]=0;}}f.entries[op.zone]={x:rect.x+inward[0],y:rect.y+inward[1]};Object.assign(exit,rect);}else{Object.assign(exit,{x:op.to.x,y:op.to.y});}}
}

async function loadContent(){state.content=await liveApi('/gm/content');state.manifest??=await liveApi('/gm/tile-artwork');renderZones();}
function renderZones(){const select=$('zone'),groups={hub:'Hubs and rooms',dive:'Dives and overworlds'},byKind={};for(const z of state.content.worldZones)(byKind[z.kind]??=[]).push(z);clear(select);for(const kind of ['dive','hub']){if(!byKind[kind])continue;const group=el('optgroup');group.label=groups[kind];for(const z of byKind[kind].sort((a,b)=>a.name.localeCompare(b.name))){const o=el('option',z.name+' · '+z.id,group);o.value=z.id;}select.append(group);}if(!state.zone||![...select.options].some(o=>o.value===state.zone))state.zone=select.options[0]?.value??'';select.value=state.zone;}
async function loadZone({keepPending=false}={}){
 if(!state.zone)return;const map=await liveApi('/gm/map?zone='+encodeURIComponent(state.zone)+'&paint=1');
 const changed=map.revision!==state.map?.revision||map.id!==state.map?.id,sameZone=map.id===state.map?.id;state.map=map;state.plan=map.floor?paintPlan(map.floor):null;
 if(!keepPending&&changed){state.pending=[];state.undone=[];}
 if(changed){state.baseKey='';state.reach=null;const s=state.selection;state.selection=s?.type?findSource({...clipOf(s),zone:map.id}):sameZone?s:null;if(s&&!state.selection&&state.tool==='inspect')renderToolOptions();} // Keep a selected object selected across refreshes (monsters roam, edits bump the revision); drop it once it is gone.
 if(syncRoute()&&state.tool==='route')renderToolOptions();
 for(const atlas of state.plan?.atlases??[])art(atlas);
 renderBadge();renderControls();renderPatch();renderPending();if(changed&&!state.base)fit();schedule();
}
function renderBadge(){const m=state.map;$('badge').textContent=m?.floor?m.id+' · '+(m.floor.width+'×'+m.floor.height)+' · '+(m.edition??'')+' · rev '+String(m.revision??'').slice(0,8)+(m.job?' · '+m.job.status:'')+(m.patch?' · patch r'+m.patch.revision:''):'map not ready';}
function renderControls(){const m=state.map,d=m?.district;$('regenerate').hidden=!(m?.kind==='dive'&&!m.job)&&!d;$('cancel').hidden=!m?.job;$('lock').hidden=!d;if(d)$('lock').textContent=d.locked?'Unlock layout (follow monthly reset)':'Lock layout (skip monthly reset)';}

function schedule(){if(schedule.pending)return;schedule.pending=true;requestAnimationFrame(()=>{schedule.pending=false;draw();});}
function rebuildBase(f){ // Terrain and scenery at 32 px per tile, rebuilt only when the floor, pending ops or loaded art change.
 const key=[state.map.id,state.map.revision,state.pending.length,JSON.stringify(state.pending.at(-1)??null),$('showLayers').checked,[...state.images.keys()].filter(k=>state.images.get(k) instanceof HTMLImageElement).length].join('|');
 if(state.base&&state.baseKey===key)return state.base;
 const canvas=state.base??document.createElement('canvas');canvas.width=f.width*TILE;canvas.height=f.height*TILE;const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.fillStyle='#160f1c';ctx.fillRect(0,0,canvas.width,canvas.height);
 const plan=paintPlan(f),paintCtx={plan,tilesets:state.manifest?.tilesets},showLayers=$('showLayers').checked,bare=showLayers?f:{...f,cover:undefined,wash:undefined,caveChannels:f.caveChannels};
 for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)for(const layer of tileAt(bare,x,y,paintCtx)){
  if(layer.fill){ctx.fillStyle='rgba('+layer.fill[0]+','+layer.fill[1]+','+layer.fill[2]+','+(layer.fill[3]/255)+')';ctx.fillRect(x*TILE,y*TILE,TILE,TILE);continue;}
  const atlas=art(layer.atlas);if(!atlas){ctx.fillStyle=f.walls[y]?.[x]?'#352840':'#96849d';ctx.fillRect(x*TILE,y*TILE,TILE,TILE);continue;}
  const cols=columnsOf(layer.atlas);ctx.drawImage(atlas,(layer.tile%cols)*TILE,Math.floor(layer.tile/cols)*TILE,TILE,TILE,x*TILE,y*TILE,TILE,TILE);
  if(layer.tint){ctx.globalCompositeOperation='multiply';ctx.fillStyle='rgb('+layer.tint.join(',')+')';ctx.fillRect(x*TILE,y*TILE,TILE,TILE);ctx.globalCompositeOperation='source-over';}
 }
 for(const p of f.decorations??[]){const img=art(p.sprite);if(!img)continue;const fw=img.width/Number(img.dataset.frames||1);ctx.drawImage(img,0,0,fw,img.height,p.x*TILE+TILE/2-Number(img.dataset.xorigin||0),p.y*TILE+TILE/2-Number(img.dataset.yorigin||0),fw,img.height);} // Dive scenery: authored origin at the cell centre.
 for(const x of f.fixtures??[]){ // Hub fixtures: sprites at their footprint, people on their tile, services as markers.
  if(x.kind==='npc'||x.kind==='shop'){fit32(ctx,x.sprite??avatarSprite(x.kind==='shop'?x.id:x.avatar),x.x,x.y)||marker(ctx,x.x,x.y,x.kind==='npc'?'#77bbff':'#be78dc');continue;} // People fit their one cell like in game; 64px Piko canvases drawn unscaled looked twice as big.
  if(x.kind==='bank'){fit32(ctx,'sprItem',x.x,x.y);continue;}if(x.kind==='dumpster'){fit32(ctx,'sprCityTrashCan',x.x,x.y)||marker(ctx,x.x,x.y,'#888');continue;}
  if(typeof x.sprite==='string'&&x.sprite&&x.kind!=='token'){const img=art(x.sprite);if(img){const fw=img.width/Number(img.dataset.frames||1);ctx.drawImage(img,0,0,fw,img.height,x.x*TILE,x.y*TILE,fw,img.height);continue;}}
  if(x.kind==='bed'){ctx.fillStyle='#ecc9df';ctx.fillRect(x.x*TILE+4,x.y*TILE+6,TILE-8,TILE-12);continue;}
  if(x.kind==='token'){fit32(ctx,x.sprite||'sprItem',x.x,x.y,'#ff0');continue;}
  if(x.kind!=='scenery')marker(ctx,x.x,x.y,'#ffcc66');
 }
 state.base=canvas;state.baseKey=key;return canvas;
}
const avatarSprite=id=>state.content?.avatarSprites?.[id]??null;
function fit32(ctx,name,x,y,tint=null){const img=art(name);if(!img)return false;const fw=img.width/Number(img.dataset.frames||1),s=TILE/Math.max(fw,img.height),w=Math.max(1,Math.round(fw*s)),h=Math.max(1,Math.round(img.height*s));ctx.drawImage(img,0,0,fw,img.height,x*TILE+(TILE-w)/2,y*TILE+(TILE-h)/2,w,h);if(tint){ctx.globalCompositeOperation='multiply';ctx.fillStyle=tint;ctx.fillRect(x*TILE+(TILE-w)/2,y*TILE+(TILE-h)/2,w,h);ctx.globalCompositeOperation='source-over';}return true;} // online_dive_sprite: fit one cell.
function marker(ctx,x,y,colour,inset=8){ctx.fillStyle=colour;ctx.fillRect(x*TILE+inset,y*TILE+inset,TILE-inset*2,TILE-inset*2);ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.strokeRect(x*TILE+inset+.5,y*TILE+inset+.5,TILE-inset*2-1,TILE-inset*2-1);}
function draw(){
 const canvas=$('map'),stage=$('stage');canvas.width=stage.clientWidth;canvas.height=stage.clientHeight;const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.fillStyle='#0d0812';ctx.fillRect(0,0,canvas.width,canvas.height);
 const f=effectiveFloor();if(!f){say(state.map?'This map is not ready yet.':'Choose a zone.');return;}
 ctx.setTransform(state.zoom,0,0,state.zoom,state.pan.x,state.pan.y);ctx.drawImage(rebuildBase(f),0,0);
 const m=state.map;ctx.lineWidth=2/state.zoom;
 for(const e of [...(f.exits??[]),...(f.portals??[])]){if(e.style==='warp')fit32(ctx,'sprStairs',e.x,e.y,'#8ff')||marker(ctx,e.x,e.y,'#8ff');else if(e.style==='gap'){ctx.fillStyle='rgba(127,224,192,.35)';ctx.fillRect(e.x*TILE,e.y*TILE,(e.w??1)*TILE,(e.h??1)*TILE);}else{ctx.fillStyle='rgba(185,135,170,.85)';ctx.fillRect(e.x*TILE+4,e.y*TILE+10,TILE-8,TILE-20);}}
 for(const c of f.chests??[])fit32(ctx,'sprItem',c.x,c.y,'#ff0')||marker(ctx,c.x,c.y,'#fc6');for(const p of f.pickups??[])fit32(ctx,p.sprite||'sprItem',p.x,p.y,'#ff0')||marker(ctx,p.x,p.y,'#fc6');
 for(const e of f.enemies??[]){if(e.dead)continue;fit32(ctx,e.definition?.sprite??e.sprite,e.x,e.y)||marker(ctx,e.x,e.y,'#ae243d');if(e.engaged){ctx.strokeStyle='#ff8fc4';ctx.strokeRect(e.x*TILE,e.y*TILE,TILE,TILE);}}
 for(const p of m.placements??[]){if(p.kind==='npc'){fit32(ctx,p.sprite,p.x,p.y)||marker(ctx,p.x,p.y,'#77bbff');}else if(p.kind==='orb'){ctx.fillStyle=orbColour(p.content);ctx.beginPath();ctx.arc(p.x*TILE+16,p.y*TILE+16,10,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(p.x*TILE+16,p.y*TILE+16,4,0,Math.PI*2);ctx.fill();}else if(p.kind==='location'){ctx.strokeStyle='#caff77';ctx.strokeRect(p.x*TILE+6,p.y*TILE+6,TILE-12,TILE-12);}else fit32(ctx,p.sprite||'sprItem',p.x,p.y)||marker(ctx,p.x,p.y,'#caff77');if(p.content===state.focus){ctx.strokeStyle='#fff';ctx.strokeRect(p.x*TILE+1,p.y*TILE+1,TILE-2,TILE-2);}}
 const entrance=f.entrance??f.spawn;if(entrance){ctx.strokeStyle='#7fe0c0';ctx.strokeRect(entrance.x*TILE+2,entrance.y*TILE+2,TILE-4,TILE-4);}for(const e of Object.values(f.entries??{})){ctx.strokeStyle='#7fe0c0';ctx.strokeRect(e.x*TILE+6,e.y*TILE+6,TILE-12,TILE-12);}
 if($('showLayers').checked&&Array.isArray(f.mist?.rows)){ctx.fillStyle='rgba(255,143,196,.28)';for(let y=0;y<f.height;y++){const row=f.mist.rows[y]??'';for(let x=0;x<f.width;x++)if(row.charAt(x)==='1')ctx.fillRect(x*TILE,y*TILE,TILE,TILE);}} // Pink Mist tiles.
 if($('showLayers').checked&&f.crater){ctx.strokeStyle='rgba(255,120,60,.8)';ctx.beginPath();ctx.arc((f.crater.x+.5)*TILE,(f.crater.y+.5)*TILE,(f.crater.r+2.2)*TILE,0,Math.PI*2);ctx.stroke();}
 if($('showSafe').checked)for(const r of f.safeRooms??[]){ctx.strokeStyle='rgba(127,224,192,.7)';ctx.strokeRect(r.x*TILE,r.y*TILE,r.w*TILE,r.h*TILE);}
 if($('showReach').checked){state.reach??=reachableCells(f);ctx.fillStyle='rgba(255,60,90,.35)';for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)if(walkableCell(f,x,y)&&!state.reach.has(x+','+y))ctx.fillRect(x*TILE,y*TILE,TILE,TILE);} // Walkable but cut off from every entrance.
 if($('showPlayers').checked)for(const p of m.players??[]){ctx.fillStyle='#7fe0c0';ctx.fillRect(p.x*TILE+9,p.y*TILE+9,TILE-18,TILE-18);ctx.strokeStyle='#fff';ctx.strokeRect(p.x*TILE+9,p.y*TILE+9,TILE-18,TILE-18);}
 if($('showGrid').checked&&state.zoom>=0.5){ctx.strokeStyle='rgba(0,0,0,.35)';ctx.lineWidth=1/state.zoom;ctx.beginPath();for(let x=0;x<=f.width;x++){ctx.moveTo(x*TILE,0);ctx.lineTo(x*TILE,f.height*TILE);}for(let y=0;y<=f.height;y++){ctx.moveTo(0,y*TILE);ctx.lineTo(f.width*TILE,y*TILE);}ctx.stroke();}
 if($('showRoutes').checked||state.tool==='route')drawRoutes(ctx,f);
 drawClipboard(ctx);
 if(state.selection){const s=state.selection;ctx.strokeStyle='#ffdc3c';ctx.lineWidth=2/state.zoom;ctx.strokeRect(s.x*TILE,s.y*TILE,(s.w??1)*TILE,(s.h??1)*TILE);}
 if(state.hover){const h=state.hover,o=state.opts;ctx.strokeStyle='#fff';ctx.lineWidth=1/state.zoom;
  if(state.tool==='terrain'){const r=Math.floor(o.brushSize/2);ctx.strokeRect((h.x-r)*TILE,(h.y-r)*TILE,o.brushSize*TILE,o.brushSize*TILE);if(state.drag?.rect){const a=state.drag.rect;ctx.strokeStyle='#ffdc3c';ctx.strokeRect(Math.min(a.x,h.x)*TILE,Math.min(a.y,h.y)*TILE,(Math.abs(h.x-a.x)+1)*TILE,(Math.abs(h.y-a.y)+1)*TILE);}}
  else if(state.tool==='scenery'&&o.scenerySprite&&!o.eraser){ctx.globalAlpha=.6;const img=art(o.scenerySprite);if(img){const fw=img.width/Number(img.dataset.frames||1);if(state.plan?.supports.decorations)ctx.drawImage(img,0,0,fw,img.height,h.x*TILE+TILE/2-Number(img.dataset.xorigin||0),h.y*TILE+TILE/2-Number(img.dataset.yorigin||0),fw,img.height);else ctx.drawImage(img,0,0,fw,img.height,h.x*TILE,h.y*TILE,fw,img.height);}ctx.globalAlpha=1;ctx.strokeStyle=o.solid?'#ff8fc4':'#7fe0c0';ctx.strokeRect(h.x*TILE,h.y*TILE,o.spanW*TILE,o.spanH*TILE);}
  else if(state.tool==='layers'&&['cover','wash','mist'].includes(o.layer)){const r=Math.floor(o.brushSize/2);ctx.strokeRect((h.x-r)*TILE,(h.y-r)*TILE,o.brushSize*TILE,o.brushSize*TILE);}
  else if(state.tool==='layers'&&o.layer==='shore'){ctx.strokeStyle='#8ff';ctx.strokeRect(h.x*TILE,h.y*TILE,TILE,TILE);ctx.fillStyle='rgba(136,255,255,.25)';ctx.fillRect(h.x*TILE,h.y*TILE,(f.width-h.x)*TILE,TILE);}
  else if(state.tool==='layers'&&o.layer==='crater'){ctx.strokeStyle='rgba(255,120,60,.9)';ctx.beginPath();ctx.arc((h.x+.5)*TILE,(h.y+.5)*TILE,(Number(o.craterR)+2.2)*TILE,0,Math.PI*2);ctx.stroke();}
  else if(state.tool==='safe'&&state.drag?.rect){const a=state.drag.rect;ctx.strokeStyle='#7fe0c0';ctx.strokeRect(Math.min(a.x,h.x)*TILE,Math.min(a.y,h.y)*TILE,(Math.abs(h.x-a.x)+1)*TILE,(Math.abs(h.y-a.y)+1)*TILE);}
  else ctx.strokeRect(h.x*TILE,h.y*TILE,TILE,TILE);}
 ctx.setTransform(1,0,0,1,0,0);
}
function orbColour(key){return state.content?.orbs?.find(r=>r.id===key)?.published?.colour??'#ffdc3c';}
function fit(){const f=state.map?.floor,stage=$('stage');if(!f)return;state.zoom=Math.max(0.1,Math.min(2,Math.min(stage.clientWidth/(f.width*TILE),stage.clientHeight/(f.height*TILE))));state.pan={x:(stage.clientWidth-f.width*TILE*state.zoom)/2,y:(stage.clientHeight-f.height*TILE*state.zoom)/2};schedule();}
function zoomBy(factor,cx,cy){const stage=$('stage'),ox=cx??stage.clientWidth/2,oy=cy??stage.clientHeight/2,next=Math.max(0.1,Math.min(6,state.zoom*factor));state.pan={x:ox-(ox-state.pan.x)*next/state.zoom,y:oy-(oy-state.pan.y)*next/state.zoom};state.zoom=next;schedule();}
function cellAt(event){const r=$('map').getBoundingClientRect(),x=Math.floor((event.clientX-r.left-state.pan.x)/state.zoom/TILE),y=Math.floor((event.clientY-r.top-state.pan.y)/state.zoom/TILE),f=state.map?.floor;return f&&x>=0&&y>=0&&x<f.width&&y<f.height?{x,y}:null;}

function describe(cell){ // Inspector text for the cell under the cursor.
 const f=effectiveFloor(),m=state.map;if(!f||!cell)return '';const {x,y}=cell,lines=[x+','+y+' · '+(f.walls[y]?.[x]?'wall':f.props?.[y]?.[x]?'prop (scenery)':'floor')+(walkableCell(f,x,y)?(state.reach??=reachableCells(f)).has(x+','+y)?' · reachable':' · CUT OFF':'')];
 if(f.floors)lines.push('tiles: floor '+(f.floors[y]?.[x]??0)+(f.wallTiles?' wall '+(f.wallTiles[y]?.[x]??0):'')+(f.decorTiles?' decor '+(f.decorTiles[y]?.[x]??0):'')+(f.treeTiles?' tree '+(f.treeTiles[y]?.[x]??0):''));
 if(typeof f.cover?.[y]==='string')lines.push('cover: '+({0:'open',1:'tall grass',2:'sheltered'}[f.cover[y].charAt(x)]??'?'));if(typeof f.wash?.[y]==='string'&&f.wash[y].charAt(x)==='1')lines.push('wash (riverbed)');if(f.shore)lines.push('shore column '+f.shore[y]);if(f.caveChannels?.[y]?.[x])lines.push('low channel (floods)');
 for(const r of f.safeRooms??[])if(x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h)lines.push('safe room '+r.x+','+r.y+' '+r.w+'×'+r.h);
 for(const d of f.decorations??[])if(x>=d.x&&x<d.x+d.span_w&&y>=d.y&&y<d.y+d.span_h)lines.push('scenery '+d.sprite+(d.solid?' (solid)':'')+(d.landmark?' → '+d.landmark:''));
 for(const d of f.fixtures??[])if(x>=d.x&&x<d.x+(d.span_w??1)&&y>=d.y&&y<d.y+(d.span_h??1))lines.push(d.kind+' '+(d.name||d.id||'')+(d.sprite?' '+d.sprite:''));
 for(const e of [...(f.exits??[]),...(f.portals??[])])if(x>=e.x&&x<e.x+(e.w??1)&&y>=e.y&&y<e.y+(e.h??1))lines.push((e.style??'exit')+' → '+(e.name??e.zone??e.target??''));
 for(const e of f.enemies??[])if(e.x===x&&e.y===y&&!e.dead)lines.push('monster '+(e.definition?.name??e.type)+(e.manual?' (DM)':'')+(e.engaged?' in combat':''));
 for(const p of m.placements??[])if(p.x===x&&p.y===y)lines.push(p.kind+' '+p.name+' ['+p.content+'] '+p.lifetime+(p.routes?.length?' · '+p.routes.length+' route'+(p.routes.length>1?'s':''):''));
 for(const p of m.players??[])if(p.x===x&&p.y===y)lines.push('player '+p.name);
 for(const c of f.chests??[])if(c.x===x&&c.y===y)lines.push('chest '+c.id);for(const c of f.pickups??[])if(c.x===x&&c.y===y)lines.push('pickup '+c.id);
 const entrance=f.entrance??f.spawn;if(entrance?.x===x&&entrance?.y===y)lines.push('arrival spawn');for(const [zone,e] of Object.entries(f.entries??{}))if(e.x===x&&e.y===y)lines.push('arrival from '+zone);
 return lines.join('\n');
}

function renderPalette(){const host=$('palette');clear(host);const patch=!!state.map?.patch,dive=!!state.plan?.supports.decorations,full=state.map?.id?.startsWith('dungeon-');for(const t of TOOLS){const b=el('button',t.name,host);b.type='button';b.className=state.tool===t.id?'active':'';if(t.patch&&(!patch||full))b.disabled=true;if(t.dive&&!dive)b.disabled=true;if(t.layers&&!supportedLayers().length)b.disabled=true;b.title=t.patch&&!patch?'Terrain editing arrives with the patch layer.':t.patch&&full?'Full dungeons keep their generated layout; place content only.':'';b.onclick=()=>{state.tool=t.id;state.drag=null;renderPalette();renderToolOptions();schedule();};}}
function field(parent,label,key,type='text',options=null){const wrap=el('label',label,parent),input=el(options?'select':'input',undefined,wrap);if(options){for(const o of options){const opt=el('option',o.name??o.id,input);opt.value=o.id;}input.value=state.opts[key];}else{input.type=type;if(type==='checkbox')input.checked=!!state.opts[key];else input.value=state.opts[key]??'';}input.onchange=()=>{state.opts[key]=type==='checkbox'?input.checked:type==='number'?Number(input.value):input.value;onOptionChange(key);};return input;}
function onOptionChange(key){if(key==='kind'||key==='sprite'||key==='scenerySprite')renderToolOptions();if(key==='scenerySprite'){const meta=spriteMeta(state.opts.scenerySprite);if(meta){state.opts.spanW=Math.max(1,Math.ceil(meta.width/TILE));state.opts.spanH=Math.max(1,Math.ceil(meta.height/TILE));renderToolOptions();}}schedule();} // Replacing the preview also disconnects retries for the previous sprite.
function renderToolOptions(){
 const host=$('toolOptions');clear(host);const c=state.content,o=state.opts;if(!c)return;
 if(state.tool==='inspect'){el('p','Click a placement, DM monster or scenery to select it; drag it to move it. Ctrl+C / Ctrl+X copy or cut the selection and Ctrl+V pastes it at the tile under the pointer (cut and paste moves it within this map). Placements and monsters change right away; scenery moves and pastes queue on the right until you Apply.',host,'note');renderSelection(host);}
 if(state.tool==='place'){
  field(host,'Kind','kind','text',[{id:'monster',name:'Monster'},{id:'npc',name:'NPC'},{id:'interact',name:'Interaction object'},{id:'token',name:'Quest token'},{id:'location',name:'Location objective'},{id:'orb',name:'Story orb'}]);
  const character=['monster','npc','orb'].includes(o.kind),artKind=['token','interact'].includes(o.kind);
  if(character){const rows=(o.kind==='npc'?c.npcs:o.kind==='orb'?c.orbs??[]:c.monsters).filter(r=>r.published&&!r.published.retired).map(r=>({id:r.id,name:(r.published.name??r.published.title)+' · '+r.id}));if(!rows.some(r=>r.id===o.definition))o.definition=rows[0]?.id??'';field(host,o.kind==='npc'?'NPC':o.kind==='orb'?'Story orb':'Monster','definition','text',rows);}
  if(artKind){const sprites=[{id:'sprItem',name:'Default item'},...(c.compiledSprites??[]).filter(id=>id!=='sprItem').sort().map(id=>({id})),...(c.assets??[]).map(a=>({id:a.id,name:'Uploaded: '+a.id.slice(0,24)}))];field(host,'Object / token sprite','sprite','text',sprites);const preview=el('div',undefined,host);preview.id='spritePreview';previewSprite(preview,o.sprite);const up=el('label','Upload sprite PNG',host),input=el('input',undefined,up);input.type='file';input.accept='image/png';input.onchange=()=>attempt(async()=>{const file=input.files[0];if(!file)return;const png=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);}),asset=await action('art_upload',{png,frames:1});c.assets.push(asset);o.sprite=asset.id;renderToolOptions();say('Uploaded '+asset.id);});}
  if(!character){field(host,'Objective target ID','target');field(host,'Display name','name');}
  if(o.kind!=='monster')field(host,'Lifetime','lifetime','text',[{id:'persistent',name:'Persistent'},{id:'temporary',name:'Current map only'}]);
  if(o.kind==='monster'){field(host,'Roam and attack automatically','aggressive','checkbox');field(host,'Respawn','respawning','checkbox');}
  field(host,'Remove mode (click a placement or DM monster)','remove','checkbox');
  if(o.kind==='orb'){const scatter=el('button','Scatter published orbs across this map…',host);scatter.type='button';scatter.onclick=()=>attempt(scatterOrbs);}
  el('p','The server checks reachability, spacing from entrances, fixtures and players, and the 128-per-zone limits.',host,'note');
 }
 if(state.tool==='terrain'){
  field(host,'Brush','brush','text',[{id:'wall',name:'Wall (solid terrain)'},{id:'floor',name:'Floor (walkable)'},{id:'prop',name:'Prop (walkable off, scenery on)'},{id:'unprop',name:'Clear prop'}]);
  field(host,'Brush size','brushSize','text',[{id:1,name:'1 tile'},{id:2,name:'2 tiles'},{id:3,name:'3 tiles'},{id:5,name:'5 tiles'}]).onchange=e=>{o.brushSize=Number(e.target.value);};
  if(state.plan?.supports.grids){el('p','This room keeps tile numbers per cell. Pick the atlas cell the brush paints:',host,'note');renderSwatches(host);}
  el('p','Click or drag to paint. Shift-drag fills a rectangle. The border stays wall except at gates; arrivals, exits, chests and fixtures cannot be covered. Changes queue on the right until you Apply.',host,'note');
 }
 if(state.tool==='scenery'){
  field(host,'Eraser (click scenery to remove it)','eraser','checkbox');
  const search=el('label','Sprite search',host),input=el('input',undefined,search);input.value=o.sceneryQuery??'';input.oninput=()=>{o.sceneryQuery=input.value;renderSpriteList();};
  const list=el('div',undefined,host);list.id='spriteList';renderSpriteList();
  const preview=el('div',undefined,host);preview.id='spritePreview';if(o.scenerySprite)previewSprite(preview,o.scenerySprite);
  field(host,'Footprint width (tiles)','spanW','number').min=1;field(host,'Footprint height (tiles)','spanH','number').min=1;field(host,'Solid (blocks walking)','solid','checkbox');if(state.plan?.supports.fixtures||state.plan?.supports.decorations)field(host,'Counts as a toilet','toilet','checkbox');
  el('p','Click a tile to stamp the sprite with its top-left on that tile. Solid scenery blocks the whole footprint.',host,'note');
 }
 if(state.tool==='safe'){el('p','Drag a rectangle to add a safe room (no roaming monsters, loot or mist). Hold Alt and click inside one to remove it.',host,'note');}
 if(state.tool==='layers'){
  const layers=supportedLayers();if(!layers.includes(o.layer))o.layer=layers[0];field(host,'Layer','layer','text',layers.map(id=>({id,name:LAYER_NAMES[id]}))).onchange=e=>{o.layer=e.target.value;renderToolOptions();};
  if(o.layer==='cover')field(host,'Paint','layerValue','text',[{id:'1',name:'Tall grass (hides accidents)'},{id:'2',name:'Sheltered spot'},{id:'0',name:'Open ground'}]);
  if(o.layer==='wash'||o.layer==='mist')field(host,'Paint','layerValue','text',[{id:'1',name:o.layer==='wash'?'Riverbed (floods)':'Mist'},{id:'0',name:'Clear'}]);
  if(['cover','wash','mist'].includes(o.layer))field(host,'Brush size','brushSize','text',[{id:1,name:'1 tile'},{id:2,name:'2 tiles'},{id:3,name:'3 tiles'},{id:5,name:'5 tiles'}]).onchange=e=>{o.brushSize=Number(e.target.value);};
  if(o.layer==='shore')el('p','Click a tile to make its column the shoreline for that row (sea starts there). Drag down a column to redraw a stretch of coast.',host,'note');
  if(o.layer==='crater'){field(host,'Crater radius','craterR','number').min=2;el('p','Click to move the crater centre. The heat zone follows it.',host,'note');}
  if(['cover','wash','mist'].includes(o.layer))el('p','Click or drag to paint. These layers change play (hiding, floods, Pink Mist) and the picture, not walkability.',host,'note');
 }
 if(state.tool==='exits'){
  field(host,'Mode','exitMode','text',[{id:'move',name:'Move an existing exit'},{id:'add',name:'Add a new crossing'}]).onchange=e=>{o.exitMode=e.target.value;renderToolOptions();};
  if(o.exitMode==='move'){const exits=(state.map?.floor?.exits??[]).map(e=>({id:e.id??e.zone,name:(e.name??e.zone)+' · '+(e.style==='gap'?'gate on the '+e.side+' wall':'warp pad')+' · '+e.x+','+e.y}));if(!exits.length){el('p','This map has no movable exits.',host,'note');return;}
   if(!exits.some(e=>e.id===o.exitZone))o.exitZone=exits[0].id;field(host,'Exit','exitZone','text',exits);
   el('p','Click where the exit should go. A gate slides along its own wall and keeps its size; a warp pad moves to any walkable tile. The arrival tile from that neighbour follows it.',host,'note');}
  else{const targets=state.map?.crossings??[];if(!targets.length){el('p','This map cannot open new crossings.',host,'note');return;}if(!targets.some(t=>t.id===o.newZone))o.newZone=targets[0].id;field(host,'Leads to','newZone','text',targets.map(t=>({id:t.id,name:t.name+' · '+t.id})));field(host,'Kind','newStyle','text',[{id:'gap',name:'Gate in the outer wall'},{id:'warp',name:'Warp pad on the floor'}]);
   el('p',o.newStyle==='gap'?'Click a tile on the outer wall: the gate opens there (two tiles wide) and a corridor is carved inward until it meets the map. Arrivals from that neighbour stand just inside.':'Click a walkable tile: the pad goes there and arrivals from that neighbour stand beside it.',host,'note');}
 }
 if(state.tool==='route')renderRouteOptions(host);
 if(state.tool==='spawn'){const targets=[{id:'entrance',name:'Default arrival (entrance / spawn)'},...Object.keys(state.map?.floor?.entries??{}).map(z=>({id:z,name:'Arrival from '+z}))];if(!targets.some(t=>t.id===o.spawnTarget))o.spawnTarget='entrance';field(host,'Which arrival point','spawnTarget','text',targets);el('p','Click a walkable tile to move that arrival point there.',host,'note');}
}
function renderSpriteList(){const list=$('spriteList');if(!list)return;clear(list);const q=(state.opts.sceneryQuery??'').toLowerCase(),prefix=sceneryPrefixes(),names=Object.keys(state.manifest?.sprites??{}).filter(n=>!n.startsWith('sprTile')).filter(n=>q?n.toLowerCase().includes(q):prefix.some(p=>n.startsWith(p))).sort();for(const n of names.slice(0,200)){const b=el('button',n,list);b.type='button';b.className=n===state.opts.scenerySprite?'active':'';b.onclick=()=>{state.opts.scenerySprite=n;onOptionChange('scenerySprite');};}if(!names.length)el('p','No sprites match. Try part of a name, like "hay" or "bench".',list,'note');}
function sceneryPrefixes(){const t=state.plan?.theme??'';return {autumn_plains:['sprPlainsEnv'],farmstead:['sprPlainsEnv','sprTownEnv'],coast:['sprCoastEnv','sprCoast'],coastal_caverns:['sprCoastEnv','sprCoast'],gulch:['sprGulchEnv'],camp:['sprGulchEnv'],caldera:['sprCalderaEnv'],spa:['sprCalderaEnv'],forest:['sprForestEnv'],tundra:['sprTundra'],taiga:['sprTundra','sprForestEnv'],high_desert:['sprDesertEnv','sprForestEnv'],desert_dungeon:['sprDesertEnv'],rose:['sprPQDetail'],lantern:['sprTownEnv'],clockwork:['sprCity'],arcanum:['sprUtopia'],foundry:['sprArcadia'],mansion:['sprMansionEnv'],dungeon:['sprDungeonEnv']}[t]??['spr'];}
function previewSprite(host,name){clear(host);const img=art(name);if(!img){el('span','loading…',host,'note');setTimeout(()=>{if(host.isConnected&&!host.querySelector('canvas'))previewSprite(host,name);},300);return;}const fw=img.width/Number(img.dataset.frames||1),canvas=el('canvas',undefined,host);canvas.width=fw;canvas.height=img.height;canvas.style.width=Math.min(128,fw*2)+'px';const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.drawImage(img,0,0,fw,img.height,0,0,fw,img.height);el('span',' '+fw+'×'+img.height+' px',host,'note');}
function renderSwatches(host){const f=state.map.floor,atlasName=f.district?atlasForTileset(f.district.tileset,state.manifest?.tilesets):atlasForTileset(f.tilesets?.floor,state.manifest?.tilesets),wallAtlas=f.tilesets?.wall?atlasForTileset(f.tilesets.wall,state.manifest?.tilesets):atlasName,img=art(atlasName),wimg=art(wallAtlas);el('p','Floor tile for the Floor brush: '+state.opts.floorTile+' · Wall tile for the Wall brush: '+state.opts.wallTile,host,'note');const box=el('div',undefined,host);box.id='swatches';if(!img){el('span','loading atlas…',box,'note');return;}const cols=columnsOf(atlasName),count=Math.floor(img.height/TILE)*cols;for(let tile=1;tile<count;tile++){const c=el('canvas',undefined,box,'swatch'+(tile===state.opts.floorTile||tile===state.opts.wallTile?' active':''));c.width=c.height=TILE;c.title='tile '+tile+' (left: floor brush, right: wall brush)';const ctx=c.getContext('2d');ctx.drawImage(tile<10||!wimg?img:wimg,(tile%cols)*TILE,Math.floor(tile/cols)*TILE,TILE,TILE,0,0,TILE,TILE);c.onclick=()=>{state.opts.floorTile=tile;renderToolOptions();};c.oncontextmenu=e=>{e.preventDefault();state.opts.wallTile=tile;renderToolOptions();};}}
function renderSelection(host){const s=state.selection,c=state.clipboard;
 if(c)el('p','Clipboard: '+c.label+(c.cut?' · cut (paste moves it, Esc cancels)':'')+(c.zone!==state.map?.id?' · from '+c.zone:''),host,'note');
 if(!s)return;const box=el('fieldset',undefined,host);el('legend',s.label,box);
 if(s.type){const row=el('div',undefined,box,'row');for(const [text,cut] of [['Copy (Ctrl+C)',false],['Cut (Ctrl+X)',true]]){const b=el('button',text,row);b.type='button';b.onclick=()=>attempt(()=>copySelection(cut));}}
 else if(c){const b=el('button','Paste '+c.label+' here (Ctrl+V)',box);b.type='button';b.onclick=()=>attempt(()=>pasteAt({x:s.x,y:s.y}));}
 if(s.scenery){const d=s.scenery;el('p',(d.solid?'Solid':'Walk-through')+' · '+d.span_w+'×'+d.span_h+' tiles'+(d.toilet?' · toilet':''),box,'note');const rm=el('button','Remove (queues a change)',box);rm.type='button';rm.onclick=()=>{queueOp({kind:'decoration',op:'remove',match:{sprite:d.sprite,x:d.x,y:d.y,...(d.id?{id:d.id}:{})}});state.selection=null;renderToolOptions();};}
 if(s.placement){const p=s.placement,edit={x:p.x,y:p.y,lifetime:p.lifetime};const xs=el('label','X',box),xi=el('input',undefined,xs);xi.type='number';xi.value=p.x;xi.onchange=()=>edit.x=Number(xi.value);const ys=el('label','Y',box),yi=el('input',undefined,ys);yi.type='number';yi.value=p.y;yi.onchange=()=>edit.y=Number(yi.value);const ls=el('label','Lifetime',box),li=el('select',undefined,ls);for(const v of ['persistent','temporary']){const o=el('option',v,li);o.value=v;}li.value=p.lifetime;li.onchange=()=>edit.lifetime=li.value;
  const row=el('div',undefined,box,'row');const upd=el('button','Update placement',row);upd.onclick=()=>attempt(async()=>{await action('world_update_content',{zone:state.map.id,edition:state.map.edition,revision:state.map.revision,placement:p.id,...edit});state.selection=null;await loadZone();say('Placement updated.');});const rm=el('button','Remove',row);rm.onclick=()=>attempt(()=>removePlacement(p));}
 if(s.monster){const rm=el('button','Remove DM monster',box);rm.onclick=()=>attempt(async()=>{await action('world_remove',{zone:state.map.id,edition:state.map.edition,revision:state.map.revision,monster:s.monster.id});state.selection=null;await loadZone();say('Monster removed.');});}
}
async function removePlacement(p){const payload={zone:state.map.id,edition:state.map.edition,revision:state.map.revision,placement:p.id};try{await action('world_remove_content',payload);}catch(e){if(!String(e.message).startsWith('Active quests depend')||!await confirmDialog(e.message+' Explicitly fail those quests and remove this placement?'))throw e;await action('world_remove_content',{...payload,resolution:'fail'});}state.selection=null;await loadZone();say('Placement removed.');}
async function scatterOrbs(){const orbs=(state.content.orbs??[]).filter(r=>r.published&&!r.published.retired);if(!orbs.length)throw Error('Publish a story orb first.');const body=$('modalBody');clear(body);el('h2','Scatter orbs',body);el('p','Tick the orbs to spread across this map, first nearest the entrance and the last deepest in.',body,'note');const checks=orbs.map(o=>{const l=el('label',undefined,body),c=el('input',undefined,l);c.type='checkbox';c.value=o.id;l.append(' '+(o.published.title??o.id));return c;});const lifetime=el('select',undefined,el('label','Lifetime',body));for(const v of ['persistent','temporary']){const o=el('option',v,lifetime);o.value=v;}if(!await openModal())return;const chosen=checks.filter(c=>c.checked).map(c=>c.value);if(!chosen.length)throw Error('Choose at least one orb.');await action('world_scatter_orbs',{zone:state.map.id,edition:state.map.edition,revision:state.map.revision,orbs:chosen,lifetime:lifetime.value});await loadZone();say('Scattered '+chosen.length+' orb(s).');}
function openModal(){return new Promise(resolve=>{const modal=$('modal');modal.showModal();$('modalOk').onclick=()=>{modal.close();resolve(true);};$('modalCancel').onclick=()=>{modal.close();resolve(false);};modal.oncancel=()=>resolve(false);});}
function confirmDialog(text){const body=$('modalBody');clear(body);el('p',text,body);return openModal();}

function queueOp(op,{merge=false}={}){ // Add a pending patch op; cells ops merge into the previous op of the same kind so a brush stroke is one change.
 const last=state.pending.at(-1);if(merge&&last?.kind==='layer'&&op.kind==='layer'&&last.layer===op.layer&&op.cells){const seen=new Map(last.cells.map(c=>[c.x+','+c.y,c]));for(const c of op.cells){const prior=seen.get(c.x+','+c.y);if(prior)Object.assign(prior,c);else{last.cells.push(c);seen.set(c.x+','+c.y,c);}}}else if(merge&&last?.kind==='layer'&&op.kind==='layer'&&last.layer==='shore'&&op.rows){for(const r of op.rows){const prior=last.rows.find(p=>p.y===r.y);if(prior)prior.edge=r.edge;else last.rows.push(r);}}else if(merge&&last?.kind==='cells'&&op.kind==='cells'){const seen=new Map(last.cells.map(c=>[c.x+','+c.y,c]));for(const c of op.cells){const prior=seen.get(c.x+','+c.y);if(prior)Object.assign(prior,c);else{last.cells.push(c);seen.set(c.x+','+c.y,c);}}}else state.pending.push({id:crypto.randomUUID(),...op});state.undone=[];state.reach=null;state.baseKey='';renderPending();schedule();}
function renderPending(){const list=$('pending');clear(list);for(const [i,op] of state.pending.entries()){const li=el('li',opLabel(op),list);const x=el('button','×',li);x.title='Drop this change';x.onclick=()=>{state.pending=op.group?state.pending.filter(p=>p.group!==op.group):state.pending.filter((_,j)=>j!==i);state.reach=null;state.baseKey='';renderPending();schedule();};}$('apply').disabled=!state.pending.length;$('apply').textContent=state.pending.length?'Apply '+state.pending.length+' change'+(state.pending.length>1?'s':''):'Apply changes';$('undo').disabled=!state.pending.length;$('redo').disabled=!state.undone.length;$('discard').disabled=!state.pending.length;}
function opLabel(op){if(op.kind==='cells')return 'Paint '+op.cells.length+' cell'+(op.cells.length>1?'s':'')+(op.note?' · '+op.note:'');if(op.kind==='decoration'&&op.note==='move')return op.op==='remove'?'Move '+op.match.sprite+' from '+op.match.x+','+op.match.y:'  … to '+op.decoration.x+','+op.decoration.y;if(op.kind==='decoration')return (op.op==='remove'?'Remove ':'Stamp ')+(op.decoration?.sprite??op.match?.sprite)+' at '+(op.decoration?.x??op.match?.x)+','+(op.decoration?.y??op.match?.y);if(op.kind==='safeRoom')return (op.op==='remove'?'Remove':'Add')+' safe room '+op.rect.x+','+op.rect.y+' '+op.rect.w+'×'+op.rect.h;if(op.kind==='spawn')return op.entrance?'Move arrival to '+op.entrance.x+','+op.entrance.y:'Move arrival from '+Object.keys(op.entries).join(', ');if(op.kind==='layer')return op.layer==='shore'?'Shoreline: '+op.rows.length+' row'+(op.rows.length>1?'s':''):op.layer==='crater'?'Move crater to '+op.crater.x+','+op.crater.y+' r'+op.crater.r:'Paint '+op.layer+' ('+op.cells.length+' cell'+(op.cells.length>1?'s':'')+')';if(op.kind==='exit')return (op.op==='add'?'Add '+(op.style==='warp'?'pad':'gate')+' to ':'Move exit ')+op.zone+' at '+op.to.x+','+op.to.y;return op.kind;}
function renderPatch(){const host=$('history'),info=$('patchInfo'),p=state.map?.patch;clear(host);if(!p){info.textContent='This server has no patch layer yet; terrain tools are disabled.';return;}info.textContent='Revision '+p.revision+' · '+p.ops.length+' stored change'+(p.ops.length===1?'':'s')+(p.skipped?.length?' · '+p.skipped.length+' skipped on this edition':'');
 if(p.ops.length){const details=el('details',undefined,host);el('summary','Stored changes',details);for(const op of p.ops){const row=el('div',opLabel(op),details,'row');const rm=el('button','remove',row);rm.onclick=()=>attempt(async()=>{await patchAction('world_patch_remove',{op:op.id});say('Removed a stored change.');});}}
 const row=el('div',undefined,host,'row');if(p.history?.length){const sel=el('select',undefined,row);for(const h of p.history){const o=el('option','r'+h.revision+' · '+new Date(h.updated).toLocaleString()+' · '+h.actor,sel);o.value=String(h.revision);}const back=el('button','Roll back to',row);back.onclick=()=>attempt(async()=>{if(!await confirmDialog('Restore patch revision '+sel.value+'? Later changes are dropped.'))return;await patchAction('world_patch_rollback',{target_revision:Number(sel.value)});say('Rolled back.');});}
 const clearBtn=el('button','Clear patch',row);clearBtn.onclick=()=>attempt(async()=>{if(!await confirmDialog('Remove every GM terrain change from this zone? The generated layout returns on the next tick.'))return;await patchAction('world_patch_clear',{});say('Patch cleared.');});}
async function patchAction(name,payload){const m=state.map;const result=await action(name,{zone:m.id,edition:m.edition,revision:m.revision,patch_revision:m.patch?.revision??0,...payload});state.pending=[];state.undone=[];await loadZone({keepPending:false});return result;}
async function applyPending(){if(!state.pending.length)return;const ops=state.pending.map(op=>({...op}));await patchAction('world_patch_apply',{ops});say('Applied '+ops.length+' change'+(ops.length>1?'s':'')+'.');}

function brushCells(cx,cy){const o=state.opts,f=state.map.floor,r=Math.floor(o.brushSize/2),cells=[];for(let dy=-r;dy<o.brushSize-r;dy++)for(let dx=-r;dx<o.brushSize-r;dx++){const x=cx+dx,y=cy+dy;if(x<0||y<0||x>=f.width||y>=f.height)continue;cells.push(cellOp(x,y));}return cells;}
function cellOp(x,y){const o=state.opts,grids=state.plan?.supports.grids;if(o.brush==='wall')return {x,y,wall:1,...(grids?{wallTile:o.wallTile,floor:0}:{})};if(o.brush==='floor')return {x,y,wall:0,prop:0,...(grids?{floor:o.floorTile,wallTile:0}:{})};if(o.brush==='prop')return {x,y,prop:1};return {x,y,prop:0};}
function rectCells(a,b){const cells=[];for(let y=Math.min(a.y,b.y);y<=Math.max(a.y,b.y);y++)for(let x=Math.min(a.x,b.x);x<=Math.max(a.x,b.x);x++)cells.push(cellOp(x,y));return cells;}

// ----- NPC routes: patrols and schedules on an NPC placement (quest-placements.mjs world_route_content) -----
function routeDraft(p,index=0){return {placement:p.id,name:p.name,routes:structuredClone(p.routes??[]),index:Math.max(0,Math.min(index,(p.routes?.length??1)-1)),dirty:false,dropped:p.routeDropped??0};}
function pickRoute(p){state.route=routeDraft(p);}
function syncRoute(){ /* An untouched draft follows the server copy of its NPC; an edited one is left alone. True when the draft was replaced. */
 const r=state.route;if(!r||r.dirty)return false;const p=state.map?.placements?.find(p=>p.id===r.placement);state.route=p?routeDraft(p,r.index):null;return true;
}
function walkPath(f,from,to){ /* Shortest four-way walk between two tiles for the preview; the server steps the same way. */
 const prev=new Map([[from.x+','+from.y,null]]),queue=[from];
 for(let i=0;i<queue.length;i++){const p=queue[i];if(p.x===to.x&&p.y===to.y){const path=[];for(let at=p;at;at=prev.get(at.x+','+at.y))path.unshift(at);return path;}
  for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]){const q={x:p.x+dx,y:p.y+dy},k=q.x+','+q.y;if(!prev.has(k)&&walkableCell(f,q.x,q.y)){prev.set(k,p);queue.push(q);}}}
 return null;
}
function cachedPath(f,from,to){ /* Paths are kept until the floor or its pending changes differ (same key as the painted base). */
 if(state.paths?.key!==state.baseKey)state.paths={key:state.baseKey,map:new Map()};
 const key=from.x+','+from.y+'>'+to.x+','+to.y;if(!state.paths.map.has(key))state.paths.map.set(key,walkPath(f,from,to));return state.paths.map.get(key);
}
function drawRoutes(ctx,f){ /* Every NPC's routes; the open draft is drawn in place of its saved copy. Dashed: the walk from home. Red: no way through. */
 const draft=state.route,centre=c=>[c.x*TILE+TILE/2,c.y*TILE+TILE/2];
 for(const p of state.map.placements??[]){
  const own=draft?.placement===p.id,routes=own?draft.routes:p.routes??[],home=p.home??p;if(p.kind!=='npc'||!routes.length)continue;
  routes.forEach((r,ri)=>{
   const colour=ROUTE_COLOURS[ri%ROUTE_COLOURS.length],stops=[home,...r.points,...(r.mode==='loop'&&r.points.length>1?[r.points[0]]:[])];
   ctx.globalAlpha=(own&&ri!==draft.index)||(!own&&draft&&state.tool==='route')?.3:1;ctx.lineWidth=3/state.zoom;
   for(let i=0;i<stops.length-1;i++){const path=cachedPath(f,stops[i],stops[i+1])??[stops[i],stops[i+1]];ctx.strokeStyle=path.length===2&&Math.abs(path[0].x-path[1].x)+Math.abs(path[0].y-path[1].y)>1?'#ff7b8f':colour;ctx.setLineDash(i===0?[6,6]:[]);ctx.beginPath();path.forEach((c,n)=>ctx[n?'lineTo':'moveTo'](...centre(c)));ctx.stroke();}
   ctx.setLineDash([]);ctx.font='bold 11px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
   r.points.forEach((c,n)=>{const [cx,cy]=centre(c);ctx.fillStyle=colour;ctx.beginPath();ctx.arc(cx,cy,9,0,Math.PI*2);ctx.fill();ctx.fillStyle='#160f1c';ctx.fillText(String(n+1),cx,cy+1);});
  });
  ctx.globalAlpha=1;ctx.strokeStyle='#fff';ctx.lineWidth=1/state.zoom;ctx.strokeRect(home.x*TILE+10,home.y*TILE+10,TILE-20,TILE-20);
 }
 ctx.globalAlpha=1;ctx.setLineDash([]);
}
function renderRouteOptions(host){
 const r=state.route;
 if(!r){el('p','Click an NPC to give it patrol routes and a schedule. Routed NPCs walk while a player is in the zone, and players can pass through them while they are on the move.',host,'note');return;}
 el('h2',r.name+(r.dirty?' · unsaved':''),host);
 if(r.dropped)el('p',r.dropped+' waypoint'+(r.dropped>1?'s':'')+' did not fit this layout and '+(r.dropped>1?'were':'was')+' dropped. Saving keeps what is shown.',host,'note');
 const touch=()=>{r.dirty=true;renderToolOptions();schedule();};
 const ask=(label,type,value,set,options)=>{const wrap=el('label',label,host),input=el(options?'select':'input',undefined,wrap);if(options)for(const o of options){const opt=el('option',o.name,input);opt.value=o.id;}else input.type=type;input.value=value;input.onchange=()=>{set(input.value);touch();};return input;};
 const tabs=el('div',undefined,host,'row');
 r.routes.forEach((route,i)=>{const b=el('button',route.name||'Route '+(i+1),tabs);b.type='button';b.className=i===r.index?'active':'';b.style.borderColor=ROUTE_COLOURS[i%ROUTE_COLOURS.length];b.onclick=()=>{r.index=i;renderToolOptions();schedule();};});
 if(r.routes.length<4){const add=el('button','+ route',tabs);add.type='button';add.onclick=()=>{r.routes.push({name:'',mode:'loop',when:{type:'always'},points:[]});r.index=r.routes.length-1;touch();};}
 const route=r.routes[r.index];
 if(route){
  ask('Name','text',route.name??'',v=>{route.name=v.slice(0,60);});
  ask('Movement','',route.mode,v=>{route.mode=v;},[{id:'loop',name:'Loop (last waypoint back to the first)'},{id:'pingpong',name:'Back and forth'},{id:'once',name:'Walk there and stay'}]);
  ask('When','',route.when.type,v=>{route.when=v==='daily'?{type:'daily',from:480,to:1200}:v==='every'?{type:'every',minutes:30}:{type:'always'};},[{id:'always',name:'Always'},{id:'daily',name:'Daily, between two times'},{id:'every',name:'One lap every N minutes'}]);
  if(route.when.type==='daily'){ask('From (UTC)','time',clockText(route.when.from),v=>{route.when.from=clockMinutes(v);});ask('Until (UTC)','time',clockText(route.when.to),v=>{route.when.to=clockMinutes(v);});el('p','The server clock is UTC; it is '+new Date().toISOString().slice(11,16)+' now.',host,'note');}
  if(route.when.type==='every'){const minutes=ask('Minutes between laps','number',route.when.minutes,v=>{route.when.minutes=Math.max(1,Math.min(1440,Math.floor(Number(v))||1));});minutes.min=1;minutes.max=1440;}
  route.points.forEach((p,i)=>{const line=el('div',undefined,host,'row');el('span',(i+1)+'. '+p.x+','+p.y+' · wait',line,'mono');const wait=el('input',undefined,line);wait.type='number';wait.min=0;wait.max=600;wait.value=p.wait??0;wait.style.width='70px';wait.setAttribute('aria-label','Seconds to wait at waypoint '+(i+1));wait.onchange=()=>{p.wait=Math.max(0,Math.min(600,Math.floor(Number(wait.value))||0));touch();};el('span','s',line,'note');const x=el('button','×',line);x.type='button';x.title='Remove this waypoint';x.onclick=()=>{route.points.splice(i,1);touch();};});
  el('p','Click a walkable tile to add a waypoint (16 at most). Alt-click a waypoint to remove it. Routes are tried in order: the first whose schedule matches is walked, and with none the NPC walks home.',host,'note');
  const del=el('button','Delete this route',host);del.type='button';del.onclick=()=>{r.routes.splice(r.index,1);r.index=Math.max(0,r.index-1);touch();};
 }
 const actions=el('div',undefined,host,'row'),save=el('button','Save routes',actions,'primary'),drop=el('button',r.dirty?'Discard changes':'Choose another NPC',actions);
 save.type='button';save.disabled=!r.dirty;save.onclick=()=>attempt(saveRoutes);
 drop.type='button';drop.onclick=()=>{if(r.dirty){r.dirty=false;syncRoute();}else state.route=null;renderToolOptions();schedule();};
}
async function saveRoutes(){
 const r=state.route,m=state.map;if(!r)return;if(r.routes.some(route=>!route.points.length))throw Error('Every route needs at least one waypoint.');
 await action('world_route_content',{zone:m.id,edition:m.edition,placement:r.placement,routes:r.routes});r.dirty=false;await loadZone({keepPending:true});if(state.tool==='route')renderToolOptions();say('Routes saved. '+r.name+' starts again from home.');
}

async function useTool(cell,event){
 const m=state.map,o=state.opts,f=effectiveFloor();if(!m?.floor||!cell)return;const {x,y}=cell;
 if(state.tool==='inspect'){select(x,y);return;}
 if(state.tool==='place'){
  const foe=m.floor.enemies?.find(e=>e.x===x&&e.y===y),placement=m.placements?.find(p=>p.x===x&&p.y===y);
  if(o.remove){if(placement)return removePlacement(placement);if(!foe)throw Error('Select a monster or managed placement to remove.');await action('world_remove',{zone:m.id,edition:m.edition,revision:m.revision,monster:foe.id});await loadZone();say('Monster removed.');return;}
  const character=['monster','npc','orb'].includes(o.kind),payload={zone:m.id,edition:m.edition,revision:m.revision,x,y,placement_kind:o.kind,monster:o.definition,content:character?o.definition:o.target,name:o.name,lifetime:o.lifetime,sprite:['token','interact'].includes(o.kind)?o.sprite:undefined,aggressive:o.aggressive,respawning:o.respawning};
  await action(o.kind==='monster'?'world_place':'world_place_content',payload);await loadZone();say('Placed '+(o.kind==='monster'?'monster':o.kind)+' at '+x+','+y+'.');return;
 }
 if(state.tool==='terrain'){if(event.shiftKey&&!state.drag?.rect){state.drag={rect:{x,y}};return;}queueOp({kind:'cells',cells:brushCells(x,y),note:o.brush},{merge:true});return;}
 if(state.tool==='scenery'){
  if(o.eraser){const d=(f.decorations??[]).find(d=>x>=d.x&&x<d.x+d.span_w&&y>=d.y&&y<d.y+d.span_h)??(f.fixtures??[]).find(d=>['scenery','toilet'].includes(d.kind)&&x>=d.x&&x<d.x+(d.span_w??1)&&y>=d.y&&y<d.y+(d.span_h??1));if(!d)throw Error('No scenery here.');queueOp({kind:'decoration',op:'remove',match:{sprite:d.sprite,x:d.x,y:d.y,...(d.id?{id:d.id}:{})}});return;}
  if(!o.scenerySprite)throw Error('Pick a sprite first.');queueOp({kind:'decoration',op:'add',decoration:{sprite:o.scenerySprite,x,y,span_w:Math.max(1,Number(o.spanW)||1),span_h:Math.max(1,Number(o.spanH)||1),solid:!!o.solid,...(o.toilet?{toilet:true}:{})}});return;
 }
 if(state.tool==='safe'){if(event.altKey){const r=(f.safeRooms??[]).find(r=>x>=r.x&&x<r.x+r.w&&y>=r.y&&y<r.y+r.h);if(!r)throw Error('No safe room here.');queueOp({kind:'safeRoom',op:'remove',rect:{x:r.x,y:r.y,w:r.w,h:r.h}});return;}if(!state.drag?.rect){state.drag={rect:{x,y}};say('Click the opposite corner of the safe room.');return;}const a=state.drag.rect;state.drag=null;queueOp({kind:'safeRoom',op:'add',rect:{x:Math.min(a.x,x),y:Math.min(a.y,y),w:Math.abs(x-a.x)+1,h:Math.abs(y-a.y)+1}});return;}
 if(state.tool==='layers'){
  if(['cover','wash','mist'].includes(o.layer)){const r=Math.floor(o.brushSize/2),cells=[];for(let dy=-r;dy<o.brushSize-r;dy++)for(let dx=-r;dx<o.brushSize-r;dx++){const cx=x+dx,cy=y+dy;if(cx>=1&&cy>=1&&cx<f.width-1&&cy<f.height-1)cells.push({x:cx,y:cy,v:String(o.layerValue)});}queueOp({kind:'layer',layer:o.layer,cells},{merge:true});return;}
  if(o.layer==='shore'){queueOp({kind:'layer',layer:'shore',rows:[{y,edge:Math.max(2,Math.min(f.width-1,x))}]},{merge:true});return;}
  if(o.layer==='crater'){queueOp({kind:'layer',layer:'crater',crater:{x,y,r:Math.max(2,Math.floor(Number(o.craterR)||9))}});return;}
 }
 if(state.tool==='exits'){
  if(o.exitMode==='add'){if(!o.newZone)throw Error('Choose where the crossing leads.');const target=(state.map?.crossings??[]).find(t=>t.id===o.newZone);if(o.newStyle==='gap'){const side=x===0?'left':x===f.width-1?'right':y===0?'top':y===f.height-1?'bottom':null;if(!side)throw Error('Click a tile on the outer wall for a gate.');queueOp({kind:'exit',op:'add',zone:o.newZone,name:target?.name??o.newZone,style:'gap',side,to:{x,y}});}else queueOp({kind:'exit',op:'add',zone:o.newZone,name:target?.name??o.newZone,style:'warp',to:{x,y}});return;}
  if(!o.exitZone)throw Error('Choose an exit first.');const chosen=(f.exits??[]).find(e=>(e.id??e.zone)===o.exitZone);queueOp({kind:'exit',op:'move',...(chosen?.id?{exit:chosen.id}:{}),zone:chosen?.zone??o.exitZone,to:{x,y}});return;}
 if(state.tool==='route'){
  const r=state.route,npc=m.placements?.find(p=>p.kind==='npc'&&((p.x===x&&p.y===y)||(p.home?.x===x&&p.home?.y===y)));
  if(!r||(npc&&npc.id!==r.placement)){if(!npc)throw Error('Click an NPC first.');if(r?.dirty)throw Error('Save or discard the open routes first.');pickRoute(npc);renderToolOptions();schedule();return;}
  if(!r.routes.length)r.routes.push({name:'',mode:'loop',when:{type:'always'},points:[]});
  const route=r.routes[r.index]??r.routes[r.index=0],at=route.points.findIndex(p=>p.x===x&&p.y===y);
  if(event.altKey){if(at<0)throw Error('No waypoint here.');route.points.splice(at,1);}
  else {if(route.points.length>=16)throw Error('A route holds 16 waypoints at most.');if(!walkableCell(f,x,y)||!(state.reach??=reachableCells(f)).has(x+','+y))throw Error('Choose a reachable, walkable tile.');route.points.push({x,y,wait:0});}
  r.dirty=true;renderToolOptions();schedule();return;
 }
 if(state.tool==='spawn'){if(!walkableCell(f,x,y))throw Error('Choose a walkable tile.');queueOp(o.spawnTarget==='entrance'?{kind:'spawn',entrance:{x,y}}:{kind:'spawn',entries:{[o.spawnTarget]:{x,y}}});return;}
}

// ----- Select / move, copy / cut / paste: placements (world_update_content), DM monsters (world_move) and scenery (grouped patch ops) -----
const sceneryEditable=()=>!!state.map?.patch&&!state.map.id.startsWith('dungeon-'); // The Scenery stamp tool's rule: full dungeons keep their generated layout.
function sceneryAt(f,x,y){ /* The scenery covering a tile (the eraser's rule): dive decorations, or hub scenery and toilet fixtures. */
 const d=(f.decorations??[]).find(d=>x>=d.x&&x<d.x+d.span_w&&y>=d.y&&y<d.y+d.span_h)??(f.fixtures??[]).find(d=>['scenery','toilet'].includes(d.kind)&&x>=d.x&&x<d.x+(d.span_w??1)&&y>=d.y&&y<d.y+(d.span_h??1));
 return d?{sprite:d.sprite,x:d.x,y:d.y,span_w:d.span_w??1,span_h:d.span_h??1,solid:d.solid!==false,...(d.toilet||d.kind==='toilet'?{toilet:true}:{}),...(d.id?{id:d.id}:{})}:null;
}
function objectAt(x,y){ /* What Select picks on a tile, top first: a managed placement, a DM monster, then scenery. */
 const m=state.map,f=effectiveFloor();if(!m||!f)return null;
 const p=m.placements?.find(p=>p.x===x&&p.y===y);if(p)return {type:'placement',x,y,w:1,h:1,label:p.kind+' '+p.name,placement:p};
 const foe=m.floor.enemies?.find(e=>e.x===x&&e.y===y&&!e.dead&&e.manual);if(foe)return {type:'monster',x,y,w:1,h:1,label:'DM monster '+(foe.definition?.name??foe.type),monster:foe};
 const d=sceneryEditable()?sceneryAt(f,x,y):null;return d?{type:'scenery',x:d.x,y:d.y,w:d.span_w,h:d.span_h,label:'scenery '+d.sprite,scenery:d}:null;
}
function select(x,y){state.selection=objectAt(x,y)??{x,y,label:'Tile '+x+','+y};renderToolOptions();schedule();}
function clipOf(o){ /* A self-contained copy of a selected object: enough to paste it anywhere, plus the ids a cut needs to find it again. */
 const p=o.placement,foe=o.monster;
 const data=o.type==='placement'?{id:p.id,kind:p.kind,content:p.content,name:p.name,sprite:p.sprite,lifetime:p.lifetime,routes:structuredClone(p.routes??[]),home:{...(p.home??{x:p.x,y:p.y})},x:o.x,y:o.y}:o.type==='monster'?{id:foe.id,type:foe.type,aggressive:!!foe.roaming,respawning:!!foe.respawning,sprite:foe.definition?.sprite??foe.sprite,x:o.x,y:o.y}:{...o.scenery};
 return {type:o.type,label:o.label,w:o.w??1,h:o.h??1,data};
}
function copySelection(cut){
 const s=state.selection;if(!s?.type)throw Error('Select a placement, DM monster or scenery first.');
 state.clipboard={...clipOf(s),zone:state.map.id,cut};renderToolOptions();schedule();
 say((cut?'Cut ':'Copied ')+s.label+'. Point at a tile and press Ctrl+V to '+(cut?'move it there (Esc cancels the cut).':'paste a copy.'));
}
function findSource(c){ /* The live object a cut refers to, or null once it is gone. */
 const m=state.map,d=c.data;if(!m?.floor||c.zone!==m.id)return null;
 if(c.type==='placement'){const p=m.placements?.find(p=>p.id===d.id);return p?{type:'placement',x:p.x,y:p.y,w:1,h:1,label:c.label,placement:p}:null;}
 if(c.type==='monster'){const foe=m.floor.enemies?.find(e=>e.id===d.id&&!e.dead);return foe?{type:'monster',x:foe.x,y:foe.y,w:1,h:1,label:c.label,monster:foe}:null;}
 const s=sceneryAt(effectiveFloor(),d.x,d.y);return s&&s.sprite===d.sprite&&s.x===d.x&&s.y===d.y?{type:'scenery',x:s.x,y:s.y,w:s.span_w,h:s.span_h,label:c.label,scenery:s}:null;
}
const stampOf=d=>({sprite:d.sprite,span_w:d.span_w,span_h:d.span_h,solid:d.solid,...(d.toilet?{toilet:true}:{})}); // A scenery record as a Scenery stamp decoration, minus its position.
async function moveObject(o,to){ /* Drag and cut/paste within one map. Placements keep their id and quest links; monsters keep id and flags; scenery becomes a remove + stamp pair. */
 const m=state.map;if(to.x===o.x&&to.y===o.y)return;
 if(o.type==='placement'){const p=o.placement;await action('world_update_content',{zone:m.id,edition:m.edition,revision:m.revision,placement:p.id,x:to.x,y:to.y,lifetime:p.lifetime});await loadZone({keepPending:true});say('Moved '+o.label+' to '+to.x+','+to.y+'.'+(p.routes?.length?' Its route waypoints stay where they are.':''));}
 else if(o.type==='monster'){await action('world_move',{zone:m.id,edition:m.edition,revision:m.revision,monster:o.monster.id,x:to.x,y:to.y});await loadZone({keepPending:true});say('Moved '+o.label+' to '+to.x+','+to.y+'.');}
 else{if(!sceneryEditable())throw Error('Scenery on this map cannot be moved.');const d=o.scenery,group=crypto.randomUUID();queueOp({kind:'decoration',op:'remove',note:'move',group,match:{sprite:d.sprite,x:d.x,y:d.y,...(d.id?{id:d.id}:{})}});queueOp({kind:'decoration',op:'add',note:'move',group,decoration:{...stampOf(d),x:to.x,y:to.y}});say('Move queued. Apply to keep it.');}
 select(to.x,to.y);
}
async function pasteAt(to){ /* Paste the clipboard with its top-left on a tile: a cut moves its original (same map only); a copy places a new one. */
 const c=state.clipboard,m=state.map;if(!c)throw Error('Copy (Ctrl+C) or cut (Ctrl+X) something first.');if(!m?.floor)throw Error('This map is not ready yet.');
 if(c.cut&&c.zone===m.id){const source=findSource(c);if(!source){state.clipboard=null;renderToolOptions();throw Error('The cut '+c.label+' is no longer there, so nothing moved.');}await moveObject(source,to);state.clipboard={...c,cut:false,data:{...c.data,x:to.x,y:to.y}};renderToolOptions();return;} // After the move the clipboard holds a copy, like any editor.
 const elsewhere=c.cut?' The original stays in '+c.zone+': cut and paste only move things within one map.':'';if(c.cut)state.clipboard={...c,cut:false};
 const d=c.data;
 if(c.type==='placement'){
  const before=new Set((m.placements??[]).map(p=>p.id));
  await action('world_place_content',{zone:m.id,edition:m.edition,revision:m.revision,x:to.x,y:to.y,placement_kind:d.kind,content:d.content,name:d.name,lifetime:d.lifetime,sprite:['token','interact'].includes(d.kind)?d.sprite:undefined});await loadZone({keepPending:true});
  let routes='';if(d.kind==='npc'&&d.routes.length){if(c.zone!==m.id)routes=' Its routes belong to the other map, so they were not copied.';else{const fresh=state.map.placements?.find(p=>!before.has(p.id)&&p.kind==='npc'&&p.content===d.content);const dx=to.x-d.home.x,dy=to.y-d.home.y; /* Waypoints shift with the NPC so the copy walks the same shape from its new home. */
   if(fresh)try{await action('world_route_content',{zone:m.id,edition:state.map.edition,placement:fresh.id,routes:d.routes.map(r=>({...r,points:r.points.map(p=>({...p,x:p.x+dx,y:p.y+dy}))}))});await loadZone({keepPending:true});routes=' Its routes came along, shifted with it.';}catch(e){routes=' Its routes were not copied: '+e.message;}}}
  say('Pasted '+c.label+' at '+to.x+','+to.y+'.'+routes+elsewhere);
 }
 else if(c.type==='monster'){await action('world_place',{zone:m.id,edition:m.edition,revision:m.revision,x:to.x,y:to.y,monster:d.type,aggressive:d.aggressive,respawning:d.respawning});await loadZone({keepPending:true});say('Pasted '+c.label+' at '+to.x+','+to.y+'.'+elsewhere);}
 else{if(!sceneryEditable())throw Error('This map has no scenery layer to paste into.');queueOp({kind:'decoration',op:'add',decoration:{...stampOf(d),x:to.x,y:to.y}});say('Paste queued. Apply to keep it.'+elsewhere);}
 select(to.x,to.y);
}
function drawGhost(ctx,c,x,y){ /* A see-through copy of an object with its top-left at x,y, for drags. */
 const d=c.data;ctx.globalAlpha=.6;
 if(c.type==='scenery'){const img=art(d.sprite);if(img){const fw=img.width/Number(img.dataset.frames||1);if(state.plan?.supports.decorations)ctx.drawImage(img,0,0,fw,img.height,x*TILE+TILE/2-Number(img.dataset.xorigin||0),y*TILE+TILE/2-Number(img.dataset.yorigin||0),fw,img.height);else ctx.drawImage(img,0,0,fw,img.height,x*TILE,y*TILE,fw,img.height);}}
 else if(c.type==='monster')fit32(ctx,d.sprite,x,y)||marker(ctx,x,y,'#ae243d');
 else if(d.kind==='orb'){ctx.fillStyle=orbColour(d.content);ctx.beginPath();ctx.arc(x*TILE+16,y*TILE+16,10,0,Math.PI*2);ctx.fill();}
 else if(d.kind!=='location')fit32(ctx,d.sprite||'sprItem',x,y)||marker(ctx,x,y,'#77bbff');
 ctx.globalAlpha=1;ctx.strokeStyle='#ffdc3c';ctx.lineWidth=2/state.zoom;ctx.setLineDash([4/state.zoom,3/state.zoom]);ctx.strokeRect(x*TILE,y*TILE,c.w*TILE,c.h*TILE);ctx.setLineDash([]);
}
function drawClipboard(ctx){ /* A cut object is dimmed in place until it is pasted; a drag shows where the object will land. */
 const c=state.clipboard;if(c?.cut){const s=findSource(c);if(s){ctx.fillStyle='rgba(13,8,18,.55)';ctx.fillRect(s.x*TILE,s.y*TILE,s.w*TILE,s.h*TILE);ctx.strokeStyle='#ff8fc4';ctx.lineWidth=2/state.zoom;ctx.setLineDash([4/state.zoom,3/state.zoom]);ctx.strokeRect(s.x*TILE,s.y*TILE,s.w*TILE,s.h*TILE);ctx.setLineDash([]);}}
 const d=state.drag;if(d?.move&&d.moved&&state.hover)drawGhost(ctx,d.clip,state.hover.x-d.offset.dx,state.hover.y-d.offset.dy);
}

function bind(){
 const stage=$('stage');let space=false,panning=null;
 stage.addEventListener('wheel',e=>{e.preventDefault();const r=stage.getBoundingClientRect();zoomBy(e.deltaY<0?1.2:1/1.2,e.clientX-r.left,e.clientY-r.top);},{passive:false});
 stage.addEventListener('pointerdown',e=>{stage.focus({preventScroll:true}); /* A scrolling focus would shift the canvas under the pointer between hover and click. */if(e.button===2||e.button===1||space){panning={x:e.clientX,y:e.clientY,px:state.pan.x,py:state.pan.y};stage.setPointerCapture(e.pointerId);return;}const cell=cellAt(e);if(!cell)return;if(state.tool==='inspect'&&e.button===0){select(cell.x,cell.y);const obj=state.selection;if(obj?.type){state.drag={move:obj,clip:clipOf(obj),offset:{dx:cell.x-obj.x,dy:cell.y-obj.y},from:cell,moved:false};stage.setPointerCapture(e.pointerId);}return;} /* Select / move: grab an object to drag it. */if((state.tool==='terrain'&&!e.shiftKey)||(state.tool==='layers'&&state.opts.layer!=='crater')){state.drag={painting:true};attempt(()=>useTool(cell,e));}else attempt(()=>useTool(cell,e));});
 stage.addEventListener('pointermove',e=>{if(panning){state.pan={x:panning.px+e.clientX-panning.x,y:panning.py+e.clientY-panning.y};schedule();return;}const cell=cellAt(e);const same=cell&&state.hover&&cell.x===state.hover.x&&cell.y===state.hover.y;state.hover=cell;if(state.drag?.move&&cell&&(cell.x!==state.drag.from.x||cell.y!==state.drag.from.y))state.drag.moved=true;if(!same){$('readout').textContent=describe(cell);if(state.drag?.painting&&cell)attempt(()=>useTool(cell,e));schedule();}});
 stage.addEventListener('pointerup',e=>{if(panning){panning=null;return;}if(state.drag?.move){const d=state.drag,cell=cellAt(e);state.drag=null;if(d.moved&&cell)attempt(()=>moveObject(d.move,{x:cell.x-d.offset.dx,y:cell.y-d.offset.dy}));schedule();return;} /* Drop: the grabbed tile lands under the pointer. */if(state.drag?.painting)state.drag=null;if(state.tool==='terrain'&&state.drag?.rect){const cell=cellAt(e);if(cell){const a=state.drag.rect;state.drag=null;queueOp({kind:'cells',cells:rectCells(a,cell),note:state.opts.brush+' rectangle'});}}});
 stage.addEventListener('pointerleave',()=>{state.hover=null;schedule();});stage.addEventListener('contextmenu',e=>e.preventDefault());
 window.addEventListener('keydown',e=>{if(e.code==='Space'){space=true;stage.style.cursor='grab';}if(e.key==='Escape'){if(state.clipboard?.cut)state.clipboard=null;state.drag=null;state.selection=null;renderToolOptions();schedule();}const typing=e.target instanceof Element&&!!e.target.closest('input,select,textarea,[contenteditable]'),key=e.key.toLowerCase(); /* Text fields keep their own clipboard. */
  if((e.ctrlKey||e.metaKey)&&!typing&&!$('modal').open){if((key==='c'||key==='x')&&state.selection?.type){e.preventDefault();attempt(()=>copySelection(key==='x'));}else if(key==='v'&&state.clipboard){e.preventDefault();const at=state.hover??(state.selection?{x:state.selection.x,y:state.selection.y}:null);attempt(()=>{if(!at)throw Error('Point at a tile, then paste.');return pasteAt(at);});}}
  if((e.ctrlKey||e.metaKey)&&key==='z'){e.preventDefault();e.shiftKey?redo():undo();}});
 window.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;stage.style.cursor='crosshair';}});window.addEventListener('resize',schedule);
 $('zone').onchange=()=>attempt(async()=>{state.zone=$('zone').value;state.map=null;state.base=null;state.pending=[];state.undone=[];state.route=null;await loadZone();fit();renderPalette();renderToolOptions();});
 $('refresh').onclick=()=>attempt(()=>loadZone({keepPending:true}));$('zoomIn').onclick=()=>zoomBy(1.25);$('zoomOut').onclick=()=>zoomBy(0.8);$('fit').onclick=fit;
 for(const id of ['showGrid','showReach','showSafe','showLayers','showPlayers','showRoutes'])$(id).onchange=()=>{state.baseKey='';schedule();};
 $('download').onclick=()=>attempt(async()=>{const layers=['terrain','scenery','content',...($('showPlayers').checked?['players']:[]),...($('showGrid').checked?['grid']:[]),...($('showSafe').checked?['safe']:[])];const r=await liveApi('/gm/map.png?zone='+encodeURIComponent(state.zone)+'&scale='+$('scale').value+'&layers='+layers.join(','),null,true);const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=state.zone+'.png';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);say('Painted '+state.zone+' ('+Math.round(blob.size/1024)+' KB).');});
 $('downloadWorld').onclick=()=>attempt(async()=>{const button=$('downloadWorld');button.disabled=true;try{say('Painting the whole world. This takes a few seconds…');const layers=['terrain','scenery','content',...($('showPlayers').checked?['players']:[])],r=await liveApi('/gm/world.png?scale=8&layers='+layers.join(','),null,true),blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='lidollquest-world.png';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);say('Painted the world ('+Math.round(blob.size/1024)+' KB).');}finally{button.disabled=false;}}); // Every overworld, dungeon and hub on one poster (world-map.mjs).
 $('regenerate').onclick=()=>attempt(async()=>{const m=state.map;if(m.district){if(!await confirmDialog('Roll a brand-new layout for this hub now? Visitors return to the spawn and scenery rerolls.'))return;await action('world_hub_regenerate',{zone:m.id,edition:m.edition,revision:m.revision,confirm_reset:true});}else{if(!await confirmDialog('Regenerate this Dive? Treasure claims and boss rewards reset for everyone once it drains.'))return;await action('world_regenerate',{zone:m.id,edition:m.edition,revision:m.revision,confirm_reset_rewards:true});}await loadZone();say('Regeneration requested.');});
 $('cancel').onclick=()=>attempt(async()=>{const m=state.map;await action('world_cancel',{zone:m.id,edition:m.edition,revision:m.revision,job:m.job?.id});await loadZone();say('Regeneration cancelled.');});
 $('lock').onclick=()=>attempt(async()=>{const m=state.map;await action('world_hub_lock',{zone:m.id,edition:m.edition,revision:m.revision,locked:!m.district?.locked});await loadZone();say(m.district?.locked?'Layout follows the monthly reset again.':'Layout locked.');});
 $('apply').onclick=()=>attempt(applyPending);$('undo').onclick=undo;$('redo').onclick=redo;$('discard').onclick=()=>{state.pending=[];state.undone=[];state.reach=null;state.baseKey='';renderPending();schedule();};
 $('auto').onchange=startTimer;
}
function undo(){const op=state.pending.pop();if(!op)return;state.undone.push(op);while(op.group&&state.pending.at(-1)?.group===op.group)state.undone.push(state.pending.pop()); /* A move is a remove + stamp pair: undo both. */state.reach=null;state.baseKey='';renderPending();schedule();}
function redo(){const op=state.undone.pop();if(!op)return;state.pending.push(op);while(op.group&&state.undone.at(-1)?.group===op.group)state.pending.push(state.undone.pop());state.reach=null;state.baseKey='';renderPending();schedule();}
function startTimer(){if(state.timer)clearInterval(state.timer);state.timer=null;if(!$('auto').checked)return;state.timer=setInterval(()=>{if(document.hidden||state.pending.length||state.drag||state.route?.dirty)return;loadZone({keepPending:true}).catch(e=>say(e.message,true));},5000);} // Players and monsters move; a draft in progress is never disturbed.

window.lidollMapEditor={state,screenOf:(x,y)=>({x:state.pan.x+(x+0.5)*TILE*state.zoom,y:state.pan.y+(y+0.5)*TILE*state.zoom})}; // Diagnostics for python/tests/fixtures/map_editor_browser.mjs; nothing secret lives in state.
attempt(async()=>{bind();await liveApi('/gm/whoami');await loadContent();renderPalette();renderToolOptions();await loadZone();fit();startTimer();say('Ready. '+(state.map?.floor?'Pick a tool on the left.':''));});
})();
