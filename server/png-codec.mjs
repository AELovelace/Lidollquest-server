// Pure-JS PNG decode/encode plus a tiny RGBA compositor, so the server can paint zone pictures with zlib alone (no npm deps).
// Decoding covers what GameMaker exports: 8-bit greyscale, RGB, palette (+tRNS), grey+alpha and RGBA, non-interlaced, all five filters.
// Encoding always writes 8-bit RGBA with filter 0 in one IDAT chunk, which validateWorldPng (world-png.mjs) accepts.
import {inflateSync,deflateSync} from 'node:zlib';

export const crcTable=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;}); // Standard CRC-32 table shared with world-png.mjs.
export function crc32(bytes){let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;} // PNG chunk checksum over type + data.
const fail=message=>{throw Object.assign(Error(message),{status:400,code:'png_codec_failed'});};
const SIGNATURE='89504e470d0a1a0a';

export function decodePng(buffer){ // -> {width,height,data:Uint8Array (RGBA, 4 bytes per pixel)}
 const bytes=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer);
 if(bytes.length<33||bytes.subarray(0,8).toString('hex')!==SIGNATURE)fail('Not a PNG.');
 let offset=8,width=0,height=0,depth=0,colour=0,interlace=0,palette=null,alpha=null;const idat=[];
 while(offset+12<=bytes.length){
  const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),start=offset+8,end=start+length;if(end+4>bytes.length)fail('Truncated PNG chunk.');
  if(type==='IHDR'){width=bytes.readUInt32BE(start);height=bytes.readUInt32BE(start+4);depth=bytes[start+8];colour=bytes[start+9];interlace=bytes[start+12];}
  else if(type==='PLTE')palette=bytes.subarray(start,end);
  else if(type==='tRNS')alpha=bytes.subarray(start,end);
  else if(type==='IDAT')idat.push(bytes.subarray(start,end));
  else if(type==='IEND')break;
  offset=end+4; // Skip the CRC; uploads were already verified by validateWorldPng and shipped files are trusted release data.
 }
 if(!width||!height||!idat.length)fail('PNG has no image data.');
 if(depth!==8||interlace!==0||![0,2,3,4,6].includes(colour))fail('Only 8-bit non-interlaced PNGs are supported.');
 const channels={0:1,2:3,3:1,4:2,6:4}[colour],stride=width*channels,raw=inflateSync(Buffer.concat(idat),{maxOutputLength:(stride+1)*height+1024});
 if(raw.length<(stride+1)*height)fail('PNG image data is short.');
 const rows=new Uint8Array(stride*height);let previous=new Uint8Array(stride);
 for(let y=0;y<height;y++){ // Undo the per-row filter (PNG spec 9.2): None, Sub, Up, Average, Paeth.
  const filter=raw[y*(stride+1)],line=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1)),out=rows.subarray(y*stride,(y+1)*stride);
  for(let i=0;i<stride;i++){
   const a=i>=channels?out[i-channels]:0,b=previous[i],c=i>=channels?previous[i-channels]:0,x=line[i];
   let value;
   if(filter===0)value=x;else if(filter===1)value=x+a;else if(filter===2)value=x+b;else if(filter===3)value=x+((a+b)>>1);
   else if(filter===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);value=x+(pa<=pb&&pa<=pc?a:pb<=pc?b:c);}
   else fail('Unknown PNG filter.');
   out[i]=value&255;
  }
  previous=out;
 }
 const data=new Uint8Array(width*height*4);
 for(let i=0,p=0;i<width*height;i++,p+=4){ // Expand every colour type to RGBA.
  const s=i*channels;
  if(colour===6){data[p]=rows[s];data[p+1]=rows[s+1];data[p+2]=rows[s+2];data[p+3]=rows[s+3];}
  else if(colour===2){data[p]=rows[s];data[p+1]=rows[s+1];data[p+2]=rows[s+2];data[p+3]=255;}
  else if(colour===0){data[p]=data[p+1]=data[p+2]=rows[s];data[p+3]=255;}
  else if(colour===4){data[p]=data[p+1]=data[p+2]=rows[s];data[p+3]=rows[s+1];}
  else {const index=rows[s];if(!palette||index*3+2>=palette.length)fail('Palette index out of range.');data[p]=palette[index*3];data[p+1]=palette[index*3+1];data[p+2]=palette[index*3+2];data[p+3]=alpha&&index<alpha.length?alpha[index]:255;}
 }
 return {width,height,data};
}

function chunk(type,payload){const length=Buffer.alloc(4);length.writeUInt32BE(payload.length);const body=Buffer.concat([Buffer.from(type,'ascii'),payload]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);} // One PNG chunk: length, type+data, CRC.
export function encodePng({width,height,data},{level=6}={}){ // RGBA -> PNG buffer (colour type 6, filter 0 every row).
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||data.length!==width*height*4)fail('encodePng needs RGBA data matching width*height.');
 const raw=Buffer.alloc((width*4+1)*height);
 for(let y=0;y<height;y++){raw[y*(width*4+1)]=0;raw.set(data.subarray(y*width*4,(y+1)*width*4),y*(width*4+1)+1);}
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;header[10]=0;header[11]=0;header[12]=0;
 return Buffer.concat([Buffer.from(SIGNATURE,'hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level})),chunk('IEND',Buffer.alloc(0))]);
}

export function createCanvas(width,height,fill=[0,0,0,0]){const data=new Uint8Array(width*height*4);if(fill.some(Boolean))for(let p=0;p<data.length;p+=4){data[p]=fill[0];data[p+1]=fill[1];data[p+2]=fill[2];data[p+3]=fill[3];}return {width,height,data};} // A blank RGBA surface.

export function blit(dst,src,dx,dy,{sx=0,sy=0,sw=src.width,sh=src.height,tint=null,alpha=1}={}){ // Source-over composite of a sub-rectangle of src onto dst; tint multiplies colour channels (0-255 each), like draw_sprite_part_ext's blend colour.
 const tr=tint?tint[0]/255:1,tg=tint?tint[1]/255:1,tb=tint?tint[2]/255:1;
 for(let y=0;y<sh;y++){const ty=dy+y,oy=sy+y;if(ty<0||ty>=dst.height||oy<0||oy>=src.height)continue;
  for(let x=0;x<sw;x++){const tx=dx+x,ox=sx+x;if(tx<0||tx>=dst.width||ox<0||ox>=src.width)continue;
   const s=(oy*src.width+ox)*4,a=src.data[s+3]*alpha/255;if(a<=0)continue;
   const d=(ty*dst.width+tx)*4,da=dst.data[d+3]/255,oa=a+da*(1-a);
   if(oa<=0)continue;
   const sr=src.data[s]*tr,sg=src.data[s+1]*tg,sb=src.data[s+2]*tb;
   dst.data[d]=Math.round((sr*a+dst.data[d]*da*(1-a))/oa);dst.data[d+1]=Math.round((sg*a+dst.data[d+1]*da*(1-a))/oa);dst.data[d+2]=Math.round((sb*a+dst.data[d+2]*da*(1-a))/oa);dst.data[d+3]=Math.round(oa*255);
  }
 }
 return dst;
}

export function fillRect(dst,x0,y0,w,h,[r,g,b,a=255]){ // Source-over a flat colour over a rectangle (alpha 0-255).
 const fa=a/255;
 for(let y=Math.max(0,y0);y<Math.min(dst.height,y0+h);y++)for(let x=Math.max(0,x0);x<Math.min(dst.width,x0+w);x++){
  const d=(y*dst.width+x)*4,da=dst.data[d+3]/255,oa=fa+da*(1-fa);if(oa<=0)continue;
  dst.data[d]=Math.round((r*fa+dst.data[d]*da*(1-fa))/oa);dst.data[d+1]=Math.round((g*fa+dst.data[d+1]*da*(1-fa))/oa);dst.data[d+2]=Math.round((b*fa+dst.data[d+2]*da*(1-fa))/oa);dst.data[d+3]=Math.round(oa*255);
 }
 return dst;
}

export function strokeRect(dst,x0,y0,w,h,colour,thickness=1){fillRect(dst,x0,y0,w,thickness,colour);fillRect(dst,x0,y0+h-thickness,w,thickness,colour);fillRect(dst,x0,y0,thickness,h,colour);fillRect(dst,x0+w-thickness,y0,thickness,h,colour);return dst;} // Outline only.

export function fillCircle(dst,cx,cy,radius,colour){for(let y=Math.floor(cy-radius);y<=Math.ceil(cy+radius);y++)for(let x=Math.floor(cx-radius);x<=Math.ceil(cx+radius);x++)if((x+0.5-cx)**2+(y+0.5-cy)**2<=radius*radius)fillRect(dst,x,y,1,1,colour);return dst;} // Orb discs and markers.

export function scaleNearest(src,sw,sh){ // Resample to sw x sh (nearest neighbour), used to shrink markers to a cell and to downscale whole pictures.
 const out=createCanvas(sw,sh);
 for(let y=0;y<sh;y++){const oy=Math.min(src.height-1,Math.floor(y*src.height/sh));for(let x=0;x<sw;x++){const ox=Math.min(src.width-1,Math.floor(x*src.width/sw)),s=(oy*src.width+ox)*4,d=(y*sw+x)*4;out.data[d]=src.data[s];out.data[d+1]=src.data[s+1];out.data[d+2]=src.data[s+2];out.data[d+3]=src.data[s+3];}}
 return out;
}

export function downscale(src,factor){ // Box-average by an integer factor so 32px cells read cleanly at 16 or 8 px.
 if(factor===1)return src;const w=Math.floor(src.width/factor),h=Math.floor(src.height/factor),out=createCanvas(w,h),n=factor*factor;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let r=0,g=0,b=0,a=0;for(let dy=0;dy<factor;dy++)for(let dx=0;dx<factor;dx++){const s=((y*factor+dy)*src.width+x*factor+dx)*4,sa=src.data[s+3];r+=src.data[s]*sa;g+=src.data[s+1]*sa;b+=src.data[s+2]*sa;a+=sa;}const d=(y*w+x)*4;if(a){out.data[d]=Math.round(r/a);out.data[d+1]=Math.round(g/a);out.data[d+2]=Math.round(b/a);}out.data[d+3]=Math.round(a/n);}
 return out;
}
