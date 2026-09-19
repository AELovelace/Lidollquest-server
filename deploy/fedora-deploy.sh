#!/usr/bin/env bash
set -euo pipefail

# Parse before installing packages so typos and help never change the host.
case "${1:-}" in
  --help|-h)
    cat <<'HELP'
Usage: sudo bash deploy/fedora-deploy.sh [--init-only]

Deploys the local checkout containing this script as lidollquest-server.
--init-only installs prerequisites and creates the private environment file
without starting the service. Configure its wallet URL/reward key, then rerun
without this flag. Existing environment and data are preserved on every run.

Code: /opt/lidollquest-server/releases (current is an atomic symlink)
Config: /etc/lidollquest/server.env
Data: /var/lib/lidollquest-server
Backups: /var/backups/lidollquest-server
See README.md for first-time tracker integration and update instructions.
HELP
    exit 0 ;;
  ''|--init-only) ;;
  *) echo 'Unknown option. Use --help.' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo 'Too many arguments. Use --help.' >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo 'Run this script with sudo.' >&2; exit 1; }
[[ -r /etc/fedora-release ]] || { echo 'This installer requires Fedora.' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'This installer requires running systemd.' >&2; exit 1; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Fedora supplies Node plus the headless private-sprite worker's Python dependencies.
dnf install -y nodejs24 ca-certificates util-linux shadow-utils policycoreutils python3 python3-requests python3-pillow
[[ -x /usr/bin/node-24 ]] || { echo 'Fedora did not provide /usr/bin/node-24.' >&2; exit 1; }

# A host-wide lock prevents two deployments from switching releases together.
exec /usr/bin/flock --nonblock /run/lock/lidollquest-deploy.lock \
  /usr/bin/node-24 "$script_dir/fedora.mjs" "$@"
