import ctypes
import fcntl
import json
import os
import pty
import select
import signal
import socket
import stat
import struct
import sys
import tempfile
import termios
import time
import unittest
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parents[1] / "scripts"
sys.dont_write_bytecode = True
sys.path.insert(0, str(SCRIPTS))
from agy_control import endpoint
from agy_session import CAPACITY, NOTICE, PASTE, QUIET
from agy_screen import Screen

REPLAY = json.loads((HERE / "fixtures" / "agy-1.5.14.json").read_bytes())
FRAMES = {k: v.encode() for k, v in REPLAY["frames"].items()}
WELCOME = json.loads((HERE / "fixtures" / "agy-welcome-inline.json").read_bytes())
ECHO = b"\x1b[?25l\r\n\n\x1b[J\x1b[2A\x1b[2C" + NOTICE.encode() + b"\x1b[?25h"


def interpreter():
    if sys.platform == "darwin":
        path = ctypes.create_string_buffer(4096)
        assert ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidpath(
            os.getpid(), path, len(path)) > 0
        return os.fsdecode(path.value)
    return os.readlink("/proc/self/exe")


class LauncherFixture(unittest.TestCase):
    launcher_args = ("--name", "worker", "--team", "test")
    launcher_env = {}

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "agy").symlink_to(interpreter())
        control = str(self.root / "fixture.sock")
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(control)
            server.listen()
            server.settimeout(4)
            self.pid, self.master = pty.fork()
            if self.pid == 0:
                try:
                    size = struct.pack("HHHH", 35, 110, 0, 0)
                    fcntl.ioctl(0, termios.TIOCSWINSZ, size)
                    os.environ["PATH"] = str(self.root) + ":" + os.environ["PATH"]
                    os.environ.update(self.launcher_env)
                    os.execv(sys.executable, [sys.executable, str(SCRIPTS / "xats-agy"),
                             *self.launcher_args, "--", "-I", "-S",
                             str(HERE / "agy-fixture.py"), control,
                             "--conversation", "fixture-id"])
                finally:
                    os._exit(126)
            self.addCleanup(self.cleanup_child)
            self.wire, _ = server.accept()
        self.addCleanup(self.wire.close)
        self.wire.settimeout(3)
        self.reader = self.wire.makefile("rb")
        self.addCleanup(self.reader.close)
        self.meta = json.loads(self.reader.readline())
        self.ident = {k: self.meta[k] for k in ("name", "team", "launch_id")}
        self.path = Path("/tmp", f"xats-agy-{os.getuid()}",
                         self.ident["launch_id"] + ".sock")

    def cleanup_child(self):
        try:
            if self.pid:
                os.kill(self.pid, signal.SIGTERM)
                os.waitpid(self.pid, 0)
        finally:
            os.close(self.master)

    def command(self, *parts):
        self.wire.sendall(json.dumps(parts).encode() + b"\n")

    def send(self, op, **fields):
        sock = socket.socket(socket.AF_UNIX)
        self.addCleanup(sock.close)
        sock.settimeout(3)
        sock.connect(str(self.path))
        sock.sendall(json.dumps({**self.ident, "op": op, **fields}).encode() + b"\n")
        return sock

    def status(self, sock):
        with sock:
            return json.loads(sock.recv(1024))["status"]

    def paint(self, raw):
        self.command("paint", raw.hex())
        actual = bytearray()
        while len(actual) < len(raw):
            self.assertTrue(select.select([self.master], [], [], 2)[0])
            actual.extend(os.read(self.master, 65536))
        self.assertEqual(actual, raw)


class LauncherTest(LauncherFixture):
    def test_identity_schema_resize_exit(self):
        self.assertEqual(self.meta["argv"], ["--conversation", "fixture-id"])
        self.assertEqual(int(self.meta["pid"]), self.meta["self"])
        self.assertEqual(uuid.UUID(self.ident["launch_id"]).version, 4)
        self.assertEqual(self.ident["name"], "worker")
        self.assertEqual(self.ident["team"], "test")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        self.assertEqual(self.status(self.send("probe")), "ready")
        for field in ("name", "team", "launch_id", "body", "prompt"):
            self.assertEqual(self.status(self.send("wake", **{field: "x"})),
                             "unavailable")
        self.assertEqual(self.status(self.send("other")), "unavailable")
        self.assertEqual(self.status(self.send("wake")), "busy")
        os.write(self.master, b"\x03user")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\x03user")
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 78, 0, 0))
        until = time.monotonic() + 2
        while True:
            self.command("size")
            if json.loads(self.reader.readline()) == [20, 78]:
                break
            self.assertLess(time.monotonic(), until)
            time.sleep(0.02)
        self.command("exit")
        self.assertIn(b"last output", os.read(self.master, 1024))
        _, status = os.waitpid(self.pid, 0)
        self.pid = None
        self.assertEqual(os.waitstatus_to_exitcode(status), 23)
        self.assertFalse(self.path.exists())

    def idle(self, frame=FRAMES["baseline"]):
        self.paint(frame)
        time.sleep(QUIET + 0.06)

    def paste(self, frame=FRAMES["baseline"]):
        self.idle(frame)
        pending = self.send("wake")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), PASTE)
        return pending

    def test_verified_echo_before_enter(self):
        pending = self.paste()
        self.assertFalse(select.select([self.wire], [], [], QUIET * 2)[0])
        self.assertEqual(self.status(self.send("wake")), "busy")
        self.paint(ECHO)
        self.assertEqual(self.status(pending), "delivered")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\r")
        self.assertEqual(self.status(self.send("wake")), "busy")

    def test_user_input_cancels_enter(self):
        pending = self.paste()
        self.paint(ECHO)
        original = "用户\r".encode()
        os.write(self.master, original)
        self.assertEqual(self.status(pending), "busy")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\x15")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])
        self.paint(b"\r\x1b[2C\x1b[K\r\n\n\x1b[90m? for shortcuts"
                   b"\r\x1b[m\x1b[2A\x1b[2C")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), original)

    def test_narrow_terminal_refuses_before_paste(self):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 40, 0, 0))
        until = time.monotonic() + 2
        while True:
            self.command("size")
            if json.loads(self.reader.readline()) == [35, 40]:
                break
            self.assertLess(time.monotonic(), until)
        frame = FRAMES["baseline"]
        suffix = frame[frame.index(b"\x1b[90m" + "─".encode()):]
        frame = b"\x1b[?2004h\x1b[H\x1b[2J" + suffix.replace(
            ("─" * 110).encode(), ("─" * 40).encode())
        screen = Screen(struct.pack("HHHH", 35, 40, 0, 0))
        screen.feed(frame)
        self.assertTrue(screen.composer(""))
        self.paint(frame)
        time.sleep(QUIET + 0.06)
        self.assertEqual(self.status(self.send("wake")), "busy")
        self.assertFalse(select.select([self.wire], [], [], 0)[0])

    def test_auto_mode_echo(self):
        pending = self.paste(WELCOME["frame"].encode())
        self.paint(b"\x1b[K" + ECHO)
        self.assertEqual(self.status(pending), "delivered")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\r")

    def test_foreground_switch_blocks_enter(self):
        pending = self.paste()
        self.command("foreground")
        self.assertEqual(json.loads(self.reader.readline()), "foreground")
        self.paint(ECHO)
        self.assertEqual(self.status(self.send("probe")), "ready")
        self.assertEqual(self.status(pending), "busy")
        self.assertFalse(select.select([self.wire], [], [], 0)[0])

    def test_extra_reader_in_foreground_group(self):
        self.idle()
        self.command("same_group")
        self.assertEqual(json.loads(self.reader.readline()), "foreground")
        self.assertEqual(self.status(self.send("probe")), "ready")
        self.assertEqual(self.status(self.send("wake")), "busy")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])

    def test_disconnect_rolls_back(self):
        pending = self.paste()
        pending.close()
        self.paint(ECHO)
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\x15")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])

    def test_approval_and_unconfirmed_paste(self):
        pending = self.paste()
        self.paint(b"\r\n\nRequesting permission for: Run this command?")
        os.write(self.master, b"user\r")
        self.assertEqual(self.status(pending), "busy")
        self.assertFalse(select.select([self.wire], [], [], 0)[0])

    def test_escape_approval_then_restore_buffer(self):
        pending = self.paste()
        self.paint(b"\r\n\nRequesting permission for: Run this command?")
        self.assertEqual(self.status(pending), "busy")
        os.write(self.master, b"user\r")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])
        os.write(self.master, b"\x1b")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\x1b")
        self.paint(b"\x1b[H\x1b[2J" + FRAMES["baseline"])
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"user\r")

    def test_manual_takeover_after_unknown_output(self):
        pending = self.paste()
        self.paint(b"\x1b[555z")
        self.assertEqual(self.status(pending), "busy")
        os.write(self.master, b"user\r")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])
        os.write(self.master, b"\x1d")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])
        os.write(self.master, b"manual")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"manual")
        self.assertEqual(self.status(self.send("probe")), "ready")
        self.assertEqual(self.status(self.send("wake")), "busy")

    def test_overflow_warns_and_preserves_manual_escape(self):
        pending = self.paste()
        self.paint(b"\x1b[555z")
        self.assertEqual(self.status(pending), "busy")
        self.check_overflow_recovery()

    def test_overflow_while_waiting_for_erase_echo(self):
        pending = self.paste()
        self.paint(ECHO)
        os.write(self.master, b"user\r")
        self.assertEqual(self.status(pending), "busy")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\x15")
        self.check_overflow_recovery()

    def check_overflow_recovery(self):
        os.set_blocking(self.master, False)
        data = memoryview(b"x" * (CAPACITY + 32768) + b"user\r")
        until = time.monotonic() + 4
        while data:
            self.assertTrue(select.select([], [self.master], [], 1)[1])
            data = data[os.write(self.master, data[:8192]):]
            self.assertLess(time.monotonic(), until)
        self.assertTrue(select.select([self.master], [], [], 1)[0])
        self.assertIn("Ctrl+]".encode(), os.read(self.master, 4096))
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])
        os.write(self.master, b"\x1d")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])
        os.write(self.master, b"manual")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"manual")

    def test_consecutive_empty_backspaces_without_output(self):
        self.idle()
        keys = b"\x7f\x08\x7f"
        os.write(self.master, keys)
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), keys)
        time.sleep(QUIET + 0.06)
        pending = self.send("wake")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), PASTE)
        pending.close()

    def test_noop_requires_new_frame(self):
        self.idle()
        os.write(self.master, b"\x1b[D")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\x1b[D")
        time.sleep(QUIET + 0.06)
        self.assertEqual(self.status(self.send("wake")), "busy")
        self.paint(b"\x1b[?25l\r\x1b[2C\x1b[?25h")
        time.sleep(QUIET + 0.06)
        pending = self.send("wake")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), PASTE)
        pending.close()

    def test_synchronized_draft_redraw_then_clear_without_cursor_toggles(self):
        self.idle()
        for stage, keys in (("draft", b"XATS_DRAFT_FIXTURE"), ("clear", b"\x7f" * 18)):
            os.write(self.master, keys)
            self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), keys)
            delta = FRAMES[stage].replace(b"\x1b[?25h", b"").replace(b"\x1b[?25l", b"")
            self.paint(b"\x1b[?2026h" + delta)
            self.assertEqual(self.status(self.send("wake")), "busy")
            self.paint(b"\x1b[?2026l")
            time.sleep(QUIET + 0.06)
            if stage == "draft":
                self.assertEqual(self.status(self.send("wake")), "busy")
        pending = self.send("wake")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), PASTE)
        self.paint(ECHO)
        self.assertEqual(self.status(pending), "delivered")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\r")

    def test_input_during_a_preexisting_sync_frame_waits_for_a_new_frame(self):
        self.idle()
        self.paint(b"\x1b[?2026h")
        os.write(self.master, b"x")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"x")
        self.paint(b"\x1b[?25h\x1b[?2026l")
        time.sleep(QUIET + 0.06)
        self.assertEqual(self.status(self.send("wake")), "busy")
        self.assertFalse(select.select([self.wire], [], [], 0)[0])

    def test_submit_is_not_noop(self):
        self.idle()
        os.write(self.master, b"user\r")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"user\r")
        os.write(self.master, b"\x08\x7f")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\x08\x7f")
        self.paint(b"\x1b[?25l\r\x1b[2C\x1b[?25h")
        time.sleep(QUIET + 0.06)
        self.assertEqual(self.status(self.send("wake")), "busy")

    def test_two_deliveries_with_history(self):
        first = self.paste()
        self.paint(ECHO)
        self.assertEqual(self.status(first), "delivered")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\r")
        self.paint(b"\r\n\nWorking... esc to cancel")
        self.assertEqual(self.status(self.send("wake")), "busy")
        frame = FRAMES["baseline"]
        edit = frame.index(b"\x1b[90m" + "─".encode())
        history = "旧对话\r\n上一封已回复\r\n".encode()
        self.paint(b"\x1b[H\x1b[2J" + history + frame[edit:])
        time.sleep(QUIET + 0.06)
        second = self.send("wake")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), PASTE)
        self.paint(ECHO)
        self.assertEqual(self.status(second), "delivered")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\r")

    def test_conversation_with_restored_history(self):
        data = json.loads((HERE / "fixtures" / "agy-first-reply.json").read_bytes())
        self.assertEqual(self.meta["argv"], ["--conversation", "fixture-id"])
        self.paint(data["welcome"].encode())
        self.paint(data["first_reply_delta"].encode())
        time.sleep(QUIET + 0.06)
        pending = self.send("wake")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), PASTE)
        self.paint(ECHO)
        self.assertEqual(self.status(pending), "delivered")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\r")

    def test_live_replay(self):
        for key in REPLAY["replay_order"]:
            with self.subTest(key=key):
                self.paint(FRAMES[key])
                time.sleep(QUIET + 0.06)
                self.assertEqual(self.status(self.send("probe")), "ready")
                if key in ("draft", "menu", "modal"):
                    self.assertEqual(self.status(self.send("wake")), "busy")
                    self.assertFalse(select.select([self.wire], [], [], 0)[0])

    def test_stop_continue_and_terminate(self):
        os.kill(self.meta["self"], signal.SIGSTOP)
        until = time.monotonic() + 2
        while self.status(self.send("probe")) != "unavailable":
            self.assertLess(time.monotonic(), until)
        os.kill(self.meta["self"], signal.SIGCONT)
        while self.status(self.send("probe")) != "ready":
            self.assertLess(time.monotonic(), until)
        os.kill(self.pid, signal.SIGTERM)
        _, status = os.waitpid(self.pid, 0)
        self.pid = None
        self.assertEqual(os.waitstatus_to_exitcode(status), 128 + signal.SIGTERM)
        self.assertFalse(self.path.exists())

    def test_sighup_releases_socket_immediately_while_child_still_exiting(self):
        self.command("ignore_hup")
        self.assertEqual(json.loads(self.reader.readline()), "ignored")
        os.kill(self.pid, signal.SIGINT)
        time.sleep(0.05)
        self.assertTrue(self.path.exists())
        self.assertEqual(self.status(self.send("probe")), "ready")
        os.kill(self.pid, signal.SIGHUP)
        until = time.monotonic() + 0.4
        while self.path.exists():
            self.assertLess(time.monotonic(), until)
            time.sleep(0.01)
        # Child ignored SIGHUP, so launcher should still be waiting for SIGKILL timeout
        # while the socket is already gone for replacement handoff.
        self.assertEqual(os.waitpid(self.pid, os.WNOHANG), (0, 0))
        _, status = os.waitpid(self.pid, 0)
        self.pid = None
        self.assertEqual(os.waitstatus_to_exitcode(status), 128 + signal.SIGKILL)

    def test_replaced_image(self):
        self.command("replace")
        self.reader.readline()
        self.assertEqual(self.status(self.send("probe")), "unavailable")
        self.assertEqual(self.status(self.send("wake")), "unavailable")


class ReplayTest(unittest.TestCase):
    def test_hpa_and_rep_match_uncompressed_terminal_output(self):
        for compressed, expanded in (
            (b"\x1b[6`X\x1b[7b", b"\x1b[6GXXXXXXXX"),
            (b"\x1b[99`A\x1b[0b", b"\x1b[99GAA"),
            ("\x1b[`\x1b[90m─\x1b[19b".encode(),
             ("\x1b[1G\x1b[90m" + "─" * 20).encode()),
        ):
            with self.subTest(compressed=compressed):
                actual, expected = [Screen(struct.pack("HHHH", 4, 20, 0, 0))
                                    for _ in range(2)]
                for byte in compressed:
                    actual.feed(bytes([byte]))
                expected.feed(expanded)
                self.assertTrue(actual.valid)
                self.assertEqual(actual.lines, expected.lines)
                self.assertEqual((actual.y, actual.x), (expected.y, expected.x))

    def test_rep_requires_an_immediately_preceding_supported_glyph(self):
        for prefix in (b"", b"A\r", b"A\x1b[1G", b"A\x1b]0;title\x07",
                       "界".encode(), "e\u0301".encode()):
            screen = Screen(struct.pack("HHHH", 4, 20, 0, 0))
            screen.feed(prefix + b"\x1b[7b")
            self.assertFalse(screen.valid, prefix)
        screen = Screen(struct.pack("HHHH", 4, 20, 0, 0))
        screen.feed(b"A\x1b[999999999b")
        self.assertFalse(screen.valid)

    def test_neon_native_redraws(self):
        data = json.loads((HERE / "fixtures" / "agy-neon-high.json").read_bytes())
        screen = Screen(struct.pack("HHHH", data["rows"], data["cols"], 0, 0))
        for state in data["replay_order"]:
            screen.feed(data["frames"][state].encode())
            with self.subTest(state=state):
                self.assertEqual(screen.composer(""), state in ("idle", "cleared"))

    def test_gemini_neon_effort_footer(self):
        cols = 195
        label = "auto · Gemini 4 Neon · high"
        border = "─" * cols
        for draft, footer in (("", label), ("未提交", label),
                              ("", label + " · approval")):
            with self.subTest(draft=draft, footer=footer):
                screen = Screen(struct.pack("HHHH", 51, cols, 0, 0))
                body = " " + draft if draft else ""
                screen.feed((
                    f"\x1b[?2004h\x1b[90m{border}\r\n\x1b[94m>\x1b[m{body}"
                    f"\r\n\x1b[90m{border}\r\n? for shortcuts"
                    f"\x1b[{cols - len(footer) + 1}G\x1b[33mauto\x1b[39;2m · "
                    f"\x1b[2m{footer[7:]}"
                    "\r\x1b[m\x1b[2A\x1b[2C\x1b[?25h"
                ).encode())
                self.assertEqual(screen.composer(""), not draft and footer == label)

    def test_first_real_reply(self):
        data = json.loads((HERE / "fixtures" / "agy-first-reply.json").read_bytes())
        screen = Screen(struct.pack("HHHH", data["rows"], data["cols"], 0, 0))
        screen.feed(data["welcome"].encode())
        self.assertTrue(screen.composer(""))
        parts = data["first_reply_delta"].split("\x1b[?25h")
        for i, chunk in enumerate(parts[:-1]):
            screen.feed((chunk + "\x1b[?25h").encode())
            self.assertTrue(screen.valid, i)
            self.assertEqual(screen.composer(""), i == len(parts) - 2, i)
            if i == 0:
                self.assertTrue(screen.composer(NOTICE))
        screen.feed(parts[-1].encode())
        self.assertTrue(screen.composer(""))

    def test_tab_stops_in_scrollback(self):
        screen = Screen(struct.pack("HHHH", 10, 20, 0, 0))
        for data, x in ((b"\t", 8), (b"\t", 16), (b"\t", 19),
                        (b"\x1b[3g\r\x1b[4G\x1bH\r\t", 3),
                        (b"\x1b[?5W\r\t", 8)):
            screen.feed(data)
            self.assertEqual(screen.x, x)
            self.assertTrue(screen.valid)
        screen.feed(b"\r1234567890\r\tX")
        self.assertEqual(screen.lines[0][7][0], "8")
        self.assertEqual(screen.lines[0][8][0], "X")

    def test_backward_tabs_use_configured_stops_and_preserve_text(self):
        screen = Screen(struct.pack("HHHH", 4, 203, 0, 0))
        screen.feed(b"abcd\x1b[202G\x1b[21Z")
        self.assertTrue(screen.valid)
        self.assertEqual((screen.y, screen.x), (0, 40))
        screen.feed(b"\x1b[3g\x1b[4G\x1bH\x1b[90G\x1b[Z")
        self.assertEqual(screen.x, 3)
        screen.feed(b"\x1b[0Z")
        self.assertEqual(screen.x, 0)
        self.assertEqual([cell[0] for cell in screen.lines[0].values()], list("abcd"))

    def test_incremental_and_fragmented(self):
        for step in (1, 4096):
            screen = Screen(struct.pack("HHHH", REPLAY["rows"], REPLAY["cols"], 0, 0))
            for key in REPLAY["replay_order"]:
                with self.subTest(key=key, step=step):
                    frame = FRAMES[key]
                    for i in range(0, len(frame), step):
                        screen.feed(frame[i:i + step])
                    self.assertTrue(screen.valid)
                    self.assertEqual(screen.composer(""), key in ("baseline", "clear"))
                    self.assertEqual(screen.composer("XATS_DRAFT_FIXTURE"),
                                     key == "draft")


    def test_sparse_placeholder(self):
        raw = WELCOME["frame"].replace("Auto mode:", "Auto\x1b[1Cmode:")
        screen = Screen(struct.pack("HHHH", 35, 110, 0, 0))
        screen.feed(raw.encode())
        self.assertTrue(screen.valid)
        self.assertFalse(screen.composer(""))

    def test_history_and_active_cancel(self):
        native = FRAMES["baseline"]
        start = native.index(b"\x1b[90m" + "─".encode())
        screen = Screen(struct.pack("HHHH", 35, 110, 0, 0))
        screen.feed(b"\x1b[?2004hEsc to cancel\r\n\n" + native[start:])
        self.assertTrue(screen.composer(""))
        screen.feed(b"\r\n\nEsc to cancel\x1b[K\r\x1b[2A\x1b[2C")
        self.assertTrue(screen.blocked())
        self.assertFalse(screen.composer(""))

    def test_combining_history_and_true_full_repaint(self):
        screen = Screen(struct.pack("HHHH", 35, 110, 0, 0))
        screen.feed("Cafe\u0301".encode())
        self.assertTrue(screen.valid)
        self.assertEqual(screen.x, 4)
        self.assertEqual(screen.lines[0][3][0], "e\u0301")
        screen.feed(b"\x1b[555z")
        self.assertFalse(screen.valid)
        screen.feed(b"\x1bP\x1b[H\x1b[2J\x1b\\")
        self.assertFalse(screen.valid)
        screen.feed(b"\x1b[H\x1b[2J")
        self.assertTrue(screen.valid)
        self.assertFalse(screen.composer(""))
        screen.feed(FRAMES["baseline"])
        self.assertTrue(screen.composer(""))

    def test_user_text_is_not_placeholder(self):
        raw = WELCOME["frame"].encode()
        for raw_case, idle in ((raw, True), (raw.replace(b"[90mAuto mode:",
                                                         b"[39mAuto mode:"), False)):
            screen = Screen(struct.pack("HHHH", 35, 110, 0, 0))
            screen.feed(raw_case)
            self.assertEqual(screen.composer(""), idle)


class EndpointTest(unittest.TestCase):
    def test_insecure_directory(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root) / f"xats-agy-{os.getuid()}"
            for mode in ("symlink", "public"):
                if mode == "symlink":
                    directory.symlink_to(root)
                else:
                    directory.mkdir()
                    directory.chmod(0o755)
                with self.assertRaises(PermissionError), endpoint("test", Path(root)):
                    self.fail("insecure listener")
                if directory.is_symlink():
                    directory.unlink()


if __name__ == "__main__":
    unittest.main()
