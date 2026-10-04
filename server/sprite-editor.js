/* Static Sprite Workshop. Pixel editing, previews and file export work without a server. */
(() => {
 'use strict';
 const $=id=>document.getElementById(id),bundled=window.LIDOLL_SPRITE_EDITOR,LOCAL='lidollquest.sprite-workshop.local.v1';
 let data=structuredClone(bundled),doc=SpriteEditorModel.create(),frame=0,meta={name:'New sprite',slot:'torso',channels:[],hides:[]},dirty=false,busy=false,stroke=null,previewSheet=null,guide=null,paintVersion=0;
 const node=(tag,text,parent)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(parent)parent.append(n);return n;};
 const say=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
 const canvas=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
 const sheet=()=>{const c=canvas(128,128);c.getContext('2d').putImageData(new ImageData(doc.data.slice(),128,128),0,0);return c;};
 const png=()=>sheet().toDataURL('image/png').split(',')[1];
 const project=()=>({format:'lidollquest-sprite',version:1,name:meta.name,slot:meta.slot,channels:meta.channels,hides:meta.hides,png:png()});
 const download=(name,blob)=>{const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 const fileName=()=>meta.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'sprite';
 const pixelsFromPng=async value=>{if(typeof value!=='string'||value.length>100000||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('Choose a 128 × 128 PNG sheet.');const image=new Image();image.src='data:image/png;base64,'+value;await image.decode();if(image.width!==128||image.height!==128)throw Error('The sheet must be 128 × 128 pixels: sixteen 32 × 32 frames.');const c=canvas(128,128);c.getContext('2d').drawImage(image,0,0);return c.getContext('2d').getImageData(0,0,128,128).data;};
 function channels(value){ // Imported metadata is data only; bound it before handing it to the shared preview renderer.
  if(!Array.isArray(value)||value.length>8)throw Error('Use up to eight tint channels.');let count=0;
  for(const c of value){if(!c||typeof c.name!=='string'||!Array.isArray(c.source)||!Array.isArray(c.shade)||c.source.length!==c.shade.length||!c.source.length)throw Error('Each channel needs a name and matching source/shade arrays.');count+=c.source.length;if(count>8)throw Error('Use up to eight source colours.');if(c.source.some(rgb=>!Array.isArray(rgb)||rgb.length!==3||rgb.some(v=>!Number.isInteger(v)||v<0||v>255)))throw Error('Source colours are RGB bytes.');if(c.shade.some(s=>(Array.isArray(s)?s:[s]).some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('Shades range from zero to one.');if(c.default_rgb&&(!Array.isArray(c.default_rgb)||c.default_rgb.length!==3||c.default_rgb.some(v=>!Number.isInteger(v)||v<0||v>255)))throw Error('Default colours are RGB bytes.');}
  return structuredClone(value);
 }
 function controls(){
  $('undo').disabled=!doc.canUndo;$('redo').disabled=!doc.canRedo;
  $('title').textContent=meta.name+' · '+meta.slot;
 }
 async function run(work){if(busy)return;busy=true;$('workspace').disabled=$('library').disabled=true;try{await work();}catch(e){say(e.message,true);}finally{busy=false;$('workspace').disabled=$('library').disabled=false;controls();}}
 function keep(announce=false){try{localStorage.setItem(LOCAL,JSON.stringify(project()));if(announce)say('Kept in this browser. Export a project for a portable backup.');}catch{say('Browser storage is unavailable or full. Export a project to keep your work.',true);}}
 function changed(){dirty=true;keep();draw();void preview();controls();}
 function framePixels(target,index,alpha=1){target.save();target.globalAlpha=alpha;target.imageSmoothingEnabled=false;target.drawImage(sheet(),index%4*32,Math.floor(index/4)*32,32,32,0,0,512,512);target.restore();}
 function draw(){
  const c=$('pixels'),ctx=c.getContext('2d');ctx.clearRect(0,0,512,512);ctx.imageSmoothingEnabled=false;
  if($('bodyGuide').checked&&guide&&meta.slot!=='base'){ctx.globalAlpha=.25;ctx.drawImage(guide,frame%4*32,Math.floor(frame/4)*32,32,32,0,0,512,512);ctx.globalAlpha=1;}
  if($('onion').checked)framePixels(ctx,Math.floor(frame/4)*4+(frame+3)%4,.25);framePixels(ctx,frame);
  if($('grid').checked){ctx.strokeStyle='#aaa4';ctx.lineWidth=1;ctx.beginPath();for(let i=1;i<32;i++){ctx.moveTo(i*16+.5,0);ctx.lineTo(i*16+.5,512);ctx.moveTo(0,i*16+.5);ctx.lineTo(512,i*16+.5);}ctx.stroke();}
  $('frameLabel').textContent=['Down','Left','Right','Up'][Math.floor(frame/4)]+' · frame '+(frame%4+1);
  const whole=sheet();for(const [i,b] of [...$('frames').children].entries()){b.setAttribute('aria-pressed',String(i===frame));const t=b.querySelector('canvas').getContext('2d');t.clearRect(0,0,32,32);t.drawImage(whole,i%4*32,Math.floor(i/4)*32,32,32,0,0,32,32);}
 }
 const assetSheet=asset=>spriteLabSheet(data,asset.sprite); // All source PNGs are bundled with the static page.
 async function preview(){
  const version=++paintVersion;try{
   const asset={...meta,id:'editor_preview',sprite:'editor_preview',channels:channels(meta.channels)},cat={...data.catalog,assets:[...data.catalog.assets.filter(a=>a.id!=='editor_preview'),asset]},look={version:1,slots:{},visible:{},colors:{},enabled:{},strength:{},facing:0};
   for(const slot of cat.order)spriteLabWear(cat,look,slot,'');
   const base=cat.assets.find(a=>a.id===$('body').value);if(base){spriteLabWear(cat,look,'base',base.id);const p=await assetSheet(base),c=canvas(128,128);c.getContext('2d').putImageData(p,0,0);if(version===paintVersion)guide=c;}
   spriteLabWear(cat,look,meta.slot,'editor_preview');
   const local={catalog:cat,sheets:{...data.sheets,editor_preview:png()}};spriteLab.images.delete('editor_preview');
   const next=await spriteLabComposite(local,look);if(version===paintVersion){previewSheet=next;draw();}
  }catch(e){if(version===paintVersion)say('Preview: '+e.message,true);}
 }
 function animate(time){const ctx=$('preview').getContext('2d');ctx.clearRect(0,0,192,192);ctx.imageSmoothingEnabled=false;if(previewSheet){const facing=Number($('direction').value),r=data.catalog.direction_rows[facing],column=$('animate').checked?(data.catalog.walk_sequence??[0,1,2,3])[Math.floor(time/150)%4]:frame%4;ctx.drawImage(previewSheet,column*32,r*32,32,32,0,0,192,192);}requestAnimationFrame(animate);}
 function settings(){
  $('name').value=meta.name;$('slot').value=meta.slot;$('channels').value=JSON.stringify(meta.channels,null,2);$('hides').replaceChildren(node('legend','Clothing hidden underneath this layer'));
  for(const s of data.catalog.slots.filter(s=>s.id!==meta.slot&&s.id!=='base')){const l=node('label',undefined,$('hides')),c=node('input',undefined,l);c.type='checkbox';c.checked=meta.hides.includes(s.id);l.append(s.label);c.onchange=()=>{meta.hides=[...$('hides').querySelectorAll('input:checked')].map(e=>e.value);changed();};c.value=s.id;}
  controls();
 }
 async function load(record){const pixels=await pixelsFromPng(record.png);if(!data.catalog.order.includes(record.slot))throw Error('Unknown wardrobe slot.');const next={name:String(record.name??'Imported sprite').slice(0,64),slot:record.slot,channels:channels(record.channels??[]),hides:(record.hides??[]).filter(s=>data.catalog.order.includes(s)&&s!=='base'&&s!==record.slot)};doc=SpriteEditorModel.create(pixels);meta=next;dirty=false;frame=0;stroke=null;settings();draw();await preview();}
 const discard=()=>!dirty||confirm('Replace your unsaved workspace? Export a project first if you want to keep it.');
 function library(){
  const body=$('body').value;$('body').replaceChildren();for(const a of data.catalog.assets.filter(a=>a.slot==='base')){const o=node('option',a.name,$('body'));o.value=a.id;}if([...$('body').options].some(o=>o.value===body))$('body').value=body; // Keep the selected bundled body guide when filtering the library.
  const search=$('search').value.toLowerCase(),slot=$('slot').value;$('sources').replaceChildren();
  for(const a of data.catalog.assets.filter(a=>a.slot===slot&&(a.name+' '+a.id).toLowerCase().includes(search))){const b=node('button',a.name,$('sources'));b.onclick=()=>run(async()=>{if(!discard())return;const p=await assetSheet(a),c=canvas(128,128);c.getContext('2d').putImageData(p,0,0);await load({...a,png:c.toDataURL().split(',')[1]});say('Editing a local copy of '+a.name+'.');});}
 }
 function coordinate(e){const r=$('pixels').getBoundingClientRect();return [Math.max(0,Math.min(31,Math.floor((e.clientX-r.left)*32/r.width))),Math.max(0,Math.min(31,Math.floor((e.clientY-r.top)*32/r.height)))];}
 function colour(){return [...spriteLabRgb($('colour').value),Number($('opacity').value)];}
 $('pixels').onpointerdown=e=>{if(busy||e.button>0)return;e.preventDefault();const at=coordinate(e),tool=$('tool').value;if(tool==='pick'){const p=doc.pixel(frame,...at);$('colour').value=spriteLabHex(p.slice(0,3));$('opacity').value=p[3];return;}doc.begin();$('pixels').setPointerCapture(e.pointerId);stroke={at,frame,colour:tool==='erase'?[0,0,0,0]:colour()};if(tool==='fill'){doc.fill(frame,...at,stroke.colour);finish();}else{doc.pixel(frame,...at,stroke.colour);draw();}};
 $('pixels').onpointermove=e=>{if(!stroke)return;const at=coordinate(e);doc.line(stroke.frame,stroke.at,at,stroke.colour);stroke.at=at;draw();};
 function finish(){if(!stroke)return;stroke=null;if(doc.commit())changed();}
 $('pixels').onpointerup=$('pixels').onpointercancel=$('pixels').onlostpointercapture=finish;
 for(let i=0;i<16;i++){const b=node('button',undefined,$('frames'));b.title=['Down','Left','Right','Up'][Math.floor(i/4)]+' frame '+(i%4+1);b.setAttribute('aria-label',b.title);b.append(canvas(32,32));b.onclick=()=>{finish();frame=i;draw();};}
 for(const s of data.catalog.slots){const o=node('option',s.label,$('slot'));o.value=s.id;}$('slot').value='torso';
 for(const rgb of data.catalog.swatches.fabric){const b=node('button','',$('palette'));b.style.background=spriteLabHex(rgb);b.title=b.style.background;b.setAttribute('aria-label','Colour '+spriteLabHex(rgb));b.onclick=()=>{$('colour').value=spriteLabHex(rgb);};}
 $('search').oninput=$('slot').onchange=library;$('body').onchange=()=>void preview();for(const id of ['grid','onion','bodyGuide'])$(id).onchange=draw;
 $('name').onchange=()=>{meta.name=$('name').value.trim()||'New sprite';changed();};
 $('blank').onclick=()=>run(async()=>{if(!discard())return;const c=canvas(128,128);await load({name:'New sprite',slot:$('slot').value,png:c.toDataURL().split(',')[1]});say('Blank layer ready.');});
 $('previous').onclick=()=>{finish();frame=(frame+15)%16;draw();};$('next').onclick=()=>{finish();frame=(frame+1)%16;draw();};
 $('undo').onclick=()=>{finish();if(doc.undo())changed();};$('redo').onclick=()=>{finish();if(doc.redo())changed();};$('copy').onclick=()=>{doc.copy(frame);say('Frame copied. Select a frame and choose Paste frame.');};$('paste').onclick=()=>{if(doc.paste(frame))changed();};
 for(const id of ['flipX','flipY','clear'])$(id).onclick=()=>{if(id==='clear'&&!confirm('Clear the selected frame? Undo can restore it.'))return;doc.transform(frame,id);changed();};
 $('pixels').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();(e.key.toLowerCase()==='y'||e.shiftKey?$('redo'):$('undo')).click();}else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();(e.key==='ArrowRight'?$('next'):$('previous')).click();}};
 $('applyChannels').onclick=()=>run(async()=>{meta.channels=channels(JSON.parse($('channels').value));changed();});
 $('fabricTint').onclick=()=>run(async()=>{const shades=new Set();for(let p=0;p<doc.data.length;p+=4)if(doc.data[p+3]&&doc.data[p]===doc.data[p+1]&&doc.data[p]===doc.data[p+2]&&doc.data[p]>0)shades.add(doc.data[p]);if(!shades.size||shades.size>8)throw Error('Use one to eight distinct grey shades (black stays an outline).');const sorted=[...shades].sort((a,b)=>a-b),high=sorted.at(-1);meta.channels=[{name:'Fabric',source:sorted.map(v=>[v,v,v]),shade:sorted.map(v=>v/high),palette:'fabric'}];settings();changed();});
 $('import').onchange=()=>run(async()=>{const file=$('import').files[0];$('import').value='';if(!file||!discard())return;if(file.size>150000)throw Error('Choose a sheet/project smaller than 150 KB.');if(file.type==='image/png'||file.name.toLowerCase().endsWith('.png')){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);await load({name:file.name.replace(/\.png$/i,''),slot:$('slot').value,png:btoa(binary)});}else{const p=JSON.parse(await file.text());if(p.format!=='lidollquest-sprite'||p.version!==1)throw Error('Choose a Sprite Workshop project file.');await load(p);}dirty=true;keep();say('Imported into your local workspace.');});
 $('png').onclick=()=>sheet().toBlob(b=>{download(fileName()+'.png',b);say('PNG downloaded. Send it to a GM for review, along with the intended wardrobe slot: '+meta.slot+'.');});$('project').onclick=()=>download(fileName()+'.lidollsprite.json',new Blob([JSON.stringify(project(),null,2)],{type:'application/json'}));
 $('strip').onclick=()=>{const c=canvas(512,32),s=sheet(),ctx=c.getContext('2d');for(let f=0;f<16;f++)ctx.drawImage(s,f%4*32,Math.floor(f/4)*32,32,32,f*32,0,32,32);c.toBlob(b=>download(fileName()+'_strip16.png',b));};$('local').onclick=()=>keep(true);
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
 library();settings();draw();requestAnimationFrame(animate);
 void run(async()=>{let saved;try{saved=JSON.parse(localStorage.getItem(LOCAL));}catch{}if(saved?.format==='lidollquest-sprite'&&saved.version===1){await load(saved);dirty=true;say('Recovered your local artwork.');}else await preview();});
})();
