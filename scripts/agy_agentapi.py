import hmac
import json
import os
import select
import shutil
import signal
import subprocess
import time
from uuid import UUID

from agy_control import Client, parse_request
from agy_process import live_image
from agy_registration import PRIVATE, Rejected
from agy_session import NOTICE


WAKE_TIMEOUT = 1.3
MAX_BIND_BYTES = 16384


def _nonempty_str(value, limit=4096):
    return (isinstance(value, str) and 0 < len(value) <= limit
            and "\0" not in value and value == value.strip())


def _valid_uuid(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = UUID(value)
    except ValueError:
        return False
    return str(parsed) == value.lower()


def _child_env(identity, bind_token):
    env = os.environ.copy()
    env.pop("XATS_AGY_DEFER_REGISTRATION", None)
    if "defer_registration" in identity:
        for key in ("XATS_AGY_IDENTITY_KEY", "XATS_IDENTITY_KEY", "XATS_AGY_NAME",
                    "XATS_AGY_TEAM", "AGY_NAME", "AGY_TEAM"):
            env.pop(key, None)
    env.update({f"XATS_AGY_{k.upper()}": v for k, v in identity.items()})
    env["XATS_AGY_PID"] = str(os.getpid())
    env["XATS_AGY_BIND_TOKEN"] = bind_token
    env["XATS_AGY_AGENTAPI"] = "1"
    return env


class DirectChild:
    """Spawn agy directly on the inherited TTY without a PTY wrapper."""

    def __init__(self, path, argv, identity, bind_token):
        self.image = os.stat(path)
        self.path = path
        self.status = None
        self.stopped = False
        self.pid = os.fork()
        if self.pid == 0:
            try:
                for sig in (signal.SIGPIPE, signal.SIGINT, signal.SIGQUIT,
                            signal.SIGTERM, signal.SIGHUP, signal.SIGWINCH):
                    signal.signal(sig, signal.SIG_DFL)
                os.execve(path, ["agy", *argv], _child_env(identity, bind_token))
            except BaseException as error:
                os.write(2, f"xats-agy: {error}\n".encode(errors="replace"))
            finally:
                os._exit(127)

    def poll(self):
        flags = os.WNOHANG | os.WUNTRACED | os.WCONTINUED
        while self.status is None:
            pid, status = os.waitpid(self.pid, flags)
            if not pid:
                break
            if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                self.status = status
            else:
                self.stopped = os.WIFSTOPPED(status)
        return self.status

    def image_reason(self):
        if self.poll() is not None:
            return "child_exited"
        if self.stopped:
            return "child_stopped"
        try:
            image = live_image(self.pid)
            if image is not None and os.path.samestat(image, self.image):
                return None
        except OSError:
            return "child_state_unavailable"
        return "child_image"

    def owns_image(self):
        return self.image_reason() is None

    def signal(self, sig):
        if self.poll() is not None:
            return
        try:
            os.kill(self.pid, sig)
        except ProcessLookupError:
            pass

    def close(self):
        if self.poll() is None:
            self.signal(signal.SIGHUP)
            deadline = time.monotonic() + 0.5
            while self.poll() is None and time.monotonic() < deadline:
                select.select([], [], [], 0.01)
            if self.status is None:
                self.signal(signal.SIGKILL)
                _, self.status = os.waitpid(self.pid, 0)

    def exit_code(self):
        code = os.waitstatus_to_exitcode(self.status)
        return 128 - code if code < 0 else code


class AgentApiClient(Client):
    def __init__(self, sock):
        super().__init__(sock, deferred=True)
        self.limit = MAX_BIND_BYTES


class AgentApiSession:
    """Supervise native agy on the inherited TTY and deliver wakes via agentapi."""

    def __init__(self, server, binding, child, bind_token):
        self.server = server
        self.socket_path = server.getsockname() if server is not None else None
        self.binding = binding
        self.child = child
        self.bind_token = bind_token
        self.clients = {}
        self.credentials = None
        self.active_wake = None
        self.last_busy = None
        self.busy_count = 0
        self.terminating = None

    def close_endpoint(self):
        if self.server is None:
            return
        server, self.server = self.server, None
        try:
            server.close()
        except OSError:
            pass
        if isinstance(self.socket_path, str) and self.socket_path:
            try:
                os.unlink(self.socket_path)
            except OSError:
                pass

    def finish(self, client, status, **fields):
        self.clients.pop(client.sock, None)
        client.finish(status, **fields)

    def busy(self, client, reason):
        self.last_busy = reason
        self.busy_count += 1
        self.finish(client, "busy")

    def _authorize_bind(self, req):
        if req.get("launch_id") != self.binding.launch_id:
            raise Rejected("invalid_launch")
        token = req.get("bind_token")
        if not isinstance(token, str) or not hmac.compare_digest(token, self.bind_token):
            raise Rejected("invalid_token")
        if not self.child.owns_image():
            raise Rejected("agy_unavailable")

    def _handle_bind(self, client, req):
        self._authorize_bind(req)
        expected = {"op", "launch_id", "bind_token", "conversation_id",
                    "ls_address", "csrf_token"}
        optional = {"agentapi_exe"}
        if not (expected <= req.keys() <= (expected | optional)):
            raise Rejected("invalid_request")
        conv_id = req["conversation_id"]
        ls_addr = req["ls_address"]
        csrf = req["csrf_token"]
        exe = req.get("agentapi_exe") or self.child.path
        if (not _valid_uuid(conv_id) or not _nonempty_str(ls_addr, 512)
                or not _nonempty_str(csrf, 1024) or not _nonempty_str(exe, 1024)):
            raise Rejected("invalid_request")
        self.credentials = {
            "conversation_id": conv_id,
            "ls_address": ls_addr,
            "csrf_token": csrf,
            "agentapi_exe": exe,
        }
        self.finish(client, "bound")

    def _handle_update_conversation(self, client, req):
        self._authorize_bind(req)
        if req.keys() != {"op", "launch_id", "bind_token", "conversation_id"}:
            raise Rejected("invalid_request")
        conv_id = req["conversation_id"]
        if not _valid_uuid(conv_id):
            raise Rejected("invalid_request")
        if self.credentials is not None:
            self.credentials["conversation_id"] = conv_id
        self.finish(client, "updated")

    def _diagnose(self, client):
        reason = self.child.image_reason()
        if not reason and not self.binding.bound:
            reason = "not_committed"
        if not reason and self.credentials is None:
            reason = "awaiting_agentapi_bind"
        phase = "waking" if self.active_wake is not None else "idle"
        self.finish(client, "diagnostic", current=reason or "ready",
                    last_busy=self.last_busy, busy_count=self.busy_count, phase=phase)

    def _start_wake(self, client):
        if self.terminating is not None:
            self.finish(client, "unavailable", detail="terminating")
            return
        if self.credentials is None:
            self.busy(client, "awaiting_agentapi_bind")
            return
        if self.active_wake is not None:
            self.busy(client, "wake_in_progress")
            return
        creds = self.credentials
        exe = creds["agentapi_exe"]
        if not os.path.isfile(exe):
            exe = shutil.which("agy") or self.child.path
        env = os.environ.copy()
        env["ANTIGRAVITY_LS_ADDRESS"] = creds["ls_address"]
        env["ANTIGRAVITY_CSRF_TOKEN"] = creds["csrf_token"]
        env["ANTIGRAVITY_CONVERSATION_ID"] = creds["conversation_id"]
        try:
            proc = subprocess.Popen(
                [exe, "agentapi", "send-message", "--title=xats",
                 creds["conversation_id"], NOTICE],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
        except OSError:
            self.finish(client, "unavailable", detail="agentapi_spawn_failed")
            return
        self.active_wake = (proc, client, time.monotonic() + WAKE_TIMEOUT)

    def _poll_wake(self, now):
        if self.active_wake is None:
            return
        proc, client, deadline = self.active_wake
        code = proc.poll()
        if code is None and now < deadline:
            return
        self.active_wake = None
        if code is None:
            proc.kill()
            proc.wait()
            for stream in (proc.stdout, proc.stderr):
                if stream:
                    stream.close()
            self.busy(client, "agentapi_timeout")
            return
        stdout = proc.stdout.read() if proc.stdout else b""
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()
        if code == 0 and b"sendMessage" in stdout:
            self.finish(client, "delivered")
        else:
            self.finish(client, "unavailable", detail="agentapi_send_failed")

    def _abort_wake(self):
        if self.active_wake is None:
            return
        proc, client, _ = self.active_wake
        self.active_wake = None
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        for stream in (proc.stdout, proc.stderr):
            if stream:
                stream.close()
        self.finish(client, "unavailable")

    def request(self, sock):
        client = self.clients[sock]
        try:
            line = client.read()
        except (EOFError, ConnectionResetError):
            if self.active_wake and self.active_wake[1] is client:
                self._abort_wake()
            else:
                self.finish(client, "unavailable")
            return
        if line is None:
            return
        req = parse_request(line)
        op = req.get("op")
        try:
            if op == "bind_agentapi":
                self._handle_bind(client, req)
                return
            if op == "update_conversation":
                self._handle_update_conversation(client, req)
                return
            reply = self.binding.operation(req, self.child.owns_image)
        except Rejected as error:
            detailed = self.binding.deferred or op in PRIVATE or op in (
                "bind_agentapi", "update_conversation")
            fields = {"detail": str(error)} if detailed else {}
            self.finish(client, "unavailable", **fields)
            return
        if reply["status"] == "wake":
            self._start_wake(client)
        elif reply["status"] == "busy":
            self.busy(client, "not_committed")
        elif reply["status"] == "diagnose":
            self._diagnose(client)
        else:
            self.finish(client, **reply)

    def stop(self, sig):
        self._abort_wake()
        self.close_endpoint()
        for client in list(self.clients.values()):
            self.finish(client, "unavailable")
        self.child.signal(sig)
        if self.terminating is None:
            self.terminating = time.monotonic() + 1.0

    def run(self):
        pending = set()
        watched = (signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT)
        old = {sig: signal.signal(sig, lambda s, _: pending.add(s)) for sig in watched}
        old_int = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            while True:
                while pending:
                    self.stop(pending.pop())
                now = time.monotonic()
                self._poll_wake(now)
                for client in list(self.clients.values()):
                    if self.active_wake and self.active_wake[1] is client:
                        continue
                    if client.deadline <= now:
                        self.finish(client, "unavailable")
                if self.terminating and now >= self.terminating:
                    self.child.signal(signal.SIGKILL)
                reads = [*self.clients]
                if self.server is not None:
                    reads.append(self.server)
                if reads:
                    ready, _, _ = select.select(reads, [], [], 0.05)
                else:
                    time.sleep(0.05)
                    ready = []
                if self.server is not None and self.server in ready:
                    sock, _ = self.server.accept()
                    if len(self.clients) < 32:
                        self.clients[sock] = AgentApiClient(sock)
                    else:
                        sock.close()
                for sock in list(self.clients):
                    if sock in ready and sock in self.clients:
                        self.request(sock)
                if self.child.poll() is not None:
                    return self.child.exit_code()
        finally:
            signal.signal(signal.SIGINT, old_int)
            for sig, handler in old.items():
                signal.signal(sig, handler)
            self._abort_wake()
            self.close_endpoint()
            for client in list(self.clients.values()):
                self.finish(client, "unavailable")
