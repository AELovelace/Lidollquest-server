(()=>{
'use strict';
const $=id=>document.getElementById(id),key='lidollquest.gm.grant';
let history=[],busy=false,authorized=false,generation=0,controller=null,expiry=null;
const grant=()=>{try{return JSON.parse(localStorage.getItem(key));}catch{return null;}};
const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
function controls(){ $('send').disabled=!authorized||busy;$('question').disabled=!authorized; }
function clear(){generation++;controller?.abort();history=[];$('chat').replaceChildren();busy=false;clearTimeout(expiry);controls();} // Clearing also prevents a late answer from repopulating the previous chat.
async function api(path,body,signal){
 const token=grant()?.token;if(!token)throw Error('Sign in using Staff sign-in, then return here.');
 const response=await fetch(path,{method:body?'POST':'GET',signal,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok){const reason=data.error_description??data.error??'GM help request failed.';if([401,403].includes(response.status)){clear();authorized=false;controls();status(reason,true);}throw Error(reason);}return data;
} // The browser sends its grant only to the same-origin GM API, never to the AI server.
async function authenticate(){const version=generation;try{await api('/gm/whoami');if(version!==generation)return;authorized=true;status('Ready. Ask a question or choose an example.');}catch(error){status(error.message,true);authorized=false;}controls();}
function showPicture(image){$('largePicture').src=image.url;$('largePicture').alt=image.caption;$('caption').textContent=image.caption;$('original').href=image.url;$('picture').showModal();}
function message(role,content,sources=[]){
 const article=document.createElement('article');article.className=role;
 const title=document.createElement('h2');title.textContent=role==='user'?'You':'GM wiki assistant';
 const answer=document.createElement('div');answer.className='answer';answer.textContent=content;article.append(title,answer);
 if(sources.length){
  const list=document.createElement('div');list.className='sources';
  for(const source of sources){
   const section=document.createElement('details');section.className='source';section.open=sources.length<=2;
   const summary=document.createElement('summary');summary.textContent=`[${source.number}] ${source.title} — ${source.heading}${source.images.length?' · pictures':''}`;
   const link=document.createElement('a');link.href=source.url;link.target='lidollquest-gm-wiki';link.rel='noopener';link.textContent='Read this wiki section';section.append(summary,link);
   for(const image of source.images){
    const figure=document.createElement('figure'),button=document.createElement('button'),img=document.createElement('img'),caption=document.createElement('figcaption');
    button.type='button';button.setAttribute('aria-label','Enlarge: '+image.caption);button.onclick=()=>showPicture(image);img.src=image.url;img.alt=image.caption;img.loading='lazy';button.append(img);caption.textContent=image.caption;figure.append(button,caption);section.append(figure);
   }
   list.append(section);
  }
  article.append(list);
 }
 $('chat').append(article);article.scrollIntoView({block:'start',behavior:'smooth'});
} // Answers and captions use textContent; model-provided HTML and Markdown cannot execute.
$('form').addEventListener('submit',async event=>{
 event.preventDefault();const question=$('question').value.trim();if(!question||busy||!authorized)return;
 const version=generation;clearTimeout(expiry);busy=true;controller=new AbortController();controls();status('Looking through the GM handbook…');message('user',question);$('question').value='';
 const timeout=setTimeout(()=>controller?.abort(),80000);
 try{
  const answer=await api('/gm/help/chat',{message:question,history},controller.signal);if(version!==generation)return;
  message('assistant',answer.reply,answer.sources);history=[...history,{role:'user',content:question},{role:'assistant',content:answer.reply.slice(0,3000)}].slice(-6);
  clearTimeout(expiry);expiry=setTimeout(()=>{clear();status('Conversation cleared after 30 minutes of inactivity.');},30*60*1000);
  status(answer.status==='unavailable'?'The answer model is unavailable; the retrieved wiki sources are below.':answer.indexed_at?'Answered using handbook index from '+answer.indexed_at:'Ready for your next question.');
 }catch(error){if(version===generation){status(error.name==='AbortError'?'The assistant timed out. Your question is ready to retry.':error.message,true);$('question').value=question;}}
 finally{clearTimeout(timeout);if(version===generation){busy=false;controller=null;controls();$('question').focus();}}
});
$('clear').onclick=()=>{clear();status(authorized?'New chat. What are you working on?':'Sign in using Staff sign-in.');};
$('closePicture').onclick=()=>$('picture').close();
$('question').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();$('form').requestSubmit();}});
for(const button of document.querySelectorAll('[data-question]'))button.onclick=()=>{$('question').value=button.dataset.question;$('question').focus();};
window.addEventListener('storage',event=>{if(event.key===key||event.key===null){clear();authorized=false;controls();authenticate();}}); // Switching accounts discards previous chat immediately.
authenticate();
})();
