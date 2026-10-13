// What a companion notices right now (COMPANION_LIFELIKE_PLAN.md phase B): a few short word facts about the place, the
// time and the player, sent with each reply as `situation`. Words only, never raw numbers, so the model can't read
// meters out loud. Facts about wetness, messes, urges and smell are `private`: follower-chat sends them only when
// nobody else can hear (public embarrassment stays with the slip rules and their Dignity cost).
import {hubCatalog} from './hubs.mjs';
import {zoneName} from './companion-events.mjs';
import {smellOf} from './dignity.mjs';

const num=v=>Number.isFinite(Number(v))?Number(v):0;
const TIME_ZONE='America/Los_Angeles'; // The game's clock (weekly resets are Pacific too).

export function placeOf(zone){ // "in Honeydew Village, a safe town" / "out in the Autumnal Plains" / "in the Forest dungeon".
 const id=String(zone??'');
 const hub=hubCatalog.find(h=>id===h.id||id.startsWith(h.id+'-'));
 if(hub)return id===hub.id?`in ${hub.name}, a safe town`:`inside a building in ${hub.name}, a safe town`;
 if(id.startsWith('overworld-'))return `out in ${zoneName(id)}`;
 if(/^(dungeon|dive)-/.test(id))return `in ${zoneName(id)}, a dangerous place`;
 return id?`in ${zoneName(id)}`:'';
}

export function timeOfDay(ms){
 const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,hour:'numeric',hourCycle:'h23'}).format(new Date(ms)));
 return hour>=5&&hour<12?'morning':hour<17&&hour>=12?'afternoon':hour>=17&&hour<21?'evening':'night';
}

export function situationFacts({name,state,zone,now,hire=null,speakerId='',recent=null}){ // -> [{text, private}]
 const p=state?.loadout?.player_info??{},facts=[],pub=text=>facts.push({text,private:false}),priv=text=>facts.push({text,private:true});
 const place=placeOf(zone);if(place)pub(`You are ${place}. It is ${timeOfDay(now)}.`);
 if(hire&&hire.character_id===speakerId){
  pub(`${name} hired you; you are traveling together.`);
  const left=num(hire.expires)-now;if(left>0&&left<10*60000)pub(`Your contract with ${name} ends in a few minutes.`);
 }
 const hp=num(p.playerHealth),max=num(p.playerHealthMax);
 if(max>0&&hp/max<.25)pub(`${name} looks badly hurt.`);else if(max>0&&hp/max<.6)pub(`${name} looks a little hurt.`);
 const hunger=num(p.hunger??250),thirst=num(p.thirst??250); // 0-250, low = hungry/thirsty.
 if(hunger<50)pub(`${name} looks very hungry.`);else if(hunger<100)pub(`${name} looks a bit hungry.`);
 if(thirst<50)pub(`${name} looks very thirsty.`);else if(thirst<100)pub(`${name} looks a bit thirsty.`);
 const urge=Math.max(num(p.wet),num(p.tum)); // 0-100; 100 is an accident.
 if(urge>=80)priv(`${name} is fidgeting badly, clearly desperate for a toilet.`);else if(urge>=45)priv(`${name} keeps shifting around like they need a toilet soon.`);
 if(num(p.had_wet_accident)>0||num(p.had_tum_accident)>0)priv(`${name}'s clothes show they had an accident.`);
 else if(num(p.diaper_tum_absorbed)>0)priv(`${name}'s padding is messy.`);
 else if(num(p.diaper_wet_absorbed)>0)priv(`${name}'s padding is wet.`);
 if(smellOf(p)>0)priv(`There is a smell of a mess around ${name}.`);
 if(recent?.text)(recent.embarrassing?priv:pub)(`Just now: ${String(recent.text).slice(0,140)}`); // The latest shared experience (last 5 minutes).
 return facts.map(f=>({...f,text:f.text.slice(0,160)})); // npc-rag accepts up to 10 facts of 160 characters.
}
export const safeZone=zone=>hubCatalog.some(h=>zone===h.id||String(zone??'').startsWith(h.id+'-')); // Towns and their buildings: where musings happen.
