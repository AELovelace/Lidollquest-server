import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Publishes content/weekly_quests.json through the same /gm/action calls the GM console
// makes, so a whole pack deploys, re-deploys after an edit, or retires in one command.
// Usage: node scripts/upload-weekly-quests.mjs --base https://<host> [--signin|--token T]
//        node scripts/upload-weekly-quests.mjs --dry-run
//        node scripts/upload-weekly-quests.mjs --base ... --token ... --retire
// The account behind the token needs the 'gamemaster' role, granted in Little Log user
// management. --signin runs the LiDollID device authorisation the panel uses; the panel
// keeps its own token in memory only, so there is nothing to copy out of a browser.
const argv=process.argv.slice(2);
const flag=name=>argv.includes('--'+name);
const value=(name,fallback=null)=>{const i=argv.indexOf('--'+name);return i>=0&&argv[i+1]&&!argv[i+1].startsWith('--')?argv[i+1]:fallback;};
const die=message=>{console.error(message);process.exit(1);};

const packPath=new URL('../'+(value('pack')??'content/weekly_quests.json'),import.meta.url);
const base=(value('base')??'').replace(/\/+$/,'');
const retire=flag('retire');
let token=value('token')??process.env.LIDOLLQUEST_GM_TOKEN??null;

const pack=JSON.parse(readFileSync(packPath,'utf8'));
if(pack.kind!=='quest')die('That pack does not declare kind "quest".'); // Guard against pointing this at an NPC or monster pack.
const quests=pack.quests??[];
if(new Set(quests.map(q=>q.id)).size!==quests.length)die('Quest IDs must be unique within the pack.');

const perHub=new Map();
for(const quest of quests){const hub=quest.givers[0].split('-garden:')[0];perHub.set(hub,(perHub.get(hub)??0)+1);}
console.log(quests.length+' quests in '+packPath.pathname.split('/').pop());
for(const [hub,n] of [...perHub].sort())console.log('  '+hub+': '+n);
if(flag('dry-run'))process.exit(0);
if(!base)die('Publishing needs --base; use --dry-run to inspect the pack offline.');

async function call(method,path,body,bearer=token){
 const headers={'Content-Type':'application/json'};
 if(bearer)headers.Authorization='Bearer '+bearer; // The GM API revalidates this against LiDollID on every call.
 let response;
 try{response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});}
 catch(error){die('Could not reach '+base+path+': '+error.message);} // A wrong --base or a closed port, not a content problem.
 const text=await response.text();
 let payload;try{payload=JSON.parse(text);}catch{payload={error:text.slice(0,400)};}
 return {status:response.status,payload};
}

async function request(method,path,body){
 const {status,payload}=await call(method,path,body);
 if(status<400)return payload;
 const hints={gm_forbidden_address:'Your address is not in LIDOLLQUEST_GM_ALLOW in /etc/lidollquest/server.env. Add it, or run this on the server.',
  gm_not_gamemaster:"Grant this LiDollID account the 'gamemaster' role in Little Log user management.",
  gm_panel_disabled:'LIDOLLQUEST_GM_ENABLED is false on this deployment.',
  gm_insecure_transport:'This deployment requires HTTPS for /gm.'};
 const hint=hints[payload.error]??(status===401?'The token has expired. Run again with --signin.':'');
 die(method+' '+path+' failed with HTTP '+status+': '+(payload.error_description??payload.error??JSON.stringify(payload))+(hint?'\n'+hint:'')); // Surface the server's own refusal, which names the invalid field.
}

async function signin(){
 const started=await request('POST','/gm/signin/start');
 console.log('\n  Open '+(started.verification_uri??'your LiDollID account page'));
 console.log('  Enter the code: '+started.user_code);
 console.log('  Waiting for approval (expires in '+(started.expires_in??600)+'s)...\n');
 let interval=Math.max(1,started.interval??5);
 const deadline=Date.now()+(started.expires_in??600)*1000;
 while(Date.now()<deadline){
  await new Promise(resolve=>setTimeout(resolve,interval*1000));
  const {status,payload}=await call('POST','/gm/signin/poll',{device_code:started.device_code},null);
  if(status===200){console.log('Signed in as '+(payload.owner??'gamemaster')+'.');return payload.access_token;}
  if(payload.error==='slow_down'){interval+=5;continue;} // The provider asks for a longer gap; honour it rather than hammering.
  if(payload.error!=='authorization_pending')die('Sign-in failed: '+(payload.error_description??payload.error));
 }
 die('Sign-in timed out before the code was approved.');
}

if(flag('signin')){
 token=await signin();
 console.log('Reuse this token with --token, or set LIDOLLQUEST_GM_TOKEN:\n  '+token+'\n');
}
if(!token)die('Publishing needs a token: pass --signin, --token, or set LIDOLLQUEST_GM_TOKEN.');

const who=await request('GET','/gm/whoami'); // Fail on identity before publishing half a pack.
console.log((retire?'Retiring':'Publishing')+' to '+base+' as '+(who.owner??'gamemaster'));

const content=await request('GET','/gm/content');
if(!Array.isArray(content.quests))die('This server exposes no quest content. Deploy the NPC/quest release first; see NPC_QUEST_RELEASE.md.');
const revisions=new Map(content.quests.map(row=>[row.id,row.revision])); // A quest the server has never seen is revision 0.

let published=0,unchanged=0;
for(const quest of quests){
 const entry={...quest,retired:retire};
 const revision=revisions.get(quest.id)??0;
 const digest=createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0,16);
 const body={action:'content_publish',kind:'quest',id:quest.id,revision,entry,request_id:((retire?'retire-':'weekly-')+quest.id+'-'+digest).slice(0,100)}; // Stable per payload, so a retried run replays its receipt instead of erroring.
 const result=await request('POST','/gm/action',body);
 const next=result.result?.revision;
 if(next===revision){unchanged++;console.log('  = '+quest.id+' (already at revision '+revision+')');}
 else{published++;console.log('  + '+quest.id+' -> revision '+next);}
}
console.log('Done: '+published+' changed, '+unchanged+' already current.');
console.log('Accepted player instances keep their pinned definitions; this affects future acceptance only.');
