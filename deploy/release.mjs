import {parseEnv} from 'node:util';
import {isIP} from 'node:net';
import {createWalletClient} from '../server/wallet.mjs';
import {computeWorkerCount} from '../server/compute-pool.mjs';

export function validateEnvironment(text) { // Check settings without printing or executing environment-file contents.
  const env = parseEnv(text);
  computeWorkerCount(env.QUEST_COMPUTE_WORKERS??'auto'); // Reject invalid pool settings before stopping the running release.
  if (env.DATA_DIR !== '/var/lib/lidollquest-server') throw Error('DATA_DIR must be /var/lib/lidollquest-server for this installer.');
  if (!isIP(env.HOST ?? '')) throw Error('HOST must be an explicit IPv4 or IPv6 bind address.');
  if (!/^\d+$/.test(env.PORT ?? '') || Number(env.PORT) < 1024 || Number(env.PORT) > 65535) throw Error('PORT must be between 1024 and 65535.');
  createWalletClient({baseUrl: env.LIDOLLCOIN_API_URL, key: env.LIDOLLCOIN_REWARD_KEY});
  const host = env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST === '::' ? '::1' : env.HOST;
  return {env, healthUrl: `http://${isIP(host) === 6 ? `[${host}]` : host}:${env.PORT}/health`};
}

export async function activateRelease(ops) { // Keep data intact and restore the prior code/running state if startup fails.
  const previous = ops.previous();
  const wasActive = ops.active();
  if (wasActive && !previous) throw Error('An active service has no managed current release; migrate it explicitly first.');
  let stopped = false, switched = false;
  try {
    await ops.stop(); stopped = true;
    await ops.backup(previous);
    ops.switch(ops.candidate); switched = true;
    await ops.start();
    await ops.health(ops.candidate);
    await ops.enable();
  } catch (error) {
    try {
      if (switched) { await ops.stop(); ops.switch(previous); }
      if (stopped && wasActive) { await ops.start(); await ops.health(previous); }
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], 'Deployment and recovery failed. Inspect journalctl -u lidollquest-server; backups were retained.');
    }
    throw error;
  }
}
