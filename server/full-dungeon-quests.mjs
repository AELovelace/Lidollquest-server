import {fullDungeons,fullDungeonContent} from './full-dungeons.mjs';
import {campaignDialogue} from './full-dungeon-rules.mjs';
import {inside} from './dive-generation.mjs';

const zones={dungeon:'dive-castle-dungeon',auto_nursery:'dive-auto-nursery',auto_school:'dive-regression-school',regression_hospital:'dive-regression-hospital',haunted_forest:'dive-haunted-woods'};
export const dungeonDataFor=zone=>fullDungeons.find(d=>d.config.zone_id===zone);
const npcKey=name=>{for(const d of fullDungeons)for(const [id,npc] of Object.entries(d.npcs))if(npc.name===name)return d.config.zone_id+':npc-'+id;throw Error('Missing online quest NPC '+name);};

export function fullDungeonQuestPack(){
 return Object.entries(fullDungeonContent.quests).map(([key,raw])=>{
  const q={...raw,...fullDungeons[0].adaptations?.quest_text?.[key]};
  const reward=q.rewards??{},giver=npcKey(q.giver_npc),objectives=[],stages=[];
  const objective=(type,target,count=1,extra={})=>({id:'objective_'+objectives.length,type,target,count,text:q.description,sharing:'personal',...extra});
  if(q.type==='kill')objectives.push(objective('kill',q.target_enemy,q.goal,{zone:zones[q.target_zone]}));
  else if(q.type==='explore')objectives.push(objective('visit',q.target_zone==='dungeon_deep'?'full-room:deep_nursery':zones[q.target_zone]));
  else if(q.type==='explore_all')for(const target of q.target_zones)objectives.push(objective('visit','full-room:'+target.replace(/^nursery_/,''),1,{zone:'dive-auto-nursery'}));
  else if(q.type==='fetch')objectives.push(objective('collect',q.target_item,q.goal,{token:!!q.key_item_spawn,zone:zones[q.key_item_spawn?.zone]}));
  else if(q.type==='delivery'){
   stages.push({id:'collect',name:'Collect the letter',objectives:[objective('collect',q.delivery_item)],next:'deliver'});
   stages.push({id:'deliver',name:'Deliver the letter',objectives:[objective('deliver',q.delivery_item,1,{npc:npcKey(q.deliver_to)})],next:'complete'});
  }else if(q.type==='state'){
   if(q.state_condition==='panties_showing')objectives.push(objective('interact','full-visible-conversation',q.goal));
   else if(q.state_condition==='forced_inco_active')objectives.push(objective('interact','full-forced-inco-step',q.goal));
   else throw Error('Unsupported campaign quest state '+q.state_condition);
  }else throw Error('Unsupported campaign quest type '+q.type);
  if(objectives.length)stages.push({id:'task',name:q.name,objectives,next:'complete'});
  return {id:'full-'+key,name:q.name,description:q.description,offer_line:q.offer_line,complete_line:q.complete_line,repeat:'once',givers:[giver],turn_in:{mode:'npc',npc:giver},stages,rewards:{coins:reward.gold??0,xp:reward.xp??0,items:reward.item_id?[{id:reward.item_id,count:1}]:[],spells:reward.spell_id?[reward.spell_id]:[],stats:reward.stat_deltas??{},dignity:reward.shame_delta??0}};
 });
} // Online quest engine owns journaling, deliveries, sharing rules and capped reward receipts.

export function fullDungeonNpc(n,key,s){
 const d=dungeonDataFor(key.split(':')[0]),npc=d?.npcs[n.content];if(!npc)return null;
 const dialogue=campaignDialogue(npc,s);
 const p=s.loadout.player_info;for(const [slot,ids] of [['mouth',['cursed_paci','cursed_paci_forest']],['weapon',['cursed_teddy']]])if(ids.includes(p['equipped_'+slot])){
  const id='full_release_'+slot;dialogue[0].actions.unshift({label:'Ask for help removing the binding',next:id,effect:'none',conditions:[],campaign_effects:[{type:'release_campaign_curse',slot}]});dialogue.push({id,text:npc.name+' releases the binding. You are free to continue.',next:'close',actions:[]});
 } // Only the campaign's friendly-removal items qualify; declining leaves equipment unchanged.
 for(const [i,service] of (d.adaptations?.npc_services?.[npc.name]??[]).entries()){const id='full_service_'+i;dialogue[0].actions.push({...service,next:id,effect:'none',conditions:[]});dialogue.push({id,text:service.text,next:dialogue[0].id,actions:[]});}
 if(npc.diaper_change){dialogue[0].actions.push({label:'Ask for a change',next:'full_change',effect:'none',conditions:[],campaign_change:true});dialogue.push({id:'full_change',text:'',next:dialogue[0].id,actions:[]});}
 return {id:key,name:npc.name,sprite:npc.sprite,dialogue,quests:[],campaign_zone:d.config.zone_id,campaign_npc:n.content};
}

export function fullDungeonQuestMovement(c,s,input,p,map,event){
 if(input.action!=='move'||!s.dive||!dungeonDataFor(p.zone))return;
 const room=map.floor.rooms.find(r=>inside(r,p.x,p.y));
 if(room)event(c,s,{id:'full-room:'+input.request_id,type:'visit',target:'full-room:'+room.type,zone:p.zone});
 if(s.loadout.player_info.forced_inco_turns>0)event(c,s,{id:'full-state:'+input.request_id,type:'interact',target:'full-forced-inco-step',zone:p.zone});
}
