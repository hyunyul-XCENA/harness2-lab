"""Exercise the real PPC through a subprocess CLI fixture and project artifacts."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import harness2_runner as host
from codex_local import CodexCLI, SUPPORTED_VERSION
from project_adapter import ProjectAdapter
from project_cli import judge, main as project_main, measure, report, run, summaries
from project_store import initialize, load, tasks_from, unlinked

FIXTURE = Path(__file__).parent / "fixtures/fake_codex.py"

class ProjectTests(unittest.TestCase):
    def prepare(self, directory, *, k=1, mode="both", n=2):
        project, output = Path(directory) / "project", Path(directory) / "experiment"
        project.mkdir()
        (project / "main.py").write_text("def value():\n    return 0\n", encoding="utf-8")
        (project / "tool").mkdir()
        (project / "tool/entry.js").write_text("console.log('native-node-ok');\n", encoding="utf-8")
        (project / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
        (project / "untracked.txt").write_text("private untracked work", encoding="utf-8")
        subprocess.run(["git", "init", "--quiet", str(project)], check=True)
        subprocess.run(["git", "-C", str(project), "add", "--", "main.py", "tool/entry.js", "package.json"], check=True)
        runtime = CodexCLI([sys.executable, str(FIXTURE)], "fixture", "medium", 10)
        settings = {"executable": sys.executable, "version": SUPPORTED_VERSION, "model": "fixture", "effort": "medium", "timeout": 10}
        tasks = [{"id": f"change-{i}", "domain": "coding", "prompt": "Change main.py value() to return 42."} for i in range(n)]
        state = initialize(output, project, tasks, settings, [], k, mode, host.PIN)
        return project, output, state, runtime

    def test_real_core_native_fixture_artifacts_history_resume_and_external_measurement(self):
        with tempfile.TemporaryDirectory() as directory:
            project, root, state, runtime = self.prepare(directory)
            self.assertEqual(run(root, state, runtime), 0)
            result = json.loads((root / "project-run.json").read_text(encoding="utf-8"))
            self.assertEqual((result["execution_count"], result["editor_calls"]), (14, 16))
            rows = list(summaries(root, state))
            self.assertEqual(result["domains"][0]["tasks"][1]["library_entries_before"], {"agg": 1, "seq": 1})
            adapter = ProjectAdapter(root, state, runtime)
            for _, summary in rows:
                for mode in ("agg", "seq"):
                    self.assertEqual(summary["modes"][mode]["ledger"]["R"], 4)
                    self.assertEqual(summary["modes"][mode]["ledger"]["P"], 3)
                    choice = summary["selections"][mode]
                    self.assertTrue(choice["trivial"])
                    chosen = Path(choice["chosen_run_dir"])
                    self.assertIn("return 42", adapter.deliverable_text(chosen))
                    self.assertTrue(adapter.artifacts_intact(chosen))
                    with tempfile.TemporaryDirectory() as work:
                        adapter.materialize_artifact(chosen, Path(work))
                        self.assertIn("return 42", (Path(work) / "main.py").read_text())
                        self.assertFalse((Path(work) / "AGENTS.md").exists())
            self.assertFalse((root / "source/untracked.txt").exists())
            self.assertIn("return 0", (project / "main.py").read_text())
            self.assertEqual(run(root, load(root, host.PIN), runtime), 0)
            resumed = json.loads((root / "project-run.json").read_text(encoding="utf-8"))
            self.assertEqual((resumed["execution_count"], resumed["editor_calls"]), (0, 0))
            commands = [[sys.executable, "-c", "from main import value; assert value() == 42"]]
            self.assertEqual(judge(root, state, runtime, commands, 10), 0)
            measured = json.loads((root / "project-grades.json").read_text(encoding="utf-8"))["rows"]
            self.assertEqual(len(measured), 6)
            self.assertEqual(sum(r["mode"] == "reference" for r in measured), 2)
            self.assertTrue(all(r["n_passed"] == (0 if r["mode"] == "reference" else 1) for r in measured))
            for path in (root / "runs").rglob("context"):
                self.assertFalse(list(path.rglob("project-grades.json")))
            # Measurements never enter a resumed improvement session.
            self.assertEqual(run(root, load(root, host.PIN), runtime), 0)
            self.assertEqual(json.loads((root / "project-run.json").read_text())["editor_calls"], 0)
            chosen = Path(rows[0][1]["selections"]["agg"]["chosen_run_dir"])
            (chosen / "changes.patch").write_text("tampered")
            self.assertFalse(adapter.delivered(chosen))
            with self.assertRaisesRegex(ValueError, "changed since measurement"):
                report(root, state)
            with self.assertRaisesRegex(ValueError, "changed"):
                adapter.execute("change-0", root / "runs/project-cx-agg1/change-0/harnesses/agg1", rows[0][1]["selections"]["agg"]["chosen_run_id"])

    def test_k2_final_only_selection_with_native_proposer_and_selector(self):
        with tempfile.TemporaryDirectory() as directory:
            _, root, state, runtime = self.prepare(directory, k=2, n=1)
            self.assertEqual(run(root, state, runtime), 0)
            result = json.loads((root / "project-run.json").read_text())
            self.assertEqual((result["execution_count"], result["editor_calls"]), (14, 16))
            for _, summary in summaries(root, state):
                for mode in ("agg", "seq"):
                    choice = summary["selections"][mode]
                    self.assertEqual(choice["n_candidates"], 2)
                    self.assertFalse(choice["trivial"])
                    self.assertFalse(choice["chosen_is_base"])
                    self.assertTrue(all(label.startswith("agg" if mode == "agg" else "c") for label in choice["id_map"].values()))

    def test_completed_retry_resumes_without_model_calls_and_preserves_failures(self):
        for edited in [False, True]:
            with self.subTest(edited=edited), tempfile.TemporaryDirectory() as directory:
                _, root, state, runtime = self.prepare(directory, n=1)
                adapter = ProjectAdapter(root, state, runtime)
                harness = None
                if edited:
                    harness = root / "edited-harness"
                    harness.mkdir()
                    (harness / "AGENTS.md").write_text(adapter.base["AGENTS.md"] + "\nInspect failures before editing.\n", encoding="utf-8")
                run_id = "project-cx-agg1/change-0/base1"
                failed = CodexCLI([sys.executable, str(FIXTURE)], "fixture-failure", "medium", 10)
                with self.assertRaisesRegex(RuntimeError, "did not complete"):
                    ProjectAdapter(root, state, failed).execute("change-0", harness, run_id)
                canonical = root / "executions" / run_id
                failed_events = (canonical / "events.jsonl").read_bytes()
                completed = adapter.execute("change-0", harness, run_id)
                self.assertTrue(completed.name.startswith("base1.retry-"))
                partial = canonical.with_name(canonical.name + ".retry-" + "f" * 32)
                partial.mkdir(exist_ok=True)
                (partial / "events.jsonl").write_text("partial", encoding="utf-8")
                resumed = ProjectAdapter(root, state, runtime)
                with patch.object(runtime, "invoke", side_effect=AssertionError("completed retry must not call a model")):
                    self.assertEqual(resumed.execute("change-0", harness, run_id), completed)
                self.assertEqual(resumed.execution_count, 0)
                self.assertEqual((canonical / "events.jsonl").read_bytes(), failed_events)
                self.assertEqual((partial / "events.jsonl").read_text(), "partial")
                identity = completed / "artifact-identity.json"
                original = identity.read_text(encoding="utf-8")
                for field in ["task_id", "run_id"]:
                    record = json.loads(original)
                    record[field] = "another-execution"
                    identity.write_text(json.dumps(record), encoding="utf-8")
                    with patch.object(runtime, "invoke", side_effect=AssertionError("invalid identity must fail before model calls")), self.assertRaisesRegex(ValueError, "identity changed"):
                        resumed.execute("change-0", harness, run_id)
                identity.write_text(original, encoding="utf-8")
                (completed / "changes.patch").write_text("tampered", encoding="utf-8")
                with patch.object(runtime, "invoke", side_effect=AssertionError("tampered retry must fail before model calls")), self.assertRaisesRegex(ValueError, "artifacts changed"):
                    resumed.execute("change-0", harness, run_id)

    def test_completed_retry_from_different_harness_is_not_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            _, root, state, runtime = self.prepare(directory, n=1)
            adapter = ProjectAdapter(root, state, runtime)
            harness = root / "edited-harness"
            harness.mkdir()
            instructions = harness / "AGENTS.md"
            instructions.write_text(adapter.base["AGENTS.md"], encoding="utf-8")
            run_id = "project-cx-agg1/change-0/probe1"
            canonical = root / "executions" / run_id
            canonical.mkdir(parents=True)
            (canonical / "events.jsonl").write_text("interrupted", encoding="utf-8")
            first = adapter.execute("change-0", harness, run_id)
            instructions.write_text(adapter.base["AGENTS.md"] + "\nInspect failures before editing.\n", encoding="utf-8")
            second = adapter.execute("change-0", harness, run_id)
            self.assertNotEqual(first, second)
            self.assertEqual(adapter.execution_count, 2)
            self.assertTrue(adapter.delivered(first))
            self.assertTrue(adapter.delivered(second))
            with patch.object(runtime, "invoke", side_effect=AssertionError("matching retry must be reused")):
                self.assertEqual(adapter.execute("change-0", harness, run_id), second)

    def test_sequential_only_summary_and_external_comparison(self):
        with tempfile.TemporaryDirectory() as directory:
            _, root, state, runtime = self.prepare(directory, mode="sequential", n=1)
            self.assertEqual(run(root, state, runtime), 0)
            self.assertEqual(len(list(summaries(root, state))), 1)
            self.assertEqual(judge(root, state, runtime, [[sys.executable, "-c", "from main import value; assert value() == 42"]], 10), 0)
            rows = json.loads((root / "project-grades.json").read_text())["rows"]
            self.assertEqual([(r["mode"], r["n_passed"]) for r in rows], [("reference", 0), ("seq", 1)])

    def test_snapshot_configuration_and_output_ownership_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            project, root, state, runtime = self.prepare(directory)
            incomplete = Path(directory) / "incomplete"
            incomplete.mkdir()
            (incomplete / ".runner-project.init").write_text("interrupted")
            with self.assertRaisesRegex(ValueError, "incomplete"):
                project_main(["check", "--output", str(incomplete)], host.PIN)
            self.assertFalse((incomplete / ".runner.lock").exists())
            with self.assertRaisesRegex(ValueError, "new or empty"):
                initialize(root, project, state["tasks"], state["runtime"], [], 1, "both", host.PIN)
            data = json.loads((root / "project.json").read_text())
            data["runtime"]["model"] = "changed"
            (root / "project.json").write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "configuration changed"):
                load(root, host.PIN)
            (root / "project.json").write_text(json.dumps(state))
            (root / "source/main.py").write_text("changed")
            with self.assertRaisesRegex(ValueError, "Snapshot changed"):
                load(root, host.PIN)

    def test_native_transport_requires_completion_and_kills_timeout_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            failed = CodexCLI([sys.executable, str(FIXTURE)], "fixture-failure", "medium", 10)
            self.assertFalse(failed.invoke(root, "fixture", root / "failure")["ok"])
            timed = CodexCLI([sys.executable, str(FIXTURE)], "fixture-timeout", "medium", 0.5)
            with patch.dict(os.environ, {"HARNESS2_FIXTURE_TIMEOUT_MARKER": str(root / "timeout-escaped.txt")}):
                result = timed.invoke(root, "fixture", root / "timeout")
            self.assertTrue(result["timed_out"])
            self.assertFalse(result["ok"])
            time.sleep(1.6)
            self.assertFalse((root / "timeout-escaped.txt").exists())
            argv = json.loads((root / "failure/events.jsonl").read_text().splitlines()[0])["argv"]
            self.assertIn("--ignore-user-config", argv)
            self.assertIn("--ephemeral", argv)
            self.assertEqual(argv[argv.index("--sandbox") + 1], "workspace-write")
            self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", argv)
            if os.name == "nt":
                self.assertIn('windows.sandbox="mxc"', argv)
            else:
                self.assertNotIn('windows.sandbox="mxc"', argv)
            self.assertFalse(argv[argv.index("-C") + 1].startswith("\\\\?\\"))
            self.assertFalse(argv[argv.index("--output-last-message") + 1].startswith("\\\\?\\"))

    def test_native_transport_accepts_only_retries_followed_by_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for variant in ["recovered", "unfinished", "failed", "unknown", "late"]:
                with self.subTest(variant=variant):
                    runtime = CodexCLI([sys.executable, str(FIXTURE)], "fixture-event-" + variant, "medium", 10)
                    result = runtime.invoke(root, "fixture", root / variant)
                    self.assertEqual(result["ok"], variant == "recovered")
                    self.assertEqual(result["recovered_transport_errors"], int(variant == "recovered"))

    @unittest.skipUnless(os.name == "nt", "Windows sandbox startup check")
    def test_windows_preflight_rejects_before_any_model_session(self):
        with tempfile.TemporaryDirectory() as directory:
            _, root, state, runtime = self.prepare(directory, n=1)
            self.assertEqual(runtime.preflight()["model_calls"], 0)
            with patch.dict(os.environ, {"HARNESS2_FIXTURE_PREFLIGHT_FAILURE": "1"}):
                with self.assertRaisesRegex(RuntimeError, "before model calls"):
                    run(root, state, runtime)
            self.assertFalse((root / "executions").exists())
            self.assertFalse((root / "audit").exists())

    @unittest.skipUnless(os.name == "nt", "Windows sandbox startup timeout")
    def test_windows_preflight_timeout_kills_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            _, root, _, runtime = self.prepare(directory, n=1)
            marker = root / "preflight-escaped.txt"
            with patch.dict(os.environ, {"HARNESS2_FIXTURE_PREFLIGHT_TIMEOUT_MARKER": str(marker)}), patch("codex_local.PREFLIGHT_TIMEOUT", 0.5):
                with self.assertRaisesRegex(RuntimeError, "startup timed out"):
                    runtime.preflight()
            time.sleep(1.6)
            self.assertFalse(marker.exists(), "preflight descendant survived the timeout")

    def test_native_node_entry_script_runs_in_measurement_workspace(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node 24 is a host prerequisite")
        with tempfile.TemporaryDirectory(prefix="h2node-", dir=unlinked(Path(tempfile.gettempdir()))) as directory:
            _, root, state, runtime = self.prepare(directory, n=1)
            adapter = ProjectAdapter(root, state, runtime)
            run_dir = adapter.execute("change-0", None, "project-cx-agg1/change-0/base1")
            measured = measure(adapter, run_dir, [[node, "tool/entry.js"]], root / "node-check", 10)
            self.assertTrue(measured["all_pass"])
            self.assertIn("native-node-ok", (root / "node-check/0.stdout.txt").read_text())

    def test_dependency_snapshot_and_local_harness_constraints(self):
        with tempfile.TemporaryDirectory() as directory:
            project, _, old_state, runtime = self.prepare(directory)
            dep = project / "deps"
            dep.mkdir()
            (dep / "lib.txt").write_text("frozen library")
            subprocess.run(["git", "-C", str(project), "add", "deps"], check=True)
            root = Path(directory) / "with-deps"
            state = initialize(root, project, old_state["tasks"], old_state["runtime"], ["deps"], 1, "parallel", host.PIN)
            self.assertNotIn("deps/lib.txt", state["source"])
            adapter = ProjectAdapter(root, state, runtime)
            for candidate, message in [({"AGENTS.md": "base", ".codex/hooks.json": "{}"}, "hooks"), ({"AGENTS.md": "base", "main.py": "replacement"}, "overwrite project"), ({"AGENTS.md": "base", "deps/lib.txt": "replacement"}, "dependency")]:
                with self.assertRaisesRegex(ValueError, message):
                    adapter.validate_tree(candidate)
            (root / "dependencies/deps/lib.txt").write_text("changed dependency")
            with self.assertRaisesRegex(ValueError, "Snapshot changed"):
                load(root, host.PIN)

    def test_task_input_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tasks.json"
            for value in [{"tasks": []}, {"tasks": [{"id": "../escape", "domain": "x", "prompt": "work"}]}, {"tasks": [{"id": "a", "domain": "x", "prompt": "work"}] * 2}]:
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    tasks_from(path)

    @unittest.skipUnless(os.name == "nt", "Win32 long-path regression")
    def test_windows_long_output_dependencies_and_artifacts_without_global_settings(self):
        # An extended temp root also lets TemporaryDirectory clean up long paths
        # without depending on the host's LongPathsEnabled registry value.
        with tempfile.TemporaryDirectory(prefix="h2long-", dir=unlinked(Path(tempfile.gettempdir()))) as directory:
            project, _, original, runtime = self.prepare(directory, n=1)
            dep = project / "deps" / ("d" * 90)
            dep.mkdir(parents=True)
            (dep / ("f" * 90 + ".txt")).write_text("dependency bytes", encoding="utf-8")
            root = Path(directory) / ("o" * 85) / ("p" * 65)
            state = initialize(root, project, original["tasks"], original["runtime"], ["deps"], 1, "parallel", host.PIN)
            self.assertGreater(len(str(root / "dependencies/deps" / dep.name / ("f" * 90 + ".txt"))), 260)
            self.assertEqual(load(root, host.PIN), state)
            adapter = ProjectAdapter(root, state, runtime)
            run_dir = adapter.execute("change-0", None, "project-cx-agg1/change-0/base1")
            self.assertTrue(adapter.delivered(run_dir))
            self.assertGreater(len(str(run_dir / "artifact-identity.json")), 260)
            with tempfile.TemporaryDirectory(prefix="h2restore-", dir=unlinked(Path(tempfile.gettempdir()))) as restored:
                adapter.materialize_artifact(run_dir, Path(restored))
                self.assertEqual((Path(restored) / "deps" / dep.name / ("f" * 90 + ".txt")).read_text(), "dependency bytes")

if __name__ == "__main__":
    unittest.main()
