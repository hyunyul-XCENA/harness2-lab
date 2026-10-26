"""Local portability patch: real exclusive file locks on Windows and POSIX.

Used by the vendored summary writer. This does not alter Harness² method logic.
"""
from __future__ import annotations

import errno
import os
import time

LOCK_EX = 2
LOCK_UN = 8

def flock(file, operation: int) -> None:
    if os.name != "nt":
        import fcntl
        fcntl.flock(file, operation)
        return
    import msvcrt
    if operation not in (LOCK_EX, LOCK_UN):
        raise ValueError("Only exclusive locking and unlocking are supported")
    if operation == LOCK_EX:
        file.seek(0, os.SEEK_END)
        if file.tell() == 0:
            file.write(b"\0")
            file.flush()
        while True:
            file.seek(0)
            try:
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                time.sleep(0.025)
    else:
        file.seek(0)
        msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)

def replace(source, destination) -> None:
    """Retain atomic replace, retrying transient Windows open-file sharing errors."""
    for attempt in range(21):
        try:
            os.replace(source, destination)
            return
        except PermissionError as exc:
            if os.name != "nt" or getattr(exc, "winerror", None) not in (5, 32, 33) or attempt == 20:
                raise
            time.sleep(0.025)
