import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {RELEASE_FILES} from '../deploy/release.mjs';

test('packaged release runs public quest editor tests outside the source checkout',()=>{
 const source=fileURLToPath(new URL('../',import.meta.url)),directory=mkdtempSync(join(tmpdir(),'quest-release-package-')),release=join(directory,'release'),work=join(directory,'work');
 mkdirSync(release);mkdirSync(work);
 try{
  for(const name of RELEASE_FILES)cpSync(join(source,name),join(release,name),{recursive:true,errorOnExist:true,force:false}); // Exercise the installer's actual allowlist, including transitive test imports and editor assets.
  const env={...process.env,NODE_OPTIONS:'',NODE_PATH:''};delete env.NODE_TEST_CONTEXT;delete env.QUEST_ZONE_WORKERS;delete env.QUEST_COMPUTE_WORKERS;
  const result=spawnSync(process.execPath,['--test',`--test-reporter=${pathToFileURL(join(release,'scripts','test-progress-reporter.mjs')).href}`,join(release,'test','public-quest-editor.test.mjs')],{cwd:work,env,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024}); // Exercise the update reporter from a separate working directory; file URLs also support Windows paths.
  assert.ifError(result.error);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/\[File 1\] RUNNING public-quest-editor\.test\.mjs/);assert.match(result.stdout,/\[Test 1\]/);assert.match(result.stdout,/1\/1 started files finished/); // Packaging must preserve both live file progress and numbered test results.
 }finally{rmSync(directory,{recursive:true,force:true});} // Remove only this fixture's newly created temporary tree.
});
