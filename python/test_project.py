"""Exercise the real PPC through a subprocess CLI fixture and project artifacts."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import harness2_runner as host
from codex_local import CodexCLI, SUPPORTED_VERSION
from project_adapter import ProjectAdapter
from project_cli import judge, report, run, summaries
from project_store import initialize, load, tasks_from

FIXTURE = Path(__file__).parent / "fixtures/fake_codex.py"

class ProjectTests(unittest.TestCase):
    def prepare(self, directory, *, k=1, mode="both", n=2):
        project, output = Path(directory) / "project", Path(directory) / "experiment"
        project.mkdir()
        (project / "main.py").write_text("def value():\n    return 0\n", encoding="utf-8")
        (project / "untracked.txt").write_text("private untracked work", encoding="utf-8")
        subprocess.run(["git", "init", "--quiet", str(project)], check=True)
        subprocess.run(["git", "-C", str(project), "add", "--", "main.py"], check=True)
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
            result = timed.invoke(root, "fixture", root / "timeout")
            self.assertTrue(result["timed_out"])
            self.assertFalse(result["ok"])
            time.sleep(1.6)
            self.assertFalse((root / "timeout/child-escaped.txt").exists())
            argv = json.loads((root / "failure/events.jsonl").read_text().splitlines()[0])["argv"]
            self.assertIn("--ignore-user-config", argv)
            self.assertIn("--ephemeral", argv)
            self.assertEqual(argv[argv.index("--sandbox") + 1], "workspace-write")
            self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", argv)

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

if __name__ == "__main__":
    unittest.main()
