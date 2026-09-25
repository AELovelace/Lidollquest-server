"""Exercise the real Bash controller with fake SSH/SCP; never contact a server."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
BASH = (str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/usr/bin/bash.exe") if os.name == "nt" else shutil.which("bash"))


def shell_path(path):
    value = Path(path).as_posix()
    return "/" + value[0].lower() + value[2:] if os.name == "nt" and len(value) > 1 and value[1] == ":" else value


@unittest.skipUnless(BASH and Path(BASH).is_file(), "Bash is required for controller tests")
class ControllerTests(unittest.TestCase):
    def run_controller(self, *arguments, fail_prepare=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "deploy").mkdir()
            (root / "python").mkdir()
            (root / "bin").mkdir()
            shutil.copyfile(ROOT / "deploy/migrate-lidoll-services.sh", root / "deploy/migrate-lidoll-services.sh")
            (root / "python/lidoll_migration_remote.py").write_text("# Never executed by these mocked SSH tests.\n")
            scripts = {
                "python3": '#!/usr/bin/env bash\nexec "' + shell_path(sys.executable) + '" "$@"\n',
                "ssh": '''#!/usr/bin/env bash
printf 'ssh %s\\n' "$*" >> "$MIGRATION_TEST_LOG"
last=${!#}
case "$last" in
  *mktemp*) echo /var/tmp/lidoll-migration.Test1234 ;;
  *'helper.py prepare '*) if [[ ${FAIL_PREPARE:-0} == 1 ]]; then exit 9; fi ;;
esac
''',
                "scp": '''#!/usr/bin/env bash
printf 'scp %s\\n' "$*" >> "$MIGRATION_TEST_LOG"
destination=${!#}
if [[ $destination == */manifest.json && $destination != *@* ]]; then
  printf '{"bytes":1234,"services":[]}' > "$destination"
fi
''',
            }
            for name, content in scripts.items():
                file = root / "bin" / name
                file.write_text(content, encoding="utf-8", newline="\n")
                file.chmod(0o755)
            env = dict(os.environ, MIGRATION_TEST_LOG=shell_path(root / "commands.log"), FAIL_PREPARE="1" if fail_prepare else "0")
            result = subprocess.run([BASH, "-c", 'export PATH="$1:/usr/bin:/bin:$PATH"; shift; bash deploy/migrate-lidoll-services.sh "$@"', "test", shell_path(root / "bin"), *arguments], cwd=root, env=env, text=True, capture_output=True, timeout=30)
            log = (root / "commands.log").read_text() if (root / "commands.log").exists() else ""
            states = [json.loads(p.read_text()) for p in (root / "artifacts").glob("*/state.json")] if (root / "artifacts").exists() else []
            return result, log, states

    def test_default_inspection_never_prepares_or_stops_services(self):
        result, log, states = self.run_controller()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("helper.py inspect ", log)
        self.assertNotIn("helper.py prepare ", log)
        self.assertNotIn("helper.py freeze ", log)
        self.assertEqual(states[0]["phase"], "inspection-complete")

    def test_migration_requires_maintenance_before_any_ssh(self):
        result, log, states = self.run_controller("--mode", "migrate")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(log, "")
        self.assertEqual(states, [])

    def test_target_preparation_failure_leaves_source_running(self):
        result, log, states = self.run_controller("--mode", "migrate", "--maintenance-confirmed", fail_prepare=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("helper.py prepare ", log)
        self.assertNotIn("helper.py freeze ", log)
        self.assertEqual(states[0]["phase"], "target-preparation")

    def test_successful_orchestration_copies_before_restore_and_start(self):
        result, log, states = self.run_controller("--mode", "migrate", "--maintenance-confirmed", "--non-interactive")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        steps = [log.index("helper.py " + action + " ") for action in ("inspect", "prepare", "freeze", "restore", "start")]
        self.assertEqual(steps, sorted(steps))
        self.assertLess(steps[2], log.index(" -3 "))
        self.assertLess(log.index(" -3 "), steps[3])
        self.assertEqual(log.count(" -3 "), 2)
        self.assertEqual(states[0]["phase"], "ready-for-proxy-cutover")
        self.assertIn("sudo -n --", log)


if __name__ == "__main__":
    unittest.main()
