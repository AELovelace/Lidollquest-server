#!/usr/bin/env python3
"""Private SSH helper for a stopped-copy migration of the four Fedora services.

Invoked by deploy/migrate-lidoll-services.sh; never prints environment-file contents.
The public proxy and DNS are deliberately outside this helper's authority.
"""

import argparse
import hashlib
import ipaddress
import json
import os
import posixpath
from pathlib import Path, PurePosixPath
try:
    import pwd
except ImportError:
    pwd = None  # Pure archive/configuration tests also run on the Windows authoring workstation.
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request
import urllib.parse


SERVICES = ["lidoll-auth", "lidoll-tracker", "lidollquest-server", "lidoll-gallery"]
DATA = ["/var/lib/lidoll/auth", "/var/lib/lidoll/tracker", "/var/lib/lidollquest-server", "/var/lib/lidoll-gallery"]
CONFIG = ["/etc/lidoll", "/etc/lidollquest", "/etc/lidoll-gallery.env"]
CODE = ["/opt/lidoll/current", "/opt/lidollquest-server/current", "/opt/lidoll-gallery"]
ENVS = ["/etc/lidoll/auth.env", "/etc/lidoll/tracker.env", "/etc/lidollquest/server.env", "/etc/lidoll-gallery.env"]
DEFAULT_PORTS = [4180, 4173, 4191, 8787]
NODE = "/usr/bin/node-24"
NPM = "/usr/lib/node_modules_24/npm/bin/npm-cli.js"


def run(*args, capture=False, check=True, cwd=None):
    """Run argument arrays without shell expansion or inherited application secrets."""
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/root"}
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=capture)
    if check and result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {args[0]}")  # Do not expose command output containing credentials.
    return result.stdout.strip() if capture else result.returncode


def prop(service, name):
    return run("systemctl", "show", service, f"--property={name}", "--value", capture=True)  # Read a single systemd property.


def inside(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")  # Compare directory boundaries, not loose string prefixes.


def allowed(path):
    if path in CODE + CONFIG + ENVS:
        return True
    roots = DATA + ["/etc/lidoll", "/etc/lidollquest", "/opt/lidoll/releases", "/opt/lidollquest-server/releases", "/opt/lidoll-gallery"]
    if any(inside(path, root) for root in roots):
        return True
    return any(path == f"/etc/systemd/system/{s}.service" or inside(path, f"/etc/systemd/system/{s}.service.d") for s in SERVICES)


def validate_member(member):
    """Reject archive paths and links outside the explicit application restore scope."""
    if member.name.startswith("/") or ".." in PurePosixPath(member.name).parts:
        raise RuntimeError("Unsafe archive member path")
    path = "/" + member.name.rstrip("/")
    if not allowed(path) or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
        raise RuntimeError(f"Unsupported archive member: {path}")
    if member.issym() or member.islnk():
        target = member.linkname
        if member.islnk():
            target = "/" + target.lstrip("/")
        elif not target.startswith("/"):
            target = str(PurePosixPath(path).parent / target)
        target = posixpath.normpath(target)
        if not allowed(target):
            raise RuntimeError(f"Link leaves the migration scope: {path}")
    if member.mode & 0o6000:
        raise RuntimeError(f"Unexpected setuid/setgid file: {path}")


def read_env(path):
    """Read ordinary dotenv assignments without sourcing arbitrary shell code."""
    result = {}
    for line in Path(path).read_text().splitlines():
        match = re.match(r"^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if match:
            value = match[2]
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            result[match[1]] = value
    return result


def rewrite_env(text, changes):
    """Change only named connection settings, preserving every other secret and option."""
    lines = text.splitlines()
    for key, value in changes.items():
        matching = [i for i, line in enumerate(lines) if re.match(rf"^\s*{re.escape(key)}\s*=", line)]
        if len(matching) > 1:
            raise RuntimeError(f"Duplicate setting needs review: {key}")
        if matching:
            lines[matching[0]] = f"{key}={value}"
        else:
            lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


def file_list(roots):
    """Enumerate exact trees; npm dependencies are rebuilt on the destination."""
    seen = set()
    for root in roots:
        path = Path(root)
        if not path.exists() and not path.is_symlink():
            raise RuntimeError(f"Required path missing: {root}")
        candidates = [path]
        if path.is_dir() and not path.is_symlink():
            for parent, dirs, files in os.walk(path, followlinks=False):
                if inside(root, "/opt"):
                    dirs[:] = [d for d in dirs if d not in ("node_modules", ".git")]
                candidates.extend(Path(parent) / name for name in sorted(dirs + files))
        for candidate in candidates:
            name = str(candidate)
            if name not in seen:
                seen.add(name)
                yield candidate


def inventory():
    """Verify the documented layout and report paths/ports only, never credentials."""
    roots = list(DATA + CONFIG + CODE)
    services = []
    for index, service in enumerate(SERVICES):
        if Path(f"/etc/systemd/system/{service}.service.d/90-lidoll-migration-fence.conf").exists():
            raise RuntimeError("An earlier migration fence exists; follow its recovery record before starting a new run")
        unit = f"/etc/systemd/system/{service}.service"
        if prop(service, "FragmentPath") != unit or prop(service, "User") != service:
            raise RuntimeError(f"Nonstandard unit/user for {service}; review before migrating")
        if prop(service, "Group") not in ("", service):
            raise RuntimeError(f"Nonstandard group for {service}")
        expected_cwd = CODE[0 if index < 2 else index - 1]
        if prop(service, "WorkingDirectory") != expected_cwd:
            raise RuntimeError(f"Nonstandard working directory for {service}")
        environment = read_env(ENVS[index])
        data_key = ["AUTH_DATA_DIR", "DATA_DIR", "DATA_DIR", "GALLERY_DATA_DIR"][index]
        if environment.get(data_key) != DATA[index]:
            raise RuntimeError(f"Nonstandard data directory for {service}")
        if index == 1 and environment.get("BASE_PATH", "/tracker/") != "/tracker/":
            raise RuntimeError("Nonstandard tracker base path needs migration review")
        port = int(environment.get("AUTH_PORT" if index == 0 else "PORT", DEFAULT_PORTS[index]))
        if not 1 <= port <= 65535:
            raise RuntimeError("Invalid service port")
        if prop(service, "Environment"):
            raise RuntimeError(f"Inline systemd environment for {service} needs explicit review")
        for env_file in re.findall(r"(\S+)\s+\(ignore_errors=(?:yes|no)\)", prop(service, "EnvironmentFiles")):
            if env_file != ENVS[index]:
                raise RuntimeError(f"Additional environment file for {service} needs review before rebinding the service")
        expected_script = ["scripts/auth-server.mjs", "scripts/serve.mjs", "server/main.mjs", "server/gallery/server.mjs"][index]
        command = prop(service, "ExecStart")
        if NODE not in command or expected_script not in command:
            raise RuntimeError(f"Nonstandard command for {service}; review its required runtime files")
        roots.append(unit)
        for dropin in prop(service, "DropInPaths").split():
            if not allowed(dropin):
                raise RuntimeError(f"Nonstandard drop-in for {service}")
            roots.append(dropin)
        account = pwd.getpwnam(service)
        services.append({"name": service, "port": port, "enabled": prop(service, "UnitFileState"), "active": prop(service, "ActiveState"), "home": account.pw_dir})
    for pointer in CODE[:2]:
        resolved = str(Path(pointer).resolve(strict=True))
        expected_parent = str(Path(pointer).parent / "releases")
        if not Path(pointer).is_symlink() or str(Path(resolved).parent) != expected_parent:
            raise RuntimeError(f"Nonstandard release pointer: {pointer}")
        roots.append(resolved)
    size = sum(p.stat().st_size for p in file_list(roots) if p.is_file() and not p.is_symlink())
    auth = read_env(ENVS[0])
    if not auth.get("AUTH_ISSUER", "").startswith("https://"):
        raise RuntimeError("Expected a production HTTPS identity issuer")
    return {"roots": roots, "services": services, "bytes": size, "architecture": run("uname", "-m", capture=True), "issuer": auth.get("AUTH_ISSUER"), "node": run(NODE, "--version", capture=True)}


def require_host(address):
    links = json.loads(run("ip", "-j", "address", capture=True))
    if not any(info.get("local") == address for link in links for info in link.get("addr_info", [])):
        raise RuntimeError(f"This host does not own {address}")  # Prevent accidentally freezing or restoring onto the wrong host.


def target_empty():
    for service in SERVICES:
        if prop(service, "LoadState") != "not-found":
            raise RuntimeError(f"Target already has {service}; refusing to overwrite it")
    for path in DATA + CONFIG + ["/var/lib/lidoll", "/opt/lidoll", "/opt/lidollquest-server", "/opt/lidoll-gallery"]:
        if Path(path).exists() or Path(path).is_symlink():
            raise RuntimeError(f"Target path already exists: {path}; use a clean destination")


def active_zone(address):
    """Resolve the zone actually used by the target interface, including its default-zone fallback."""
    links = json.loads(run("ip", "-j", "address", capture=True))
    interface = next(link["ifname"] for link in links if any(info.get("local") == address for info in link.get("addr_info", [])))
    zone = run("firewall-cmd", "--get-zone-of-interface=" + interface, check=False, capture=True)
    return run("firewall-cmd", "--get-default-zone", capture=True) if not zone or zone == "no zone" else zone


def prepare(config, manifest):
    """Install target prerequisites while the source remains online."""
    require_host(config["target"])
    target_empty()
    if not Path("/etc/fedora-release").is_file():
        raise RuntimeError("Destination must be conventional Fedora with systemd")
    if run("uname", "-m", capture=True) != manifest["architecture"]:
        raise RuntimeError("This migration requires matching source and target CPU architectures")
    run("dnf", "install", "-y", "nodejs24", "nodejs24-npm", "python3", "python3-requests", "python3-pillow", "ffmpeg-free", "policycoreutils", "shadow-utils", "util-linux", "iproute", "curl")
    run(NODE, "--input-type=module", "-e", "if(Number(process.versions.node.split('.')[0])!==24 || Number(process.versions.node.split('.')[1])<9) process.exit(1); import('node:sqlite');")
    if run("firewall-cmd", "--state", check=False, capture=True) != "running":
        raise RuntimeError("Configure/start firewalld with working SSH access before migrating")
    zone = active_zone(config["target"])
    if config["zone"] == "auto":
        config["zone"] = zone
    if zone != config["zone"]:
        raise RuntimeError(f"Target interface uses firewall zone {zone}; rerun with that zone")
    for service in SERVICES + ["lidoll-migrate", "lidoll-deploy"]:
        try:
            account = pwd.getpwnam(service)
            if account.pw_uid == 0:
                raise RuntimeError("Service account cannot be root")
        except KeyError:
            run("useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/var/lib/" + service, "--shell", "/usr/sbin/nologin", service)
    # Both runtime and permanent checks happen before the source is stopped.
    for permanent in ([], ["--permanent"]):
        run("firewall-cmd", *permanent, "--zone=" + config["zone"], "--list-all", capture=True)
    for port in [s["port"] for s in manifest["services"]]:
        if run("ss", "-H", "-ltn", "sport", "=", f":{port}", capture=True):
            raise RuntimeError(f"Target port {port} is already occupied")
        # Explicit destination-limited reject rules also defeat broad port allowances in this zone.
        clients = [config["proxy"]] + config.get("allowed_clients", [])
        rules = [(-20, f'source address="{client}/32" ', "accept") for client in clients] + [(-10, "", "reject")]
        for priority, source, action in rules:
            rule = f'rule priority="{priority}" family="ipv4" {source}destination address="{config["target"]}/32" port port="{port}" protocol="tcp" {action}'
            for permanent in ([], ["--permanent"]):
                run("firewall-cmd", *permanent, "--zone=" + config["zone"], "--add-rich-rule=" + rule)
    available = shutil.disk_usage("/var").free
    if available < manifest["bytes"] * 3 + 1024 ** 3:
        raise RuntimeError("Target /var needs space for archive, restored data, dependencies and rollback copies")
    if shutil.disk_usage("/opt").free < manifest["bytes"] + 1024 ** 3:
        raise RuntimeError("Target /opt needs sufficient release/dependency space")
    print("Target prerequisites ready; source services have not been stopped.")


def fingerprint(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()  # Stream large gallery archives without loading them into RAM.


def freeze(config, manifest, stage):
    """Stop all writers before creating one coherent archive containing every database."""
    require_host(config["source"])
    current = inventory()
    if current["roots"] != manifest["roots"] or current["services"] != manifest["services"]:
        raise RuntimeError("Source deployment changed since inventory; inspect again")
    backup = Path("/var/backups/lidoll-migration") / config["run_id"]
    backup.mkdir(parents=True, mode=0o700, exist_ok=False)
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2))
    for location in (backup, stage):
        if shutil.disk_usage(location).free < manifest["bytes"] * 2 + 1024 ** 3:
            raise RuntimeError("Source needs space for both the frozen backup and the SCP staging archive")
    for service in SERVICES:
        fence = Path(f"/etc/systemd/system/{service}.service.d/90-lidoll-migration-fence.conf")
        if fence.exists():
            raise RuntimeError("An earlier migration fence exists; inspect the earlier run before continuing")
        fence.parent.mkdir(mode=0o755, exist_ok=True)
        fence.write_text(f"[Unit]\nConditionPathExists={backup}/ALLOW_SOURCE_START\n")
        os.chmod(fence, 0o644)
    run("systemctl", "daemon-reload")  # The absent condition file blocks manual, timer and reboot starts of the old copies.
    for service in reversed(SERVICES):
        run("systemctl", "stop", service)
        run("systemctl", "disable", service)
    for service in SERVICES:
        if prop(service, "ActiveState") not in ("inactive", "failed"):
            raise RuntimeError(f"Service did not stop: {service}")
    # A stray process, second service or worker with an open data file invalidates a stopped copy.
    for fd in Path("/proc").glob("[0-9]*/fd/*"):
        try:
            opened = os.readlink(fd)
        except (FileNotFoundError, PermissionError):
            continue
        if any(inside(opened, root) for root in DATA):
            raise RuntimeError("Another process still has a migrated data file open; source remains stopped")
    archive = backup / "services.tar"
    with tarfile.open(archive, "w", format=tarfile.PAX_FORMAT) as bundle:
        for path in file_list(manifest["roots"]):
            member = bundle.gettarinfo(str(path), arcname=str(path).lstrip("/"))
            validate_member(member)
            if member.isfile():
                with path.open("rb") as stream:
                    bundle.addfile(member, stream)
            else:
                bundle.addfile(member)
    checksum = fingerprint(archive)
    (backup / "services.sha256").write_text(checksum + "\n")
    # A second private copy is readable by the SSH account for SCP; the root-owned backup stays on the old host.
    shutil.copyfile(archive, stage / "services.tar")
    (stage / "services.sha256").write_text(checksum + "\n")
    owner = stage.stat().st_uid
    for name in ("services.tar", "services.sha256"):
        os.chown(stage / name, owner, -1)
        os.chmod(stage / name, 0o600)
    print(f"Source stopped and disabled. Root-owned backup: {backup}")


def configure(config, manifest):
    """Rebind only private connectivity; all public origins, auth keys and account IDs survive."""
    ports = [s["port"] for s in manifest["services"]]
    target = config["target"]
    changes = [
        {"AUTH_HOST": target},
        {"HOST": target, "LIDOLLCOIN_IDENTITY_URL": f"http://{target}:{ports[0]}/wallet/identity", "LIDOLLQUEST_API_URL": f"http://127.0.0.1:{ports[2]}/"},
        {"LIDOLLCOIN_API_URL": f"http://{target}:{ports[1]}/tracker/api/lidollcoin/v1/"},
        {"HOST": target},
    ]
    quest = read_env(ENVS[2])
    if quest.get("HOST") == config["source"]:
        changes[2]["HOST"] = target  # Preserve a loopback-only quest listener when the proxy does not access /gm directly.
    for path, replacement in zip(ENVS, changes):
        file = Path(path)
        file.write_text(rewrite_env(file.read_text(), replacement))
    for parent in ("/opt/lidoll", "/opt/lidoll/releases", "/opt/lidollquest-server", "/opt/lidollquest-server/releases", "/var/lib/lidoll"):
        os.chmod(parent, 0o755)  # tar's implicit parents inherit the private umask; services still need directory traversal.
    for scaffold in ("/var/backups/lidoll", "/var/backups/lidollquest-server", "/var/lib/lidoll-deploy"):
        Path(scaffold).mkdir(mode=0o700, exist_ok=True)  # Tracker's systemd InaccessiblePaths requires these paths to exist.
    run("chown", "lidoll-deploy:lidoll-deploy", "/var/lib/lidoll-deploy")
    deploy = Path("/etc/lidoll/deploy.json")
    if deploy.is_file():
        settings = json.loads(deploy.read_text())
        # Existing deploy configuration names are checked against the actual shipped deployment helper.
        for key in ("bindAddress", "bind_address"):
            if settings.get(key) == config["source"]:
                settings[key] = target
        settings["firewallZone"] = active_zone(target)
        settings["proxyIp"] = config["proxy"]
        deploy.write_text(json.dumps(settings, indent=2) + "\n")
    for root, service in zip(DATA, SERVICES):
        run("chown", "-R", f"{service}:{service}", root)
        os.chmod(root, 0o700)
    for index, file in enumerate(ENVS):
        run("chown", f"root:{SERVICES[index]}", file)
        os.chmod(file, 0o600 if index == 3 else 0o640)
    snippet = Path("/opt/lidoll-gallery/server/gallery/nginx-gallery.conf")
    if snippet.is_file():
        snippet.write_text(snippet.read_text().replace(f'http://{config["source"]}:', f'http://{target}:'))
    run("restorecon", "-RF", *DATA, *CONFIG, "/opt/lidoll", "/opt/lidollquest-server", "/opt/lidoll-gallery")


def restore(config, manifest, stage):
    """Verify the transport, restore into empty paths and build pinned target dependencies."""
    require_host(config["target"])
    target_empty()
    archive = stage / "services.tar"
    if fingerprint(archive) != (stage / "services.sha256").read_text().strip():
        raise RuntimeError("Archive SHA-256 mismatch; nothing restored")
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        for member in members:
            validate_member(member)
        # The archive is from our authenticated source; every path/link/type was independently scoped above.
        bundle.extractall("/", members=members, filter="fully_trusted")
    configure(config, manifest)
    for pointer in (CODE[0], CODE[2]):
        code = str(Path(pointer).resolve(strict=True))
        run("chown", "-R", "lidoll-migrate:lidoll-migrate", code)
        try:
            run("runuser", "-u", "lidoll-migrate", "--", "env", "HOME=/tmp", "npm_config_cache=/tmp/lidoll-migration-npm", NODE, NPM, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", cwd=code)
            run("runuser", "-u", "lidoll-migrate", "--", NODE, "--input-type=module", "-e", "await import('sharp'); await import('openid-client');", cwd=code)
        finally:
            run("chown", "-R", "root:root", code)
    for root in DATA:
        for database in Path(root).rglob("*.sqlite"):
            with sqlite3.connect(str(database)) as connection:
                if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise RuntimeError(f"SQLite integrity failed: {database}")
    # Integrity checks may create sidecars; restore ownership before the service opens them.
    for root, service in zip(DATA, SERVICES):
        run("chown", "-R", f"{service}:{service}", root)
    run("systemctl", "daemon-reload")
    run("systemd-analyze", "verify", *[f"/etc/systemd/system/{s}.service" for s in SERVICES])
    (stage / "restored").write_text("Verified restore completed; source remains stopped.\n")
    print("All four services restored and configured; they have not been started.")


def start(config, manifest, stage):
    """Start in dependency order and check local endpoints before any proxy cutover."""
    require_host(config["target"])
    if not (stage / "restored").is_file():
        raise RuntimeError("Restore verification has not completed")
    (stage / "target-start-attempted").write_text("New databases may now receive writes; never blindly restart the old copies.\n")
    for service in SERVICES:
        run("systemctl", "enable", "--now", service)
    ports = [s["port"] for s in manifest["services"]]
    endpoints = [
        (f'http://{config["target"]}:{ports[0]}/.well-known/openid-configuration', 200),
        (f'http://{config["target"]}:{ports[1]}/tracker/api/session', 401),
        (f'http://{read_env(ENVS[2]).get("HOST", "127.0.0.1")}:{ports[2]}/health', 200),
        (f'http://{config["target"]}:{ports[3]}/gallery/api/sets', 200),
    ]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    import time
    for index, (url, expected) in enumerate(endpoints):
        for attempt in range(30):
            try:
                headers = {"Host": urllib.parse.urlparse(manifest["issuer"]).netloc, "X-Forwarded-Proto": "https"} if index == 0 else {}
                request = urllib.request.Request(url, headers=headers)
                try:
                    response = opener.open(request, timeout=3)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    payload = json.loads(response.read())
                    if response.status != expected:
                        raise RuntimeError("Unexpected health status")
                if index == 0 and payload.get("issuer") != manifest["issuer"]:
                    raise RuntimeError("Auth issuer changed")
                if index == 2 and payload.get("ok") is not True:
                    raise RuntimeError("Quest health failed")
                break
            except (OSError, ValueError, RuntimeError):
                if attempt == 29:
                    raise RuntimeError(f"Health check failed for {SERVICES[index]}; inspect its journal locally")
                time.sleep(1)
        print(f"PASS: {SERVICES[index]} local health")
    print("READY FOR PROXY CUTOVER. Old services must stay stopped. Run public login/media/wallet/game checks next.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["inspect", "prepare", "freeze", "restore", "start"])
    parser.add_argument("--stage", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Use root SSH or noninteractive sudo for this helper")
    os.umask(0o077)
    import fcntl
    lock = open("/run/lock/lidoll-services-migration.lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)  # Keep the handle alive until this host-local action exits.
    stage = Path(args.stage)
    if not re.fullmatch(r"/var/tmp/lidoll-migration\.[A-Za-z0-9]+", str(stage)) or stage.is_symlink() or stage.stat().st_mode & 0o077:
        raise RuntimeError("Invalid private staging directory")
    config = json.loads((stage / "config.json").read_text())
    for key in ("source", "target", "proxy"):
        ipaddress.IPv4Address(config[key])
    for address in config.get("allowed_clients", []):
        ipaddress.IPv4Address(address)
    if len({config["source"], config["target"], config["proxy"]}) != 3:
        raise RuntimeError("Source, target and proxy must be different hosts")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", config["zone"]) or not re.fullmatch(r"[A-Za-z0-9_-]+", config["run_id"]):
        raise RuntimeError("Invalid zone or run identifier")
    if args.action == "inspect":
        require_host(config["source"])
        report = inventory()
        manifest_file = stage / "manifest.json"
        manifest_file.write_text(json.dumps(report, indent=2))
        os.chown(manifest_file, stage.stat().st_uid, -1)
        print(json.dumps(report, indent=2))
        return
    manifest = json.loads((stage / "manifest.json").read_text())
    {"prepare": lambda: prepare(config, manifest), "freeze": lambda: freeze(config, manifest, stage), "restore": lambda: restore(config, manifest, stage), "start": lambda: start(config, manifest, stage)}[args.action]()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"MIGRATION STOPPED: {error}", file=sys.stderr)
        sys.exit(1)
