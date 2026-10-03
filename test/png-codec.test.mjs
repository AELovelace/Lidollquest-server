import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {decodePng,encodePng,createCanvas,blit,fillRect,fillCircle,strokeRect,scaleNearest,downscale,crc32} from '../server/png-codec.mjs';
import {validateWorldPng} from '../server/world-png.mjs';

const tiny='iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAN0lEQVR4nO3QQREAMAgDQYofTCKxhspUBZ+NgcvsudUvFpebcQcIECBAgAABAgQIECBAgACBTzBf6ALAS4QDIwAAAABJRU5ErkJggg=='; // 32x32 greyscale fixture shared with world-controls.test.mjs.
function png(width,height,colour,rows,extra=[]){ // Hand-built PNG with chosen colour type, filter bytes and chunks, for decoder coverage.
 const chunk=(type,payload)=>{const length=Buffer.alloc(4);length.writeUInt32BE(payload.length);const body=Buffer.concat([Buffer.from(type,'ascii'),payload]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=colour;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),...extra.map(([type,payload])=>chunk(type,Buffer.from(payload))),chunk('IDAT',deflateSync(Buffer.from(rows))),chunk('IEND',Buffer.alloc(0))]);
}

test('encodePng output decodes back to the same pixels and passes the upload validator',()=>{
 const canvas=createCanvas(5,3,[10,20,30,255]);fillRect(canvas,1,1,2,1,[200,100,50,255]);fillRect(canvas,4,2,1,1,[0,0,0,0]);canvas.data[(2*5+4)*4+3]=0;
 const bytes=encodePng(canvas);assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),5);assert.equal(bytes.readUInt32BE(20),3);
 validateWorldPng(bytes,5,3); // The GM upload path accepts what the painter writes.
 const back=decodePng(bytes);assert.equal(back.width,5);assert.equal(back.height,3);assert.deepEqual([...back.data],[...canvas.data]);
});

test('decodePng handles every 8-bit colour type and all five row filters',()=>{
 const rgba=decodePng(png(2,1,6,[0,255,0,0,255,0,255,0,255]));assert.deepEqual([...rgba.data],[255,0,0,255,0,255,0,255]);
 const rgb=decodePng(png(2,1,2,[1,10,20,30,5,5,5]));assert.deepEqual([...rgb.data],[10,20,30,255,15,25,35,255]); // Sub filter adds the previous pixel.
 const grey=decodePng(png(1,2,0,[0,100,2,20]));assert.deepEqual([...grey.data],[100,100,100,255,120,120,120,255]); // Up filter adds the pixel above.
 const greyAlpha=decodePng(png(1,2,4,[0,100,200,3,10,10]));assert.deepEqual([...greyAlpha.data],[100,100,100,200,60,60,60,110]); // Average filter: floor((0+100)/2)+10.
 const paeth=decodePng(png(2,2,0,[0,10,20,4,5,5]));assert.deepEqual([...paeth.data].filter((_,i)=>i%4===0),[10,20,15,25]); // Paeth picks the nearest predictor.
 const palette=decodePng(png(2,1,3,[0,0,1],[['PLTE',[255,0,0,0,0,255]],['tRNS',[255,128]]]));assert.deepEqual([...palette.data],[255,0,0,255,0,0,255,128]);
 const fixture=decodePng(Buffer.from(tiny,'base64'));assert.equal(fixture.width,32);assert.equal(fixture.height,32);assert.equal(fixture.data.length,32*32*4);
 assert.throws(()=>decodePng(Buffer.from('not a png')),/Not a PNG/);
 const sixteen=Buffer.from(png(1,1,6,[0,0,0,0,0]));sixteen[24]=16;assert.throws(()=>decodePng(sixteen),/8-bit/);
});

test('blit composites with alpha and tint, and the scalers keep dimensions honest',()=>{
 const dst=createCanvas(4,4,[0,0,0,255]),src=createCanvas(2,2,[200,100,0,128]);
 blit(dst,src,1,1,{tint:[255,255,0]});
 assert.deepEqual([...dst.data.subarray((1*4+1)*4,(1*4+1)*4+4)],[100,50,0,255]); // Half-covered black stays opaque and takes half the tinted colour.
 assert.deepEqual([...dst.data.subarray(0,4)],[0,0,0,255]); // Untouched corner.
 const atlas=createCanvas(4,2,[0,0,0,255]);fillRect(atlas,2,0,2,2,[9,9,9,255]);const out=createCanvas(2,2);blit(out,atlas,0,0,{sx:2,sy:0,sw:2,sh:2});assert.equal(out.data[0],9); // Sub-rectangle copy (an atlas cell).
 const big=scaleNearest(src,4,4);assert.equal(big.width,4);assert.equal(big.data[3],128);
 const quarter=downscale(createCanvas(4,4,[40,80,120,255]),2);assert.equal(quarter.width,2);assert.deepEqual([...quarter.data.subarray(0,4)],[40,80,120,255]);
 const ring=createCanvas(8,8);strokeRect(ring,0,0,8,8,[1,2,3,255]);fillCircle(ring,4,4,2,[7,7,7,255]);assert.equal(ring.data[(4*8+4)*4],7);assert.equal(ring.data[(1*8+1)*4+3],0);
});
