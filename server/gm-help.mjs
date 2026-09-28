import {readFileSync} from 'node:fs';

const chapters=JSON.parse(readFileSync(new URL('./gm-wiki/pages.json',import.meta.url),'utf8'));
const pictures=new Set(JSON.parse(readFileSync(new URL('./gm-wiki/illustrations.json',import.meta.url),'utf8')));
const catalog=new Map(chapters.map(page=>{
 const markdown=readFileSync(new URL(`./gm-wiki/content/${page.slug}.md`,import.meta.url),'utf8');
 const images=new Map([...markdown.matchAll(/!\[([^\]]*)\]\(\.\.\/(assets\/tutorial\/[a-z0-9-]+\.(?:png|svg))(?:\s+"([^"]*)")?\)/g)].map(m=>[m[2],[m[1],m[3]].filter(Boolean).join(' ')]));
 return [page.slug,{...page,images}];
})); // Canonical local metadata prevents model output from inventing external links or image URLs.
const fail=(status,message)=>{throw Object.assign(Error(message),{status,code:'gm_help_failed'});};
const text=(value,max)=>typeof value==='string'?value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,max):'';

export function helpSources(value){
 if(!Array.isArray(value))return [];
 return value.slice(0,5).flatMap((source,index)=>{
  const page=catalog.get(source?.slug);if(!page)return [];
  const anchor=text(source.anchor,180),path='/gm/wiki/#/'+(page.slug==='index'?'':page.slug)+(anchor?'/'+encodeURIComponent(anchor):'');
  const seen=new Set(),images=[];
  for(const image of (Array.isArray(source.images)?source.images:[]).slice(0,3)){
   if(!pictures.has(image?.path)||!page.images.has(image.path)||seen.has(image.path))continue;
   seen.add(image.path);images.push({url:'/gm/wiki/'+image.path,caption:page.images.get(image.path)});
  }
  return [{number:index+1,title:page.title,heading:text(source.heading,200),url:path,images}];
 });
} // Only shipped wiki chapters and pictures can become clickable references in the chat window.

export function createGmHelp({url=process.env.LIDOLLQUEST_GM_HELP_URL||'',apiKey=process.env.LIDOLLQUEST_GM_HELP_KEY||'',fetchImpl=fetch,timeoutMs=70000,maxConcurrent=2}={}){
 const pending=new Set();
 return async function ask(owner,input){
  if(!url||!apiKey)fail(503,'GM help is not configured yet. Set LIDOLLQUEST_GM_HELP_URL and LIDOLLQUEST_GM_HELP_KEY on the game server.');
  if(!input||typeof input.message!=='string'||!input.message.trim()||input.message.length>2000)fail(400,'Write a question between 1 and 2000 characters.');
  const history=input.history??[];
  if(!Array.isArray(history)||history.length>6||history.some(t=>!t||!['user','assistant'].includes(t.role)||typeof t.content!=='string'||!t.content.trim()||t.content.length>8000))fail(400,'Conversation history is invalid. Start a new chat.');
  if(pending.has(owner)||pending.size>=maxConcurrent)fail(429,'The GM assistant is busy. Please try again shortly.');
  pending.add(owner);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
  try{
   const endpoint=new URL('/v1/gm/chat',url);
   if(!['http:','https:'].includes(endpoint.protocol))fail(503,'GM help endpoint configuration is invalid.');
   const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json','X-Api-Key':apiKey},body:JSON.stringify({message:input.message.trim(),history:history.map(({role,content})=>({role,content}))})});
   if(!response.ok){await response.body?.cancel();fail(response.status===429?429:502,response.status===429?'The GM assistant is busy. Try again shortly.':'The GM help service is unavailable. You can still open the GM wiki.');}
   let size=0;const chunks=[];
   for await(const chunk of response.body){size+=chunk.length;if(size>128*1024){controller.abort();fail(502,'The GM help response was too large.');}chunks.push(chunk);}
   const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(typeof result.reply!=='string'||!result.reply.trim())fail(502,'The GM help service returned an empty answer.');
   return {reply:text(result.reply,8000),sources:helpSources(result.sources),status:['answered','no_sources','unavailable'].includes(result.status)?result.status:'answered',indexed_at:text(result.indexed_at,40)};
  }catch(error){
   if(error.code==='gm_help_failed')throw error;
   fail(502,'The GM help service could not answer. Try again, or open the GM wiki.');
  }finally{clearTimeout(timer);pending.delete(owner);}
 }; // No identity grants, drafts, accounts or game state are sent to the AI service.
}
