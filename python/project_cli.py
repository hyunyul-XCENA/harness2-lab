"""Project prepare/run/judge/report commands around the pinned original method."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from harness2.core import _filelock
from harness2.core.schedule import Namespace, mode_token, run_sweep
from codex_local import CodexCLI, CodexProposer, resolve_runtime, stop_tree
from project_adapter import ProjectAdapter
from project_store import digest, initialize, json_bytes, load, relative, tasks_from, unlinked, write_json

def modes_of(state):
    return ("agg", "seq") if state["mode"] == "both" else (mode_token(state["mode"]),)

def summaries(root, state):
    for task in state["tasks"]:
        # Upstream always stores the merged task summary in the agg namespace,
        # including when the requested execution mode is sequential only.
        path = Namespace("project", "cx", "agg", state["k"]).task_dir(root / "runs", task["id"]) / "summary.json"
        if path.is_file():
            yield task["id"], json.loads(path.read_text(encoding="utf-8"))

def run(root: Path, state: dict, runtime: CodexCLI):
    if runtime.version() != state["runtime"]["version"]:
        raise ValueError("Codex version changed; prepare a new experiment with the supported version")
    adapter = ProjectAdapter(root, state, runtime)
    proposer = CodexProposer(runtime, root / "audit")
    print(f"Original PPC | native Codex local adapter | model={runtime.model} | k={state['k']} | {state['mode']}", flush=True)
    result = run_sweep(state["k"], adapter=adapter, prop=proposer, runs_root=adapter.spec.runs_root, library_root=root / "library", modes=modes_of(state), selector_prop=proposer)
    result["execution_count"] = adapter.execution_count
    result["editor_calls"] = sum(r.attempts for r in proposer._calls if not r.cached)
    result["billing"] = "Native CLI usage; USD cost is not reported (ledger zero is not a free run)."
    write_json(root / "project-run.json", result)
    for tid, summary in summaries(root, state):
        fallbacks = sum(len(m.get("fell_back", [])) for m in summary.get("modes", {}).values())
        if fallbacks:
            print(f"  {tid}: {fallbacks} editing stages fell back; inspect summary.json for errors", flush=True)
        for mode, choice in summary.get("selections", {}).items():
            if choice.get("ok"):
                print(f"  {tid} / {mode}: {choice['chosen_label']} -> {Path(choice['chosen_run_dir']) / 'changes.patch'}", flush=True)
    failed = sum(d.get("failed", 1 if d.get("error") else 0) for d in result["domains"])
    print(f"Task executions: {adapter.execution_count} | model editor calls: {result['editor_calls']} | failed tasks: {failed}\nArtifacts: {root}", flush=True)
    return int(failed > 0)

def parse_commands(values):
    commands = []
    for value in values:
        command = json.loads(value)
        if not isinstance(command, list) or not command or any(not isinstance(v, str) or not v or "\0" in v for v in command):
            raise ValueError("--command-json needs a nonempty argv array of strings")
        binary = shutil.which(command[0])
        if not binary or Path(binary).suffix.lower() in {".cmd", ".bat", ".ps1"}:
            raise ValueError("Measurement commands must name native executables; use node/python directly instead of npm.cmd")
        commands.append([binary, *command[1:]])
    return commands

def measure(adapter, run_dir, commands, output, timeout):
    records = []
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="harness2-measure-") as directory:
        workspace = Path(directory)
        adapter.materialize_artifact(run_dir, workspace)
        for i, command in enumerate(commands):
            started, expired = time.monotonic(), False
            with (output / f"{i}.stdout.txt").open("wb") as stdout, (output / f"{i}.stderr.txt").open("wb") as stderr:
                process = subprocess.Popen(command, cwd=workspace, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0, start_new_session=os.name != "nt")
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    expired = True
                    stop_tree(process)
                    process.wait(timeout=15)
            records.append({"argv": command, "exit_code": process.returncode, "timed_out": expired, "wall_s": round(time.monotonic() - started, 3)})
            if process.returncode != 0 or expired:
                break
    return {"n_passed": sum(r["exit_code"] == 0 and not r["timed_out"] for r in records), "n_criteria": len(commands), "all_pass": len(records) == len(commands) and all(r["exit_code"] == 0 and not r["timed_out"] for r in records), "commands": records}

def measurement_identity(root, state, adapter):
    records = []
    for tid, summary in summaries(root, state):
        entries = [b["run_dir"] for b in summary.get("base", [])]
        entries += [s["chosen_run_dir"] for m, s in summary.get("selections", {}).items() if m in modes_of(state) and s.get("ok")]
        artifacts = []
        for directory in entries:
            run_dir = Path(directory)
            artifacts.append({"run_dir": directory, "intact": adapter.delivered(run_dir), "identity": digest((run_dir / "artifact-identity.json").read_bytes()) if adapter.delivered(run_dir) else None})
        records.append({"task_id": tid, "summary": digest(json_bytes(summary)), "artifacts": artifacts})
    return digest(json_bytes({"config": state, "records": records}))

def judge(root, state, runtime, commands, timeout):
    # The judging module is loaded only by this separate post-selection command.
    from harness2.core.judge import judge_one
    adapter = ProjectAdapter(root, state, runtime)
    rows = []
    plan = digest(json_bytes(commands))[:16]
    completed = list(summaries(root, state))
    if {tid for tid, _ in completed} != {t["id"] for t in state["tasks"]}:
        raise ValueError("Some task selections are missing; finish project run before measurement")
    for tid, summary in completed:
        if summary.get("status") != "ok" or not all(summary.get("selections", {}).get(m, {}).get("ok") for m in modes_of(state)):
            raise ValueError(f"Task selection is incomplete: {tid}")
        candidates = [("reference", b["label"], b["run_id"], b["run_dir"]) for b in summary["base"]]
        candidates += [(m, c["chosen_label"], c["chosen_run_id"], c["chosen_run_dir"]) for m, c in summary["selections"].items() if m in modes_of(state)]
        for mode, label, rid, directory in candidates:
            output = root / "grades" / plan / tid / mode / label
            class Measurement:
                def score(self, run_dir, task_id):
                    return measure(adapter, run_dir, commands, output, timeout)
            scored = judge_one(Measurement(), tid, mode, state["k"], label, rid, Path(directory), chosen_is_base=mode == "reference")
            rows.append(scored.__dict__ | {"graded": scored.graded, "frac": scored.frac, "logs": str(output)})
    if not rows:
        raise ValueError("No completed selections to measure; run project run first")
    write_json(root / "project-grades.json", {"command_plan": commands, "rows": rows, "measurement_identity": measurement_identity(root, state, adapter)})
    report(root, state)
    return int(any(not r["graded"] for r in rows))

def report(root, state):
    path = root / "project-grades.json"
    if not path.is_file():
        raise ValueError("No external measurements yet; run project judge after project run")
    data = json.loads(path.read_text(encoding="utf-8"))
    adapter = ProjectAdapter(root, state, CodexCLI.configured(state))
    if data.get("measurement_identity") != measurement_identity(root, state, adapter):
        raise ValueError("Selections or artifacts changed since measurement; run project judge again")
    print("External checks after selection (not feedback to PPC):")
    for row in data["rows"]:
        status = f"{row['n_passed']}/{row['n_criteria']} commands passed" if row["graded"] else "measurement failed: " + row["error"]
        print(f"  {row['task_id']} / {row['mode']} / {row['label']}: {status}")
    print(f"Full results: {path}\nThese checks measure the supplied commands; they do not establish general model improvement.")

def main(arguments, pin):
    parser = argparse.ArgumentParser(description="Run original PPC on isolated local project snapshots with native Codex")
    sub = parser.add_subparsers(dest="action", required=True)
    prepare = sub.add_parser("init", help="freeze tracked source, task order, dependencies and model settings; no model calls")
    prepare.add_argument("--project", type=Path, required=True)
    prepare.add_argument("--tasks", type=Path, required=True)
    prepare.add_argument("--model", required=True)
    prepare.add_argument("--codex-path", default="codex")
    prepare.add_argument("--effort", choices=("low", "medium", "high", "xhigh"), default="medium")
    prepare.add_argument("--timeout", type=int, default=1200)
    prepare.add_argument("--deps", action="append", default=[], help="relative dependency directory to copy separately from task source (repeatable)")
    prepare.add_argument("--k", type=int, default=1)
    prepare.add_argument("--mode", choices=("parallel", "sequential", "both"), default="parallel")
    for command in [prepare, sub.add_parser("check"), sub.add_parser("run"), sub.add_parser("report")]:
        command.add_argument("--output", type=Path, required=True)
    grade = sub.add_parser("judge", help="measure references and selected artifacts, after selection only")
    grade.add_argument("--output", type=Path, required=True)
    grade.add_argument("--command-json", action="append", required=True, help='native argv, e.g. ["node","node_modules/typescript/bin/tsc","-p","tsconfig.json"]')
    grade.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args(arguments)
    root = unlinked(args.output)
    if args.action == "init":
        if args.k < 1 or args.timeout < 1:
            parser.error("--k and --timeout must be positive")
        runtime = resolve_runtime(args.codex_path, args.model, args.effort, args.timeout)
        state = initialize(root, args.project, tasks_from(args.tasks), runtime, args.deps, args.k, args.mode, pin)
        ProjectAdapter(root, state, CodexCLI.configured(state))
        print(f"Prepared {len(state['tasks'])} task(s), {len(state['source'])} tracked source files. No model calls.\nConfig: {root / 'project.json'}")
    else:
        # One experiment writer across run, judge, report and check. This protects
        # original library rebuilding and keeps measurements out of a live run.
        if not root.is_dir():
            raise ValueError("Project experiment output is missing; run project init first")
        with unlinked(root / ".runner.lock").open("a+b") as lease:
            _filelock.flock(lease, _filelock.LOCK_EX)
            try:
                state = load(root, pin)
                runtime = CodexCLI.configured(state)
                if args.action == "run":
                    return run(root, state, runtime)
                if args.action == "judge":
                    if args.timeout < 1:
                        parser.error("--timeout must be positive")
                    return judge(root, state, runtime, parse_commands(args.command_json), args.timeout)
                if args.action == "report":
                    report(root, state)
                else:
                    if runtime.version() != state["runtime"]["version"]:
                        raise ValueError("Codex version differs from the frozen experiment")
                    count, k, modes = len(state["tasks"]), state["k"], modes_of(state)
                    rolls = (4 * k if len(modes) == 1 else 7 * k) * count
                    editors = (3 * k + 1 + int(k > 1)) * len(modes) * count
                    print(f"Snapshot verified | {count} tasks | k={k} | {state['mode']}\nPlanned task executions: {rolls}; editor/selection/reflection sessions: {editors} before retries.\nModel: {runtime.model}; {state['runtime']['version']}; native login required.\nNo model calls. Source and output are local; run starts real model sessions.")
            finally:
                _filelock.flock(lease, _filelock.LOCK_UN)
    return 0
