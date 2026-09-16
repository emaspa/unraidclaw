"""Exercise a real TTY without printing its credential-bearing input or output."""
import errno
import json
import os
import pathlib
import pty
import select
import subprocess
import sys
import time

data = json.load(sys.stdin)
try:
    master, slave = pty.openpty()
except OSError as error:
    if error.errno in (errno.EPERM, errno.EACCES, errno.ENOENT):
        print(json.dumps({"skipped": "Sandbox does not allow pseudo-terminals"}))
        sys.exit(0)
    raise
try:
    child = subprocess.Popen(data["command"], stdin=slave, stdout=slave, stderr=slave,
                             cwd=data["cwd"])
    os.close(slave)
    transcript = b""
    sent = False
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            if child.poll() is not None:
                break
            continue
        try:
            part = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not part:
            break
        transcript += part
        if not sent and b"API key (hidden): " in transcript:
            os.write(master, data["key"].encode() + b"\n")
            sent = True
    if child.poll() is None:
        child.kill()
    code = child.wait()
    saved_path = pathlib.Path(data["cwd"]) / ".config/unraidclaw/config.json"
    saved = json.loads(saved_path.read_text()) if saved_path.exists() else {}
    print(json.dumps({"code": code, "prompted": sent,
                      "echoed": data["key"].encode() in transcript,
                      "saved": saved.get("key") == data["key"]}))
finally:
    os.close(master)
