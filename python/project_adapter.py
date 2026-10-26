"""Local code work at the original BenchmarkAdapter seam; no method implementation."""
from __future__ import annotations

import difflib
import json
from pathlib import Path
import re
import tempfile
import threading

from harness2.core import context, runmark, tree
from harness2.core.spec import BenchPrompts, BenchSpec
from harness2.substrate.codex import CodexSubstrate
from codex_local import CodexChannel, CodexCLI
from project_store import IGNORED, check_inventory, copy_dependencies, copy_files, digest, files, inventory, json_bytes, relative, unlinked, write_json

DEFAULT_INSTRUCTIONS = """Work on the software request in this workspace. Inspect the relevant source,
make a focused implementation, and check it with the available tools.
Explain what changed and any checks you could not complete. Do not delegate.
Do not read external project or experiment directories.
"""

class ProjectAdapter:
    def __init__(self, root: Path, state: dict, runtime: CodexCLI):
        root = unlinked(root)
        self.root, self.state, self.runtime = root, state, runtime
        self.substrate = CodexSubstrate()
        channel = CodexChannel(runtime.model, runtime.effort, runtime.timeout)
        self.spec = BenchSpec(name="project", runs_root=root / "runs", install_mode="codex_root", prompts=BenchPrompts(work="implement a focused software change in a source checkout", domain_word="software area", yardstick="Correct behavior, a focused patch and clear evidence from the observed work.", deliverable_word="code patch", selection_checks="Read every patch and its explanation. Check whether the requested behavior is implemented and existing behavior is preserved."), channels={"proposer": channel, "selector": channel}, leak_globs=("project-grades.json", "grades/*"))
        self._tasks = {t["id"]: t for t in state["tasks"]}
        context.assert_no_grader_verdicts(root / "source")
        self.execution_count = 0
        self._count_lock = threading.Lock()
        self.base = {"AGENTS.md": DEFAULT_INSTRUCTIONS}
        for name, file in files(root / "source").items():
            if name == "AGENTS.md" or name.startswith(".agents/skills/") and tree.is_allowed(self.substrate.surface(), name):
                self.base[name] = file.read_text(encoding="utf-8")
        self.validate_tree(self.base)
        tree.validate(self.substrate.surface(), self.base, allow_subagents=False)
        base_dir = self.base_harness()
        if base_dir.exists():
            expected = {name: body.encode("utf-8") for name, body in self.base.items()}
            actual = {name: p.read_bytes().replace(b"\r\n", b"\n") for name, p in files(base_dir).items()}
            if actual != expected:
                raise ValueError("Base harness has changed; choose a new experiment output")
        else:
            tree.write_tree(self.substrate.surface(), self.base, base_dir, stubs=False)

    def tasks(self, split="all"):
        return list(self._tasks)

    def domain_of(self, task_id):
        return self._tasks[task_id]["domain"]

    def task_prompt(self, task_id):
        return self._tasks[task_id]["prompt"]

    def task_files(self, task_id):
        return self.root / "source"

    def base_harness(self):
        return self.root / "base"

    def validate_tree(self, harness):
        # Native hook commands run on the host outside workspace-write. Until a
        # hook-isolated launcher exists, fail explicitly rather than ignore them.
        if ".codex/hooks.json" in harness:
            raise ValueError("The local native adapter does not support lifecycle hooks; use the isolated original benchmark launcher for that surface")
        for name in harness:
            relative(name)
            if name in self.state["source"] and name not in self.base:
                raise ValueError(f"Harness helper would overwrite project source: {name}")
            if any(name == d or name.startswith(d + "/") for d in self.state["dependencies"]):
                raise ValueError(f"Harness cannot overwrite a dependency: {name}")

    def completed_execution(self, task_id, harness_dir, run_id):
        canonical = unlinked(self.root / "executions" / relative(run_id))
        candidates = [canonical]
        if canonical.parent.is_dir():
            pattern = re.compile(re.escape(canonical.name) + r"\.retry-[0-9a-f]{32}")
            candidates.extend(sorted(p for p in canonical.parent.iterdir() if pattern.fullmatch(p.name)))
        for candidate in candidates:
            candidate = unlinked(candidate)
            if not candidate.is_dir():
                continue
            unlinked(candidate / runmark.MARK)
            if not runmark.is_complete(candidate, harness_dir=harness_dir):
                continue
            record_path = unlinked(candidate / "artifact-identity.json")
            if not self.artifacts_intact(candidate):
                raise ValueError(f"Execution artifacts changed: {candidate}")
            record = json.loads(record_path.read_text(encoding="utf-8"))
            if runmark.read_mark(candidate).get("run_id") != run_id or record.get("run_id") != run_id or record.get("task_id") != task_id:
                raise ValueError(f"Execution identity changed: {candidate}")
            return candidate
        return None

    def execute(self, task_id, harness_dir, run_id, *, timeout=None):
        completed = self.completed_execution(task_id, harness_dir, run_id)
        if completed is not None:
            print(f"  [solver] {run_id}: reused {completed.name}", flush=True)
            return completed
        run_dir = unlinked(self.root / "executions" / relative(run_id))
        if run_dir.exists() and any(run_dir.iterdir()):
            # Preserve failed/partial attempts; a fresh directory holds each retry.
            import uuid
            run_dir = run_dir.with_name(run_dir.name + ".retry-" + uuid.uuid4().hex)
        run_dir.mkdir(parents=True)
        harness = tree.read_tree(self.substrate.surface(), harness_dir or self.base_harness())
        self.validate_tree(harness)
        with tempfile.TemporaryDirectory(prefix="harness2-project-", dir=unlinked(Path(tempfile.gettempdir()))) as directory:
            workspace = Path(directory)
            copy_files(self.root / "source", workspace)
            copy_dependencies(self.root, workspace, self.state)
            for name, body in harness.items():
                path = workspace / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body.encode("utf-8"))
            prompt = self.task_prompt(task_id) + "\n\nImplement the requested code change in this workspace. Return a concise account of the changes and checks. Do not change harness files, dependencies, or use other project/experiment directories. Do not delegate."
            with self._count_lock:
                self.execution_count += 1
            print(f"  [solver] {run_id}: starting native Codex", flush=True)
            result = self.runtime.invoke(workspace, prompt, run_dir, timeout)
            if not result["ok"]:
                raise RuntimeError(f"Codex did not complete successfully; retained logs: {run_dir}")
            for dep in self.state["dependencies"]:
                expected = {n[len(dep) + 1:]: info for n, info in self.state["dependency_files"].items() if n.startswith(dep + "/")}
                check_inventory(workspace / dep, expected)
            for name, body in harness.items():
                path = unlinked(workspace / name)
                if not path.is_file() or path.read_bytes().replace(b"\r\n", b"\n") != body.encode("utf-8").replace(b"\r\n", b"\n"):
                    raise ValueError(f"Solver changed the experimental harness: {name}")
            after = {n: p for n, p in files(workspace, ignore=IGNORED).items() if not any(n == d or n.startswith(d + "/") for d in self.state["dependencies"])}
            # Harness files are experiment inputs, separate from the code artifact.
            for name in harness:
                after.pop(name, None)
            before = {n: p for n, p in files(self.root / "source").items() if n not in harness}
            changes, patch = [], []
            for name in sorted(set(before) | set(after)):
                old = before[name].read_bytes() if name in before else None
                new = after[name].read_bytes() if name in after else None
                if old == new:
                    continue
                change = {"path": name, "deleted": new is None}
                if new is not None:
                    dest = run_dir / "artifact/files" / name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(new)
                    if name in after:
                        import shutil
                        shutil.copymode(after[name], dest)
                    change["sha256"] = digest(new)
                changes.append(change)
                try:
                    a, b = (old or b"").decode("utf-8"), (new or b"").decode("utf-8")
                    for line in difflib.unified_diff(a.splitlines(keepends=True), b.splitlines(keepends=True), fromfile=f"a/{name}" if old is not None else "/dev/null", tofile=f"b/{name}" if new is not None else "/dev/null"):
                        patch.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
                except UnicodeDecodeError:
                    patch.append(f"Binary file changed: {name} (bytes retained under artifact/files)\n")
            write_json(run_dir / "artifact/changes.json", changes)
            (run_dir / "changes.patch").write_text("".join(patch), encoding="utf-8", newline="\n")
            (run_dir / "deliverable.md").write_text(result["text"] + "\n\n# Code changes\n\n" + ("".join(patch) or "No code files changed.\n"), encoding="utf-8", newline="\n")
            record = {"task_id": task_id, "run_id": run_id, "files": inventory(run_dir / "artifact"), "answer_sha256": digest((run_dir / "answer.txt").read_bytes()), "deliverable_sha256": digest((run_dir / "deliverable.md").read_bytes()), "patch_sha256": digest((run_dir / "changes.patch").read_bytes()), "events_sha256": digest((run_dir / "events.jsonl").read_bytes())}
            write_json(run_dir / "artifact-identity.json", record)
            runmark.mark_complete(run_dir, run_id=run_id, harness_dir=harness_dir)
        return run_dir

    def artifacts_intact(self, run_dir):
        try:
            run_dir = unlinked(run_dir)
            if not run_dir.is_relative_to((self.root / "executions").absolute()):
                return False
            record = json.loads((run_dir / "artifact-identity.json").read_text(encoding="utf-8"))
            return inventory(run_dir / "artifact") == record["files"] and all(digest(unlinked(run_dir / name).read_bytes()) == record[key] for name, key in [("answer.txt", "answer_sha256"), ("deliverable.md", "deliverable_sha256"), ("changes.patch", "patch_sha256"), ("events.jsonl", "events_sha256")])
        except (OSError, ValueError, KeyError):
            return False

    def delivered(self, run_dir):
        return runmark.is_complete(run_dir, match_harness=False) and self.artifacts_intact(run_dir)

    def trajectory(self, run_dir, *, obs_trunc):
        return self.substrate.read_trajectory(run_dir / "events.jsonl", obs_trunc=obs_trunc, max_chars=2_000_000)

    def deliverable_text(self, run_dir):
        return (run_dir / "deliverable.md").read_text(encoding="utf-8")

    def deliverable_files(self, run_dir):
        return {"patch-and-notes.md": self.deliverable_text(run_dir)}

    def score(self, run_dir, task_id):
        # No judge callback is attached during the improvement process.
        raise RuntimeError("Use project judge after selection; no measurement is available to PPC")

    def materialize_artifact(self, run_dir: Path, workspace: Path):
        if not self.delivered(run_dir):
            raise ValueError("Cannot measure a missing or modified artifact")
        copy_files(self.root / "source", workspace)
        for change in json.loads((run_dir / "artifact/changes.json").read_text(encoding="utf-8")):
            name = relative(change["path"])
            dest = workspace / name
            if change["deleted"]:
                dest.unlink()
            else:
                copy_files(run_dir / "artifact/files", workspace, [name])
        copy_dependencies(self.root, workspace, self.state)
