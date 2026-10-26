"""Model-free executable fixture for native Codex sessions (never a production mode)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

if sys.argv[1:] == ["--version"]:
    print("codex-cli 0.164.0")
    raise SystemExit(0)
if "sandbox" in sys.argv[1:]:
    if marker := os.environ.get("HARNESS2_FIXTURE_PREFLIGHT_TIMEOUT_MARKER"):
        subprocess.Popen([sys.executable, "-c", "import time,pathlib,sys; time.sleep(1.5); pathlib.Path(sys.argv[1]).write_text('escaped')", marker])
        time.sleep(20)
    if os.environ.get("HARNESS2_FIXTURE_PREFLIGHT_FAILURE"):
        print("fixture sandbox unavailable", file=sys.stderr)
        raise SystemExit(1)
    print("HARNESS2_SANDBOX_PREFLIGHT")
    raise SystemExit(0)
cwd = Path(sys.argv[sys.argv.index("-C") + 1])
answer = Path(sys.argv[sys.argv.index("--output-last-message") + 1])
model = sys.argv[sys.argv.index("--model") + 1]
mission = sys.stdin.read()
print(json.dumps({"type": "fixture.argv", "argv": sys.argv[1:]}), flush=True)
if model.startswith("fixture-event-"):
    retry = {"type": "error", "message": "Reconnecting... 2/5 (stream disconnected before completion: No such host is known. (os error 11001))"}
    complete = {"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 5}}
    variants = {
        "recovered": [retry, complete],
        "unfinished": [retry],
        "failed": [retry, {"type": "turn.failed", "error": {"message": "still failed"}}],
        "unknown": [{"type": "error", "message": "unexpected fatal error"}, complete],
        "late": [complete, retry],
    }
    answer.write_text("fixture deliverable", encoding="utf-8")
    for event in variants[model.removeprefix("fixture-event-")]:
        print(json.dumps(event), flush=True)
    raise SystemExit(0)
if model == "fixture-timeout":
    subprocess.Popen([sys.executable, "-c", "import time,pathlib,sys; time.sleep(1.5); pathlib.Path(sys.argv[1]).write_text('escaped')", os.environ.get("HARNESS2_FIXTURE_TIMEOUT_MARKER", str(answer.parent / "child-escaped.txt"))])
    time.sleep(20)
if model == "fixture-failure":
    answer.write_text("looks successful", encoding="utf-8")
    print(json.dumps({"type": "turn.failed", "error": {"message": "fixture failure"}}), flush=True)
    raise SystemExit(0)
context = cwd / "context"
if (context / "base_harness").is_dir():
    text = "<edits>\ncomponent: AGENTS.md\ncandidates: inv1\nchange: inspect failures before editing\nobserved: main.py changed to return the requested value\nverdict: helped\n</edits>\n<experience>\ncue: A small software change\nlesson: Inspect failures before editing.\nevidence: The AGENTS.md row and main.py patch in the probe.\nconfidence: limited to the observed contrast\n</experience>"
elif (context / "candidates").is_dir():
    chosen = sorted((context / "candidates").glob("*.md"))[0].stem
    text = f"<why>The patch implements the request.</why>\n```choice\n{chosen}\n```"
elif (context / "harness").is_dir():
    instructions = context / "harness/AGENTS.md"
    instructions.write_text(instructions.read_text(encoding="utf-8") + "\nInspect failures before editing.\n", encoding="utf-8")
    text = "<notes>Use the main.py trajectory to make a focused change.</notes>"
else:
    source = cwd / "main.py"
    if "Inspect failures" in (cwd / "AGENTS.md").read_text(encoding="utf-8"):
        source.write_text(source.read_text().replace("return 0", "return 42"), encoding="utf-8")
    text = "Inspected main.py and completed the requested change."
answer.write_text(text, encoding="utf-8")
print(json.dumps({"type": "item.completed", "item": {"id": "a1", "type": "agent_message", "text": text}}), flush=True)
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 5}}), flush=True)
