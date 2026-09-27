import test from 'node:test';
import assert from 'node:assert/strict';
import {envFlag} from '../server/env-flag.mjs';

// server.env switches are read case-insensitively: QUEST_FOLLOWERS_ENABLED=TRUE once left recruitment off.
test('on/off switches ignore case and spaces, and unknown values keep the default',()=>{
 for(const value of ['true','TRUE','True',' yes ','ON','1'])assert.equal(envFlag('X',false,{X:value}),true,value);
 for(const value of ['false','FALSE','No','off','0'])assert.equal(envFlag('X',true,{X:value}),false,value);
 assert.equal(envFlag('X',false,{}),false,'unset keeps the default (off)');
 assert.equal(envFlag('X',true,{X:''}),true,'blank keeps the default (on)');
 assert.equal(envFlag('X',true,{X:'maybe'}),true,'a typo never flips a switch');
});
