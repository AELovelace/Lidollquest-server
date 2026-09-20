// Local help navigation never saves, publishes, or replaces an editor's mounted form.
const guideArticles=[...document.querySelectorAll('#guideArticles article')];
let guideTopic='first-quest';
function renderGuide(){
 const query=$('guideSearch').value.trim().toLowerCase(),matching=guideArticles.filter(article=>article.dataset.guideSearch.includes(query));
 if(!matching.some(article=>article.dataset.guideId===guideTopic))guideTopic=matching[0]?.dataset.guideId??'';
 clear($('guideTopics'));
 for(const article of guideArticles)article.hidden=article.dataset.guideId!==guideTopic;
 for(const article of matching){const button=el('button',null,article.querySelector('h3').textContent);button.type='button';button.setAttribute('aria-current',String(article.dataset.guideId===guideTopic));button.onclick=()=>{guideTopic=article.dataset.guideId;renderGuide();article.focus();};$('guideTopics').appendChild(button);}
 $('guideResults').textContent=matching.length?matching.length+' topics'+(query?' match your search.':'. Choose one below.'):'No matching topics. Try a shorter word or show all topics.';
}
function openGuide(topic){
 $('guideSearch').value='';guideTopic=guideArticles.some(article=>article.dataset.guideId===topic)?topic:'first-quest';renderGuide();$('tab-guide').click();guideArticles.find(article=>article.dataset.guideId===guideTopic).focus();
} // The tab's normal handler preserves unsaved drafts and its keyboard navigation.
$('guideSearch').oninput=renderGuide;
$('guideClear').onclick=()=>{$('guideSearch').value='';renderGuide();$('guideSearch').focus();};
document.addEventListener('click',event=>{
 const help=event.target.closest('[data-guide-topic]');if(help){openGuide(help.dataset.guideTopic);return;}
 const tool=event.target.closest('#panel-guide [data-gm-tool]');if(tool){const tab=$('tab-'+tool.dataset.gmTool);if(tab){tab.click();tab.focus();}}
}); // Tool shortcuts only navigate; they never create a draft or submit an action.
for(const article of guideArticles)article.dataset.guideSearch=article.textContent.toLowerCase(); // Search authored help only, not catalog results appended later.
let guideCatalog=null;
function renderGuideIds(){
 if(!guideCatalog)return;const kind=$('guideIdKind').value,query=$('guideIdSearch').value.trim().toLowerCase();
 let rows=guideCatalog[kind]??[];
 if(['npcs','monsters','quests'].includes(kind))rows=rows.filter(row=>row.published&&!row.published.retired).map(row=>({id:row.id,name:row.published.name}));
 if(kind==='npcs')rows=rows.concat(guideCatalog.onlineNpcs??[]);
 if(kind==='spells')rows=rows.map(id=>({id,name:id}));
 rows=rows.filter(row=>(row.id+' '+(row.name??'')).toLowerCase().includes(query));clear($('guideIdList'));
 for(const row of rows.slice(0,100)){const label=el('label',null,row.name??row.id),input=el('input');input.type='text';input.readOnly=true;input.value=row.id;input.setAttribute('aria-label',(row.name??row.id)+' ID');input.onfocus=()=>input.select();label.appendChild(input);$('guideIdList').appendChild(label);}
 $('guideIdStatus').textContent=rows.length>100?'Showing the first 100 of '+rows.length+' matches. Narrow the search.':rows.length+' matching IDs. Select an ID and copy it.';
} // Read-only fields make exact IDs easy to copy without requiring clipboard permissions.
$('guideLoadIds').onclick=async()=>{const button=$('guideLoadIds');button.disabled=true;$('guideIdStatus').textContent='Loading IDs...';try{guideCatalog=await api('/gm/content');renderGuideIds();}catch(error){$('guideIdStatus').textContent='Could not load IDs: '+error.message;}finally{button.disabled=false;}};
$('guideIdKind').onchange=renderGuideIds;$('guideIdSearch').oninput=renderGuideIds;
renderGuide();
