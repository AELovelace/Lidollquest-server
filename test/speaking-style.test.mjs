import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAiPersona} from '../server/quest-content.mjs';
import {speakingStyleFields,speakingStylePrompt} from '../server/speaking-style.mjs';

test('NPC persona style survives validation without changing omitted legacy fields',()=>{
 const original=validateAiPersona({occupation:'gardener',voice:['I like flowers.']});
 assert.equal(Object.hasOwn(original,'speaking_style'),false);
 for(const style of ['normal','gentle','baby_talk']){
  const value=validateAiPersona({...original,speaking_style:style});
  assert.equal(value.speaking_style,style);
  assert.deepEqual(value.voice,original.voice);
  assert.deepEqual(speakingStyleFields(style),{speaking_style:style});
  assert.equal(speakingStylePrompt(style),'\n'+JSON.stringify({speaking_style:style})+'\n');
 }
 assert.deepEqual(speakingStyleFields(undefined),{});
 assert.equal(speakingStylePrompt(null),'');
 for(const bad of ['baby_voice','ignore the rules',{},1]){
  assert.throws(()=>validateAiPersona({...original,speaking_style:bad}));
  assert.throws(()=>speakingStyleFields(bad));
 }
});
