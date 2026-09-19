import {createHash,timingSafeEqual} from 'node:crypto';
import {inspectionProjection} from './inspection.mjs';
import {createPaperdoll} from './paperdoll.mjs';

export function createMommybotProfile(db,{token='',enabled=()=>true,now=Date.now,paperdoll=createPaperdoll()}={}){
 if(token&&!/^[A-Za-z0-9_-]{32,128}$/.test(token))throw Error('MOMMYBOT_ONLINE_TOKEN must be 32-128 URL-safe secret characters.');
 const hash=value=>createHash('sha256').update(value).digest();
 return {
  route(req,res,url){
   if(url.pathname!=='/integrations/mommybot/character')return false;
   const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));return true;};
   if(!token)return send(503,{error:'profile_disabled'});
   if(req.headers.origin||!timingSafeEqual(hash(String(req.headers.authorization||'')),hash('Bearer '+token)))return send(401,{error:'profile_unauthorized'});
   if(req.method!=='GET')return send(405,{error:'method_not_allowed'});
   const owner=String(url.searchParams.get('account_id')||'');
   if(!owner||owner.length>128)return send(400,{error:'invalid_account'});
   if(!enabled(owner))return send(404,{error:'character_unavailable'});
   const id=String(url.searchParams.get('character_id')||'');
   const chosen=id
    ?db.prepare('SELECT * FROM quest_characters WHERE owner=? AND id=?').get(owner,id)
    :db.prepare(`SELECT c.* FROM quest_characters c LEFT JOIN quest_presence p ON p.character_id=c.id
      WHERE c.owner=? ORDER BY COALESCE(p.seen,0) DESC,c.created DESC,c.id LIMIT 1`).get(owner);
   if(!chosen)return send(404,{error:'character_unavailable'}); // Every lookup is scoped to the requested owner, so no character of another account is ever reachable.
   const sheet=inspectionProjection(chosen);
   delete sheet.account_id; // MommyBot already knows which wallet it asked about; never echo the account back.
   const characters=db.prepare('SELECT id,name FROM quest_characters WHERE owner=? ORDER BY created DESC,id LIMIT 25').all(owner);
   // The portrait composites the same authored layers the companion client draws.
   // It is rendered from the projection above, so it can never show gear the sheet
   // does not already disclose. A deployment without exported artwork simply omits
   // it and the caller falls back to the appearance fields.
   let portrait=null;
   try{portrait=paperdoll.render({character_id:chosen.id,revision:chosen.revision,player_info:sheet.player_info});}
   catch{portrait=null;} // A portrait is never worth failing the request over.
   return send(200,{...sheet,
    online:Boolean(db.prepare('SELECT 1 FROM quest_presence WHERE character_id=? AND seen>?').get(chosen.id,now()-30000)),
    characters,
    portrait_png:portrait?portrait.toString('base64'):null,
    portrait_size:portrait?paperdoll.size:null});
  }, // The server-only credential reveals one owner's public inspection sheet: appearance, level, class and equipped items, never inventory, coins, saves or grants.
 };
} // Serve the same projection an in-world player may already inspect, to an authenticated companion service instead of a peer.
