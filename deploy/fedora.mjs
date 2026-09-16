import {existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, realpathSync, symlinkSync, renameSync, unlinkSync, chmodSync, mkdtempSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {validateEnvironment, activateRelease} from './release.mjs';

const ROOT = '/opt/lidollquest-server', CONFIG = '/etc/lidollquest', DATA = '/var/lib/lidollquest-server';
const BACKUPS = '/var/backups/lidollquest-server', NODE = '/usr/bin/node-24', USER = 'lidollquest-server';
const UNIT = 'lidollquest-server.service', unitPath = `/etc/systemd/system/${UNIT}`;
const current = join(ROOT, 'current'), envPath = join(CONFIG, 'server.env');
const source = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

function run(command, args, {capture = false, cwd} = {}) { // Pass arguments directly, never through a privileged shell.
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', env: {...process.env, NODE_OPTIONS: '', NODE_PATH: ''}});
  if (result.error || result.status !== 0) throw Error(`Command failed: ${command} ${args.join(' ')}`);
  return result.stdout?.trim();
}

function plainPath(path) { // Reject redirected privileged destinations, including symlinked parent directories.
  for (let at = resolve(path); ; at = dirname(at)) {
    try { if (lstatSync(at).isSymbolicLink()) throw Error(`Refusing symlink: ${at}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(at) === at) break;
  }
}

function directory(path, mode = 0o755) { // Create stable directories while preserving existing data inside them.
  plainPath(path); mkdirSync(path, {recursive: true, mode});
}

function regularTree(path) { // Copy only regular checkout/data files; do not follow source symlinks as root.
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw Error(`Not a regular file/directory: ${path}`);
  if (info.isDirectory()) for (const name of readdirSync(path)) regularTree(join(path, name));
}

function previous() { // Only replace symlinks pointing at this installer's immutable releases.
  try {
    if (!lstatSync(current).isSymbolicLink()) throw Error('current must be an installer-managed symlink; move an old manual checkout aside first.');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const target = realpathSync(current);
  if (dirname(target) !== join(ROOT, 'releases')) throw Error('current points outside the managed releases directory.');
  return target;
}

function switchRelease(target) { // Rename the new pointer atomically without touching persistent SQLite state.
  if (!target) { unlinkSync(current); return; }
  const temp = join(ROOT, `.current-${randomUUID()}`);
  symlinkSync(target, temp); renameSync(temp, current);
}

function active() { // An inactive or failed old service may still be repaired by deployment.
  return spawnSync('/usr/bin/systemctl', ['is-active', '--quiet', UNIT]).status === 0;
}

async function health(release, url) { // Verify both the response and the running process's actual release directory.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      if (!active()) throw Error('Service inactive');
      const pid = run('/usr/bin/systemctl', ['show', '--property=MainPID', '--value', UNIT], {capture: true});
      if (!/^[1-9]\d*$/.test(pid) || realpathSync(`/proc/${pid}/cwd`) !== release) throw Error('Wrong service release');
      const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(1500)});
      if (response.ok && (await response.json()).ok === true) return;
    } catch { /* Retry while systemd brings up the new process. */ }
    await new Promise(done => setTimeout(done, 500));
  }
  throw Error('Service health check failed; inspect journalctl -u lidollquest-server.');
}

async function main() { // Prepare configuration first; require a usable reward key before stopping an existing service.
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !existsSync('/etc/fedora-release')) throw Error('Run through fedora-deploy.sh with sudo on Fedora.');
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== '--init-only')) throw Error('Expected only --init-only or no arguments.');
  process.umask(0o077);
  for (const path of [ROOT, join(ROOT, 'releases')]) { directory(path); chmodSync(path, 0o755); }
  directory(CONFIG, 0o750); directory(DATA, 0o700); directory(BACKUPS, 0o700);
  plainPath(envPath); plainPath(unitPath); previous();
  regularTree(join(source, 'deploy'));
  const unit = readFileSync(join(source, 'deploy', UNIT), 'utf8').replaceAll('\r\n', '\n');
  if (existsSync(unitPath) && readFileSync(unitPath, 'utf8').replaceAll('\r\n', '\n') !== unit) throw Error(`Existing ${unitPath} differs; review it explicitly. Use systemd drop-ins for customizations.`);
  if (spawnSync('/usr/bin/id', ['-u', USER], {stdio: 'ignore'}).status !== 0) run('/usr/sbin/useradd', ['--system', '--user-group', '--home-dir', DATA, '--shell', '/usr/sbin/nologin', USER]);
  if (!existsSync(envPath)) writeFileSync(envPath, readFileSync(join(source, 'deploy/server.env.example')), {flag: 'wx', mode: 0o640});
  run('/usr/bin/chown', [`root:${USER}`, CONFIG, envPath]); chmodSync(CONFIG, 0o750); chmodSync(envPath, 0o640);
  run('/usr/bin/chown', [`${USER}:${USER}`, DATA]); chmodSync(DATA, 0o700); chmodSync(BACKUPS, 0o700);
  if (args[0] === '--init-only') {
    console.log(`Configuration ready: ${envPath}. Set the wallet URL and matching server reward key (README.md), then rerun without --init-only.`);
    return;
  }
  const environment = validateEnvironment(readFileSync(envPath, 'utf8'));
  const release = join(ROOT, 'releases', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(release, {mode: 0o755});
  for (const name of ['package.json', 'README.md', 'server', 'deploy', 'test']) {
    regularTree(join(source, name)); cpSync(join(source, name), join(release, name), {recursive: true, errorOnExist: true, force: false});
  }
  run('/usr/bin/chown', ['-R', 'root:root', release]);
  run('/usr/bin/chmod', ['-R', 'u=rwX,go=rX', release]);
  run('/usr/sbin/restorecon', ['-R', ROOT, CONFIG, DATA]);
  console.log('Testing the candidate as nobody, without access to service data or configuration...');
  const testDir = mkdtempSync('/var/tmp/lidollquest-test-');
  run('/usr/bin/chown', ['nobody', testDir]);
  const tests = readdirSync(join(release, 'test')).filter(name => name.endsWith('.test.mjs')).map(name => join(release, 'test', name));
  if (!tests.length) throw Error('Candidate contains no tests.');
  run('/usr/sbin/runuser', ['-u', 'nobody', '--', NODE, '--test', ...tests], {cwd: testDir});
  console.log(`Test artifacts: ${testDir}`);
  if (!existsSync(unitPath)) { writeFileSync(unitPath, unit, {flag: 'wx', mode: 0o644}); chmodSync(unitPath, 0o644); }
  run('/usr/bin/systemctl', ['daemon-reload']);
  await activateRelease({candidate: release, previous, active, switch: switchRelease,
    stop: () => run('/usr/bin/systemctl', ['stop', UNIT]),
    start: () => run('/usr/bin/systemctl', ['start', UNIT]),
    enable: () => run('/usr/bin/systemctl', ['enable', UNIT]),
    health: target => health(target, environment.healthUrl),
    backup: prior => {
      const destination = join(BACKUPS, randomUUID()); mkdirSync(destination, {mode: 0o700});
      regularTree(DATA); cpSync(DATA, join(destination, 'data'), {recursive: true});
      cpSync(envPath, join(destination, 'server.env')); chmodSync(join(destination, 'server.env'), 0o600);
      writeFileSync(join(destination, 'release.json'), JSON.stringify({previous: prior, candidate: release, createdAt: new Date().toISOString()}));
      console.log(`Stopped-service backup (including SQLite/WAL): ${destination}`);
    },
  });
  console.log(`Deployed ${release}\nHealth: ${environment.healthUrl}\nThis checks process availability; verify linked gameplay to check the tracker connection.`);
}

main().catch(error => { console.error(error.message); if (error.errors) for (const cause of error.errors) console.error(cause.message); process.exitCode = 1; });
