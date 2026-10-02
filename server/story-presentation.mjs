import {readFileSync} from 'node:fs';

export const interactionText={
 goodbye:'Goodbye.',more:'Tell me more.',quests:'Ask about quests.',turn_in:'Turn in: ',continue:'Continue',
 hire:'Hire for 1 diamond - 60 minutes',not_now:'Not now.',keep_travelling:'Keep travelling.',dismiss:'Dismiss companion',
 hire_details:' I take one party slot. Your account and party may each hire only one companion. Mention my name in Area chat to talk to me.',
 hire_remaining:'We have {minutes} minutes left together. Mention my name in Area chat when you want to talk. Dismissing me early ends this hire without a refund.',
 curse_empty:"You aren't wearing any cursed gear. Come back if something refuses to come off!",curse_more:'More equipment',curse_other:'Choose another item',
 curse_confirm:'Remove your {item} for {price} LiDollCoins? This removes one item only.',curse_pay:'Pay {price} coins',
 faith_yours:'I am already yours.',faith_free:'Swear yourself to {god} (free)',faith_later:'Not yet.',faith_switch:'Switching gods costs a tribute, and your piety starts again from nothing.',faith_diamonds:'Offer {amount} diamond',faith_stars:'Offer {amount} stars',
 tutor_ask:'Ask a question.',tutor_again:'Ask another question.',
 native_release:'Ask for help removing the binding',native_released:'{name} releases the binding. You are free to continue.',native_change:'Ask for a change',
 quest_offer_menu:'Ask about quests',quest_menu:'What would you like to help with?',quest_accept:'Accept quest',quest_resume:'Resume quest',quest_back:'Back to quests',quest_added:'Quest added to your journal: {quest}.',quest_more:'More quests',quest_previous:'Previous quests',quest_conversation:'Back to conversation',quest_completed:'Thank you for your help.',quest_deliver:'Deliver: ',story_continue:'Continue personal story',conversation_continue:'Continue conversation'
}; // These are presentation templates; the existing server service still calculates prices and commits effects.
const events=JSON.parse(readFileSync(new URL('./online-conversations-data.json',import.meta.url),'utf8')).events;
const currentZone=zone=>zone==='honeydew-lantern-garden'?'honeydew-lantern':zone==='littlebig-clockwork-garden'?'littlebig-clockwork':zone;
export function registerInteractionPresentation(live){
 live.registerSheet('presentation','online','interaction_text',interactionText,{name:'Shared NPC choices and service confirmations',source:'story-presentation.mjs'});
 for(const [ref,body] of Object.entries(events)){const at=ref.indexOf(':'),zone=currentZone(ref.slice(0,at)),avatar=ref.slice(at+1);live.registerSheet('npc_event',zone,avatar,body,{name:body.title??avatar,source:'online-conversations-data.json'});}
} // Previously packaged NPC tours become server-published scene sheets without campaign callbacks.
export function storyText(live,key,values={}){return (live?.sheet('presentation','online','interaction_text')?.[key]??interactionText[key]??key).replace(/\{(\w+)\}/g,(match,k)=>values[k]??match);}
