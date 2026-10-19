// GM "AI Tester" tab (gm.mjs GET /gm/ai-tester, POST /gm/ai-test): every AI node's full /health, and test queries sent to
// one chosen node (or the pool's pick) with the same request the live game builds: persona, voice, GM speaking style and
// the current lore version come from follower-chat.mjs companionBody(), so GM edits are included. Nothing is stored and
// no character or memory is touched; the GM action log records who tested what. Lives in the main process.
import {participationContext} from './participation-gate.mjs';

export const AI_TEST_ROUTES=Object.freeze({ // route -> npc-rag path. Each builds its own body below.
 chat:'/v1/companion/chat',               // A companion reply (the LangGraph pipeline: classify, wiki, lore, memories, guard).
 impressions:'/v1/companion/impressions', // Facts the companion would remember from one exchange.
 summarize:'/v1/companion/summarize',     // Folding memories into the running summary.
 pip:'/v1/npc/chat',                      // Pip, the tutor (wiki RAG).
 gate:'/v1/participation/decide',         // The Decider: would this companion join in (JOIN/QUIET)?
});
const KINDS=['chat','emote'];        // What a player can send; the unprompted kinds are tested from their own tabs.
const MAX_IN_FLIGHT=3;               // AI slots are shared with players: a few GM tests at once at most.
const TIMEOUT_MS=30000;              // A slow node still answers; the live game gives up sooner.
const REPLY_CHARS=240;               // npc-rag COMPANION_MAX_REPLY_CHARS.
const FLAG_RE=/^[a-z][a-z0-9_:.-]{0,63}$/;

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,code:'ai_test_invalid'});};
const line=(v,max)=>String(v??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max); // One clean line.
const lines=(v,max,count)=>String(v??'').split(/\r?\n/).map(l=>line(l,max)).filter(Boolean).slice(0,count); // A textarea, one entry per line.
const int=(v,lo,hi,dflt)=>{const n=Number(v);return Number.isFinite(n)?Math.max(lo,Math.min(hi,Math.round(n))):dflt;};

export function parseHistory(text,player,npcName){ // "Name: words" lines -> npc-rag turns; a line without a known name counts as the player.
 return lines(text,600,10).map(l=>{const m=/^([^:]{1,64}):\s*(.+)$/.exec(l),who=m?.[1].trim().toLowerCase();
  return who&&who===String(npcName).toLowerCase()?{role:'npc',content:m[2]}:{role:'player',content:m&&who===String(player).toLowerCase()?m[2]:l};});
}

export function quickChecks(route,reply,{npcName='',style=null}={}){ // Cheap red flags only: the keyword checks can't judge a reply, so read it.
 if(!['chat','pip'].includes(route))return [];
 const text=String(reply??''),out=[];
 if(!text.trim())out.push('empty reply');
 if(/\{"(responding_to|secret)"/.test(text))out.push('prompt marker leaked'); // npc-rag strips these; one surviving means a prompt bug.
 if(npcName&&new RegExp('^\\s*'+npcName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*:','i').test(text))out.push('labelled its own line');
 if(/\b(as an ai|language model|ai[- ]powered|i'?m an ai)\b/i.test(text))out.push('talks about being an AI');
 if(route==='chat'&&text.length>REPLY_CHARS)out.push(`over ${REPLY_CHARS} characters`);
 if(style!=='baby_talk'&&/\b(wittle|widdle|tummy-wummy|nap-nap)\b/i.test(text))out.push('baby talk without the baby_talk style');
 return out;
}

export function createAiTester({chat=()=>null,followers=()=>null,pool=()=>null,speakingStyle=()=>undefined,now=Date.now}={}){
 let inFlight=0;
 const catalog=()=>followers()?.catalog??{};
 function companions(){ // What the form offers: every companion with its style and backstory gates (so you know what a secret is).
  return Object.entries(catalog()).filter(([,d])=>d?.online).map(([id,d])=>{const gm=speakingStyle(id);
   return {id,name:String(d.name??id),style:gm===undefined?d.online.speaking_style??null:gm,
    backstory:(d.online.backstory??[]).map(s=>({id:String(s.id),heading:String(s.heading??''),reveal_bond:int(s.reveal?.bond,0,100,0),reveal_flag:String(s.reveal?.flag??''),draft:!!s.draft}))};})
   .sort((a,b)=>a.name.localeCompare(b.name));
 }
 async function view(){ // GET /gm/ai-tester.
  const ai=pool();
  return {configured:!!ai?.configured,routes:Object.keys(AI_TEST_ROUTES),kinds:KINDS,pool:ai?.view()??[],nodes:ai?.health?await ai.health():[],
   lore:chat()?.lore?.()??null,companions:companions(),inFlight,maxInFlight:MAX_IN_FLIGHT};
 }
 function build(input){ // Validated input -> {route,path,body,npcName,style}.
  const route=String(input?.route??'chat');if(!Object.hasOwn(AI_TEST_ROUTES,route))fail('Unknown route.');
  const player=line(input.player,64)||'Tester',message=line(input.message,500);
  if(route!=='summarize'&&!message)fail('Type a message to send.');
  if(route==='pip'){
   return {route,path:AI_TEST_ROUTES.pip,npcName:'Pip',style:null,
    body:{message,player_id:'gm-ai-test',player_name:player,npc_name:'Pip',history:parseHistory(input.history,player,'Pip')}}; // Fixed id: tests never share a session with a real character.
  }
  const npc=String(input.npc??''),def=catalog()[npc];if(!def?.online)fail('Pick a companion.');
  const name=String(def.name??npc).slice(0,32),history=parseHistory(input.history,player,name);
  if(route==='impressions')return {route,path:AI_TEST_ROUTES.impressions,npcName:name,style:null,body:{npc_name:name,player_name:player,message,reply:line(input.reply,600)}};
  if(route==='summarize'){
   const memories=lines(input.memories,400,60);if(!memories.length)fail('Add at least one memory line to summarise.');
   return {route,path:AI_TEST_ROUTES.summarize,npcName:name,style:null,body:{npc_name:name,player_name:player,summary:line(input.summary,1200),memories}};
  }
  if(route==='gate')return {route,path:AI_TEST_ROUTES.gate,npcName:name,style:null,
   body:participationContext(def,{message,playerName:player,kind:KINDS.includes(input.kind)?input.kind:'chat',history,conversation:!!input.conversation,hired:!!input.hired})};
  const flags=lines(String(input.flags??'').replace(/,/g,'\n'),64,50).filter(f=>FLAG_RE.test(f));
  const body=chat().companionBody(npc,null,{player_name:player,message,kind:KINDS.includes(input.kind)?input.kind:'chat',history,
   bond:int(input.bond,0,100,0),flags,audience:int(input.audience,0,50,0),summary:line(input.summary,1200),
   memories:lines(input.memories,400,20).map((text,i)=>({id:'gm-test-'+(i+1),text,importance:2})),situation:lines(input.situation,160,10)});
  return {route,path:AI_TEST_ROUTES.chat,npcName:name,style:body.speaking_style??null,body};
 }
 async function run(input){ // POST /gm/ai-test: one request to one node (input.node = host) or the pool's pick (input.node = '').
  const ai=pool();if(!ai?.configured)fail('No AI nodes are configured (NPC_RAG_NODES).',409);
  if(!chat()?.companionBody)fail('Companion chat is not running on this server.',409);
  const host=String(input?.node??'');if(host&&!ai.hosts().includes(host))fail('Unknown AI node.');
  const {route,path,body,npcName,style}=build(input);
  if(inFlight>=MAX_IN_FLIGHT)fail(`${MAX_IN_FLIGHT} tests are already running; wait for one to finish.`,429);
  inFlight++;const started=now();
  try{
   const opts={timeoutMs:TIMEOUT_MS,attempts:host?1:2,...(host?{only:n=>n.host===host}:{})}; // A chosen node gets no failover: you asked for that one.
   let res=await ai.request(path,body,opts),lorePushed=false;
   if(res.status===409&&route==='chat'){await chat().pushLore();lorePushed=true;res=await ai.request(path,body,opts);} // That node lacked the current lore: push, retry once (as live).
   const reply=route==='chat'||route==='pip'?String(res.body?.reply??''):'';
   return {route,node:res.node,status:res.status,ms:now()-started,lorePushed,request:body,response:res.body,reply,checks:res.ok?quickChecks(route,reply,{npcName,style}):[]};
  }catch(error){
   if(error?.code==='ai_test_invalid')throw error;
   return {route,node:error?.node??host,status:0,ms:now()-started,request:body,response:null,reply:'',error:String(error?.message??error).slice(0,300),checks:[]};
  }finally{inFlight--;}
 }
 return {view,run,companions};
}
