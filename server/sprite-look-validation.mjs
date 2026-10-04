// Pure look validation shared by the server and the offline quest editor. The caller supplies the shipped layer catalog.
export function validateSpriteLook(input,catalog,{unlocked=null,fail=message=>{throw Object.assign(Error(message),{status:400,code:'look_invalid'});}}={}){
 // unlocked: the account's accessory/premium IDs, or null for GM-authored NPCs that do not require player purchases.
 const integer=(v,min,max,label)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(label+' must be between '+min+' and '+max+'.');return v;};
 if(!input||input.version!==1||!input.slots)fail('Design a look in the wardrobe first.');
 const accessories=new Set((catalog.slots??[]).filter(s=>s.accessory).map(s=>s.id)),limit=catalog.accessory_limit??3;
 const out={version:1,slots:{},colors:{},strength:{},enabled:{},visible:{},facing:integer(input.facing??0,0,3,'Direction')};
 let worn=0;
 for(const slot of catalog.order){
  const id=input.slots[slot]??'',asset=catalog.assets.find(a=>a.id===id&&a.slot===slot);
  if(!asset){if(slot==='base'||id)fail('Unsupported look layer.');out.slots[slot]='';out.colors[slot]=[];out.strength[slot]=[];out.enabled[slot]=[];out.visible[slot]=true;continue;}
  if(accessories.has(slot)){
   worn++;if(worn>limit)fail(`You can wear up to ${limit} accessories at once.`);
  }
  if(asset.personal&&(!unlocked||!unlocked.has(id)))fail('This personal sprite belongs to another account.');
  if(!asset.personal&&unlocked&&(accessories.has(asset.slot)||asset.premium===true)&&!unlocked.has(id))fail(`Unlock ${asset.name} (1 diamond) before wearing it.`);
  out.slots[slot]=id;out.visible[slot]=slot==='base'||input.visible?.[slot]!==false;
  out.colors[slot]=asset.channels.map((c,i)=>{const rgb=input.colors?.[slot]?.[i]??c.default_rgb??[255,255,255];if(!Array.isArray(rgb)||rgb.length!==3)fail('Choose valid RGB colours.');return rgb.map(v=>integer(v,0,255,'Colour'));});
  out.strength[slot]=asset.channels.map((_,i)=>{const n=input.strength?.[slot]?.[i]??1;if(!Number.isFinite(n)||n<0||n>1)fail('Invalid tint strength.');return n;});
  out.enabled[slot]=asset.channels.map((_,i)=>input.enabled?.[slot]?.[i]===true);
 }
 return out;
} // Only registered layers and numeric tint channels are published; no client asset URLs or shader code.
