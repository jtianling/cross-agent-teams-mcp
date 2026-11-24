import json
import os
import socket
import stat
import time
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def endpoint(launch_id, root=Path("/tmp")):
    directory = root / f"xats-agy-{os.getuid()}"
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if (info.st_uid != os.getuid() or not stat.S_ISDIR(info.st_mode)
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise PermissionError(f"unsafe socket directory: {directory}")
    path = directory / f"{launch_id}.sock"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        previous = os.umask(0o177)
        try:
            server.bind(str(path))
        finally:
            os.umask(previous)
        try:
            path.chmod(0o600)
            server.listen(16)
            server.setblocking(False)
            yield server
        finally:
            path.unlink(missing_ok=True)


def unique_keys(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate request key")
    return result


def parse_request(line):
    try:
        request = json.loads(line.decode("utf-8"), object_pairs_hook=unique_keys)
    except (ValueError, RecursionError):
        return {}
    return request if isinstance(request, dict) else {}


class Client:
    def __init__(self, sock, *, deferred=False):
        # Two 256-character labels can each occupy 3072 bytes as JSON surrogate pairs.
        self.limit = 8192 if deferred else 4096
        self.sock = sock
        self.buffer = bytearray()
        self.deadline = time.monotonic() + 1.1
        sock.setblocking(False)

    def read(self):
        data = self.sock.recv(self.limit + 1 - len(self.buffer))
        if not data:
            raise EOFError
        self.buffer.extend(data)
        if len(self.buffer) > self.limit or b"\n" in self.buffer[:-1]:
            return b""
        if self.buffer.endswith(b"\n"):
            return bytes(self.buffer)
        return None

    def finish(self, status, **fields):
        reply = {"status": status, **fields}
        try:
            self.sock.sendall(json.dumps(reply, ensure_ascii=False).encode() + b"\n")
        except (BrokenPipeError, ConnectionResetError, BlockingIOError):
            pass
        finally:
            self.sock.close()
