// Sprite Lab look designer for staff NPC authoring. Shared by the GM panel and Story Workshop, so it brings its own DOM
// helpers and takes the page's authenticated api(). It edits the same look shape players save (sprite-looks.mjs validateLook):
// {version,slots,colors,strength,enabled,visible,facing}. Layers and sheets come from GET /gm/sprite-lab.
const spriteLab={data:null,images:new Map()};
function spriteLabNode(tag,text,parent){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(parent)parent.appendChild(n);return n;}
async function spriteLabLoad(api){
 spriteLab.data??=api('/gm/sprite-lab').catch(e=>{spriteLab.data=null;throw e;});
 return spriteLab.data;
}
function spriteLabSheet(data,sprite){ // The layer's 128x128 sheet as raw pixels, decoded once.
 if(!spriteLab.images.has(sprite))spriteLab.images.set(sprite,new Promise((resolve,reject)=>{
  if(!data.sheets[sprite])return reject(Error('The server has no sheet for '+sprite+'. Re-run the game importer.'));
  const image=new Image();image.onerror=()=>reject(Error('Could not decode '+sprite));
  image.onload=()=>{const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);resolve(ctx.getImageData(0,0,c.width,c.height));};
  image.src='data:image/png;base64,'+data.sheets[sprite];
 }));
 return spriteLab.images.get(sprite);
}
function spriteLabTint(pixels,asset,look){ // The same rules as the game's palette shader: exact source shades become colour x shade, blended by strength.
 const slot=asset.slot,map=new Map(),out=new ImageData(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height);
 asset.channels.forEach((ch,c)=>{
  if(!look.enabled?.[slot]?.[c])return; // "Original" leaves every source shade untouched.
  const rgb=look.colors?.[slot]?.[c]??ch.default_rgb??[255,255,255],amount=Math.min(1,Math.max(0,look.strength?.[slot]?.[c]??1));
  if(ch.kind&&slot!=='base')return; // Skin and eye channels only exist on bodies.
  ch.source.forEach((src,p)=>{
   if(!ch.kind&&(src[0]!==src[1]||src[1]!==src[2]))return; // General tint only ever replaces neutral grays.
   const shade=ch.kind==='eyes'?[1,1,1]:Array.isArray(ch.shade[p])?ch.shade[p]:[ch.shade[p],ch.shade[p],ch.shade[p]];
   map.set(src[0]<<16|src[1]<<8|src[2],src.map((v,k)=>Math.round(v+(Math.min(255,rgb[k]*shade[k])-v)*amount)));
  });
 });
 if(!map.size)return out;
 const d=out.data;
 for(let i=0;i<d.length;i+=4){if(!d[i+3])continue;const to=map.get(d[i]<<16|d[i+1]<<8|d[i+2]);if(to){d[i]=to[0];d[i+1]=to[1];d[i+2]=to[2];}}
 return out;
}
function spriteLabBodySprite(cat,asset,baseId){ // Alternate pixels share the garment's ID, tint channels and unlock.
 const base=cat.assets.find(a=>a.id===baseId&&a.slot==='base'),body=base?.body_type??(baseId==='piko_base'?'masc':'femme');
 return !asset.hash&&asset.body_sprites?.[body]||asset.sprite; // A published workshop sheet is explicit artist artwork, not an inherited bundled variant.
}
async function spriteLabComposite(data,look){ // One 128x128 canvas holding all sixteen frames of the finished look.
 const cat=data.catalog,sheet=document.createElement('canvas');sheet.width=sheet.height=128;const ctx=sheet.getContext('2d'),layer=document.createElement('canvas');layer.width=layer.height=128;
 const worn=slot=>look.visible?.[slot]===false?null:cat.assets.find(a=>a.id===look.slots?.[slot]&&a.slot===slot),hidden=new Set(cat.order.flatMap(slot=>worn(slot)?.hides??[]));
 for(const slot of cat.order){
  const asset=worn(slot);if(!asset||hidden.has(slot))continue;
  layer.getContext('2d').putImageData(spriteLabTint(await spriteLabSheet(data,spriteLabBodySprite(cat,asset,look.slots?.base)),asset,look),0,0);ctx.drawImage(layer,0,0);
 }
 return sheet;
}
function spriteLabDefault(cat){ // A dressed body in original colours, ready to restyle.
 const look={version:1,slots:{},colors:{},strength:{},enabled:{},visible:{},facing:0},accessory=new Set(cat.slots.filter(s=>s.accessory).map(s=>s.id));
 for(const slot of cat.order){const first=accessory.has(slot)||slot==='underwear'?null:cat.assets.find(a=>a.slot===slot&&!a.premium)??cat.assets.find(a=>a.slot===slot);spriteLabWear(cat,look,slot,first?.id??'');}
 return look;
}
function spriteLabWear(cat,look,slot,id){ // Put an item (or nothing) in a slot and reset that slot's channels to the item's defaults.
 const asset=cat.assets.find(a=>a.id===id&&a.slot===slot);
 look.slots[slot]=asset?.id??'';look.visible[slot]=true;
 look.colors[slot]=(asset?.channels??[]).map(ch=>[...(ch.default_rgb??[255,255,255])]);look.strength[slot]=(asset?.channels??[]).map(()=>1);look.enabled[slot]=(asset?.channels??[]).map(()=>false);
}
function spriteLabSwatches(cat,ch){return cat.swatches?.[ch.palette??(ch.kind==='skin'?'skin':ch.kind==='eyes'?'eyes':'fabric')]??cat.swatches?.fabric??[];}
function spriteLabRandomize(cat,look){
 const pick=list=>list[Math.floor(Math.random()*list.length)],limit=cat.accessory_limit??3;let accessories=0;
 for(const slot of cat.order){
  const accessory=cat.slots.find(s=>s.id===slot)?.accessory,options=cat.assets.filter(a=>a.slot===slot).map(a=>a.id);
  if(slot!=='base'&&(!accessory||accessories<limit))options.push('');
  if(accessory&&accessories>=limit){spriteLabWear(cat,look,slot,'');continue;}
  if(!options.length)continue;
  const id=accessory&&Math.random()<0.6?'':pick(options);spriteLabWear(cat,look,slot,id);if(accessory&&id)accessories++;
  const asset=cat.assets.find(a=>a.id===id);
  asset?.channels.forEach((ch,c)=>{const colours=spriteLabSwatches(cat,ch);if(colours.length){look.colors[slot][c]=[...pick(colours)];look.enabled[slot][c]=true;}});
 }
}
const spriteLabHex=rgb=>'#'+rgb.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
const spriteLabRgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
// host: element to fill. look: the current look or null. onChange(look|null) fires after every edit. unavailable: a reason to show instead (public editor).
function spriteLabDesigner(host,{look,api,onChange,unavailable=''}){
 const box=spriteLabNode('fieldset',undefined,host);spriteLabNode('legend','Sprite Lab look',box);
 if(unavailable){spriteLabNode('p',look?'This NPC has a Sprite Lab look. '+unavailable:unavailable,box);return box;}
 const status=spriteLabNode('p','Loading layers…',box);let draw=0;
 spriteLabLoad(api).then(data=>{if(box.isConnected)render(data);}).catch(e=>{status.textContent='Sprite Lab is unavailable: '+e.message;});
 function render(data){
  const cat=data.catalog;box.replaceChildren(spriteLabNode('legend','Sprite Lab look'));
  const changed=()=>{onChange(look);void paint();};
  if(!look){
   spriteLabNode('p','No Sprite Lab look. The NPC uses the walking sprite chosen above.',box);
   const add=spriteLabNode('button','Design a Sprite Lab look',box);add.type='button';add.onclick=()=>{look=spriteLabDefault(cat);onChange(look);render(data);};return;
  }
  spriteLabNode('p','Players see this layered look on the map instead of the walking sprite. It also fills the portrait when no portrait is chosen.',box);
  const canvas=spriteLabNode('canvas',undefined,box);canvas.width=4*96;canvas.height=96;canvas.style.cssText='image-rendering:pixelated;background:#2e3a48;border-radius:6px;max-width:100%';
  const note=spriteLabNode('p','',box);let sheet=null;
  async function paint(){const turn=++draw;try{const next=await spriteLabComposite(data,look);if(turn===draw){sheet=next;note.textContent='';}}catch(e){note.textContent=e.message;}}
  (function frame(time){ // Front, left, right and back, walking in step like the in-game preview.
   if(!canvas.isConnected)return;
   const ctx=canvas.getContext('2d'),column=(cat.walk_sequence??[0,1,2,3])[Math.floor(time/180)%4];ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,canvas.width,canvas.height);
   if(sheet)for(let row=0;row<4;row++)ctx.drawImage(sheet,column*32,row*32,32,32,row*96,0,96,96);
   requestAnimationFrame(frame);
  })(0);
  const tools=spriteLabNode('div',undefined,box);tools.className='row';
  const random=spriteLabNode('button','Randomize',tools);random.type='button';random.onclick=()=>{spriteLabRandomize(cat,look);onChange(look);render(data);};
  const remove=spriteLabNode('button','Remove look',tools);remove.type='button';remove.onclick=()=>{look=null;onChange(null);render(data);};
  const limit=cat.accessory_limit??3,accessories=()=>cat.slots.filter(s=>s.accessory&&look.slots[s.id]).length;
  for(const slot of cat.slots){
   const options=cat.assets.filter(a=>a.slot===slot.id);if(!options.length)continue;
   const label=spriteLabNode('label',slot.label,box),select=spriteLabNode('select',undefined,label);
   if(slot.id!=='base')spriteLabNode('option','None',select).value='';
   for(const a of options)spriteLabNode('option',a.name+(a.premium?' ★':''),select).value=a.id;
   select.value=look.slots[slot.id]??'';
   select.onchange=()=>{
    if(slot.accessory&&select.value&&!look.slots[slot.id]&&accessories()>=limit){select.value='';note.textContent='A look wears up to '+limit+' accessories. Take one off first.';return;}
    spriteLabWear(cat,look,slot.id,select.value);onChange(look);render(data);
   };
   const asset=options.find(a=>a.id===look.slots[slot.id]);
   asset?.channels.forEach((ch,c)=>{
    const row=spriteLabNode('div',undefined,box);row.className='row';row.style.alignItems='center';
    spriteLabNode('span',ch.name,row);
    const colour=spriteLabNode('input',undefined,row);colour.type='color';colour.value=spriteLabHex(look.colors[slot.id][c]);colour.setAttribute('aria-label',slot.label+' '+ch.name+' colour');
    const set=(rgb,commit=true)=>{look.colors[slot.id][c]=rgb;look.enabled[slot.id][c]=true;colour.value=spriteLabHex(rgb);original.checked=false;if(commit)changed();else void paint();};
    colour.oninput=()=>set(spriteLabRgb(colour.value),false);colour.onchange=()=>onChange(look); // Dragging repaints; releasing records one edit.
    for(const rgb of spriteLabSwatches(cat,ch)){const b=spriteLabNode('button','',row);b.type='button';b.title=rgb.join(', ');b.style.cssText='width:18px;height:18px;padding:0;background:'+spriteLabHex(rgb);b.onclick=()=>set([...rgb]);}
    const keep=spriteLabNode('label','',row);keep.style.margin='0';const original=spriteLabNode('input',undefined,keep);original.type='checkbox';original.checked=!look.enabled[slot.id][c];keep.append(' Original');
    original.onchange=()=>{look.enabled[slot.id][c]=!original.checked;changed();};
    const strength=spriteLabNode('input',undefined,row);strength.type='range';strength.min=0;strength.max=100;strength.value=Math.round(look.strength[slot.id][c]*100);strength.style.width='90px';strength.setAttribute('aria-label',slot.label+' '+ch.name+' tint strength');
    strength.oninput=()=>{look.strength[slot.id][c]=Number(strength.value)/100;void paint();};strength.onchange=()=>onChange(look);
   });
  }
  void paint();
 }
 return box;
}
