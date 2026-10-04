(()=>{'use strict'; // The Balance Metrics pop-out (/gm/balance). Reads game-balance statistics (balance-stats.mjs) with the panel's stored grant; nothing here writes to the server.
const $=id=>document.getElementById(id),SVG='http://www.w3.org/2000/svg';
const el=(tag,text,parent,cls)=>{const e=document.createElement(tag);if(text!==undefined&&text!==null)e.textContent=text;if(cls)e.className=cls;if(parent)parent.append(e);return e;};
const shape=(tag,attrs,parent,text)=>{const node=document.createElementNS(SVG,tag);for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;if(parent)parent.append(node);return node;};
const clear=node=>{while(node.firstChild)node.removeChild(node.firstChild);};
const say=(text,error=false)=>{$('status').textContent=text;$('status').className=error?'error':'';};
const SERIES=['#3987e5','#d95926','#199e70','#c98500']; // Fixed order, validated for colour-vision separation on this panel's dark surface; a chart never plots more than four series.
const label=name=>String(name).replaceAll('_',' ');
const show=value=>value===null||value===undefined?'–':typeof value==='number'?value.toLocaleString(undefined,{maximumFractionDigits:2}):String(value);
const state={tab:'overview',summary:null,records:[],next:null,loadedFor:'',busy:false};

function grantToken(){let grant;try{grant=JSON.parse(localStorage.getItem('lidollquest.gm.grant'));}catch{}if(!grant?.token)throw Error('Sign in using Advanced GM tools, then reload this window.');return grant.token;}
async function api(path){
 const r=await fetch(path,{headers:{Authorization:'Bearer '+grantToken()},cache:'no-store'}),data=await r.json().catch(()=>({}));
 if(r.status===401||r.status===403)wipe(); // A revoked role must not leave player data on screen.
 if(!r.ok)throw Error(data.error_description??data.error??'Request failed');
 return data;
}
function wipe(){state.summary=null;state.records=[];state.next=null;state.loadedFor='';clear($('tiles'));clear($('charts'));clear($('recordTable'));$('more').hidden=true;}
const day=value=>{const [y,m,d]=value.split('-').map(Number);return new Date(y,m-1,d).getTime();}; // Local midnight, so a day filter matches the reader's calendar.
function filters(extra={}){
 const q=new URLSearchParams();
 if($('from').value)q.set('from',day($('from').value));
 if($('to').value)q.set('to',day($('to').value)+86400000);
 q.set('interval',$('interval').value);if($('character').value)q.set('character',$('character').value);if($('staff').checked)q.set('staff','1');
 for(const [key,value] of Object.entries(extra))if(value!==''&&value!==null&&value!==undefined)q.set(key,value);
 return q.toString();
}
function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const cell=value=>{const text=value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value),safe=/^[=+\-@\t\r\n']/.test(text)&&typeof value!=='number'?"'"+text:text;return '"'+safe.replaceAll('"','""')+'"';}; // Quote everything and defuse spreadsheet formulas, as Little Log's export does.
const csv=(columns,rows)=>'﻿'+[columns,...rows].map(row=>row.map(cell).join(',')).join('\r\n');

function table(columns,rows,parent){
 clear(parent);
 const head=el('tr',null,el('thead',null,parent));for(const c of columns)el('th',label(c),head);
 const body=el('tbody',null,parent);
 if(!rows.length){const td=el('td','No matching records.',el('tr',null,body),'empty');td.colSpan=columns.length;return;}
 for(const row of rows){const tr=el('tr',null,body);row.forEach((value,i)=>{const td=el('td',show(value),tr);if(typeof value==='number')td.className='num';else if(columns[i]==='data')td.className='wide';});}
}

function plot(chart){ // One hand-built SVG per chart: grouped bars or lines over the first column, a single y-axis, a hover tooltip and a legend.
 const wrap=el('div',null,null,'plot'),W=640,H=260,left=48,right=12,top=12,bottom=34;
 const cap=chart.type==='bar'?40:400,rows=chart.rows.slice(0,cap),cols=chart.plot.map(name=>chart.columns.indexOf(name)).filter(i=>i>0).slice(0,SERIES.length);
 const values=rows.flatMap(r=>cols.map(i=>r[i])).filter(v=>typeof v==='number');
 if(!rows.length||!values.length){el('div','No data in this range yet.',wrap,'empty');return wrap;}
 const svg=shape('svg',{viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':chart.title},wrap);
 const max=Math.max(...values,0)||1,step=10**Math.floor(Math.log10(max)),nice=[1,2,2.5,5,10].map(m=>m*step).find(m=>m>=max)??max,tick=nice/4;
 const y=v=>H-bottom-(v/nice)*(H-top-bottom),band=(W-left-right)/rows.length,x=i=>left+band*(i+.5);
 for(let i=0;i<=4;i++){const v=tick*i;shape('line',{x1:left,x2:W-right,y1:y(v),y2:y(v),stroke:i?'#33254a':'#5a4673','stroke-width':1},svg);shape('text',{x:left-6,y:y(v)+4,'text-anchor':'end','font-size':11,fill:'#a894b8'},svg,show(v));}
 const every=Math.ceil(rows.length/8);rows.forEach((r,i)=>{if(i%every===0)shape('text',{x:x(i),y:H-bottom+16,'text-anchor':'middle','font-size':11,fill:'#a894b8'},svg,show(r[0]));});
 shape('text',{x:W-right,y:H-4,'text-anchor':'end','font-size':11,fill:'#a894b8'},svg,label(chart.columns[0]));
 if(chart.type==='bar'){
  const group=Math.min(band-4,cols.length*26),w=Math.max(2,group/cols.length-2);
  rows.forEach((r,i)=>cols.forEach((c,k)=>{const v=r[c];if(typeof v!=='number'||v<=0)return;const h=Math.max(1,y(0)-y(v)),bx=x(i)-group/2+k*(group/cols.length)+1,rad=Math.min(4,w/2,h);
   shape('path',{d:`M${bx},${y(0)}v${-(h-rad)}q0,${-rad} ${rad},${-rad}h${w-2*rad}q${rad},0 ${rad},${rad}v${h-rad}z`,fill:SERIES[k]},svg);})); // Rounded data-ends, square on the baseline.
 }else cols.forEach((c,k)=>{
  let points=[];const flush=()=>{if(points.length>1)shape('polyline',{points:points.join(' '),fill:'none',stroke:SERIES[k],'stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'},svg);points=[];};
  rows.forEach((r,i)=>{if(typeof r[c]!=='number'){flush();return;}points.push(x(i)+','+y(r[c]));});flush(); // A missing value leaves a gap rather than an invented line.
  rows.forEach((r,i)=>{if(typeof r[c]==='number')shape('circle',{cx:x(i),cy:y(r[c]),r:rows.length>60?2:4,fill:SERIES[k],stroke:'#221730','stroke-width':2},svg);});
 });
 const guide=shape('line',{x1:0,x2:0,y1:top,y2:H-bottom,stroke:'#a894b8','stroke-width':1,visibility:'hidden'},svg),tip=el('div',null,wrap,'tip');tip.hidden=true;
 const hover=event=>{ // The whole band is the hit target, so thin marks stay easy to read.
  const box=svg.getBoundingClientRect(),px=(event.clientX-box.left)/box.width*W,i=Math.max(0,Math.min(rows.length-1,Math.floor((px-left)/band))),r=rows[i];
  guide.setAttribute('x1',x(i));guide.setAttribute('x2',x(i));guide.setAttribute('visibility',chart.type==='bar'?'hidden':'visible');
  clear(tip);el('b',label(chart.columns[0])+' '+show(r[0]),tip);
  chart.columns.forEach((name,c)=>{if(!c)return;const line=el('div',null,tip),k=cols.indexOf(c);if(k>=0){const dot=el('i',null,line);dot.style.background=SERIES[k];}line.append(label(name)+': '+show(r[c]));});
  tip.hidden=false;tip.style.left=Math.max(70,Math.min(box.width-70,x(i)/W*box.width))+'px';tip.style.top=(Math.min(...cols.map(c=>typeof r[c]==='number'?y(r[c]):H))/H*box.height)+'px';
 };
 svg.addEventListener('pointermove',hover);svg.addEventListener('pointerleave',()=>{tip.hidden=true;guide.setAttribute('visibility','hidden');});
 if(cols.length>1){const legend=el('div',null,wrap,'legend');cols.forEach((c,k)=>{const item=el('span',null,legend),dot=el('i',null,item);dot.style.background=SERIES[k];item.append(label(chart.columns[c]));});}
 if(chart.rows.length>cap)el('div','Showing the first '+cap+' of '+chart.rows.length+' rows; the exact data below has all of them.',wrap,'note');
 return wrap;
}
function card(chart){
 const box=el('article',null,null,'card');el('h2',chart.title,box);el('p',chart.description,box);
 let figure=null;
 if(chart.type==='table'){const scroll=el('div',null,box,'scroll');scroll.style.maxHeight='340px';table(chart.columns,chart.rows,el('table',null,scroll));}
 else{figure=plot(chart);box.append(figure);const details=el('details',null,box);el('summary','Exact data ('+chart.rows.length+' rows)',details);const scroll=el('div',null,details,'scroll');scroll.style.maxHeight='300px';table(chart.columns,chart.rows,el('table',null,scroll));}
 const row=el('div',null,box,'row');
 el('button','Data CSV',row,'sm').onclick=()=>download('lidollquest-balance-'+chart.id+'.csv',csv(chart.columns,chart.rows),'text/csv;charset=utf-8');
 const svg=figure?.querySelector('svg');if(svg)el('button','Download SVG',row,'sm').onclick=()=>{const copy=svg.cloneNode(true);copy.setAttribute('xmlns',SVG);copy.setAttribute('style','background:#221730;font-family:Segoe UI,sans-serif');download('lidollquest-balance-'+chart.id+'.svg',new XMLSerializer().serializeToString(copy),'image/svg+xml');};
 return box;
}
function render(){
 for(const button of document.querySelectorAll('[data-tab]'))button.setAttribute('aria-selected',String(button.dataset.tab===state.tab));
 const charts=['overview','combat','needs','economy'].includes(state.tab);
 $('summary').hidden=!charts;$('records').hidden=state.tab!=='records';$('export').hidden=state.tab!=='export';
 if(charts&&state.summary){
  const open=new Set([...document.querySelectorAll('#charts details[open]')].map(d=>d.parentElement.dataset.chart)); // An auto-refresh keeps the tables you opened.
  $('tiles').hidden=state.tab!=='overview';clear($('tiles'));for(const tile of state.summary.tiles){const a=el('article',null,$('tiles'));el('strong',show(tile.value),a);el('span',tile.label,a);}
  clear($('charts'));for(const chart of state.summary.charts.filter(c=>c.tab===state.tab)){const box=card(chart);box.dataset.chart=chart.id;if(open.has(chart.id))box.querySelector('details').open=true;$('charts').append(box);}
 }
 if(state.tab==='records')void loadRecords(false).catch(error=>say(error.message,true));
}
const RECORD_COLUMNS=['id','at','kind','name','staff','level','zone','hp','hp_max','wet','tum','hunger','thirst','dignity','turn','value','data'];
const EXPORT_COLUMNS=['id','at','time','kind','owner','character_id','name','staff','level','zone','route','depth','hp','hp_max','wet','tum','hunger','thirst','dignity','shame','incontinence','turn','value'];
async function loadRecords(more){
 const key=filters({kind:$('kind').value});
 if(!more&&state.loadedFor===key)return;
 if(!more){state.records=[];state.next=null;}
 const page=await api('/gm/balance/events?'+filters({kind:$('kind').value,limit:100,before:more?state.next:''}));
 state.records.push(...page.events);state.next=page.nextBefore;state.loadedFor=key;
 table(RECORD_COLUMNS,state.records.map(e=>RECORD_COLUMNS.map(c=>c==='at'?new Date(e.at).toLocaleString():c==='data'?Object.entries(e.data).map(([k,v])=>k+'='+(typeof v==='object'?JSON.stringify(v):v)).join('  '):e[c])),$('recordTable'));
 $('recordCount').textContent=state.records.length+' newest events shown'+(state.next?'':' (all that match)');$('more').hidden=!state.next;
}
async function exportAll(format){ // Page through the server until every matching event is in hand, then build the file in the browser.
 if(state.busy)return;state.busy=true;$('exportCsv').disabled=$('exportJson').disabled=true;
 try{
  const events=[];let before='';
  do{const page=await api('/gm/balance/events?'+filters({kind:$('kind').value,limit:1000,before}));events.push(...page.events);before=page.nextBefore;$('exportStatus').textContent='Fetched '+events.length+' events…';}while(before);
  events.reverse(); // Oldest first reads naturally in a spreadsheet.
  const span=($('from').value||'start')+'-to-'+($('to').value||'now'),name='lidollquest-balance-'+span+'.'+format;
  if(format==='json')download(name,JSON.stringify({format:'lidollquest-balance',version:1,exportedAt:new Date().toISOString(),filters:Object.fromEntries(new URLSearchParams(filters({kind:$('kind').value}))),events},null,2),'application/json');
  else{
   const keys=[...new Set(events.flatMap(e=>Object.keys(e.data)))].sort();
   download(name,csv([...EXPORT_COLUMNS,...keys.map(k=>'data.'+k)],events.map(e=>[...EXPORT_COLUMNS.map(c=>c==='time'?new Date(e.at).toISOString():e[c]),...keys.map(k=>e.data[k])])),'text/csv;charset=utf-8');
  }
  $('exportStatus').textContent='Downloaded '+events.length+' events as '+name+'.';
 }catch(error){$('exportStatus').textContent='Export failed: '+error.message;}
 finally{state.busy=false;$('exportCsv').disabled=$('exportJson').disabled=false;}
}
async function refresh(){
 try{
  const [summary,lists]=await Promise.all([api('/gm/balance/summary?'+filters()),api('/gm/balance/filters')]);
  state.summary=summary;state.loadedFor='';
  for(const [id,rows,text] of [['character',lists.characters.map(c=>[c.id,c.name+(c.staff?' (staff)':'')+' · '+c.events]),'Everyone'],['kind',lists.kinds.map(k=>[k,label(k)]),'All kinds']]){
   const select=$(id),chosen=select.value;clear(select);el('option',text,select).value='';for(const [value,name] of rows)el('option',name,select).value=value;select.value=[...select.options].some(o=>o.value===chosen)?chosen:'';
  }
  $('stamp').textContent='Updated '+new Date(summary.generatedAt).toLocaleTimeString();
  say(summary.events?summary.events.toLocaleString()+' events match these filters.':'No events match these filters yet. Statistics are recorded as people play online.');
  render();
 }catch(error){say(error.message,true);}
}
const iso=date=>date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
$('to').value=iso(new Date());$('from').value=iso(new Date(Date.now()-29*86400000)); // The last 30 days by default.
for(const id of ['from','to','interval','character','staff'])$(id).addEventListener('change',refresh);
$('kind').addEventListener('change',()=>void loadRecords(false).catch(error=>say(error.message,true)));
$('allDates').onclick=()=>{$('from').value='';$('to').value='';void refresh();};
$('refresh').onclick=refresh;$('more').onclick=()=>void loadRecords(true).catch(error=>say(error.message,true));
$('exportCsv').onclick=()=>void exportAll('csv');$('exportJson').onclick=()=>void exportAll('json');
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>{state.tab=button.dataset.tab;render();};
setInterval(()=>{if($('auto').checked&&!document.hidden&&!state.busy)void refresh();},30000);
window.addEventListener('storage',event=>{if(event.key==='lidollquest.gm.grant')location.reload();}); // Signing in or out on the main panel carries over.
window.addEventListener('pagehide',wipe);
void refresh();
})();
