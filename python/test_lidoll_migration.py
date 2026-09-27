"""Offline safety regressions. No SSH, systemd, sudo or live databases are used."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("migration", Path(__file__).with_name("lidoll_migration_remote.py"))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def test_connection_rewrite_preserves_identity_and_secrets(self):
        original = 'HOST=10.1.1.23\nAUTH_ISSUER=https://auth.sadgirlsclub.wtf\nKEY="do-not-change"\nLIDOLLCOIN_REWARD_KEYS=\'{"lidollquest":"secret"}\'\n'
        result = migration.rewrite_env(original, {"HOST": "10.1.1.24", "NEW_ENDPOINT": "http://127.0.0.1:4191/"})
        self.assertIn('HOST=10.1.1.24\n', result)
        self.assertIn('AUTH_ISSUER=https://auth.sadgirlsclub.wtf\n', result)
        self.assertIn('KEY="do-not-change"\n', result)
        self.assertIn('LIDOLLCOIN_REWARD_KEYS=\'{"lidollquest":"secret"}\'\n', result)
        self.assertEqual(result, migration.rewrite_env(result, {"HOST": "10.1.1.24", "NEW_ENDPOINT": "http://127.0.0.1:4191/"}))

    def test_duplicate_connection_assignment_is_rejected(self):
        with self.assertRaises(RuntimeError):
            migration.rewrite_env('HOST=one\nHOST=two\n', {"HOST": "new"})

    def test_archive_rejects_paths_outside_application_roots(self):
        for name in ("/etc/passwd", "etc/passwd", "var/lib/lidoll/auth/../../../../etc/passwd", "var/lib/lidoll-gallery-other/db", "etc/systemd/system/ssh.service"):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                migration.validate_member(tarfile.TarInfo(name))

    def test_archive_preserves_only_scoped_links(self):
        member = tarfile.TarInfo("opt/lidoll/current")
        member.type = tarfile.SYMTYPE
        member.linkname = "releases/known-release"
        migration.validate_member(member)
        member.linkname = "/etc/passwd"
        with self.assertRaises(RuntimeError):
            migration.validate_member(member)
        member.linkname = "/var/lib/lidoll-gallery/../../../etc/passwd"
        with self.assertRaises(RuntimeError):
            migration.validate_member(member)
        member.type = tarfile.LNKTYPE
        member.name = "var/lib/lidoll-gallery/copy"
        member.linkname = "var/lib/lidoll-gallery/original"
        migration.validate_member(member)
        member.linkname = "../../etc/passwd"
        with self.assertRaises(RuntimeError):
            migration.validate_member(member)

    def test_special_files_and_setuid_are_rejected(self):
        member = tarfile.TarInfo("var/lib/lidoll-gallery/unexpected")
        member.type = tarfile.FIFOTYPE
        with self.assertRaises(RuntimeError):
            migration.validate_member(member)
        member.type = tarfile.REGTYPE
        member.mode = 0o4755
        with self.assertRaises(RuntimeError):
            migration.validate_member(member)

    def test_host_identity_must_match_before_changes(self):
        with patch.object(migration, "run", return_value='[{"addr_info":[{"local":"10.1.1.23"}]}]'):
            migration.require_host("10.1.1.23")
            with self.assertRaises(RuntimeError):
                migration.require_host("10.1.1.24")

    def test_vendor_dropin_environment_is_not_flagged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "usr/lib/systemd/system/service.d"
            vendor.mkdir(parents=True)
            (vendor / "10-timeout-abort.conf").write_text("[Service]\nTimeoutStopFailureMode=abort\n")
            (vendor / "50-keep-warm.conf").write_text("# Fedora workaround\n[Service]\nEnvironment=SYSTEMD_SLEEP_FREEZE_USER_SESSIONS=0\n")
            dropins = "/usr/lib/systemd/system/service.d/10-timeout-abort.conf /usr/lib/systemd/system/service.d/50-keep-warm.conf"
            def scoped_path(value):
                return root / str(value).lstrip("/")  # Read the fake vendor files instead of the real filesystem.
            def fake_prop(environment):
                return lambda service, name: {"DropInPaths": dropins, "Environment": environment}[name]
            with patch.object(migration, "Path", side_effect=scoped_path):
                with patch.object(migration, "prop", side_effect=fake_prop("SYSTEMD_SLEEP_FREEZE_USER_SESSIONS=0")):
                    self.assertEqual(migration.admin_environment("lidoll-auth"), [])  # Fedora's global default is ignored.
                with patch.object(migration, "prop", side_effect=fake_prop('SYSTEMD_SLEEP_FREEZE_USER_SESSIONS=0 "AUTH_HOST=10.1.1.23"')):
                    self.assertEqual(migration.admin_environment("lidoll-auth"), ["AUTH_HOST=10.1.1.23"])  # A hand-added setting still stops the run.
        self.assertTrue(migration.vendor_dropin("/usr/lib/systemd/system/service.d/50-keep-warm.conf"))
        self.assertFalse(migration.vendor_dropin("/etc/systemd/system/lidoll-auth.service.d/override.conf"))
        self.assertFalse(migration.allowed("/usr/lib/systemd/system/service.d/50-keep-warm.conf"))  # Still never archived.

    def test_resume_refuses_started_or_running_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / "target-start-attempted").write_text("started")
            with patch.object(migration, "require_host"), patch.object(migration, "configure") as configure:
                with self.assertRaisesRegex(RuntimeError, "already started"):
                    migration.restore({"target": "10.1.1.24"}, {}, stage, resume=True)
                (stage / "target-start-attempted").unlink()
                with patch.object(migration, "prop", return_value="active"), self.assertRaisesRegex(RuntimeError, "not inactive"):
                    migration.restore({"target": "10.1.1.24"}, {}, stage, resume=True)
                configure.assert_not_called()

    def test_resume_detects_missing_or_truncated_members(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def scoped_path(value):
                return root / str(value).lstrip("/")  # Pretend the temp dir is the target's filesystem root.
            data = tarfile.TarInfo("var/lib/lidoll/tracker/market.sqlite")
            data.size = 10
            env = tarfile.TarInfo("etc/lidoll/auth.env")
            env.size = 50
            with patch.object(migration, "Path", side_effect=scoped_path):
                self.assertFalse(migration.extraction_complete([data, env]))  # Nothing extracted yet.
                (root / "var/lib/lidoll/tracker").mkdir(parents=True)
                (root / "var/lib/lidoll/tracker/market.sqlite").write_bytes(b"12345")
                (root / "etc/lidoll").mkdir(parents=True)
                (root / "etc/lidoll/auth.env").write_text("AUTH_HOST=10.1.1.24\n")
                self.assertFalse(migration.extraction_complete([data, env]))  # Database cut off mid-write.
                (root / "var/lib/lidoll/tracker/market.sqlite").write_bytes(b"1234567890")
                self.assertTrue(migration.extraction_complete([data, env]))  # Rewritten env file may differ in size.

    def test_backup_scaffolds_create_missing_parents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "var/lib").mkdir(parents=True)  # Fresh Fedora: no /var/backups at all.
            real_path = Path
            def scoped_path(value):
                return real_path(directory) / str(value).lstrip("/")
            with patch.object(migration, "Path", side_effect=scoped_path), patch.object(migration, "run"), patch.object(migration, "read_env", return_value={}), patch.object(migration, "rewrite_env", return_value=""), patch.object(migration.os, "chmod"):
                for env in migration.ENVS:
                    (root / env.lstrip("/")).parent.mkdir(parents=True, exist_ok=True)
                    (root / env.lstrip("/")).write_text("")
                migration.configure({"target": "10.1.1.24", "source": "10.1.1.23", "proxy": "10.1.1.20"}, {"services": [{"port": p} for p in migration.DEFAULT_PORTS]})
            self.assertTrue((root / "var/backups/lidoll").is_dir())
            self.assertTrue((root / "var/backups/lidollquest-server").is_dir())

    def test_existing_target_service_aborts(self):
        with patch.object(migration, "prop", return_value="loaded"):
            with self.assertRaises(RuntimeError):
                migration.target_empty()

    def test_integrity_mismatch_never_extracts_or_configures(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / "services.tar").write_bytes(b"changed during transfer")
            (stage / "services.sha256").write_text("0" * 64)
            with patch.object(migration, "require_host"), patch.object(migration, "target_empty"), patch.object(migration, "configure") as configure, patch.object(tarfile, "open") as open_archive:
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    migration.restore({"target": "10.1.1.24"}, {}, stage)
                configure.assert_not_called()
                open_archive.assert_not_called()

    def test_out_of_scope_bundle_is_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            archive = stage / "services.tar"
            with tarfile.open(archive, "w") as bundle:
                info = tarfile.TarInfo("etc/passwd")
                info.size = 3
                bundle.addfile(info, io.BytesIO(b"bad"))
            (stage / "services.sha256").write_text(hashlib.sha256(archive.read_bytes()).hexdigest())
            with patch.object(migration, "require_host"), patch.object(migration, "target_empty"), patch.object(tarfile.TarFile, "extractall") as extract:
                with self.assertRaises(RuntimeError):
                    migration.restore({"target": "10.1.1.24"}, {}, stage)
                extract.assert_not_called()

    def test_freeze_fences_and_stops_all_services_before_archiving(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "etc/systemd/system").mkdir(parents=True)
            stage = root / "stage"
            stage.mkdir()
            manifest = {"roots": [], "services": [], "bytes": 0}
            def scoped_path(value):
                return root / str(value).lstrip("/")
            calls = []
            with patch.object(migration, "Path", side_effect=scoped_path), patch.object(migration, "require_host"), patch.object(migration, "inventory", return_value=manifest), patch.object(migration, "run", side_effect=lambda *args, **kw: calls.append(args)), patch.object(migration, "prop", return_value="active"), patch.object(tarfile, "open") as archive:
                with self.assertRaisesRegex(RuntimeError, "did not stop"):
                    migration.freeze({"source": "10.1.1.23", "run_id": "test"}, manifest, stage)
                archive.assert_not_called()
            self.assertEqual([c[2] for c in calls if c[:2] == ("systemctl", "stop")], list(reversed(migration.SERVICES)))
            for service in migration.SERVICES:
                fence = root / f"etc/systemd/system/{service}.service.d/90-lidoll-migration-fence.conf"
                self.assertIn("ConditionPathExists=", fence.read_text())

    def test_start_requires_completed_restore(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(migration, "require_host"), patch.object(migration, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Restore verification"):
                migration.start({"target": "10.1.1.24"}, {}, Path(directory))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
