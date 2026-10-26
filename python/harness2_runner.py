"""Thin host for the pinned original Harness² implementation, not a new optimizer."""
from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
import uuid

PIN = "1cfe254e8d25b15f37048c3730134686abe60335"
ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "harness2"
MODULES = {"run": "run_sweep", "judge": "judge", "report": "report", "setup": "setup", "check": "check"}

def verify_vendor() -> dict:
    manifest = json.loads((VENDOR / "PROVENANCE.json").read_text(encoding="utf-8"))
    if manifest["commit"] != PIN or manifest["repository"] != "https://github.com/google-research/harness2":
        raise RuntimeError("Unexpected upstream identity")
    for name, expected in manifest["files"].items():
        file = VENDOR / name
        if file.is_symlink() or not file.is_file():
            raise RuntimeError(f"Missing or linked upstream file: {name}")
        digest = hashlib.sha256(file.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
        if digest != expected["sha256"]:
            raise RuntimeError(f"Upstream source drift: {name}; restore vendor files before running")
    return manifest

def safe_path(path: Path) -> Path:
    path = path.expanduser().absolute()
    for part in [path, *path.parents]:
        if part.is_symlink() or part.is_junction():
            raise ValueError(f"Linked output paths are not supported: {part}")
    return path

def prepare_demo(root: Path, k: int, mode: str) -> Path:
    root = safe_path(root)
    marker = root / ".runner-harness2-demo.json"
    identity = {"upstream": PIN, "k": k, "mode": mode, "kind": "model-free-upstream-demo"}
    if root.exists():
        if not root.is_dir():
            raise ValueError("Demo output must be a directory")
        if marker.exists():
            if marker.is_symlink() or json.loads(marker.read_text(encoding="utf-8")) != identity:
                raise ValueError("Demo output belongs to another configuration; choose a new --output")
            for item in root.rglob("*"):
                if item.is_symlink() or item.is_junction():
                    raise ValueError(f"Linked demo content is not supported: {item}")
        elif any(root.iterdir()):
            raise ValueError("Refusing to use a nonempty directory without a demo ownership marker")
    root.mkdir(parents=True, exist_ok=True)
    try:
        with marker.open("x", encoding="utf-8") as output:
            output.write(json.dumps(identity, indent=2) + "\n")
    except FileExistsError:
        if json.loads(marker.read_text(encoding="utf-8")) != identity:
            raise ValueError("Demo output configuration changed")
    return root

def demo(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run the original deterministic PPC demo; no model service is called.")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--k", type=int, default=1)
    parser.add_argument("--mode", choices=("parallel", "sequential", "both"), default="both")
    args = parser.parse_args(arguments)
    if args.k < 1:
        parser.error("--k must be positive")
    root = prepare_demo(args.output or ROOT / ".terminal-runner" / "harness2" / f"demo-{uuid.uuid4()}", args.k, args.mode)
    from harness2.cli.demo import main as upstream_demo
    from harness2.core import _filelock
    # Upstream protects individual summaries. This lease also serializes the host's
    # whole demo stream so simultaneous resumes cannot rebuild a shared library.
    with (root / ".runner.lock").open("a+b") as lease:
        _filelock.flock(lease, _filelock.LOCK_EX)
        try:
            print(f"Harness² upstream {PIN} | deterministic demo | k={args.k} | {args.mode}", flush=True)
            code = upstream_demo(["--output", str(root), "--k", str(args.k), "--mode", args.mode])
            result = json.loads((root / "demo.json").read_text(encoding="utf-8"))
            for row in result["tasks"]:
                summary_path = root / "runs" / f"demo-oc-agg{args.k}" / row["task"] / "summary.json"
                if not summary_path.is_file():
                    continue
                summary = json.loads(summary_path.read_text(encoding="utf-8"))
                for mode, selected in summary.get("selections", {}).items():
                    if not selected.get("ok") or not selected.get("chosen_run_dir"):
                        continue
                    answer = Path(selected["chosen_run_dir"]) / "answer.txt"
                    if answer.is_file():
                        print(f"  {row['task']} / {mode}: {selected['chosen_label']} → {answer.read_text(encoding='utf-8').strip()}", flush=True)
            print(f"Task executions: {result['execution_count']} | editor calls: {result['editor_calls']} (scripted, not LLM improvement)", flush=True)
            print(f"Artifacts: {root}", flush=True)
            return code
        finally:
            _filelock.flock(lease, _filelock.LOCK_UN)

def main(arguments: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if arguments is None else arguments)
    if not args or args == ["--help"] or args == ["-h"]:
        print("Original Harness² host\nCommands: demo, project, verify, test, run, judge, report, setup, check\nExample: npm run harness2 -- demo --k 1 --mode both\nproject adds a local native Codex adapter; project --help lists prepare/run/judge commands.\nrun/judge/report/setup/check delegate to upstream and require its Linux environment.\nThe existing chat UI is a separate prototype, not the Harness² algorithm.")
        return 0
    if not ((3, 12) <= sys.version_info[:2] < (3, 14)):
        raise RuntimeError("Upstream requires Python 3.12 or 3.13; set HARNESS2_PYTHON to that executable")
    action, rest = args[0], args[1:]
    if action not in {"demo", "project", "verify", "test", *MODULES}:
        raise ValueError(f"Unknown command: {action}")
    verify_vendor()
    sys.path.insert(0, str(VENDOR))
    sys.dont_write_bytecode = True
    if action == "verify":
        if rest:
            raise ValueError("verify takes no arguments")
        print(f"Verified pinned Harness² {PIN}")
        return 0
    if action == "demo":
        return demo(rest)
    if action == "project":
        from project_cli import main as project_main
        return project_main(rest, PIN)
    if action == "test":
        if rest:
            raise ValueError("test takes no arguments")
        suite = unittest.TestLoader().discover(str(VENDOR / "tests"))
        spec = importlib.util.spec_from_file_location("runner_host_tests", ROOT / "python" / "test_host.py")
        assert spec and spec.loader
        tests = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tests)
        suite.addTests(unittest.TestLoader().loadTestsFromModule(tests))
        project_spec = importlib.util.spec_from_file_location("runner_project_tests", ROOT / "python" / "test_project.py")
        assert project_spec and project_spec.loader
        project_tests = importlib.util.module_from_spec(project_spec)
        project_spec.loader.exec_module(project_tests)
        suite.addTests(unittest.TestLoader().loadTestsFromModule(project_tests))
        return int(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
    # Full benchmark runners use Linux shells/process groups and the pinned
    # benchmark dependencies. Never silently route them to our chat adapters.
    if sys.platform != "linux" and rest not in (["--help"], ["-h"]):
        raise RuntimeError("Original model-backed benchmarks require Linux. Run this command inside WSL/Linux after upstream setup; the local demo works on Windows.")
    os.chdir(VENDOR)
    return int(importlib.import_module(f"harness2.cli.{MODULES[action]}").main(rest) or 0)

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"Harness²: {exc}", file=sys.stderr)
        raise SystemExit(1)
