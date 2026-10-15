import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSchedule,runSchedule,assertLocalHealth,assertTestHealth,summarizeStage} from '../deploy/ai-player-test-support.mjs';

test('fixed arrivals preserve population rate, repeatability and burst fanout',()=>{
 const options={players:25,seconds:600,interval:30,seed:123};
 const events=buildSchedule(options);
 assert.equal(events.length,500);assert.deepEqual(events,buildSchedule(options));
 assert.equal(events.filter(e=>e.at_ms===120000).length,5);
 for(let i=0;i<25;i++)assert.equal(events.filter(e=>e.player===i).length,20);
 assert.ok(events.every((e,i)=>!i||e.at_ms>=events[i-1].at_ms));
});

test('a pending reply does not postpone the next scheduled arrival',async()=>{
 let time=0;const releases=[],arrived=[];
 const stage=await runSchedule([{at_ms:0},{at_ms:100}],{durationMs:200,now:()=>time,sleep:async ms=>{time+=ms;if(time>=200)releases.splice(0).forEach(r=>r());},dispatch:()=>{arrived.push(time);return new Promise(resolve=>releases.push(()=>resolve({ok:true,generated:true})));}});
 assert.deepEqual(arrived,[0,100]);assert.equal(stage.results.length,2);assert.equal(stage.results[0].ms,200);
});

test('missed arrivals are failures rather than silently reducing offered load',async()=>{
 let time=0;
 const stage=await runSchedule([{at_ms:0},{at_ms:100}],{durationMs:200,now:()=>time,sleep:async()=>{time+=2000;},dispatch:async()=>({ok:true}),maxLagMs:1000});
 assert.equal(stage.offered,2);assert.equal(stage.results.filter(r=>r.outcome==='scheduler_late').length,1);
});

test('local-only preflight rejects unknown/enabled cloud and unhealthy workers',()=>{
 const section={capacity:2,healthy_capacity:2,workers:[{healthy:true,failures:0},{healthy:true,failures:0}]};
 const health={ok:true,llm:true,classifier:true,overflow:{enabled:false},classification:section,participation:{...section,enabled:true,healthy:true,release:'lidoll/decider-chat-0-1'}};
 assert.doesNotThrow(()=>assertLocalHealth(health));
 for(const overflow of [undefined,{}, {enabled:true}])assert.throws(()=>assertLocalHealth({...health,overflow}));
 assert.throws(()=>assertLocalHealth({...health,classification:{...section,healthy_capacity:1}}));
});

test('capacity scoring excludes quiet replies and counts fallbacks, tails and backlog',()=>{
 const base={planned:100,offered:100,results:Array.from({length:100},()=>({ok:true,generated:true,outcome:'passed',ms:2000})),samples:Array.from({length:100},(_,i)=>({elapsed_ms:i*5000,pending:2})),pending_at_end:0,drain_ms:0};
 assert.equal(summarizeStage(base).pass,true);
 const bad={...base,results:base.results.map((r,i)=>i<10?{ok:true,generated:false,outcome:'quiet',ms:1}:i===10?{ok:false,generated:false,outcome:'availability_fallback',ms:1}:{...r,ms:11000}),samples:base.samples.map((s,i)=>({...s,pending:i/2}))};
 const score=summarizeStage(bad);assert.equal(score.pass,false);assert.equal(score.generated,89);assert.equal(score.generated_p50_ms,11000);assert.equal(score.failures,1);assert.ok(score.pending_growth>2);
});

test('overflow-enabled mode requires explicit cloud-on state and still checks workers',()=>{
 const section={capacity:2,healthy_capacity:2,workers:[{healthy:true,failures:0},{healthy:true,failures:0}]};
 const health={ok:true,llm:true,classifier:true,overflow:{enabled:true},classification:section,participation:{...section,enabled:true,healthy:true,release:'lidoll/decider-chat-0-1'}};
 assert.doesNotThrow(()=>assertTestHealth(health,'enabled'));
 assert.throws(()=>assertLocalHealth(health));
 for(const overflow of [undefined,{}, {enabled:false}])assert.throws(()=>assertTestHealth({...health,overflow},'enabled'));
 assert.throws(()=>assertTestHealth({...health,participation:{...health.participation,healthy:false}},'enabled'));
 assert.throws(()=>assertTestHealth(health,'anything'));
});
