import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFlow} from '../server/flow-content.mjs';
import {storyFoes} from '../server/story-encounter.mjs';
const story=battle=>({id:'lineup',name:'Lineup',nodes:[{id:'start',type:'entry'},{id:'fight',type:'battle',...battle},{id:'done',type:'end'}],edges:[{from:'start',port:'next',to:'fight'},...['victory','defeat','retreat'].map(port=>({from:'fight',port,to:'done'}))]});
const catalog={monsters:[{id:'slime'},{id:'bat'},{id:'retired',retired:true}]};
test('battle lineups validate every slot, keep duplicates and upgrade legacy references',()=>{
 const validate=b=>validateFlow(story(b),{catalog,publish:true}).flow.nodes[1];
 assert.deepEqual(validate({ref:'slime'}).monsters,['slime']);
 assert.deepEqual(validate({monsters:['slime','bat','slime'],ref:'stale'}).monsters,['slime','bat','slime']);
 assert.equal(validate({monsters:['bat'],ref:'slime'}).ref,'bat');
 for(const monsters of [[],['slime','missing'],['slime','retired'],['slime','bat','slime','bat'],null,'slime'])assert.throws(()=>validate({monsters}));
 assert.match(validateFlow(story({monsters:[]})).issues.map(v=>v.message).join(' '),/1 to 3/);
});
test('story placement is atomic and each duplicate slot is retryable',()=>{
 const floor={width:9,height:9,walls:Array.from({length:9},()=>Array(9).fill(0)),enemies:[],entrance:{x:4,y:4}},owner={id:'alice'},position={x:4,y:4},monster={id:'slime',name:'Slime'};
 const foes=storyFoes(floor,owner,position,[monster,monster,monster],'receipt');
 assert.equal(new Set(foes.map(v=>v.id)).size,3);assert.equal(new Set(foes.map(v=>v.x+','+v.y)).size,3);
 assert.deepEqual(storyFoes(floor,owner,position,[monster,monster,monster],'receipt'),foes);assert.equal(floor.enemies.length,3);
 monster.name='Changed';assert.equal(foes[2].definition.name,'Slime');
 const blocked={...floor,enemies:[],walls:Array.from({length:9},()=>Array(9).fill(1))};blocked.walls[4][4]=0;blocked.walls[4][5]=0;
 assert.throws(()=>storyFoes(blocked,owner,position,[monster,monster],'blocked'),/open area/);assert.equal(blocked.enemies.length,0);
});
