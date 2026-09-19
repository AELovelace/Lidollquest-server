import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {pythonSpriteProvider} from '../server/private-sprites.mjs';

function worker(finish){
 return (_python,_args,options)=>{
  assert.equal(options.windowsHide,true);
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill(){this.emit('close',null);}});
  queueMicrotask(()=>finish(child));return child;
 } // Exercise subprocess error handling without invoking a paid provider or requiring a particular Python installation.
}
test('provider retains safe HTTP status and stage without returning raw stderr',async()=>{
 const provider=pythonSpriteProvider({token:'synthetic-secret',spawnWorker:worker(child=>{
  child.stderr.write('private prompt and token: synthetic-secret\n');
  child.stderr.write(JSON.stringify({error:{code:'provider_http_error',stage:'create',http_status:401,body:'synthetic-secret'}}));child.emit('close',1);
 })});
 await assert.rejects(provider('private prompt'),error=>{assert.deepEqual(error.diagnostic,{code:'provider_http_error',stage:'create',http_status:401});assert.doesNotMatch(JSON.stringify(error)+error.message,/synthetic-secret|private prompt/);return true;});
});
test('unknown diagnostics and missing executable produce fixed safe labels',async()=>{
 const unknown=pythonSpriteProvider({token:'synthetic',spawnWorker:worker(child=>{child.stderr.write(JSON.stringify({error:{code:'private text',stage:'secret stage',http_status:'token'}}));child.emit('close',1);})});
 await assert.rejects(unknown('private'),error=>{assert.deepEqual(error.diagnostic,{code:'generation_failed',stage:'startup'});return true;});
 const missing=pythonSpriteProvider({token:'synthetic',spawnWorker:worker(child=>child.emit('error',Object.assign(Error('private path'),{code:'ENOENT'})))});
 await assert.rejects(missing('private'),error=>error.diagnostic.code==='python_unavailable');
});
test('malformed worker output is diagnosed while valid output remains unchanged',async()=>{
 for(const [text,valid] of [['not JSON',false],[JSON.stringify({frames:36,png:'synthetic'}),true]]){
  const provider=pythonSpriteProvider({token:'synthetic',spawnWorker:worker(child=>{child.stdout.write(text);child.emit('close',0);})});
  if(valid)assert.deepEqual(await provider('private'),{frames:36,png:'synthetic'});
  else await assert.rejects(provider('private'),error=>error.diagnostic.code==='invalid_sprite_output');
 }
});
