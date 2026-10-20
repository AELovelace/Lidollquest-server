function installPlaceEditor(api){ // Keep place authoring in the Map Editor, sharing its authenticated requests and canvas.
 const {state,request,command,openDraft,openLive,refresh,say}=api;
 const host=document.createElement('section');host.id='placeWorkshop';document.getElementById('tools').prepend(host);
 let records=[],selected=null;
 const node=(tag,text,parent=host)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;parent.append(n);return n;};
 const run=fn=>async()=>{try{await fn();}catch(e){say(e.message,true);}};
 const button=(text,fn,parent=host)=>{const b=node('button',text,parent);b.type='button';b.onclick=run(fn);return b;};
 const input=(label,value,type='text',parent=host)=>{const l=node('label',label,parent),n=node('input',undefined,l);n.type=type;n.value=value;return n;};
 const select=(label,options,value,parent=host)=>{const l=node('label',label,parent),n=node('select',undefined,l);for(const [v,text] of options){const o=node('option',text,n);o.value=v;}n.value=value;return n;};
 async function load(id=selected?.id){const result=await request('/gm/places');records=result.places;selected=records.find(r=>r.id===id)??null;render();}
 async function save(entry){selected=await command('world_place_save',{id:selected.id,revision:selected.revision,entry});await load(selected.id);say('Draft saved. Players still see the published version.');}
 const update=fn=>async()=>{const e=structuredClone(selected.draft);await fn(e);await save(e);};
 function render(){
  host.replaceChildren();node('h2','Town places');
  const picker=select('Place',[['','Choose a place'],...records.map(r=>[r.id,r.draft.name+' · r'+r.revision+(r.published?' · published':' · draft')])],selected?.id??'');
  picker.onchange=run(()=>load(picker.value));button('Add place',create);
  button('Import bundle',importBundle);
  if(!selected)return;
  node('p',state.draft?.id===selected.id?'Editing a private draft. Apply saves draft strokes. Publish makes the place live.':'Open a draft room to paint privately, or a published room to edit its live patch.',host).className='note';
  const name=input('Name',selected.draft.name);
  button('Save name',update(e=>{e.name=name.value;}));
  const e=selected.draft;
  if(e.exterior){const x=input('Town parcel X',e.exterior.x,'number'),y=input('Town parcel Y',e.exterior.y,'number'),w=input('Parcel width',e.exterior.w,'number'),h=input('Parcel height',e.exterior.h,'number');button('Move parcel',update(v=>{v.exterior.x=Number(x.value);v.exterior.y=Number(y.value);v.exterior.w=Number(w.value);v.exterior.h=Number(h.value);}));}
  button('Show town entrance',()=>openLive(e.home));
  if(e.exterior)button('Preview town draft',()=>openDraft(selected.id,'town'));
  for(const r of e.rooms){const row=node('div');node('strong',r.name,row);button('Edit draft',()=>openDraft(selected.id,r.id),row);if(selected.published)button('Open live',()=>openLive(e.home+'-place-'+selected.id+'-'+r.id),row);}
  button('Add room / floor',addRoom);
  button('Clone room geometry',cloneRoom);
  button('Add paired door',addDoor);
  button('Add named anchor',addAnchor);
  const links=node('ul');for(const c of e.connections??[])node('li',c.name+': '+c.a.zone+' ↔ '+c.b.zone,links);
  button('Publish place',async()=>{if(state.pending.length)throw Error('Apply or discard canvas strokes before publishing.');selected=await command('world_place_publish',{id:selected.id,revision:selected.revision});await refresh();await load();say('Place published.');});
  button('Retire place',async()=>{if(!confirm('Retire this place? The server will refuse while occupants or references remain.'))return;await command('world_place_retire',{id:selected.id,revision:selected.revision});state.draft=null;await refresh();await load();say('Place retired; history retained.');});
  button('Export bundle',async()=>{const b=await request('/gm/place-bundle?id='+encodeURIComponent(selected.id));download(b,selected.id+'.place.json');});
  button('Advanced properties',()=>jsonEditor());
 }
 function form(title,build){const d=document.createElement('dialog');document.body.append(d);node('h2',title,d);build(d);button('Close',()=>{d.close();d.remove();},d);d.showModal();}
 function create(){form('Add a town place',d=>{
  const id=input('Stable ID','utopia-test-shop','text',d),name=input('Name','Utopia test shop','text',d);
  const town=select('Town',state.content.worldZones.filter(z=>['utopia-arcanum','honeydew-lantern','littlebig-clockwork','arcadia-foundry'].includes(z.id)).map(z=>[z.id,z.name]),state.zone==='utopia-arcanum'?state.zone:'utopia-arcanum',d);
  const type=select('Place type',[['interior','Building with interior'],['walkin','Walk-in building'],['poi','Outdoor POI']],'interior',d);
  const x=input('Parcel X',state.hover?.x??5,'number',d),y=input('Parcel Y',state.hover?.y??5,'number',d);
  const w=input('Interior width',20,'number',d),h=input('Interior height',20,'number',d);
  const template=select('Template',[['blank','Blank room'],['shop','Shop'],['workshop','Workshop'],['garden','Garden / outdoor POI']],'blank',d);
  button('Create draft',async()=>{const kind=template.value==='garden'?'poi':type.value,rooms=kind==='interior'?[{id:'ground',name:name.value,width:Number(w.value),height:Number(h.value),ops:template.value==='shop'?[{kind:'cells',cells:[4,5,6,7].map(x=>({x,y:4,wall:1,wallTile:15}))}]:template.value==='workshop'?[{kind:'fixture',op:'add',furniture:'forge',to:{x:4,y:4}}]:[]}]:[];
   selected=await command('world_place_save',{id:id.value,revision:0,entry:{name:name.value,home:town.value,type:kind,exterior:{x:Number(x.value),y:Number(y.value),w:3,h:3,sprite:'sprUtopiaWorkshop'},rooms}});d.close();d.remove();await load(selected.id);if(rooms.length)await openDraft(selected.id,'ground');say('Draft created. Set the parcel on clear town ground before publication.');},d);
 });}
 function addRoom(){form('Add room / floor',d=>{const id=input('Room ID','upstairs','text',d),name=input('Name','Upstairs','text',d),w=input('Width',20,'number',d),h=input('Height',20,'number',d);button('Add room',async()=>{const e=structuredClone(selected.draft);e.rooms.push({id:id.value,name:name.value,width:Number(w.value),height:Number(h.value)});await save(e);d.close();d.remove();say('Add a paired door and designate this room’s default return before publishing.');},d);});}
 function cloneRoom(){form('Clone room geometry',d=>{const source=select('Source room',state.content.worldZones.filter(z=>z.kind==='hub').map(z=>[z.id,z.name]),state.zone,d),id=input('New room ID','copy','text',d),name=input('Name','Room copy','text',d);button('Copy walls only',async()=>{const m=await request('/gm/map?paint=1&zone='+encodeURIComponent(source.value)),f=m.floor;if(f.width>48||f.height>48)throw Error('Choose an interior no larger than 48 ? 48.');const e=structuredClone(selected.draft),offset=Math.min(6,f.height-3),walls=f.walls.map((row,y)=>row.map((v,x)=>x===0||y===0||x===f.width-1||y===f.height-1?1:v));walls[offset][0]=0;walls[offset+1][0]=0;walls[offset][1]=0;walls[offset+1][1]=0;e.rooms.push({id:id.value,name:name.value,width:f.width,height:f.height,spawn:{x:1,y:offset},exit:{side:'left',offset},walls});await save(e);d.close();d.remove();say('Copied geometry only. Add its paired default exit before publishing.');},d);});}
 function addDoor(){form('Paired door / stairs',d=>{
  const options=[['town','Town'],...selected.draft.rooms.map(r=>[r.id,r.name])],id=input('Connection ID','stairs','text',d);
  const a=select('From room',options,selected.draft.rooms[0]?.id,d),ax=input('Door X',5,'number',d),ay=input('Door Y',5,'number',d),aax=input('Arrival X',5,'number',d),aay=input('Arrival Y',6,'number',d);
  const b=select('To room',options,selected.draft.rooms[1]?.id??'town',d),bx=input('Door X',0,'number',d),by=input('Door Y',6,'number',d),bax=input('Arrival X',1,'number',d),bay=input('Arrival Y',6,'number',d);
  const def=select('Default return for',[['','Additional door'],...options.filter(v=>v[0]!=='town')],selected.draft.rooms[1]?.id??'',d);
  button('Save paired door',async()=>{const e=structuredClone(selected.draft);e.connections??=[];e.connections.push({id:id.value,name:id.value,a:{zone:a.value,x:Number(ax.value),y:Number(ay.value),arrival:{x:Number(aax.value),y:Number(aay.value)}},b:{zone:b.value,x:Number(bx.value),y:Number(by.value),arrival:{x:Number(bax.value),y:Number(bay.value)}},...(def.value?{defaultFor:def.value}:{})});await save(e);d.close();d.remove();},d);
 });}
 function addAnchor(){form('Named place anchor',d=>{const id=input('Anchor ID','counter','text',d),room=select('Room',[['town','Town'],...selected.draft.rooms.map(r=>[r.id,r.name])],state.draft?.room??'town',d),x=input('X',state.hover?.x??3,'number',d),y=input('Y',state.hover?.y??3,'number',d);button('Save anchor',async()=>{const e=structuredClone(selected.draft);e.anchors??=[];e.anchors.push({id:id.value,name:id.value,zone:room.value,x:Number(x.value),y:Number(y.value)});await save(e);d.close();d.remove();},d);});}
 function jsonEditor(){form('Place properties',d=>{node('p','Edit connections, anchors, staged content or room properties. Published rooms keep their IDs and dimensions.',d);const t=node('textarea',JSON.stringify(selected.draft,null,2),d);t.rows=20;t.style.width='100%';button('Validate and save draft',async()=>{await save(JSON.parse(t.value));d.close();d.remove();},d);});}
 function importBundle(){form('Import portable place',d=>{const id=input('New place ID','imported-place','text',d),t=node('textarea','',d);t.rows=15;t.placeholder='Paste a version 1 place bundle';const file=input('Or choose JSON','','file',d);file.accept='.json';file.onchange=run(async()=>{t.value=await file.files[0].text();});button('Preview draft import',async()=>{const b=JSON.parse(t.value);if(b.format!=='lidollquest-place'||b.version!==1)throw Error('Unsupported place bundle.');selected=await command('world_place_save',{id:id.value,revision:0,entry:b.entry});d.close();d.remove();await load(selected.id);say('Imported as a private draft. Review dependencies and coordinates, then publish.');},d);});}
 function download(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return {load};
}
