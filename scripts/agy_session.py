import errno
import fcntl
import os
import select
import signal
import termios
import time
import tty
from contextlib import contextmanager

from agy_control import Client, parse_request
from agy_registration import PRIVATE, Rejected
from agy_process import window_size
from agy_screen import Screen, cell_width


NOTICE = "你收到一封 xats 新邮件，请调用 get_inbox 查看并按需回复。"
PASTE = b"\x1b[200~" + NOTICE.encode() + b"\x1b[201~"
QUIET = 0.15
CAPACITY = 262144


@contextmanager
def terminal():
    attrs = termios.tcgetattr(0)
    blocking = [os.get_blocking(fd) for fd in (0, 1)]
    try:
        tty.setraw(0, termios.TCSANOW)
        for fd in (0, 1):
            os.set_blocking(fd, False)
        yield
    finally:
        for fd in (0, 1):
            os.set_blocking(fd, blocking[fd])
        termios.tcsetattr(0, termios.TCSANOW, attrs)


@contextmanager
def signals():
    pending = set()
    watched = (signal.SIGWINCH, signal.SIGTERM, signal.SIGHUP,
               signal.SIGINT, signal.SIGQUIT)
    old = {sig: signal.signal(sig, lambda s, _: pending.add(s)) for sig in watched}
    try:
        yield pending
    finally:
        for sig, handler in old.items():
            signal.signal(sig, handler)


class Session:
    def __init__(self, server, binding, child):
        self.server = server
        self.socket_path = server.getsockname() if server is not None else None
        self.binding = binding
        self.child = child
        self.screen = Screen(window_size())
        self.clients = {}
        self.pending = None
        self.phase = None
        self.last_busy = None
        self.busy_count = 0
        self.manual = self.saw_other_view = False
        self.input = bytearray()
        self.output = bytearray()
        self.changed = time.monotonic()
        self.await_change = self.empty_noop = False
        self.redraw_at_write = 0
        self.input_open = self.pty_open = True
        self.terminating = None

    def finish(self, client, status, **fields):
        self.clients.pop(client.sock)
        if self.pending is client:
            self.pending = None
        client.finish(status, **fields)

    def busy(self, client, reason):
        self.last_busy = reason
        self.busy_count += 1
        self.finish(client, "busy")

    def cancel(self, reason, *, waiting=False):
        if self.pending and waiting:
            reason = self.echo_reason(peek=True) or reason
        if self.phase == "paste":
            self.phase = "rollback"
        if self.pending:
            self.busy(self.pending, reason)

    def safe_reason(self, *, rollback=False, peek=False):
        if self.input and not rollback:
            return "input_buffered"
        if self.terminating:
            return "terminating"
        if not self.input_open:
            return "input_closed"
        if not self.pty_open:
            return "pty_closed"
        if time.monotonic() - self.changed < QUIET:
            return "quiet_interval"
        reason = self.child.image_reason(peek=peek) or self.child.foreground_reason()
        if reason:
            return reason
        reads = [self.child.master] if rollback else [0, self.child.master]
        readable, writable, _ = select.select(reads, [self.child.master], [], 0)
        if 0 in readable:
            return "input_readable"
        if readable:
            return "pty_readable"
        if not writable:
            return "pty_not_writable"
        return None

    def wake_reason(self, *, peek=False):
        if self.manual:
            return "manual"
        if self.phase:
            return "phase_" + self.phase
        if self.await_change:
            return "await_change"
        if cell_width(NOTICE) + 2 >= self.screen.cols:
            return "narrow_terminal"
        return self.screen.composer_reason("") or self.safe_reason(peek=peek)

    def echo_reason(self, *, peek=False, rollback=False):
        return (self.screen.composer_reason(NOTICE)
                or self.safe_reason(rollback=rollback, peek=peek))

    def diagnose(self, client):
        try:
            reason = self.child.image_reason(peek=True)
            if not reason and not self.binding.bound:
                reason = "not_committed"
            current = reason or self.wake_reason(peek=True) or "ready"
        except Exception:
            # Diagnostic failures must not interrupt the interactive PTY.
            current = "child_state_unavailable"
        self.finish(client, "diagnostic", current=current,
                    last_busy=self.last_busy, busy_count=self.busy_count,
                    phase=self.phase or "idle")

    def start_wake(self, client):
        reason = self.wake_reason()
        if reason:
            self.busy(client, reason)
            return
        self.await_change = True
        self.phase = "paste"
        self.saw_other_view = False
        written = self.inject(PASTE)
        if written == len(PASTE):
            self.pending = client
            self.changed = time.monotonic()
        else:
            self.phase = "rollback" if written else None
            self.await_change = bool(written)
            self.busy(client, "paste_partial" if written else "paste_write")

    def inject(self, data):
        try:
            return os.write(self.child.master, data)
        except BlockingIOError:
            return 0
        except OSError as error:
            if error.errno == errno.EIO:
                return 0
            raise

    def confirm(self):
        if self.phase == "paste":
            if self.echo_reason() is None:
                if self.inject(b"\r"):
                    self.phase = None
                    self.await_change = False
                    self.finish(self.pending, "delivered")
                else:
                    self.cancel("enter_write")
        elif self.phase == "rollback":
            if self.saw_other_view and self.screen.composer(""):
                self.phase = "erasing"
            elif self.echo_reason(rollback=True) is None:
                if self.inject(b"\x15"):
                    self.phase = "erasing"
                    self.changed = time.monotonic()
        elif self.phase == "erasing":
            if self.screen.composer("") and self.safe_reason(rollback=True) is None:
                if self.input:
                    del self.input[:os.write(self.child.master, self.input[:65536])]
                    self.await_change = True
                    self.empty_noop = False
                    self.redraw_at_write = self.screen.redraws
                else:
                    self.await_change = False
                self.phase = None

    def request(self, sock):
        client = self.clients[sock]
        try:
            line = client.read()
        except (EOFError, ConnectionResetError):
            if self.pending is client:
                self.cancel("client_disconnected")
            else:
                self.finish(client, "unavailable")
            return
        if self.pending is client:
            self.cancel("client_input")
        elif line is not None:
            request = parse_request(line)
            try:
                reply = self.binding.operation(request, self.child.owns_image)
            except Rejected as error:
                detailed = self.binding.deferred or request.get("op") in PRIVATE
                fields = {"detail": str(error)} if detailed else {}
                self.finish(client, "unavailable", **fields)
                return
            if reply["status"] == "wake":
                self.start_wake(client)
            elif reply["status"] == "busy":
                self.busy(client, "not_committed")
            elif reply["status"] == "diagnose":
                self.diagnose(client)
            else:
                self.finish(client, **reply)

    def read_input(self):
        data = os.read(0, 65536)
        if self.phase and data == b"\x1d":
            # Explicit manual takeover discards quarantined keys, including Enter.
            self.cancel("manual_takeover")
            self.manual = True
            self.phase = None
            self.input.clear()
            return
        if self.phase == "overflow" and data:
            return
        if self.phase and len(self.input) + len(data) > CAPACITY:
            self.cancel("input_overflow")
            self.input.clear()
            self.phase = "overflow"
            self.manual = True
            self.output.extend(("\r\nxats-agy: 暂存输入超限, 已丢弃. "
                                "请单按 Ctrl+] 接管后重新输入.\r\n").encode())
            return
        if self.phase and data in (b"\x03", b"\x1b") and self.screen.blocked():
            self.cancel("user_input")
            self.inject(data)
            return
        self.changed = time.monotonic()
        idle = self.screen.composer("")
        backspaces = data and not data.strip(b"\x08\x7f")
        harmless = (idle and backspaces and not self.await_change and not self.phase
                    and not self.input.strip(b"\x08\x7f"))
        if not harmless:
            noop = data in (b"\x1b[D", b"\x1b[C", b"\x1b[H", b"\x1b[F")
            self.empty_noop = (idle and noop
                               and (self.empty_noop or not self.await_change))
            self.await_change = self.await_change or idle or self.screen.sync
        self.cancel("user_input" if data else "input_closed")
        if data:
            self.input.extend(data)
        else:
            self.input_open = False
            self.stop(signal.SIGHUP)

    def read_output(self):
        data = self.child.read()
        if data:
            self.output.extend(data)
            self.changed = time.monotonic()
            self.screen.feed(data)
            if self.phase and self.screen.blocked():
                self.saw_other_view = True
                self.cancel("blocked_view", waiting=True)
            if (self.await_change and not self.input and not self.phase
                    and self.screen.redraws > self.redraw_at_write
                    and self.screen.visible and self.screen.text()
                    and (self.empty_noop or not self.screen.composer(""))):
                self.await_change = self.empty_noop = False
        else:
            self.pty_open = False
            self.cancel("pty_closed")

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

    def stop(self, sig):
        self.cancel("signal")
        self.child.signal(sig)
        if sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
            # Release the control socket immediately so a replacement launcher
            # can prove the incumbent is exiting without waiting for SIGKILL.
            self.close_endpoint()
            for client in list(self.clients.values()):
                self.finish(client, "unavailable")
            if self.terminating is None:
                self.terminating = time.monotonic() + 1

    def handle_signals(self, pending):
        while pending:
            sig = pending.pop()
            if sig == signal.SIGWINCH:
                self.cancel("resize")
                size = window_size()
                fcntl.ioctl(self.child.master, termios.TIOCSWINSZ, size)
                self.screen.resize(size)
                self.changed = time.monotonic()
            else:
                self.stop(sig)

    def io(self):
        master = self.child.master
        reads = [*self.clients]
        if self.server is not None:
            reads.append(self.server)
        if (self.input_open and self.pty_open
                and (self.phase or len(self.input) < CAPACITY)):
            reads.append(0)
        if self.pty_open and len(self.output) < CAPACITY:
            reads.append(master)
        writes = [1] if self.output else []
        if self.input and self.pty_open and not self.phase:
            writes.append(master)
        ready, writable, _ = select.select(reads, writes, [], 0.05)
        if 0 in ready:
            self.read_input()
        if master in ready:
            self.read_output()
        if master in writable and self.pty_open and not self.phase:
            del self.input[:os.write(master, self.input[:65536])]
            self.redraw_at_write = self.screen.redraws
        if 1 in writable:
            del self.output[:os.write(1, self.output[:65536])]
        if self.server is not None and self.server in ready:
            sock, _ = self.server.accept()
            if len(self.clients) < 32:
                self.clients[sock] = Client(sock, deferred=self.binding.deferred)
            else:
                sock.close()
        for sock in list(self.clients):
            if sock in ready and sock in self.clients:
                self.request(sock)

    def run(self, pending):
        try:
            while True:
                self.handle_signals(pending)
                now = time.monotonic()
                for client in list(self.clients.values()):
                    if client.deadline <= now:
                        if client is self.pending:
                            self.cancel("echo_timeout", waiting=True)
                        else:
                            self.finish(client, "unavailable")
                if self.terminating and now >= self.terminating:
                    self.child.signal(signal.SIGKILL)
                try:
                    self.io()
                except BlockingIOError:
                    continue
                if not pending:
                    self.confirm()
                if self.child.poll() is not None and not self.output:
                    if not self.pty_open or not select.select(
                            [self.child.master], [], [], 0)[0]:
                        return self.child.exit_code()
        finally:
            for client in list(self.clients.values()):
                self.finish(client, "unavailable")
