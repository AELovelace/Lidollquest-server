import {CAVERNS_ZONE} from './caverns-generation.mjs';
export function installCavernsContent(db,live,flows){
 if(!flows?.enabled||flows.get('coastal_caverns_story'))return; // Ship once; subsequent GM drafts and published edits belong to the editor.
 if(db.prepare("SELECT 1 FROM world_content WHERE id IN ('caverns_surveyor','caverns_survey','caverns_memory') LIMIT 1").get())return; // Do not overwrite a separately authored pack with colliding IDs.
 db.exec('SAVEPOINT caverns_pack');try{
 const flags=['story_caverns_started','story_caverns_surveyed','story_caverns_hermit_defeated','story_caverns_memory_read'];
 for(const id of flags)if(!flows.flags().some(f=>f.id===id))flows.gm({action:'flow_flag_save',revision:0,entry:{id,name:id.replace('story_caverns_','Caverns: ').replaceAll('_',' ')}},'shipped-caverns');
 const npc={id:'caverns_surveyor',name:'Surveyor Maren',sprite:'sprNPCHalfwayHero',quests:['caverns_survey'],dialogue:[{id:'hello',text:'The cave breathes with the waves. Dry ledges are always safe to follow. Your Active Effects panel shows which clothes got wet. The screened camp is here whenever you need to change.',next:'close',actions:[]}]};
 const quest={id:'caverns_survey',name:'What the Sea Leaves Behind',description:'Recover three survey markers, return to the midpoint refuge, then defeat the Breakwater Hermit.',givers:[npc.id],repeatable:false,turn_in:{mode:'journal'},stages:[{id:'survey',name:'Recover the survey',objectives:[{id:'markers',type:'collect',token:true,target:'caverns_survey_marker',zone:CAVERNS_ZONE,count:3,text:'Recover three lost survey markers',on_complete_flags:['story_caverns_surveyed']}],next:'hermit'},{id:'hermit',name:'The Breathing Vault',objectives:[{id:'boss',type:'kill',target:'breakwater_hermit',zone:CAVERNS_ZONE,count:1,text:'Defeat the Breakwater Hermit',on_complete_flags:['story_caverns_hermit_defeated']}],next:'complete'}],rewards:{xp:120,items:[{id:'stamina_potion',count:2}]}};
 const orb={id:'caverns_memory',title:'The Sea Remembers',colour:'#75dbd5',hidden_until_revealed:true,pages:[{text:'Every mark on these walls was made by something returning. Waves, surveyors, and you. The cave kept a dry path through it all.'}]};
 const nodes=[
 {id:'greet',type:'npc_entry',ref:npc.id,repeatable:true,conditions:{none:['story_caverns_started']}},
 {id:'offer',type:'choice',text:'I lost three survey markers below. Follow the ledges, or risk the channels when the cave exhales. Will you recover them?',choices:[{id:'yes',label:'I will recover them.'},{id:'later',label:'Maybe later.'}]},
 {id:'accept',type:'quest',ref:quest.id,operation:'accept'},{id:'started',type:'set_flag',flag:'story_caverns_started'},
 {id:'hint',type:'dialogue',text:'Watch Active Effects after a crossing: the clothes that got wet appear there. Bring all three markers back near the midpoint refuge before you enter the Breathing Vault.'},
 {id:'markers',type:'objective_entry',ref:quest.id,stage:'survey',objective:'markers',start_zone:CAVERNS_ZONE,start_location:'caverns_recovery'},
 {id:'ambush_intro',type:'dialogue',text:'At the refuge, the recovered markers click together. A scraped warning reads: The old hermit guards the vault. Two scavengers hear the sound and close in.'},
 {id:'ambush',type:'battle',monsters:['dust_scavenger','brineback_crab']},
 {id:'victory',type:'dialogue',text:'The refuge is quiet again. Follow the dry ledge to the Breathing Vault.'},
 {id:'boss',type:'objective_entry',ref:quest.id,stage:'hermit',objective:'boss',start_zone:CAVERNS_ZONE},
 {id:'reveal',type:'reveal_orb',ref:orb.id},{id:'memory_hint',type:'narrative',text:'With the hermit still, a sea-green light appears in the vault. Your survey reward is ready in the Journal.'},
 {id:'memory',type:'narrative',text:orb.pages[0].text},{id:'remember',type:'set_flag',flag:'story_caverns_memory_read'},
 {id:'end',type:'end'}];
 const edge=(from,port,to)=>({from,port,to});const edges=[edge('greet','next','offer'),edge('offer','yes','accept'),edge('offer','later','end'),edge('accept','next','started'),edge('started','next','hint'),edge('hint','next','end'),edge('markers','next','ambush_intro'),edge('ambush_intro','next','ambush'),edge('ambush','victory','victory'),edge('ambush','defeat','end'),edge('ambush','retreat','end'),edge('victory','next','end'),edge('boss','next','reveal'),edge('reveal','next','memory_hint'),edge('memory_hint','next','end'),edge('memory','next','remember'),edge('remember','next','end')];
 nodes.forEach((n,i)=>Object.assign(n,{x:80+(i%4)*300,y:70+Math.floor(i/4)*230}));
 flows.gm({action:'flow_publish',id:'coastal_caverns_story',revision:0,entry:{id:'coastal_caverns_story',name:'Coastal Caverns: What the Sea Leaves Behind',nodes,edges,bindings:[{kind:'orb',ref:orb.id,entry:'memory'}]},assets:[['npc',npc],['quest',quest],['orb',orb]].map(([kind,entry])=>({kind,id:entry.id,entry,revision:0}))},'shipped-caverns');
 db.exec('RELEASE caverns_pack');
 }catch(error){db.exec('ROLLBACK TO caverns_pack');db.exec('RELEASE caverns_pack');live.invalidate();throw error;}
} // The shipped quest, NPC and story use the exact same block schemas and validation as editor-authored content.
