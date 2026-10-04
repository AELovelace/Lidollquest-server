// Industrial controls share the dungeon's persisted edition and optimistic mechanism revision.
const fail=message=>{throw Object.assign(Error(message),{status:409,code:'dungeon_conflict'});};
export function installIndustrial(f,data,{fixture,free,berth=free}){
 const cfg=data.config.industrial;if(!cfg)return;
 f.industrial={kind:cfg.kind,cycle_steps:cfg.cycle_steps??1,warning_steps:cfg.warning_steps??0,active_steps:cfg.active_steps??0,damage:cfg.damage??0};
 for(const [i,type] of cfg.rooms.entries()){
  const room=f.rooms.find(r=>r.type===type),point=free(room);if(!point)throw Error('No industrial salvage space');
  const control=fixture({id:'machine-'+i,kind:'industrial',name:cfg.kind==='production'?'Production cutoff':'Cargo crane',sprite:cfg.kind==='production'?'sprArcadiaEnvGauge':'sprArcadiaEnvCrane',span_w:cfg.kind==='cargo'?2:1,span_h:2,room_types:[type],state:0,mode:cfg.kind});
  f.chests.push({id:'machine-salvage-'+i,...point,requires_machine:control.id,loot_pool:[cfg.material]});
  control.hazard=cfg.kind==='production'?{x:room.x+2,y:room.cy,w:Math.max(1,room.w-4),h:1}:null;
  if(cfg.kind==='cargo'){
   control.berths=[];
   for(let n=0;n<3;n++){const point=berth(room);if(!point)throw Error('No cargo berth');control.berths.push(point);} // Maze quays supply a berth allocator with permanently clear turning space.
   const at=control.berths[0];f.props[at.y][at.x]=1;
   f.decorations.push({id:control.id+'-load',...at,sprite:'sprArcadiaEnvCrates',span_w:1,span_h:1,solid:true});
  }
 }
} // Required controls are placed before ambient enemies and scenery can occupy their working space.

export function industrialControl(f,fix,input,occupants=[]){
 if(input.mechanism_revision!==f.mechanismRevision)fail('The machinery changed. Refresh before acting.');
 if(fix.mode==='production'){fix.state=1;fix.name='Production line stopped';}
 else{
  const next=input.choice===0?0:(fix.state+1)%3,at=fix.berths[next];
  if(occupants.some(p=>p.x===at.x&&p.y===at.y))fail('Clear the marked cargo berth first.');
  const before=fix.berths[fix.state];f.props[before.y][before.x]=0;f.props[at.y][at.x]=1;
  const load=f.decorations.find(d=>d.id===fix.id+'-load');Object.assign(load,at);fix.state=next;
  fix.name=next===2?'Cargo parked - salvage open':'Cargo crane - berth '+(next+1);
 }
 f.mechanismRevision++;f.geometryVersion++;
 return fix.mode==='production'?'Production stopped. The salvage locker is available.':fix.state===2?'Load parked. The salvage locker is available.':'Cargo moved to berth '+(fix.state+1)+'.';
} // The shared controller validates occupied berths before changing either collision cell.

export const industrialUnlocked=fix=>fix?.mode==='production'?fix.state===1:fix?.state===2;
export function industrialStep(f,personal,p){
 if(f.industrial?.kind!=='production')return 0;
 personal.industrialSteps=(personal.industrialSteps??0)+1;
 const phase=personal.industrialSteps%f.industrial.cycle_steps,warning=f.industrial.warning_steps;
 personal.industrialPhase=phase;
 if(phase<warning||phase>=warning+f.industrial.active_steps)return 0;
 return f.fixtures.some(v=>v.kind==='industrial'&&!industrialUnlocked(v)&&v.hazard&&p.x>=v.hazard.x&&p.x<v.hazard.x+v.hazard.w&&p.y===v.hazard.y)?f.industrial.damage:0;
} // Only committed movement advances a character's cycle; warning and recovery steps cause no damage.

export function prepareIndustrialBoss(enemy,f){
 if(!enemy.industrial_phases)return;
 enemy.industrialSuppression=Math.min(3,(f.fixtures??[]).filter(v=>v.kind==='industrial'&&industrialUnlocked(v)).length);
} // Pin the support-station advantage when combat starts; another party cannot alter an ongoing fight.
