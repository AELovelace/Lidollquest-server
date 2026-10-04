/* Local teaching model only: no game API, grants, map saves or network requests. */
(() => {
 'use strict';
 const home={x:1,y:6},points=[{x:3,y:2,wait:0},{x:8,y:2,wait:4},{x:8,y:6,wait:0}];
 function create(){
  let mode='pingpong',active=true,blocked=false,pos={...home},leg=0,back=false,until=null,time=0,message='At home. Press Step to begin.';
  const solid=(x,y)=>x<=0||x>=10||y<=0||y>=8||(x===5&&(y!==4||blocked));
  function path(from,to){ // Four-direction shortest path through the diagram's geometry, just like the editor's preview concept.
   const key=p=>p.x+','+p.y,queue=[from],seen=new Map([[key(from),null]]);
   for(let i=0;i<queue.length;i++){
    const p=queue[i];if(key(p)===key(to)){const out=[];for(let at=p;at;at=seen.get(key(at)))out.unshift(at);return out;}
    for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1]]){const q={x:p.x+dx,y:p.y+dy};if(!solid(q.x,q.y)&&!seen.has(key(q))){seen.set(key(q),p);queue.push(q);}}
   }
   return null;
  }
  const reset=()=>{pos={...home};leg=0;back=false;until=null;time=0;message='At home. Press Step to begin.';};
  function step(){ // One simulated two-second slot, including a wait at the middle destination.
   time+=2;let target=active?points[leg]:home;
   if(active&&pos.x===target.x&&pos.y===target.y){
    until??=time+target.wait;
    if(time<until){message='Waiting at waypoint '+(leg+1)+' ('+(until-time)+' seconds left).';return;}
    if(mode==='once'&&leg===points.length-1){message='Holding at the last waypoint while this route is active.';return;}
    if(mode==='pingpong'){if(leg===points.length-1)back=true;else if(leg===0)back=false;leg+=back?-1:1;}else leg=(leg+1)%points.length;
    until=null;target=points[leg];
   }
   if(pos.x===target.x&&pos.y===target.y){message='Home: no route is active.';return;}
   const walk=path(pos,target);if(!walk){message='No path: blocked passage. Waiting for a way through.';return;}
   pos={...walk[1]};message=active?'Walking toward waypoint '+(leg+1)+'.':'No matching route: walking home.';
  }
  return {step,reset,path,solid,setMode(value){if(!['loop','pingpong','once'].includes(value))throw Error('Unknown mode');mode=value;reset();},setActive(value){active=!!value;leg=0;back=false;until=null;message=active?'Route active: heading toward waypoint 1.':'No matching route: heading home.';},setBlocked(value){blocked=!!value;},snapshot(){return {mode,active,blocked,pos:{...pos},home:{...home},points:points.map(p=>({...p})),leg,time,message};}};
 }
 function mount(article){
  const heading=article.querySelector('#try-the-movement-demonstration');if(!heading)return ()=>{};
  const node=(tag,text,parent)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(parent)parent.append(n);return n;};
  const box=node('section');box.className='route-demo';box.setAttribute('aria-label','Interactive NPC movement demonstration');
  node('p','Teaching diagram · simulated movement · no live changes',box);
  const controls=node('div',null,box);controls.className='route-demo-controls';
  const label=node('label','Movement ',controls),select=node('select',null,label);
  for(const [value,name] of [['pingpong','Back and forth'],['loop','Loop'],['once','Walk there and stay']]){const o=node('option',name,select);o.value=value;}
  const play=node('button','Play',controls),step=node('button','Step (2 seconds)',controls),reset=node('button','Reset',controls);for(const b of [play,step,reset])b.type='button';
  const check=(caption,on)=>{const l=node('label',null,controls),input=node('input',null,l);input.type='checkbox';input.checked=on;l.append(' '+caption);return input;};
  const active=check('Route active',true),block=check('Block the passage',false);
  const canvas=node('canvas',null,box);canvas.width=660;canvas.height=540;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Diagram of home and three waypoints separated by a wall with a passage.');
  const status=node('p',null,box);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  node('p','White H = home; yellow numbers = destinations; green dot = NPC. Waypoint 2 waits four seconds. Play runs at one step every two seconds. Interval schedules and other occupants are outside this demonstration.',box);
  heading.insertAdjacentElement('afterend',box);
  const model=create();let timer=null;
  function draw(){
   const s=model.snapshot(),ctx=canvas.getContext('2d'),tile=60,centre=p=>[(p.x+.5)*tile,(p.y+.5)*tile];
   ctx.fillStyle='#181324';ctx.fillRect(0,0,660,540);
   for(let y=0;y<9;y++)for(let x=0;x<11;x++){ctx.fillStyle=model.solid(x,y)?'#4c405b':'#282334';ctx.fillRect(x*tile+1,y*tile+1,tile-2,tile-2);}
   const stops=[s.home,...s.points,...(s.mode==='loop'?[s.points[0]]:[])];
   for(let i=1;i<stops.length;i++){const path=model.path(stops[i-1],stops[i]);ctx.strokeStyle=path?'#ffdc3c':'#ff7b8f';ctx.lineWidth=4;ctx.setLineDash(i===1?[7,6]:[]);ctx.beginPath();(path??[stops[i-1],stops[i]]).forEach((p,j)=>ctx[j?'lineTo':'moveTo'](...centre(p)));ctx.stroke();}
   ctx.setLineDash([]);ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold 22px sans-serif';
   const [hx,hy]=centre(s.home);ctx.strokeStyle='#fff';ctx.strokeRect(hx-18,hy-18,36,36);ctx.fillStyle='#fff';ctx.fillText('H',hx,hy);
   s.points.forEach((p,i)=>{const [x,y]=centre(p);ctx.fillStyle='#ffdc3c';ctx.beginPath();ctx.arc(x,y,18,0,Math.PI*2);ctx.fill();ctx.fillStyle='#181324';ctx.fillText(String(i+1),x,y);});
   const [x,y]=centre(s.pos);ctx.fillStyle='#7fe0c0';ctx.strokeStyle='#181324';ctx.lineWidth=3;ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.fill();ctx.stroke();
   status.textContent=s.time+'s · NPC at '+s.pos.x+','+s.pos.y+' · '+s.message;
  }
  const pause=()=>{clearInterval(timer);timer=null;play.textContent='Play';};
  play.onclick=()=>{if(timer){pause();return;}play.textContent='Pause';timer=setInterval(()=>{if(!box.isConnected){pause();return;}model.step();draw();},2000);};
  step.onclick=()=>{pause();model.step();draw();};reset.onclick=()=>{pause();model.reset();draw();};
  select.onchange=()=>{pause();model.setMode(select.value);draw();};active.onchange=()=>{model.setActive(active.checked);draw();};block.onchange=()=>{model.setBlocked(block.checked);draw();};
  draw();return pause; // Wiki navigation disposes playback; no background timer follows readers to another chapter.
 }
 globalThis.GmRouteDemo={create,mount};
})();
