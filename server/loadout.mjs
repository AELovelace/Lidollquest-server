const fail=message=>{throw Object.assign(Error(message),{status:400,code:'invalid_loadout'});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const currencies=new Set(['gold','coins','diamonds','wallet','balance','lidollcoins','lidollcoin']);
const number=(value,fallback,min=0,max=1000000)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;

export function importLoadout(input) { // Campaign data is intentionally client-trusted; bounds protect storage and transport, not competitive integrity.
 if(!object(input)||!object(input.player_info)||!Array.isArray(input.inventory)||input.inventory.length>512)fail('Send character stats and at most 512 inventory slots.');
 if(Buffer.byteLength(JSON.stringify(input))>192*1024)fail('Character data is too large.');
 let nodes=0;
 function copy(value,depth=0){
  if(++nodes>20000||depth>16)fail('Character data is too complex.');
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))fail('Character numbers must be finite.');return value;}
  if(Array.isArray(value))return value.map(v=>copy(v,depth+1));
  if(object(value))return Object.fromEntries(Object.entries(value).filter(([key])=>!currencies.has(key.toLowerCase())&&!['__proto__','prototype','constructor'].includes(key)).map(([key,v])=>[key,copy(v,depth+1)]));
  fail('Unsupported character data.');
 }
 const result=copy({player_info:input.player_info,inventory:input.inventory,childish:number(input.childish,0,0,10),player_spells:input.player_spells??[],player_mp:input.player_mp??0,player_mp_max:input.player_mp_max??0,attack:input.attack??Math.max(1,number(input.player_info.str,0)*2)});
 const p=result.player_info;
 p.playerHealthMax=number(p.playerHealthMax,70,1);p.playerHealth=number(p.playerHealth,p.playerHealthMax,0,p.playerHealthMax);
 for(const key of ['str','def','dex','int','cha'])p[key]=number(p[key],0,-1000000); // Preserve campaign curse/equipment penalties as well as bonuses.
 p.level=number(p.level,1,1);p.xp=number(p.xp,0);
 result.attack=number(result.attack,Math.max(1,p.str*2),1); // The client includes its existing class damage multiplier.
 result.player_mp_max=number(result.player_mp_max,0);result.player_mp=number(result.player_mp,0,0,result.player_mp_max);
 if(!Array.isArray(result.player_spells)||result.player_spells.length>512||result.inventory.some(item=>!object(item)||typeof item.item_id!=='string'))fail('Invalid inventory or learned spells.');
 return result;
}

export function applyRunLoadout(run,loadout) { // Handicaps remain attached to this run when equipment or consumables change base stats.
 const p=loadout.player_info,weakened=run.handicaps.filter(h=>h==='Weakened strikes').length,vitality=run.handicaps.filter(h=>h==='Reduced vitality').length;
 run.maxHp=Math.max(1,p.playerHealthMax-vitality*5);run.hp=Math.min(run.maxHp,p.playerHealth);
 run.attack=Math.max(1,loadout.attack-weakened);run.defense=p.def-run.handicaps.filter(h=>h==='Reduced armor').length;run.level=p.level;
}

export function syncRunHealth(state,run) { // Save current HP without permanently applying temporary arena maximum-HP penalties.
 if(state.loadout)state.loadout.player_info.playerHealth=run.hp;
}
