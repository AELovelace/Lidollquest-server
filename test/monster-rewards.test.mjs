import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {awardMonsterCoins} from '../server/monster-rewards.mjs';
import {dailyCoinCap} from '../server/hubs.mjs';

test('monster drops honor authored ranges, old exports, wildlife and the shared UTC account cap',()=>{
 const db=new DatabaseSync(':memory:'),awards=[];let time=0;
 db.exec('CREATE TABLE quest_reward_days(owner TEXT,day INTEGER,coins INTEGER,PRIMARY KEY(owner,day))');
 const pay=(enemies,id='first')=>awardMonsterCoins(db,{character:{id,owner:'same-account'},enemies,now:()=>time,roll:n=>n-1,adjust:(owner,asset,n)=>awards.push({owner,asset,n})});
 try{
  assert.equal(pay([{}, {gold_min:4,gold_max:10}, {wildlife:true}, {gold_min:0,gold_max:0}]),13);
  db.prepare('UPDATE quest_reward_days SET coins=?').run(dailyCoinCap()-2);
  assert.equal(pay([{}],'second'),2); // Another character shares the same two remaining coins.
  assert.equal(pay([{}]),0);assert.equal(awards.length,2);
  time=86400000;assert.equal(pay([{}]),3); // New UTC day restores eligibility.
  assert.deepEqual(awards.at(-1),{owner:'same-account',asset:'coins',n:3});
 }finally{db.close();}
});
