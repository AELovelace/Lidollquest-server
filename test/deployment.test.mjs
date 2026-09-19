import test from 'node:test';
import assert from 'node:assert/strict';
import {activateRelease, validateEnvironment} from '../deploy/release.mjs';

const valid = `DATA_DIR=/var/lib/lidollquest-server
HOST=127.0.0.1
PORT=4191
LIDOLLCOIN_API_URL=http://127.0.0.1:4173/tracker/api/lidollcoin/v1/
LIDOLLCOIN_REWARD_KEY=${'a'.repeat(43)}
`;

test('deployment validates private data location, wallet transport and health bind addresses', () => {
  assert.equal(validateEnvironment(valid).healthUrl, 'http://127.0.0.1:4191/health');
  assert.equal(validateEnvironment(valid.replace('HOST=127.0.0.1', 'HOST=::')).healthUrl, 'http://[::1]:4191/health');
  assert.equal(validateEnvironment(valid.replace('HOST=127.0.0.1', 'HOST=0.0.0.0')).healthUrl, 'http://127.0.0.1:4191/health');
  assert.equal(validateEnvironment(valid+'QUEST_COMPUTE_WORKERS=6\n').env.QUEST_COMPUTE_WORKERS,'6');
  for (const content of [
    valid.replace('/var/lib/lidollquest-server', '/tmp/quest'),
    valid.replace('PORT=4191', 'PORT=80'),
    valid.replace('PORT=4191', 'PORT=65536'),
    valid.replace('HOST=127.0.0.1', 'HOST=localhost'),
    valid.replace('a'.repeat(43), ''),
    valid.replace('http://127.0.0.1:4173', 'http://wallet.example'),
    valid+'QUEST_COMPUTE_WORKERS=invalid\n',
  ]) assert.throws(() => validateEnvironment(content));
});

function simulation({prior = 'old', running = true, failure} = {}) { // Model the release pointer and running service independently.
  const state = {current: prior, running, enabled: false, backups: [], starts: [], checks: []};
  const ops = {
    candidate: 'new', previous: () => state.current, active: () => state.running,
    stop: () => { state.running = false; },
    backup: previous => { assert.equal(state.running, false); if (failure === 'backup') throw Error('backup failed'); state.backups.push(previous); },
    switch: target => { state.current = target; },
    start: () => { state.running = true; state.starts.push(state.current); },
    health: target => { state.checks.push(target); if (failure === 'health' && target === 'new') throw Error('health failed'); },
    enable: () => { state.enabled = true; },
  };
  return {state, ops};
}

test('successful deployment backs up before activating and enables only healthy code', async () => {
  const {state, ops} = simulation(); await activateRelease(ops);
  assert.deepEqual(state, {current: 'new', running: true, enabled: true, backups: ['old'], starts: ['new'], checks: ['new']});
});

test('failed health restores the prior running release without restoring stale database state', async () => {
  const {state, ops} = simulation({failure: 'health'});
  await assert.rejects(activateRelease(ops), /health failed/);
  assert.equal(state.current, 'old'); assert.equal(state.running, true); assert.equal(state.enabled, false);
  assert.deepEqual(state.starts, ['new', 'old']); assert.deepEqual(state.checks, ['new', 'old']);
  assert.deepEqual(state.backups, ['old']);
});

test('backup failure restarts the old service without switching code', async () => {
  const {state, ops} = simulation({failure: 'backup'});
  await assert.rejects(activateRelease(ops), /backup failed/);
  assert.equal(state.current, 'old'); assert.equal(state.running, true); assert.deepEqual(state.starts, ['old']);
});

test('failed initial install or previously stopped service stays stopped', async () => {
  for (const prior of [null, 'old']) {
    const {state, ops} = simulation({prior, running: false, failure: 'health'});
    await assert.rejects(activateRelease(ops), /health failed/);
    assert.equal(state.current, prior); assert.equal(state.running, false); assert.equal(state.enabled, false);
  }
});

test('rollback failure is reported together with the original startup failure', async () => {
  const {ops} = simulation({failure: 'health'});
  ops.health = () => { throw Error('unhealthy'); };
  await assert.rejects(activateRelease(ops), error => error instanceof AggregateError && error.errors.length === 2);
});
