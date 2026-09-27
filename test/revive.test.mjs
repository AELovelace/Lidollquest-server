import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reviveDowned,POULTICE_ID,REVIVE_HP_PCT} from '../server/revive.mjs';

const hubData=JSON.parse(readFileSync(new URL('../server/hub-data.json',import.meta.url),'utf8'));

function party({poultices=2,status='defeat'}={}){ // Two members: Alice active, Bea knocked out, and Bea's hired companion sitting out.
 const alice={a:{id:'alice',name:'Alice',status:'active',run:{hp:40,maxHp:100}},s:{loadout:{inventory:poultices?[{item_id:POULTICE_ID,category:'medicine',stackable:true,quantity:poultices}]:[]}}};
 const bea={a:{id:'bea',name:'Bea',status,run:{hp:0,maxHp:90},defeatEnemy:{name:'Goblin'},downedAt:5,readyAt:0,duration:4000,cycle:3},s:{loadout:{player_info:{dex:0},inventory:[]}}};
 const e={sequence:0,events:[],followers:[{id:'pip',hirer:'bea',status:'owner_out'}]};
 const lines=[],tools={now:()=>1000,message:(_e,text)=>lines.push(text),reset:(a)=>{a.cycle++;a.readyAt=1000+a.duration;}};
 return {alice,bea,e,lines,tools};
}

test('a Healing Poultice stands a knocked-out ally back up at 30% HP and uses one from the stack',()=>{
 const {alice,bea,e,lines,tools}=party();
 reviveDowned(e,alice,bea,tools);
 assert.equal(bea.a.status,'active');assert.equal(bea.a.run.hp,Math.ceil(90*REVIVE_HP_PCT/100)); // 27 of 90
 assert.equal(bea.a.defeatEnemy,undefined);assert.equal(bea.a.downedAt,undefined); // No defeat scene for an undone knockout.
 assert.equal(bea.a.cycle,4);assert.equal(bea.a.readyAt,5000); // A fresh gauge.
 assert.equal(e.followers[0].status,'active'); // Her companion rejoins.
 assert.equal(alice.s.loadout.inventory[0].quantity,1);assert.match(lines[0],/Healing Poultice/);
 const second=party({poultices:1});reviveDowned(second.e,second.alice,second.bea,second.tools);assert.deepEqual(second.alice.s.loadout.inventory,[]); // The last one empties the slot.
});

test('poultices only work on knocked-out allies, and only if you have one',()=>{
 const empty=party({poultices:0});assert.throws(()=>reviveDowned(empty.e,empty.alice,empty.bea,empty.tools),/no Healing Poultice/);
 const fled=party({status:'flee'});assert.throws(()=>reviveDowned(fled.e,fled.alice,fled.bea,fled.tools),/knocked-out ally/); // Retreating was a choice.
 const self=party();assert.throws(()=>reviveDowned(self.e,self.alice,self.alice,self.tools),/knocked-out ally/);
 assert.equal(self.alice.s.loadout.inventory[0].quantity,2); // A refused revive never spends a poultice.
 const charmed=party({status:'charm_backfire'});reviveDowned(charmed.e,charmed.alice,charmed.bea,charmed.tools);assert.equal(charmed.bea.a.status,'active'); // A backfired charm is a knockout too.
});

test('Fern the Apothecary stocks Healing Poultices in the hubs',()=>{
 assert.equal(hubData.items[POULTICE_ID].category,'medicine');assert.equal(hubData.items[POULTICE_ID].stackable,true);
 assert.ok(hubData.shops.find(s=>s.id==='objNPCApothecary').pool.includes(POULTICE_ID));
});
