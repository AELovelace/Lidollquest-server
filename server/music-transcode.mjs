// ffmpeg wrapper for served music. Every song (GM uploads here, library tracks in the game repo's
// python/export_online_music.py) is converted the same way: one input, two outputs — a constant-bitrate mp3 for the
// browser build's <audio> player and an Ogg Vorbis copy for desktop builds (GameMaker's audio_create_stream reads ogg).
// KEEP THE ARGUMENTS IN SYNC with export_online_music.py (FFMPEG_OUTPUT_ARGS there) so library and uploads match.
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const fail=(status,message,code='music_upload_invalid')=>{throw Object.assign(Error(message),{status,code});}; // Same rejection shape as zone-music.mjs.

export function outputArgs(kbps,maxSeconds){ // Shared per-output settings: first audio stream only, no cover art or tags, stereo 44.1 kHz.
 const common=['-map','0:a:0','-vn','-map_metadata','-1','-t',String(maxSeconds+1),'-ac','2','-ar','44100'];
 return {mp3:[...common,'-c:a','libmp3lame','-b:a',kbps+'k','-f','mp3'],ogg:[...common,'-c:a','libvorbis','-b:a',kbps+'k','-f','ogg']};
}

export function createTranscoder({ffmpeg=process.env.QUEST_FFMPEG||'ffmpeg',kbps=Number(process.env.QUEST_MUSIC_BITRATE_KBPS)||96,maxSeconds=600,timeoutMs=180000,run=execFile}={}){
 let busy=false,ready=null; // One conversion at a time keeps a burst of uploads from pinning every core; ready caches the encoder check.
 const exec=(args,timeout)=>new Promise((resolve,reject)=>run(ffmpeg,args,{timeout,windowsHide:true,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr:String(stderr??'')})):resolve(String(stdout??''))));
 async function available(){ // True when ffmpeg runs and has both encoders; cached after the first successful answer.
  if(ready!==null)return ready;
  try{const list=await exec(['-hide_banner','-encoders'],15000);ready=/libmp3lame/.test(list)&&/libvorbis/.test(list);}catch{return false;} // A failure is not cached, so installing ffmpeg needs no restart.
  return ready;
 }
 async function convert(input){ // Buffer of any audio ffmpeg can read -> {mp3, ogg, seconds}.
  if(busy)fail(409,'Another song is converting; try again in a moment.','music_busy');
  busy=true;const dir=await mkdtemp(join(tmpdir(),'quest-music-'));
  try{
   const source=join(dir,'in'),mp3=join(dir,'out.mp3'),ogg=join(dir,'out.ogg'),args=outputArgs(kbps,maxSeconds);
   await writeFile(source,input);
   try{await exec(['-hide_banner','-nostdin','-v','error','-y','-i',source,...args.mp3,mp3,...args.ogg,ogg],timeoutMs);}
   catch(error){
    if(error.code==='ENOENT')fail(503,'ffmpeg is not installed on this server (run deploy/fedora-deploy.sh).','music_ffmpeg_missing');
    if(error.killed||error.signal)fail(504,'Converting took too long; try a shorter file.','music_timeout');
    fail(400,'That file could not be read as audio.');
   }
   const out={mp3:await readFile(mp3),ogg:await readFile(ogg)};
   out.seconds=Math.round(out.mp3.length*8/(kbps*1000)*10)/10; // Constant bitrate: size gives the length.
   if(out.mp3.length<1000)fail(400,'That file has no audio in it.');
   if(out.seconds>maxSeconds)fail(400,'Songs can be up to '+Math.round(maxSeconds/60)+' minutes.','music_too_long');
   return out;
  }finally{busy=false;await rm(dir,{recursive:true,force:true});}
 }
 return {convert,available,kbps,maxSeconds};
}
