"""Host/portability checks; original method regressions live in upstream tests."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import harness2_runner as host
from harness2.core import _filelock, tree
from harness2.substrate.opencode import OpencodeSubstrate

class HostTests(unittest.TestCase):
    def test_vendor_identity_and_drift_fail_before_execution(self):
        self.assertEqual(host.verify_vendor()["commit"], host.PIN)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "PROVENANCE.json").write_text(json.dumps({"commit": host.PIN, "repository": "https://github.com/google-research/harness2", "files": {"bad.py": {"sha256": "0" * 64}}}), encoding="utf-8")
            (root / "bad.py").write_text("raise RuntimeError('must never execute')", encoding="utf-8")
            with patch.object(host, "VENDOR", root), self.assertRaisesRegex(RuntimeError, "source drift"):
                host.verify_vendor()

    def test_demo_refuses_project_files_and_changed_resume_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "user.txt").write_text("keep me", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "nonempty"):
                host.prepare_demo(root, 1, "both")
            self.assertEqual((root / "user.txt").read_text(), "keep me")
            owned = host.prepare_demo(root / "owned", 1, "both")
            self.assertEqual(host.prepare_demo(owned, 1, "both"), owned)
            with self.assertRaisesRegex(ValueError, "another configuration"):
                host.prepare_demo(owned, 2, "both")

    def test_tree_uses_portable_keys_and_resets_noneditable_stubs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            surface = OpencodeSubstrate().surface()
            harness = {"systemprompt.md": "base", "scripts/summarize.py": "print(1)\n"}
            tree.write_tree(surface, harness, root)
            (root / "skills/README.md").write_text("stale stub", encoding="utf-8")
            tree.write_tree(surface, harness, root)
            self.assertNotEqual((root / "skills/README.md").read_text(), "stale stub")
            rejected: list[str] = []
            actual = tree.read_tree(surface, root, rejected=rejected)
            self.assertEqual(rejected, [])
            self.assertIn("scripts/summarize.py", actual)
            self.assertTrue(all("\\" not in name for name in actual))

    def test_exclusive_file_lock_serializes_separate_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "summary.lock"
            with lock.open("a+b") as lease:
                _filelock.flock(lease, _filelock.LOCK_EX)
                code = "import sys; from pathlib import Path; from harness2.core import _filelock; print('started',flush=True); f=Path(sys.argv[1]).open('a+b'); _filelock.flock(f,_filelock.LOCK_EX); print('acquired',flush=True); _filelock.flock(f,_filelock.LOCK_UN)"
                child = subprocess.Popen([sys.executable, "-X", "utf8", "-c", code, str(lock)], env={**__import__('os').environ, "PYTHONPATH": str(host.VENDOR)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertEqual(child.stdout.readline().strip(), "started")
                    with self.assertRaises(subprocess.TimeoutExpired):
                        child.wait(timeout=0.15)
                    _filelock.flock(lease, _filelock.LOCK_UN)
                    out, err = child.communicate(timeout=5)
                    self.assertEqual((child.returncode, out.strip(), err.strip()), (0, "acquired", ""))
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.communicate()

    def test_atomic_replace_keeps_original_if_replacement_is_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "summary.json"
            target.write_text("original", encoding="utf-8")
            with self.assertRaises(FileNotFoundError):
                _filelock.replace(target.with_suffix(".missing"), target)
            self.assertEqual(target.read_text(), "original")

    def test_atomic_replace_retries_only_bounded_windows_sharing_errors(self):
        transient = PermissionError("temporarily open")
        transient.winerror = 32
        replace = Mock(side_effect=[transient, None])
        with patch.object(_filelock, "os", SimpleNamespace(name="nt", replace=replace)), patch.object(_filelock.time, "sleep") as sleep:
            _filelock.replace("source", "target")
            self.assertEqual(replace.call_count, 2)
            sleep.assert_called_once()
        replace = Mock(side_effect=transient)
        with patch.object(_filelock, "os", SimpleNamespace(name="nt", replace=replace)), patch.object(_filelock.time, "sleep"):
            with self.assertRaises(PermissionError):
                _filelock.replace("source", "target")
            self.assertEqual(replace.call_count, 21)

if __name__ == "__main__":
    unittest.main()
