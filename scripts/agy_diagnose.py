import json
import os
import re
import socket
import stat
from pathlib import Path
from uuid import UUID


def _code(value):
    return isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,79}", value)


def _result(line):
    if len(line) > 4096 or not line.endswith(b"\n"):
        raise ValueError("incomplete launcher diagnostic response")
    result = json.loads(line)
    if isinstance(result, dict) and result.get("status") == "unavailable":
        detail = result.get("detail")
        raise ValueError(detail if _code(detail) else "diagnostic unavailable")
    if (not isinstance(result, dict)
            or set(result) != {"status", "current", "last_busy", "busy_count", "phase"}
            or result["status"] != "diagnostic"
            or not _code(result["current"]) or not _code(result["phase"])
            or (result["last_busy"] is not None and not _code(result["last_busy"]))
            or type(result["busy_count"]) is not int or result["busy_count"] < 0):
        raise ValueError("unexpected launcher diagnostic response")
    return result


def diagnose(launch_id, name, team):
    parsed = UUID(launch_id)
    if parsed.version != 4 or str(parsed) != launch_id:
        raise ValueError("expected a canonical launch UUID v4")
    root = Path("/tmp") / f"xats-agy-{os.getuid()}"
    path = root / f"{launch_id}.sock"
    for target, kind in ((root, stat.S_ISDIR), (path, stat.S_ISSOCK)):
        info = target.lstat()
        if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("unsafe launcher diagnostic endpoint")
    request = {"op": "diagnose", "launch_id": launch_id, "name": name, "team": team}
    with socket.socket(socket.AF_UNIX) as peer:
        peer.settimeout(2)
        peer.connect(str(path))
        peer.sendall(json.dumps(request, ensure_ascii=False).encode() + b"\n")
        with peer.makefile("rb") as stream:
            return _result(stream.readline(4097))
