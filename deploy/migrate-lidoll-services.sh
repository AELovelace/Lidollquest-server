#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Coordinates SSH/SCP only; the adjacent Python helper owns checked, host-local operations.
usage() {
  cat <<'HELP'
Usage: bash deploy/migrate-lidoll-services.sh [options]

Modes:
  --mode inspect          Inventory the source; no service changes (default).
  --mode prepare          Inspect and prepare the empty target; source stays online.
  --mode migrate          Prepare, stop/fence source, SCP, restore, configure and start target.

Options:
  --source IP             Default: 10.1.1.23
  --target IP             Default: 10.1.1.24
  --proxy IP              Default: 10.1.1.20 (existing proxy; never changed by this script)
  --source-user USER      Default: aedith
  --target-user USER      Default: aedith
  --zone ZONE             Default: auto (target interface's firewalld zone)
  --allow-client IP       Also allow a private integration caller; may be repeated.
  --ssh-port PORT         Same SSH port on both hosts; default: 22
  --identity-file PATH    Optional SSH private key; otherwise normal SSH configuration.
  --non-interactive       Require working SSH keys and noninteractive sudo.
  --maintenance-confirmed Required for migrate: public traffic/external writers are paused.
  --help                  Show help without contacting any host.

Run from Linux, WSL or Git Bash with Bash, Python 3, OpenSSH ssh and scp.
Interactive SSH/sudo passwords are entered into their own prompts, never stored.
Read MIGRATION_10.1.1.24.md before using migrate. No DNS or proxy changes are automatic.
HELP
}

mode=inspect
source_address=10.1.1.23
target_address=10.1.1.24
proxy_address=10.1.1.20
source_user=aedith
target_user=aedith
zone=auto
ssh_port=22
identity_file=''
non_interactive=false
maintenance_confirmed=false
allowed_clients=()
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --non-interactive) non_interactive=true; shift ;;
    --maintenance-confirmed) maintenance_confirmed=true; shift ;;
    --mode|--source|--target|--proxy|--source-user|--target-user|--zone|--allow-client|--ssh-port|--identity-file)
      (($# >= 2)) || { echo "Missing value for $1" >&2; exit 2; }
      case "$1" in
        --mode) mode=$2 ;; --source) source_address=$2 ;; --target) target_address=$2 ;;
        --proxy) proxy_address=$2 ;; --source-user) source_user=$2 ;; --target-user) target_user=$2 ;;
        --zone) zone=$2 ;; --allow-client) allowed_clients+=("$2") ;;
        --ssh-port) ssh_port=$2 ;; --identity-file) identity_file=$2 ;;
      esac
      shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ $mode =~ ^(inspect|prepare|migrate)$ ]] || { echo 'Invalid mode.' >&2; exit 2; }
[[ $source_user =~ ^[a-z_][a-z0-9_-]*\$?$ && $target_user =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || { echo 'Invalid SSH username.' >&2; exit 2; }
[[ $zone =~ ^[A-Za-z0-9_-]+$ && $ssh_port =~ ^[1-9][0-9]{0,4}$ ]] && ((ssh_port <= 65535)) || { echo 'Invalid zone or port.' >&2; exit 2; }
if [[ $mode == migrate && $maintenance_confirmed != true ]]; then
  echo 'Migrate requires --maintenance-confirmed after public traffic and external writers have been paused.' >&2
  exit 2
fi
for program in python3 ssh scp; do command -v "$program" >/dev/null || { echo "Missing prerequisite: $program" >&2; exit 2; }; done
python3 - "$source_address" "$target_address" "$proxy_address" "${allowed_clients[@]}" <<'PY'
import ipaddress, sys
for value in sys.argv[1:]:
    ipaddress.IPv4Address(value)
if len(set(sys.argv[1:4])) != 3:
    raise SystemExit('Source, target and proxy must be different hosts.')
PY

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
helper="$repo_root/python/lidoll_migration_remote.py"
[[ -f $helper ]] || { echo "Missing helper: $helper" >&2; exit 2; }
[[ -z $identity_file || -f $identity_file ]] || { echo 'SSH identity file does not exist.' >&2; exit 2; }
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
run_dir="$repo_root/artifacts/migration-$run_id"
mkdir -p -- "$run_dir"
ssh_options=(-p "$ssh_port" -o StrictHostKeyChecking=ask -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
scp_options=(-P "$ssh_port" -o StrictHostKeyChecking=ask -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
if [[ $non_interactive == true ]]; then ssh_options+=(-o BatchMode=yes); scp_options+=(-o BatchMode=yes); fi
if [[ -n $identity_file ]]; then ssh_options+=(-i "$identity_file"); scp_options+=(-i "$identity_file"); fi
source_login="$source_user@$source_address"
target_login="$target_user@$target_address"
source_stage=''
target_stage=''
phase=initializing

python3 - "$run_dir/config.json" "$source_address" "$target_address" "$proxy_address" "$zone" "$run_id" "${allowed_clients[@]}" <<'PY'
import json, pathlib, sys
path, source, target, proxy, zone, run_id, *clients = sys.argv[1:]
pathlib.Path(path).write_text(json.dumps(dict(source=source,target=target,proxy=proxy,zone=zone,run_id=run_id,allowed_clients=clients)), encoding='utf-8')
PY

save_phase() {
  phase=$1
  python3 - "$run_dir/state.json" "$run_id" "$phase" "$source_login" "$target_login" "$source_stage" "$target_stage" <<'PY'
import json, pathlib, sys
path, *values = sys.argv[1:]
pathlib.Path(path).write_text(json.dumps(dict(zip(['run_id','phase','source','target','source_stage','target_stage'],values)),indent=2), encoding='utf-8')
PY
  printf '\n[%s]\n' "$phase"
} # Keep a credential-free recovery record even if a network connection disappears halfway through.

on_exit() {
  local status=$?
  if ((status)); then
    printf '\nSTOPPED in phase %s. Recovery record: %s/state.json\n' "$phase" "$run_dir" >&2
    printf 'Source services may be stopped. After a target start attempt, never blindly restart the old database copies.\n' >&2
  fi
} # Fail closed: restarting the old host automatically could fork the wallet or account history.
trap on_exit EXIT

create_stage() {
  local login=$1
  result_stage=$(ssh "${ssh_options[@]}" "$login" 'umask 077; mktemp -d /var/tmp/lidoll-migration.XXXXXXXX')
  [[ $result_stage =~ ^/var/tmp/lidoll-migration\.[A-Za-z0-9]+$ ]] || { echo 'Unexpected SSH staging output.' >&2; return 1; }
  scp "${scp_options[@]}" "$helper" "$login:$result_stage/helper.py"
  scp "${scp_options[@]}" "$run_dir/config.json" "$login:$result_stage/config.json"
} # Use disk-backed /var/tmp, not Fedora's potentially RAM-backed /tmp, for large galleries.

remote_helper() {
  local login=$1 stage=$2 action=$3
  local command="/usr/bin/python3 $stage/helper.py $action --stage $stage"
  local options=("${ssh_options[@]}")
  if [[ $login != root@* ]]; then
    if [[ $non_interactive == true ]]; then command="sudo -n -- $command"
    else options+=(-t); command="sudo -- $command"; fi
  fi
  ssh "${options[@]}" "$login" "$command"
} # Only validated fixed paths/action names enter the remote shell; sudo handles its own password prompt.

save_phase source-inventory
create_stage "$source_login"
source_stage=$result_stage
save_phase source-inventory
remote_helper "$source_login" "$source_stage" inspect
scp "${scp_options[@]}" "$source_login:$source_stage/manifest.json" "$run_dir/manifest.json"
python3 - "$run_dir/manifest.json" <<'PY'
import json, sys
m=json.load(open(sys.argv[1], encoding='utf-8'))
print(f"Stopped-copy payload: approximately {m['bytes']/1024**3:.2f} GiB, excluding rebuilt npm dependencies.")
PY
printf 'Inventory: %s/manifest.json\n' "$run_dir"
if [[ $mode == inspect ]]; then save_phase inspection-complete; exit 0; fi

save_phase target-preparation
create_stage "$target_login"
target_stage=$result_stage
save_phase target-preparation
scp "${scp_options[@]}" "$run_dir/manifest.json" "$target_login:$target_stage/manifest.json"
remote_helper "$target_login" "$target_stage" prepare
if [[ $mode == prepare ]]; then save_phase preparation-complete; exit 0; fi

save_phase source-freeze-started
remote_helper "$source_login" "$source_stage" freeze
save_phase copying-stopped-archive
for name in services.tar services.sha256; do
  scp "${scp_options[@]}" -3 "$source_login:$source_stage/$name" "$target_login:$target_stage/$name"
done # SCP relays encrypted bytes through this machine; it does not save an archive in the local repository.
save_phase target-restore-started
remote_helper "$target_login" "$target_stage" restore
save_phase target-start-attempted
remote_helper "$target_login" "$target_stage" start
save_phase ready-for-proxy-cutover
printf '\nNew services passed local health checks on %s. Change only their upstreams on %s.\n' "$target_address" "$proxy_address"
printf 'Old services remain stopped and fenced. Run public smoke tests; retain the frozen backup.\n'
printf 'Recovery record: %s/state.json\nPrivate remote staging archives remain until you clean them up using the runbook.\n' "$run_dir"
