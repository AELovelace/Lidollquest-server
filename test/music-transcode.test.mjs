import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTranscoder,outputArgs} from '../server/music-transcode.mjs';

// music-transcode.mjs: one ffmpeg run turns any upload into a 96 kbps mp3 (browser build) and an Ogg Vorbis file (desktop).
// The real round trip runs only where ffmpeg is installed (dev machines, the Fedora host); error paths use a fake runner.

const ffmpeg=process.env.QUEST_FFMPEG||'ffmpeg';
const hasFfmpeg=(()=>{try{const list=execFileSync(ffmpeg,['-hide_banner','-encoders'],{encoding:'utf8',windowsHide:true});return /libmp3lame/.test(list)&&/libvorbis/.test(list);}catch{return false;}})();

test('real ffmpeg: a 3 s wav becomes a 96 kbps mp3 plus an ogg',{skip:!hasFfmpeg&&'ffmpeg with libmp3lame + libvorbis is not installed'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'transcode-test-'));
 try{
  const wav=join(dir,'tone.wav');execFileSync(ffmpeg,['-hide_banner','-v','error','-f','lavfi','-i','sine=frequency=440:duration=3','-ac','2',wav],{windowsHide:true});
  const t=createTranscoder({ffmpeg});assert.equal(await t.available(),true);
  const out=await t.convert(readFileSync(wav));
  assert.ok(out.mp3.length>30000&&out.mp3.length<45000,'about 36 KB at 96 kbps: '+out.mp3.length);
  assert.ok(Math.abs(out.seconds-3)<0.3,'length from the constant bitrate: '+out.seconds);
  assert.equal(out.ogg.subarray(0,4).toString('latin1'),'OggS');
  await assert.rejects(t.convert(Buffer.from('definitely not audio, just words')),error=>error.status===400,'unreadable input');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('both outputs share one argument list (kept in sync with the exporter)',()=>{
 const args=outputArgs(96,600);
 for(const list of [args.mp3,args.ogg]){assert.deepEqual(list.slice(0,12),['-map','0:a:0','-vn','-map_metadata','-1','-t','601','-ac','2','-ar','44100','-c:a']);assert.ok(list.includes('96k'));}
 assert.ok(args.mp3.includes('libmp3lame'));assert.ok(args.ogg.includes('libvorbis')); // The game repo's export_online_music.py has a matching contract test.
});

test('error paths: ffmpeg missing, timeouts, busy, too long, and an encoder check that is not cached on failure',async()=>{
 const missing=createTranscoder({run:(cmd,args,opts,cb)=>cb(Object.assign(Error('spawn ffmpeg ENOENT'),{code:'ENOENT'}))});
 await assert.rejects(missing.convert(Buffer.from('x')),error=>error.status===503&&/not installed/.test(error.message));
 assert.equal(await missing.available(),false);
 const slow=createTranscoder({run:(cmd,args,opts,cb)=>cb(Object.assign(Error('killed'),{killed:true,signal:'SIGTERM'}))});
 await assert.rejects(slow.convert(Buffer.from('x')),error=>error.status===504);
 let release;const hold=createTranscoder({run:(cmd,args,opts,cb)=>{release=()=>cb(Object.assign(Error('done'),{code:1}));}});
 const first=hold.convert(Buffer.from('x'));await new Promise(r=>setTimeout(r,20));
 await assert.rejects(hold.convert(Buffer.from('y')),error=>error.status===409,'one conversion at a time');
 release();await assert.rejects(first,error=>error.status===400);
 const {writeFileSync}=await import('node:fs');
 const long=createTranscoder({maxSeconds:1,run:(cmd,args,opts,cb)=>{const mp3=args[args.indexOf('mp3')+1],ogg=args[args.length-1];writeFileSync(mp3,Buffer.alloc(96000/8*3));writeFileSync(ogg,Buffer.from('OggS'));cb(null,'','');}}); // 3 s of 96 kbps "audio".
 await assert.rejects(long.convert(Buffer.from('x')),error=>error.status===400&&/up to/.test(error.message));
 let answers=0;const flaky=createTranscoder({run:(cmd,args,opts,cb)=>{answers++;answers===1?cb(Object.assign(Error('nope'),{code:'ENOENT'})):cb(null,' A..... libmp3lame\n A..... libvorbis\n','');}});
 assert.equal(await flaky.available(),false);assert.equal(await flaky.available(),true,'installing ffmpeg needs no restart');
});
