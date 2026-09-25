// The gods of LiDollQuest Online (FAITH_DESIGN.md): dedication, uniforms, piety and blessings, all server-side.
//  - state.faith = {god, piety, gainTurns, dedications, since, anathema, reasons, locked, freeBreaks:{day, used}}. It lives in
//    character state (never the client-trusted loadout) and reaches the client in the snapshot as character.faith.
//  - uniformStatus(god, loadout, items): {ok, reasons[]} against the god's uniform rules (gods-data.json).
//  - tickFaith(state, prev, next, ctx): piety for one committed turn (ctx.turn) or an equipment change (Sable's changing rooms).
//  - blessingValue / crawlFree: how much of a god's blessing a follower has earned (faith-blessing.mjs; 0 while Orin's
//    followers are locked in cursed gear). combatFaith(state) is the slice zones.mjs stamps onto the loadout for combat.
import {outfitLook,cursedWorn} from './outfit.mjs';
import {isCrawling} from './crawl.mjs';

import {godsData,GODS,faithBlessing,faithCrawlFree} from './faith-blessing.mjs';
export {godsData,GODS};
export const FAITH_SETTINGS=Object.freeze({...godsData.settings});
export const templeGod=hub=>godsData.gods.find(g=>g.temple_hub===hub)??null; // Which god's temple stands in a hub.
const num=v=>Number.isFinite(Number(v))?Number(v):0;
const S=FAITH_SETTINGS;

export function uniformStatus(godId,loadout,items){ // Does this outfit and body keep the god's uniform? Reasons are short, player-facing phrases.
 const god=GODS[godId];if(!god||god.uniform.none)return {ok:true,reasons:[]};
 const u=god.uniform,look=outfitLook(loadout,items),reasons=[];
 if(u.max_item_childish!==undefined)for(const {item} of look.worn)if(item&&item.category!=='weapon'&&num(item.childish)>u.max_item_childish){reasons.push((item.name??item.item_id)+' is too childish');break;} // Orthain: every garment grown-up
 if(u.forbid_diaper&&look.padded)reasons.push('wearing a diaper');
 if(u.require_diaper&&!look.padded)reasons.push('not wearing a diaper');
 if(u.forbid_crawling&&isCrawling(loadout))reasons.push('crawling');
 if(u.min_childish_avg!==undefined&&look.childish<u.min_childish_avg)reasons.push('dressed too grown-up');
 if(u.incontinence_max!==undefined&&look.incontinence>u.incontinence_max)reasons.push('incontinence too high');
 if(u.incontinence_min!==undefined&&look.incontinence<u.incontinence_min)reasons.push('not incontinent enough');
 if(u.chest==='bare'&&!look.chestBare)reasons.push('chest covered');
 if(u.chest==='covered'&&!look.chestCovered)reasons.push('chest uncovered');
 if(u.underwear==='shown'&&look.bottomHidden)reasons.push('underwear hidden');
 if(u.underwear==='concealed'&&!look.bottomHidden)reasons.push('underwear showing');
 return {ok:reasons.length===0,reasons};
}

export function wouldBreakUniform(godId,loadout,item,items){ // Would putting this garment on turn a follower who keeps the uniform into one who breaks it?
 if(!GODS[godId]||GODS[godId].uniform.none||!item)return false;
 if(!uniformStatus(godId,loadout,items).ok)return false; // Already in anathema: nothing new is forced on them.
 const p={...(loadout?.player_info??{})},cat=item.category==='dress'?'torso':item.category;
 p['equipped_'+cat]=item.item_id;if(item.category==='dress')p.equipped_pants=item.item_id; // A dress fills both slots.
 if(cat==='panties')p.panties_bulk=num(items[item.item_id]?.bulk??item.bulk);
 return !uniformStatus(godId,{...loadout,player_info:p},{...items,[item.item_id]:items[item.item_id]??item}).ok;
}

export function changedPadding(prev,next){ // Did this commit change the underwear layer: a new item, removal, or a diaper emptied (a change)?
 const a=prev?.player_info??{},b=next?.player_info??{};
 if((a.equipped_panties??'')!==(b.equipped_panties??''))return true;
 return num(b.diaper_wet_absorbed)<num(a.diaper_wet_absorbed)||num(b.diaper_tum_absorbed)<num(a.diaper_tum_absorbed);
}

export function dedicate(state,godId,now){ // Swear to a god: piety starts again at 0.
 if(!GODS[godId])throw Object.assign(Error('Choose one of the five gods.'),{status:400});
 const before=state.faith??{};state.faithSworn=num(state.faithSworn)+1; // Lifetime vows: only the very first is free (hubs.mjs prepareDedication).
 state.faith={god:godId,piety:0,gainTurns:0,dedications:num(before.dedications)+1,since:now,anathema:false,reasons:[],locked:false,freeBreaks:before.freeBreaks??{day:'',used:0}};
 return state.faith;
}

export function tickFaith(state,prev,next,{items,turn=true,changingRoom=false}={}){ // Returns log lines; mutates state.faith.
 const f=state.faith,god=f?GODS[f.god]:null;if(!god)return [];
 const lines=[],max=S.piety_max,before=num(f.piety);
 if(god.uniform.none){ // Orin: no uniform, but being locked in cursed gear is a humiliation of its own.
  const locked=cursedWorn(next,items);
  if(locked&&turn)f.piety=Math.max(0,num(f.piety)-S.orin_cursed_drain);
  if(locked&&!f.locked)lines.push('Orin scowls: you are locked in cursed gear. His blessing fails you until you break free.');
  if(!locked&&f.locked)lines.push('Free again. Orin grins.');
  f.locked=locked;
  return lines;
 }
 if(god.uniform.changing_rooms_only&&changedPadding(prev,next)&&!changingRoom){ // Sable: the under-layer is changed in private, or not at all.
  f.piety=Math.max(0,num(f.piety)-S.sable_change_penalty);
  lines.push(`Anathema! You changed out in the open. Sable turns her face from you. Piety -${Math.min(before,S.sable_change_penalty)}.`);
 }
 const status=uniformStatus(god.id,next,items);
 if(status.ok){
  if(f.anathema)lines.push(`Back in ${god.name}'s uniform. The weight on your heart lifts.`);
  if(turn){f.gainTurns=num(f.gainTurns)+1;if(f.gainTurns>=S.piety_gain_every_turns){f.gainTurns=0;f.piety=Math.min(max,num(f.piety)+1);}} // slow, steady devotion
 }else{
  if(turn)f.piety=Math.max(0,num(f.piety)-S.piety_loss_per_turn);
  if(!f.anathema)lines.push(`Anathema! ${status.reasons[0][0].toUpperCase()+status.reasons[0].slice(1)}. ${god.name} is displeased; piety falls every step until you fix it.`);
 }
 f.anathema=!status.ok;f.reasons=status.reasons;
 if(before<max&&f.piety>=max)lines.push(`Your devotion is complete: ${god.name}'s full blessing is yours.`);
 return lines;
}

export const blessingValue=(state,key)=>faithBlessing(state?.faith,key); // A blessing number scaled by piety (faith-blessing.mjs).
export const crawlFree=state=>faithCrawlFree(state?.faith);

export function prayText(state,godId,loadout,items){ // What an altar tells you: your standing with a follower's own god, or what a stranger god asks.
 const god=GODS[godId],f=state.faith;
 if(f?.god===godId){
  const status=uniformStatus(godId,loadout,items),locked=god.uniform.none&&f.locked;
  return `You pray at the altar of ${god.name}. Piety ${num(f.piety)}/${S.piety_max}. `+(locked?'You are locked in cursed gear; Orin will not bless you until you break free.':status.ok?`You keep ${god.name}'s ways. ${god.blessing_text}`:`Anathema: ${status.reasons.join(', ')}.`);
 }
 return `The altar of ${god.name}, god of ${god.domain}. "${god.philosophy}" ${god.blessing_text} Speak to the priest to swear yourself to ${god.name}.`;
}

export function breakFree(state,now){ // Orin's devout: spend one of today's (UTC) free breaks from cursed gear, if any remain.
 const day=new Date(now).toISOString().slice(0,10),allowed=Math.floor(blessingValue(state,'free_breaks_per_day')+1e-9);
 const fb=state.faith.freeBreaks?.day===day?state.faith.freeBreaks:{day,used:0};
 if(fb.used>=allowed)return {ok:false,left:0,allowed};
 fb.used++;state.faith.freeBreaks=fb;return {ok:true,left:allowed-fb.used,allowed}; // left: breaks remaining today after this one.
}
export function combatFaith(state){ // The slice of faith combat needs, attached to the run's loadout so combat.mjs never reads character state.
 return state?.faith?{god:state.faith.god,piety:num(state.faith.piety),locked:!!state.faith.locked}:null;
}
