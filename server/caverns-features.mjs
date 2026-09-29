import {exposeClothing} from './clothing-conditions.mjs';
export function cavernBreath(cfg,time){
 const durations=[cfg.ebb_seconds??45,cfg.warning_seconds??15,cfg.surge_seconds??30].map(v=>Math.max(1,Number(v)||1)*1000),period=durations.reduce((a,b)=>a+b,0),phase=((time%period)+period)%period;
 let index=0,start=0;while(index<2&&phase>=start+durations[index])start+=durations[index++];
 return {phase:['ebb','inhale','surge'][index],until:time+start+durations[index]-phase,durations,period};
} // One server clock for the whole edition; reconnects never accumulate missed exposure.
export function cavernStep(f,s,x,y,config,time,catalog={}){
 const band=f.caveChannels?.[y]?.[x],cfg=config.features?.cavern_breath;
 if(!band||!cfg||cavernBreath(cfg,time).phase!=='surge'||s.run||s.dungeonScene||s.pendingDefeat)return false;
 const slots=band===2?(cfg.deep_slots??['socks','shoes','pants']):(cfg.shallow_slots??['socks','shoes']);
 exposeClothing(s.loadout.player_info,slots,catalog);
 s.loadout.player_info.wet=Math.min(100,Math.max(0,s.loadout.player_info.wet??0)+(cfg.needs_pressure??1)); // Explicit needs pressure is independent of garment wetting and never invokes an accident event.
 return true;
}
export function cavernDelay(f,x,y,config,time){
 const cfg=config.features?.cavern_breath;
 return cfg&&f.caveChannels?.[y]?.[x]&&cavernBreath(cfg,time).phase==='surge'?Math.max(0,Number(cfg.step_delay_ms)||0):0;
} // Only a step leaving flooded low ground adds a wading interval; dry ledges keep their normal pace.
