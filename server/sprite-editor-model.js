// Pure pixel operations shared by the static page and tests; frame edits never touch a neighbouring frame.
(function(root){
 const W=128,F=32,length=W*W*4;
 function create(pixels=new Uint8ClampedArray(length)){
  if(pixels.length!==length)throw Error('A sprite sheet contains 128 x 128 RGBA pixels.');
  let data=new Uint8ClampedArray(pixels),undo=[],redo=[],before=null,clipboard=null;
  const offset=(frame,x,y)=>{if(!Number.isInteger(frame)||frame<0||frame>15||!Number.isInteger(x)||!Number.isInteger(y)||x<0||x>=F||y<0||y>=F)throw Error('Pixel outside the selected frame.');return ((Math.floor(frame/4)*F+y)*W+(frame%4)*F+x)*4;};
  const equal=(a,b)=>a.every((v,i)=>v===b[i]);
  function begin(){if(!before)before=data.slice();}
  function commit(){if(!before)return false;const changed=!equal(data,before);if(changed){undo.push(before);if(undo.length>40)undo.shift();redo=[];}before=null;return changed;}
  function pixel(frame,x,y,colour){const at=offset(frame,x,y);if(colour===undefined)return Array.from(data.subarray(at,at+4));if(!Array.isArray(colour)||colour.length!==4||colour.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error('Use RGBA bytes.');data.set(colour,at);}
  function line(frame,a,b,colour){let [x,y]=a;const [x1,y1]=b,dx=Math.abs(x1-x),sx=x<x1?1:-1,dy=-Math.abs(y1-y),sy=y<y1?1:-1;let error=dx+dy;for(;;){pixel(frame,x,y,colour);if(x===x1&&y===y1)break;const twice=2*error;if(twice>=dy){error+=dy;x+=sx;}if(twice<=dx){error+=dx;y+=sy;}}}
  function fill(frame,x,y,colour){const old=pixel(frame,x,y);if(equal(old,colour))return;const queue=[[x,y]],seen=new Set();while(queue.length){const [px,py]=queue.pop(),key=py*F+px;if(px<0||px>=F||py<0||py>=F||seen.has(key))continue;seen.add(key);if(!equal(pixel(frame,px,py),old))continue;pixel(frame,px,py,colour);queue.push([px+1,py],[px-1,py],[px,py+1],[px,py-1]);}}
  function copy(frame){clipboard=new Uint8ClampedArray(F*F*4);for(let y=0;y<F;y++)for(let x=0;x<F;x++)clipboard.set(pixel(frame,x,y),(y*F+x)*4);}
  function paste(frame){if(!clipboard)return false;begin();for(let y=0;y<F;y++)for(let x=0;x<F;x++)pixel(frame,x,y,Array.from(clipboard.subarray((y*F+x)*4,(y*F+x+1)*4)));return commit();}
  function transform(frame,operation){const source=data.slice();begin();for(let y=0;y<F;y++)for(let x=0;x<F;x++){const sx=operation==='flipX'?F-1-x:x,sy=operation==='flipY'?F-1-y:y;pixel(frame,x,y,operation==='clear'?[0,0,0,0]:Array.from(source.subarray(offset(frame,sx,sy),offset(frame,sx,sy)+4)));}return commit();}
  function history(back){commit();const from=back?undo:redo,to=back?redo:undo;if(!from.length)return false;to.push(data);data=from.pop();return true;}
  return {get data(){return data;},get canUndo(){return !!undo.length;},get canRedo(){return !!redo.length;},begin,commit,pixel,line,fill,copy,paste,transform,undo:()=>history(true),redo:()=>history(false)};
 }
 root.SpriteEditorModel={create};
})(globalThis);
