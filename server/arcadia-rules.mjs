// Arcadia's Big Rules, server side: the bigs judge how little you look, and charge for it.
//  - arcadiaLook(loadout, items): how childish your outfit is, whether your padding shows and whether it is visibly used
//    (outfit.mjs, mirroring the client's get_player_childish and are_panties_concealed).
//  - littleTax(look, tuning): the merchant's verdict: a normal price, a marked-up one, or no sale at all.
// zones.mjs applies the tax to the shop offers it sends, so the prices the client shows are exactly what hubs.mjs charges.
import {dignityTuning} from './dignity.mjs';
import {outfitLook} from './outfit.mjs'; // Shared with the gods' uniforms (faith.mjs).

export const ARCADIA_ZONE='arcadia-foundry';
export const inArcadia=zoneId=>zoneId===ARCADIA_ZONE||String(zoneId??'').startsWith(ARCADIA_ZONE+'-'); // The city and its Boarding House, Rail Depot and Guildhall.

export function arcadiaLook(loadout,items){ // How little you look to a big: the shared outfit reading (outfit.mjs), trimmed to what the little tax needs.
 const {childish,padded,showing,used}=outfitLook(loadout,items);return {childish,padded,showing,used};
}

export function littleTax(look,tuning){ // {refuse, percent, reason}: what an Arcadia merchant makes of you.
 const t=dignityTuning(tuning);
 if(look.used)return {refuse:true,percent:0,reason:'visibly wet or messy'}; // No big will serve someone in that state.
 const little=look.showing||look.childish>=t.arcadiaLittleChildish;
 return little?{refuse:false,percent:t.arcadiaLittleTaxPct,reason:look.showing?'visible padding':'a childish outfit'}:{refuse:false,percent:0,reason:''};
}

export const taxedPrice=(price,tax)=>tax.percent>0?Math.max(1,Math.ceil(price*(100+tax.percent)/100)):price; // Always at least the base price; rounding up, as bigs do.
