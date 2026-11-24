import ctypes
import errno
import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path


PS_TIMEOUT = 0.25


def window_size():
    return fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))


def live_image(pid):
    if sys.platform.startswith("linux"):
        return os.stat(f"/proc/{pid}/exe")
    if sys.platform == "darwin":
        path = ctypes.create_string_buffer(4096)
        if _proc.proc_pidpath(pid, path, len(path)) > 0:
            return os.stat(path.value)
    return None


if sys.platform == "darwin":
    _proc = ctypes.CDLL("/usr/lib/libproc.dylib")
    _proc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]


def exclusive_tty(pid, slave):
    if sys.platform == "darwin":
        holders = (ctypes.c_int * 2)()
        path = os.fsencode(os.ttyname(slave))
        size = _proc.proc_listpidspath(2, pid, path, 0, holders, ctypes.sizeof(holders))
        if size != ctypes.sizeof(ctypes.c_int) or holders[0] != pid:
            return False
        size = _proc.proc_listpidspath(2, pid, b"/dev/tty", 0, holders,
                                      ctypes.sizeof(holders))
        return size == 0 or (size == ctypes.sizeof(ctypes.c_int) and holders[0] == pid)
    if sys.platform.startswith("linux"):
        tty_devices = {os.fstat(slave).st_rdev, os.stat("/dev/tty").st_rdev}
        for proc in Path("/proc").iterdir():
            if not proc.name.isdecimal() or int(proc.name) == pid:
                continue
            try:
                if os.getpgid(int(proc.name)) == pid and any(
                    fd.stat().st_rdev in tty_devices for fd in (proc / "fd").iterdir()
                ):
                    return False
            except ProcessLookupError:
                continue
            except FileNotFoundError:
                return False
        return True
    return False


def child_environment(identity):
    env = os.environ.copy()
    env.pop("XATS_AGY_DEFER_REGISTRATION", None)
    if "defer_registration" in identity:
        for key in ("XATS_AGY_IDENTITY_KEY", "XATS_IDENTITY_KEY", "XATS_AGY_NAME",
                    "XATS_AGY_TEAM", "AGY_NAME", "AGY_TEAM"):
            env.pop(key, None)
    env.update({f"XATS_AGY_{k.upper()}": v for k, v in identity.items()})
    env["XATS_AGY_PID"] = str(os.getpid())
    return env


class Child:
    def __init__(self, path, argv, identity):
        self.image = os.stat(path)
        size = window_size()
        attrs = termios.tcgetattr(0)
        self.status = None
        self.stopped = False
        self.master, self.slave = os.openpty()
        try:
            self.pid = os.fork()
        except OSError:
            os.close(self.master)
            os.close(self.slave)
            raise
        if self.pid == 0:
            try:
                os.close(self.master)
                os.setsid()
                fcntl.ioctl(self.slave, termios.TIOCSCTTY, 0)
                for fd in (0, 1, 2):
                    os.dup2(self.slave, fd)
                os.close(self.slave)
                fcntl.ioctl(0, termios.TIOCSWINSZ, size)
                termios.tcsetattr(0, termios.TCSANOW, attrs)
                for sig in (signal.SIGPIPE, signal.SIGINT, signal.SIGQUIT,
                            signal.SIGTERM, signal.SIGHUP, signal.SIGWINCH):
                    signal.signal(sig, signal.SIG_DFL)
                os.execve(path, ["agy", *argv], child_environment(identity))
            except BaseException as error:
                os.write(2, f"xats-agy: {error}\n".encode(errors="replace"))
            finally:
                os._exit(127)
        os.set_blocking(self.master, False)

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

    def _peek_state(self):
        if self.status is not None:
            return "child_exited"
        waitid = getattr(os, "waitid", None)
        try:
            if waitid is None:
                # Older macOS Python does not expose waitid(WNOWAIT).
                result = subprocess.run(["/bin/ps", "-o", "state=", "-p", str(self.pid)],
                                        capture_output=True, timeout=PS_TIMEOUT)
                state = result.stdout.strip()[:1]
                if result.returncode or not state:
                    return "child_state_unavailable"
                if state == b"T":
                    return "child_stopped"
                if state == b"Z":
                    return "child_exited"
                if state in (b"I", b"R", b"S", b"D", b"U"):
                    return None
                return "child_state_unavailable"
            flags = os.WEXITED | os.WSTOPPED | os.WCONTINUED | os.WNOHANG | os.WNOWAIT
            event = waitid(os.P_PID, self.pid, flags)
        except (OSError, subprocess.TimeoutExpired):
            return "child_state_unavailable"
        if not event or not event.si_pid:
            return "child_stopped" if self.stopped else None
        if event.si_code == os.CLD_CONTINUED:
            return None
        if event.si_code in (os.CLD_STOPPED, os.CLD_TRAPPED):
            return "child_stopped"
        return "child_exited"

    def image_reason(self, *, peek=False):
        if peek:
            reason = self._peek_state()
            if reason:
                return reason
        elif self.poll() is not None:
            return "child_exited"
        elif self.stopped:
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

    def foreground_reason(self):
        try:
            attrs = termios.tcgetattr(self.slave)
            queued = fcntl.ioctl(self.slave, termios.FIONREAD, bytes(4))
            if not exclusive_tty(self.pid, self.slave):
                return "tty_not_exclusive"
            if os.tcgetpgrp(self.master) != self.pid:
                return "tty_foreground"
            if attrs[3] & termios.ICANON:
                return "tty_canonical"
            if attrs[3] & termios.ECHO:
                return "tty_echo"
            if struct.unpack("i", queued)[0]:
                return "tty_queued"
            return None
        except (OSError, termios.error):
            return "tty_unavailable"

    def foreground(self):
        return self.foreground_reason() is None

    def signal(self, sig):
        if self.poll() is not None:
            return
        try:
            foreground = os.tcgetpgrp(self.master)
        except OSError:
            foreground = 0
        groups = {self.pid}
        if foreground > 0:
            groups.add(foreground)
        for group in groups:
            try:
                os.killpg(group, sig)
            except ProcessLookupError:
                if group == self.pid:
                    try:
                        os.kill(self.pid, sig)
                    except ProcessLookupError:
                        pass

    def read(self):
        try:
            return os.read(self.master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return b""
            raise

    def close(self):
        try:
            if self.poll() is None:
                self.signal(signal.SIGHUP)
                deadline = time.monotonic() + 0.5
                while self.poll() is None and time.monotonic() < deadline:
                    select.select([], [], [], 0.01)
                if self.status is None:
                    self.signal(signal.SIGKILL)
                    _, self.status = os.waitpid(self.pid, 0)
        finally:
            os.close(self.slave)
            os.close(self.master)

    def exit_code(self):
        code = os.waitstatus_to_exitcode(self.status)
        return 128 - code if code < 0 else code
