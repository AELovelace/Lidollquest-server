// Defeat aftermath effects: the numeric beat fields authored on a loss blurb (wet_delta, set_tum, shame_delta, ...) now apply online too.
// The service settles the pressure/need/Dignity fields once per encounter, like defeat-dignity.mjs. The diaper_* accident fields ride along on
// the scene pages and play on the client (online_defeat_beats -> _narrative_apply_diaper_fill), because accident absorption is client-simulated.
import {currentTuning} from './combat.mjs';
import {resolvedDefeat} from './defeat-scenes.mjs';
import {loseDignity} from './dignity.mjs';
const losses=new Set(['defeat','submit','submitted','charm_backfire']); // Same outcomes as defeat-equipment.mjs and defeat-dignity.mjs.
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const AFTERMATH_EFFECTS=Object.freeze({ // key -> [min,max] accepted when authored (world-content.mjs validates GM edits with the same table).
 wet_delta:[-100,100],tum_delta:[-100,100],set_wet:[0,100],set_tum:[0,100],shame_delta:[-1024,1024],
 hunger_delta:[-250,250],thirst_delta:[-250,250],stamina_delta:[-1000,1000],diaper_wet_delta:[-10,10],diaper_tum_delta:[-10,10]
});

export function aftermathPages(run,outcome){ // The exact aftermath pages this defeat presents: the same receipt hash and group the client shows.
 const content=run?.enemy?.defeat?resolvedDefeat(run.enemy.defeat,run.id,outcome):null;
 return content?.first?.aftermath??[]; // First and repeat share one aftermath list and hash, so either picks the same pages; a charm backfire already resolves to the charm group.
}

export function applyDefeatAftermath(state,run,outcome,tuning=currentTuning()){ // Returns the log lines it added; empty when nothing changed.
 if(!losses.has(outcome)||!state.loadout||!run||state.defeatAftermathReceipt===run.id)return []; // Receipt: polling and reconnects never apply one aftermath twice.
 state.defeatAftermathReceipt=run.id;
 const p=state.loadout.player_info,total={};
 for(const page of aftermathPages(run,outcome))for(const [key,value] of Object.entries(page?.effects??{})){
  if(!Object.hasOwn(AFTERMATH_EFFECTS,key)||!Number.isFinite(value))continue;
  total[key]=key.startsWith('set_')?value:(total[key]??0)+value; // Linear blurbs: deltas add up page by page, a later set_ wins.
 }
 const lines=[],before={wet:num(p.wet),tum:num(p.tum)};
 if(total.set_wet!=null)p.wet=clamp(total.set_wet,0,100);
 if(total.set_tum!=null)p.tum=clamp(total.set_tum,0,100);
 if(total.wet_delta)p.wet=clamp(num(p.wet)+total.wet_delta,0,100);
 if(total.tum_delta)p.tum=clamp(num(p.tum)+total.tum_delta,0,100);
 if(num(p.wet)!==before.wet)lines.push('Bladder '+(p.wet>before.wet?'+':'')+(p.wet-before.wet)+' ('+p.wet+'/100).');
 if(num(p.tum)!==before.tum)lines.push('Tummy '+(p.tum>before.tum?'+':'')+(p.tum-before.tum)+' ('+p.tum+'/100).');
 for(const [key,field] of [['hunger_delta','hunger'],['thirst_delta','thirst']])if(total[key])p[field]=clamp(num(p[field])+total[key],0,250); // Same 0-250 range as survival_adjust().
 if(total.stamina_delta)p.stamina=clamp(num(p.stamina)+total.stamina_delta,0,num(p.stamina_max,100));
 if(total.shame_delta<0){const lost=loseDignity(p,-total.shame_delta,tuning);if(lost)lines.push('Dignity -'+lost+' ('+p.shame+' / 1024).');} // Campaign sign: negative costs Dignity, scaled by Shame.
 else if(total.shame_delta>0){const was=num(p.shame,1024);p.shame=Math.min(1024,was+total.shame_delta);if(p.shame>was)lines.push('Dignity +'+(p.shame-was)+' ('+p.shame+' / 1024).');} // Authored comfort gives Dignity back, unscaled (enemyStat's rule).
 run.log?.push(...lines);
 return lines;
}
