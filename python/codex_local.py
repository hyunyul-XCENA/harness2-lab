"""Native Codex transport extension; the upstream PPC implementation stays unchanged."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

from harness2.core.proposer import Proposer
from harness2.substrate.codex import final_message
from project_store import files, native_cwd, plain_path, unlinked, write_json

SUPPORTED_VERSION = "codex-cli 0.164.0"

def stop_tree(process):
    if os.name == "nt":
        subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=15)
    else:
        os.killpg(process.pid, signal.SIGKILL)

@dataclass(frozen=True)
class CodexChannel:
    """Local extension value at the channel seam, not an upstream ChannelSpec alias."""
    model: str
    effort: str = "medium"
    timeout: int = 1200
    kind: str = "codex_exec"

class CodexCLI:
    def __init__(self, argv: list[str], model: str, effort: str, timeout: int):
        self.argv, self.model, self.effort, self.timeout = argv, model, effort, timeout

    @classmethod
    def configured(cls, state: dict):
        r = state["runtime"]
        return cls([r["executable"]], r["model"], r["effort"], r["timeout"])

    def version(self) -> str:
        return subprocess.run([*self.argv, "--version"], capture_output=True, text=True, encoding="utf-8", check=True, timeout=15).stdout.strip()

    def invoke(self, cwd: Path, mission: str, output: Path, timeout: int | None = None) -> dict:
        output.mkdir(parents=True, exist_ok=True)
        # Native CLI authentication is inherited. Global config/rules are excluded
        # from an experimental harness; workspace writes retain the native sandbox.
        env = {k: v for k, v in os.environ.items() if not k.startswith("ORCA_")}
        started = time.monotonic()
        timed_out = False
        launch_cwd = native_cwd(cwd)
        # The durable log directory can exceed MAX_PATH. Capture the CLI's
        # response at a short ordinary path, then persist it using Python paths.
        with tempfile.TemporaryDirectory(prefix="h2native-", dir=unlinked(Path(tempfile.gettempdir()))) as directory:
            response = Path(directory) / "answer.txt"
            command = [*self.argv, "exec", "--model", self.model, "-c", f'model_reasoning_effort={json.dumps(self.effort)}', "-c", 'approval_policy="never"', "-c", 'features.multi_agent=false', "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "--json", "--color", "never", "-C", launch_cwd, "--output-last-message", plain_path(response), "-"]
            with (output / "events.jsonl").open("wb") as stdout, (output / "stderr.txt").open("wb") as stderr:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, cwd=launch_cwd, env=env, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0, start_new_session=os.name != "nt")
                try:
                    process.communicate(mission.encode("utf-8"), timeout=timeout or self.timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    stop_tree(process)
                    process.communicate(timeout=15)
            native_text = response.read_text(encoding="utf-8", errors="replace") if response.is_file() else None
        events = []
        for line in (output / "events.jsonl").read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    events.append(value)
            except ValueError:
                continue
        answer = output / "answer.txt"
        text = native_text if native_text is not None else final_message(output / "events.jsonl")
        answer.write_text(text, encoding="utf-8")
        success = process.returncode == 0 and not timed_out and any(e.get("type") == "turn.completed" for e in events) and not any(e.get("type") in {"turn.failed", "error"} for e in events) and bool(text.strip())
        result = {"ok": success, "exit_code": process.returncode, "timed_out": timed_out, "wall_s": round(time.monotonic() - started, 3), "usage": next((e.get("usage", {}) for e in reversed(events) if e.get("type") == "turn.completed"), {}), "cost_usd": None}
        write_json(output / "native.json", result)
        return result | {"text": text}

class CodexProposer(Proposer):
    """Keep upstream retry/cache/harvest/audit; replace only its model I/O slot.

    Upstream dispatches non-Claude transports through _opencode. This subclass
    overrides that slot, with the truthful codex_exec kind in every audit record.
    """
    def __init__(self, runtime: CodexCLI, audit_dir: Path):
        super().__init__(CodexChannel(runtime.model, runtime.effort, runtime.timeout), audit_dir=audit_dir)
        self.runtime = runtime

    def call(self, mission, context_dir, label, **kwargs):
        print(f"  [editor] {label}: start", flush=True)
        reply = super().call(mission, context_dir, label, **kwargs)
        print(f"  [editor] {label}: {'cached' if reply.cached else 'complete'}", flush=True)
        return reply

    def _opencode(self, cwd: Path, mission: str, system: str, wall: int):
        output = Path(self.audit_dir) / "native" / uuid.uuid4().hex
        prompt = (system + "\n\n" if system else "") + mission
        prompt += "\n\nWork only in this session workspace. Do not delegate to other agents or use external project/experiment directories."
        result = self.runtime.invoke(cwd, prompt, output, wall)
        return (result["text"], 0.0, "") if result["ok"] else ("", 0.0, f"Codex invocation failed; see {output / 'native.json'}")

    def _harvest(self, tmp, sub, label, cache_key=""):
        if (tmp / sub).is_dir():
            files(tmp / sub)  # Do not follow model-created links into the audit cache.
        return super()._harvest(tmp, sub, label, cache_key)

def resolve_runtime(executable: str, model: str, effort: str, timeout: int) -> dict:
    binary = shutil.which(executable)
    if not binary or Path(binary).suffix.lower() in {".cmd", ".bat", ".ps1"}:
        raise ValueError("Set --codex-path to a native Codex executable (not a shell shim)")
    if not model.strip() or model.startswith("-"):
        raise ValueError("--model must name a model available to your account")
    runtime = {"executable": str(Path(binary).absolute()), "model": model, "effort": effort, "timeout": timeout}
    version = CodexCLI.configured({"runtime": runtime}).version()
    if version != SUPPORTED_VERSION:
        raise ValueError(f"Local project adapter supports {SUPPORTED_VERSION}; found {version}. Upstream benchmark executors have separate pins.")
    return runtime | {"version": version}
