// Small factory departments sit inside a connected maze of two-tile maintenance passages.
export function carveBrassworksMaze(f,data,{rnd,open,rectangle}){
 const pitch=6,cols=Math.floor((f.width-4)/pitch),rows=Math.floor((f.height-4)/pitch);
 const nodes=Array.from({length:cols*rows},(_,i)=>({x:3+(i%cols)*pitch,y:3+Math.floor(i/cols)*pitch,links:[]}));
 const neighbours=i=>[i%cols>0?i-1:-1,i%cols<cols-1?i+1:-1,i>=cols?i-cols:-1,i<cols*(rows-1)?i+cols:-1].filter(n=>n>=0);
 const stamp=(x,y)=>{for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)open(x+dx,y+dy);};
 function connect(a,b){
  nodes[a].links.push(b);nodes[b].links.push(a);
  let {x,y}=nodes[a];const end=nodes[b];stamp(x,y);
  while(x!==end.x||y!==end.y){x+=Math.sign(end.x-x);y+=Math.sign(end.y-y);stamp(x,y);}
 } // Each graph edge becomes a walkable two-tile passage with a wall between neighbouring runs.
 const seen=new Set([0]),stack=[0];
 while(stack.length){
  const at=stack.at(-1),options=neighbours(at).filter(n=>!seen.has(n));
  if(!options.length){stack.pop();continue;}
  const next=options[rnd(options.length)];connect(at,next);seen.add(next);stack.push(next);
 } // Depth-first carving guarantees connectivity while producing long bends and side branches.
 const closed=nodes.flatMap((node,i)=>neighbours(i).filter(j=>j>i&&!node.links.includes(j)).map(j=>[i,j]));
 for(let n=0;n<data.structure.extra_loops&&closed.length;n++){
  const [a,b]=closed.splice(rnd(closed.length),1)[0];connect(a,b);
 } // A few additional links offer alternate routes without opening every neighbouring department.
 const sw=Math.floor(f.width/3),sh=Math.floor(f.height/3);
 for(const [i,type] of data.campaign.type_pool.entries()){
  const col=Math.floor(i/3),row=i%3,w=9+rnd(4),h=9+rnd(4);
  const x=col*sw+3+rnd(sw-w-5),y=row*sh+3+rnd(sh-h-5);
  const r=rectangle(x,y,w,h);Object.assign(r,{type,original_type:type,is_atrium:false,is_hollow:false,col,row});f.rooms.push(r);
  const nearest=nodes.reduce((a,b)=>Math.abs(a.x-r.cx)+Math.abs(a.y-r.cy)<Math.abs(b.x-r.cx)+Math.abs(b.y-r.cy)?a:b);
  let xx=r.cx,yy=r.cy;stamp(xx,yy);
  while(xx!==nearest.x||yy!==nearest.y){if(xx!==nearest.x)xx+=Math.sign(nearest.x-xx);else yy+=Math.sign(nearest.y-yy);stamp(xx,yy);}
 } // Compact chambers retain all nine room identities and explicitly join the maintenance network.
 f.maintenanceEnds=nodes.filter(n=>n.links.length===1&&!f.rooms.some(r=>n.x>=r.x-1&&n.x<=r.x+r.w&&n.y>=r.y-1&&n.y<=r.y+r.h)).map(({x,y})=>({x,y}));
} // Dead ends outside departments become optional salvage destinations during population.
