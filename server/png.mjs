import {inflateSync,deflateSync} from 'node:zlib';

// Minimal PNG codec, stdlib only. The service has no dependencies and no
// node_modules, so a native canvas is not an option; this exists so paperdoll
// portraits can be composited server-side without changing that.
//
// Scope is deliberately narrow: 8-bit RGBA, non-interlaced, which is what every
// one of the 1,540 exported paperdoll layers is. Anything else is refused loudly
// rather than decoded approximately, because a silently wrong portrait is worse
// than a missing one.

const SIGNATURE=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const fail=message=>{throw Object.assign(Error(message),{code:'png_unsupported'});};

const CRC_TABLE=(()=>{ // Standard PNG/zlib CRC-32, built once at import.
 const table=new Int32Array(256);
 for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c;}
 return table;
})();
function crc32(buffer){
 let c=-1;
 for(let i=0;i<buffer.length;i++)c=CRC_TABLE[(c^buffer[i])&0xff]^(c>>>8);
 return (c^-1)>>>0;
}

const paeth=(a,b,c)=>{ // The PNG predictor: pick whichever neighbour the gradient favours.
 const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
 return pa<=pb&&pa<=pc?a:pb<=pc?b:c;
};

export function decode(buffer){
 if(buffer.length<8||!buffer.subarray(0,8).equals(SIGNATURE))fail('Not a PNG.');
 let offset=8,width=0,height=0,ready=false;
 const parts=[];
 while(offset+8<=buffer.length){
  const length=buffer.readUInt32BE(offset),type=buffer.toString('latin1',offset+4,offset+8);
  const start=offset+8,end=start+length;
  if(end+4>buffer.length)fail('Truncated PNG.');
  if(type==='IHDR'){
   width=buffer.readUInt32BE(start);height=buffer.readUInt32BE(start+4);
   const depth=buffer[start+8],colour=buffer[start+9],interlace=buffer[start+12];
   if(depth!==8||colour!==6)fail(`Only 8-bit RGBA PNG is supported (got depth ${depth}, colour type ${colour}).`);
   if(interlace!==0)fail('Interlaced PNG is not supported.');
   if(!width||!height)fail('PNG has no pixels.');
   ready=true;
  }
  else if(type==='IDAT')parts.push(buffer.subarray(start,end));
  else if(type==='IEND')break;
  offset=end+4; // skip the chunk CRC; a corrupt file fails at inflate or unfilter instead
 }
 if(!ready)fail('PNG has no header.');
 if(!parts.length)fail('PNG has no image data.');

 const raw=inflateSync(Buffer.concat(parts));
 const stride=width*4,expected=(stride+1)*height;
 if(raw.length<expected)fail('PNG image data is short.');

 // Undo the per-scanline filter in place, walking rows top to bottom.
 const data=Buffer.allocUnsafe(stride*height);
 let previous=Buffer.alloc(stride); // row -1 is treated as all zeroes
 for(let y=0;y<height;y++){
  const filter=raw[y*(stride+1)],line=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1));
  const row=data.subarray(y*stride,(y+1)*stride);
  for(let i=0;i<stride;i++){
   const a=i>=4?row[i-4]:0,b=previous[i],c=i>=4?previous[i-4]:0,x=line[i];
   row[i]=filter===0?x:filter===1?(x+a)&0xff:filter===2?(x+b)&0xff
    :filter===3?(x+((a+b)>>1))&0xff:filter===4?(x+paeth(a,b,c))&0xff
    :fail(`Unknown PNG filter ${filter}.`);
  }
  previous=row;
 }
 return {width,height,data};
}

function chunk(type,body){
 const out=Buffer.allocUnsafe(body.length+12);
 out.writeUInt32BE(body.length,0);
 out.write(type,4,'latin1');
 body.copy(out,8);
 out.writeUInt32BE(crc32(out.subarray(4,8+body.length)),8+body.length);
 return out;
}

export function encode({width,height,data}){
 const stride=width*4;
 if(data.length<stride*height)fail('Pixel buffer is short.');
 // Adaptive filtering: try all five per row and keep whichever has the smallest
 // sum of absolute differences, the heuristic the PNG spec itself suggests. Sprite
 // artwork has large flat regions, so this roughly halves the encoded size.
 const raw=Buffer.allocUnsafe((stride+1)*height);
 const candidate=Buffer.allocUnsafe(stride);
 let previous=Buffer.alloc(stride);
 for(let y=0;y<height;y++){
  const row=data.subarray(y*stride,(y+1)*stride);
  let bestFilter=0,bestScore=Infinity,best=null;
  for(let filter=0;filter<5;filter++){
   let score=0;
   for(let i=0;i<stride;i++){
    const a=i>=4?row[i-4]:0,b=previous[i],c=i>=4?previous[i-4]:0,x=row[i];
    const v=filter===0?x:filter===1?(x-a)&0xff:filter===2?(x-b)&0xff
     :filter===3?(x-((a+b)>>1))&0xff:(x-paeth(a,b,c))&0xff;
    candidate[i]=v;
    score+=v<128?v:256-v; // signed magnitude, as the spec's minimum-sum heuristic uses
   }
   if(score<bestScore){bestScore=score;bestFilter=filter;best=Buffer.from(candidate);}
  }
  raw[y*(stride+1)]=bestFilter;
  best.copy(raw,y*(stride+1)+1);
  previous=row;
 }
 const header=Buffer.alloc(13);
 header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);
 header[8]=8;header[9]=6;header[10]=0;header[11]=0;header[12]=0; // 8-bit RGBA, deflate, adaptive filter, no interlace
 return Buffer.concat([SIGNATURE,chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}

export function blank(width,height){return {width,height,data:Buffer.alloc(width*height*4)};}

export function over(target,source,alpha=1){
 // Source-over compositing, matching what the browser canvas does with globalAlpha.
 // Layers are the same size by construction; anything else is a content bug, so it
 // is clipped rather than stretched.
 const w=Math.min(target.width,source.width),h=Math.min(target.height,source.height);
 for(let y=0;y<h;y++){
  let d=(y*target.width)*4,s=(y*source.width)*4;
  for(let x=0;x<w;x++,d+=4,s+=4){
   const sa=(source.data[s+3]/255)*alpha;
   if(sa<=0)continue;
   if(sa>=1){target.data[d]=source.data[s];target.data[d+1]=source.data[s+1];target.data[d+2]=source.data[s+2];target.data[d+3]=255;continue;}
   const da=target.data[d+3]/255,out=sa+da*(1-sa);
   if(out<=0){target.data[d+3]=0;continue;}
   for(let i=0;i<3;i++)target.data[d+i]=Math.round((source.data[s+i]*sa+target.data[d+i]*da*(1-sa))/out);
   target.data[d+3]=Math.round(out*255);
  }
 }
 return target;
}
