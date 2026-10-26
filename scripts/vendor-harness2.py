"""Reproduce the pinned upstream source mirror and its Windows portability patches."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import zipfile

PIN = "1cfe254e8d25b15f37048c3730134686abe60335"
REPOSITORY = "https://github.com/google-research/harness2"
ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "vendor" / "harness2"
PATHS = ["harness2", "third_party", "scripts", "tests", "docs", "dependencies/README.md", "dependencies/PINNED.md", "pyproject.toml", "README.md", "LICENSE", "CONTRIBUTING.md", "MANIFEST.in"]

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="local checkout of the official upstream repository")
    args = parser.parse_args()
    subprocess.run(["git", "-C", str(args.source), "cat-file", "-e", f"{PIN}^{{commit}}"], check=True)
    data = subprocess.run(["git", "-C", str(args.source), "archive", "--format=zip", PIN, *PATHS], check=True, capture_output=True).stdout
    files: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            rel = PurePosixPath(entry.filename)
            if rel.is_absolute() or ".." in rel.parts or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                raise RuntimeError(f"Unexpected archive path: {entry.filename}")
            body = archive.read(entry)
            if b"\0" in body:
                raise RuntimeError(f"Unexpected binary source: {entry.filename}")
            files[entry.filename] = body.replace(b"\r\n", b"\n")
    original = dict(files)
    schedule = files["harness2/core/schedule.py"].decode("utf-8")
    assert schedule.count("    import fcntl\n") == 1
    assert schedule.count('    with open(lock, "w") as lf:\n') == 1
    schedule = schedule.replace("    import fcntl\n", "    from . import _filelock as fcntl\n").replace('    with open(lock, "w") as lf:\n', '    with open(lock, "a+b") as lf:\n')
    assert schedule.count("            os.replace(tmp, summary_path)\n") == 1
    schedule = schedule.replace("            os.replace(tmp, summary_path)\n", "            fcntl.replace(tmp, summary_path)\n")
    schedule = schedule.replace('"""Namespacing,', '# Local portability patch: OS file locking and Windows atomic-replace retry.\n# Method/scheduling policy remains upstream; see PROVENANCE.json.\n\n"""Namespacing,', 1)
    files["harness2/core/schedule.py"] = schedule.encode("utf-8")
    tree = files["harness2/core/tree.py"].decode("utf-8")
    assert tree.count("        rel = str(p.relative_to(d))\n") == 1
    assert tree.count("        rel = str(p.relative_to(dest))\n") == 1
    files["harness2/core/tree.py"] = tree.replace("        rel = str(p.relative_to(d))\n", "        rel = p.relative_to(d).as_posix()\n").replace("        rel = str(p.relative_to(dest))\n", "        rel = p.relative_to(dest).as_posix()\n").encode("utf-8")
    files["harness2/core/tree.py"] = files["harness2/core/tree.py"].replace(b'"""The c1..c8', b'# Local portability patch: canonical POSIX path keys on Windows.\n# Editable-surface policy remains upstream; see PROVENANCE.json.\n\n"""The c1..c8', 1)
    # This small compatibility file is kept as first-party source beside this script.
    files["harness2/core/_filelock.py"] = (ROOT / "python" / "filelock.py").read_bytes().replace(b"\r\n", b"\n")
    manifest = {
        "repository": REPOSITORY, "commit": PIN, "license": "Apache-2.0 (third-party notices retained)",
        "hashAlgorithm": "sha256-lf", "patches": ["Windows/POSIX exclusive summary-file locking and bounded retry of atomic replace on Windows sharing errors", "Canonical POSIX harness keys on every platform; method, prompts, selection and library policy unchanged"],
        "files": {name: {"upstreamSha256": sha(original[name]) if name in original else None, "sha256": sha(body)} for name, body in sorted(files.items())},
    }
    TARGET.mkdir(parents=True, exist_ok=True)
    for name, body in files.items():
        target = TARGET / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    (TARGET / "PROVENANCE.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Mirrored {len(files)} upstream/compatibility files at {PIN}")

if __name__ == "__main__":
    main()
