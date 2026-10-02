import {writeFile} from 'node:fs/promises';
import {createQuestService} from '../server/service.mjs';

process.env.QUEST_FLOWS_ENABLED='true'; // Include optional shipped flow packs in this isolated inventory.
const service=createQuestService({walletClient:{},now:()=>Date.parse('2026-10-02T12:00:00Z'),log:()=>{}});
try{
 const view=service.live.view(),errors=[];
 for(const row of view.sheets)try{service.live.validateSheet(row.draft);}catch(e){errors.push({id:row.id,name:row.draft.name,error:e.message});}
 const inventory={schema:1,scope:'online',sources:view.storyInventory.map(s=>({...s,status:errors.some(e=>e.id===s.id)?'invalid':'editable'})),quests:view.quests.map(r=>({id:r.id,name:r.draft.name,published:!!r.published})),authoredNpcs:view.npcs.map(r=>({id:r.id,name:r.draft.name})),counts:{sheets:view.sheets.length,quests:view.quests.length,categories:view.sheets.reduce((out,r)=>(out[r.draft.category]=(out[r.draft.category]??0)+1,out),{})},errors};
 if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(inventory,null,2)+'\n');
 console.log(JSON.stringify({counts:inventory.counts,errors},null,2));if(errors.length)process.exitCode=1;
}finally{service.server.emit('close');} // Read-only audit uses an isolated in-memory world and never contacts a deployed service.
