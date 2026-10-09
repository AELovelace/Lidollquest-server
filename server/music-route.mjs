// Serves one music file (zone-music.mjs musicFile) with single-range support. Used by the public GET /music/<id>.mp3|.ogg
// route in service.mjs (no auth: nginx publishes it as /quest-music/ and caches it) and by the GM panel's bearer-authed
// previews in gm.mjs. Browsers' <audio> elements ask for byte ranges (Safari refuses media without 206 support).
import {createReadStream} from 'node:fs';

export const MUSIC_PATH=/^[/]music[/]([0-9a-f]{32})[.](mp3|ogg)$/; // Public route: /music/<id>.<ext>

export function sendMusic(req,res,file,{cache='public, max-age=31536000, immutable'}={}){ // file: {path,bytes,type}; returns true once answered.
 const head={'Content-Type':file.type,'Accept-Ranges':'bytes','Cache-Control':cache,'X-Content-Type-Options':'nosniff'};
 const range=req.headers.range;
 if(range){
  const match=/^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  let start=match&&match[1]!==''?Number(match[1]):null,end=match&&match[2]!==''?Number(match[2]):null;
  if(match&&start===null&&end!==null){start=Math.max(0,file.bytes-end);end=file.bytes-1;} // "bytes=-500": the last 500 bytes.
  else if(match&&start!==null)end=end===null?file.bytes-1:Math.min(end,file.bytes-1);
  if(!match||start===null||start>end||start>=file.bytes){res.writeHead(416,{...head,'Content-Range':'bytes */'+file.bytes});res.end();return true;} // Multi-range and nonsense ranges are refused, not guessed.
  res.writeHead(206,{...head,'Content-Range':`bytes ${start}-${end}/${file.bytes}`,'Content-Length':end-start+1});
  if(req.method==='HEAD'){res.end();return true;}
  createReadStream(file.path,{start,end}).on('error',()=>res.destroy()).pipe(res);return true;
 }
 res.writeHead(200,{...head,'Content-Length':file.bytes});
 if(req.method==='HEAD'){res.end();return true;}
 createReadStream(file.path).on('error',()=>res.destroy()).pipe(res);return true;
}
