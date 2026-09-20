import {inflateSync} from 'node:zlib';
const fail=()=>{throw Object.assign(Error('Upload a complete, valid PNG image.'),{status:400,code:'world_invalid_png'});};
const crcTable=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function checksum(bytes){let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;} // Reject damaged uploads before clients try decoding them.
export function validateWorldPng(bytes,width,height){
 let offset=8,ended=false;const compressed=[];
 while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset),end=offset+12+length;if(end>bytes.length)fail();const type=bytes.toString('ascii',offset+4,offset+8);
  if(checksum(bytes.subarray(offset+4,offset+8+length))!==bytes.readUInt32BE(offset+8+length))fail();
  if(type==='IHDR'&&(offset!==8||length!==13))fail();
  if(type==='IDAT')compressed.push(bytes.subarray(offset+8,offset+8+length));
  if(type==='IEND'){if(length!==0||end!==bytes.length)fail();ended=true;break;}offset=end;
 }
 if(!ended||!compressed.length||![0,2,3,4,6].includes(bytes[25])||![1,2,4,8,16].includes(bytes[24])||bytes[26]!==0||bytes[27]!==0||bytes[28]>1)fail();
 try{const decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:Math.min(17000000,width*height*8+height*8+1024)});if(decoded.length<height)fail();}catch{fail();}
} // Bound decompression before a PNG reaches either the browser or GameMaker texture loader.
