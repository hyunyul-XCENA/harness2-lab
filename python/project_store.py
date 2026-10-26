"""Owned, immutable source snapshots for local project experiments."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess

IGNORED = {".git", ".codex", ".claude", "node_modules", "dist", "__pycache__", ".terminal-runner", ".test-artifacts"}

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")

def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json_bytes(value))

def relative(name: str) -> str:
    p = PurePosixPath(name)
    if not name or "\\" in name or ":" in name or p.is_absolute() or any(v in ("", ".", "..") for v in name.split("/")):
        raise ValueError(f"Invalid relative path: {name!r}")
    return p.as_posix()

def unlinked(path: Path) -> Path:
    path = path.expanduser().absolute()
    # Use the Win32 extended-length form locally instead of requiring a machine
    # registry change. Keep it from the root down so scans, reads and writes all
    # refer to the same paths, including deep dependency and artifact trees.
    if os.name == "nt":
        value = str(path)
        if not value.startswith("\\\\?\\"):
            value = "\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value
            path = Path(value)
    for p in [path, *path.parents]:
        if p.is_symlink() or p.is_junction():
            raise ValueError(f"Linked path is not supported: {p}")
    return path

def files(root: Path, *, ignore: set[str] | None = None) -> dict[str, Path]:
    root = unlinked(root)
    out = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in [*dirs, *names]:
            p = parent / name
            if p.is_symlink() or p.is_junction():
                raise ValueError(f"Linked content is not supported: {p}")
        dirs[:] = sorted(d for d in dirs if d not in (ignore or set()))
        for name in sorted(names):
            p = parent / name
            if not p.is_file():
                raise ValueError(f"Non-file content: {p}")
            out[p.relative_to(root).as_posix()] = p
    return out

def inventory(root: Path) -> dict[str, dict]:
    return {name: {"sha256": digest(p.read_bytes()), "executable": bool(p.stat().st_mode & 0o111) if os.name != "nt" else False} for name, p in files(root).items()}

def check_inventory(root: Path, expected: dict) -> None:
    if inventory(root) != expected:
        raise ValueError(f"Snapshot changed or contains unexpected files: {root}")

def copy_files(source: Path, dest: Path, names: list[str] | None = None) -> None:
    source, dest = unlinked(source), unlinked(dest)
    selected = files(source) if names is None else {relative(n): unlinked(source / n) for n in names}
    for name, file in selected.items():
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
        shutil.copymode(file, target)

def token(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", value):
        raise ValueError("Task IDs and domains must be lowercase slugs (up to 64 characters)")
    return value

def tasks_from(path: Path) -> list[dict]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict) or set(value) != {"tasks"} or not isinstance(value["tasks"], list) or not value["tasks"]:
        raise ValueError("Tasks file must contain a nonempty tasks array")
    seen = set()
    for task in value["tasks"]:
        if not isinstance(task, dict) or set(task) != {"id", "domain", "prompt"}:
            raise ValueError("Each task needs exactly id, domain and prompt")
        if token(task["id"]) in seen:
            raise ValueError("Duplicate task ID")
        seen.add(task["id"])
        token(task["domain"])
        if not isinstance(task["prompt"], str) or not task["prompt"].strip() or len(task["prompt"]) > 100_000:
            raise ValueError("Task prompt must contain 1..100000 characters")
    return value["tasks"]

def git_tracked(project: Path) -> list[str]:
    result = subprocess.run(["git", "-C", str(project), "ls-files", "--cached", "-z", "--", "."], check=True, capture_output=True)
    names = [relative(n.decode("utf-8")) for n in result.stdout.split(b"\0") if n]
    if not names:
        raise ValueError("Project must contain Git-tracked files; untracked files are not included")
    return sorted(set(names))

def initialize(root: Path, project: Path, tasks: list[dict], runtime: dict, deps: list[str], k: int, mode: str, pin: str) -> dict:
    root, project = unlinked(root), unlinked(project)
    if root.exists() and (not root.is_dir() or any(root.iterdir())):
        raise ValueError("Project experiment output must be new or empty")
    dependencies = sorted(set(relative(d) for d in deps))
    if any(a == b or a.startswith(b + "/") for a in dependencies for b in dependencies if a != b):
        raise ValueError("Dependency directories must not overlap")
    if any(d.split("/")[0] in {".git", ".codex", ".claude", ".agents", ".terminal-runner", ".test-artifacts"} for d in dependencies):
        raise ValueError("Cannot snapshot state or native configuration directories as dependencies")
    names = [n for n in git_tracked(project) if not set(PurePosixPath(n).parts) & IGNORED and not any(n == d or n.startswith(d + "/") for d in dependencies)]
    if not names:
        raise ValueError("No tracked task source remains after excluding state and dependency directories")
    for name in names:
        base = PurePosixPath(name).name.lower()
        if (base == ".env" or base.startswith(".env.") and base not in {".env.example", ".env.sample"}) or base.endswith((".pem", ".key", ".p12")) or base in {"auth.json", "credentials.json"}:
            raise ValueError(f"Credential-like tracked file must be removed from the experiment scope: {name}")
    # Refuse links before writing any snapshot, including within dependencies.
    for name in names:
        if not unlinked(project / name).is_file():
            raise ValueError(f"Tracked source missing: {name}")
    for dep in dependencies:
        path = unlinked(project / dep)
        if not path.is_dir():
            raise ValueError(f"Dependency directory missing: {dep}")
        files(path)
    root.mkdir(parents=True, exist_ok=True)
    # Reserve even when two initializers both observed an empty/new directory.
    # An interrupted initialization remains visibly incomplete, never reusable.
    with (root / ".runner-project.init").open("xb") as reservation:
        reservation.write(b"initializing\n")
    copy_files(project, root / "source", names)
    for dep in dependencies:
        copy_files(project / dep, root / "dependencies" / dep)
    state = {"version": 1, "upstream": pin, "kind": "local-codex-project", "project": str(project), "tasks": tasks, "runtime": runtime, "k": k, "mode": mode, "dependencies": dependencies, "source": inventory(root / "source"), "dependency_files": inventory(root / "dependencies")}
    write_json(root / "project.json", state)
    # Exclusive marker binds settings, task order and source/dependency identities.
    with (root / ".runner-project.json").open("xb") as marker:
        marker.write(json_bytes({"version": 1, "config_sha256": digest(json_bytes(state))}))
    (root / ".runner-project.init").unlink()
    return state

def load(root: Path, pin: str) -> dict:
    root = unlinked(root)
    state = json.loads(unlinked(root / "project.json").read_text(encoding="utf-8"))
    marker = json.loads(unlinked(root / ".runner-project.json").read_text(encoding="utf-8"))
    if marker != {"version": 1, "config_sha256": digest(json_bytes(state))} or state["upstream"] != pin or state["kind"] != "local-codex-project":
        raise ValueError("Project experiment configuration changed; initialize a new output directory")
    check_inventory(root / "source", state["source"])
    check_inventory(root / "dependencies", state["dependency_files"])
    # Reject redirected output descendants before core writes into them.
    files(root)
    return state

def copy_dependencies(root: Path, workspace: Path, state: dict) -> None:
    for name in state["dependencies"]:
        copy_files(root / "dependencies" / name, workspace / name)
