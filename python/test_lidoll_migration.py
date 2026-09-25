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
