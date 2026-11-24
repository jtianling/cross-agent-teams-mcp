import json
import os
import select
import signal
import struct
import sys
import subprocess
import termios
import time
import tty
import unittest
from unittest.mock import Mock, patch

from test_xats_agy import ECHO, FRAMES, NOTICE, PASTE, QUIET, SCRIPTS, LauncherFixture
from agy_process import Child
from agy_screen import Screen
from agy_session import Session


class ReasonTest(LauncherFixture):
    def diagnostic(self):
        with self.send("diagnose") as sock:
            return json.loads(sock.recv(4096))

    def begin_paste(self):
        self.paint(FRAMES["baseline"])
        time.sleep(QUIET + 0.06)
        pending = self.send("wake")
        self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), PASTE)
        return pending

    def test_timeout_reports_missing_echo_across_rollback_and_diagnosis(self):
        pending = self.begin_paste()
        screen = Screen(struct.pack("HHHH", 35, 110, 0, 0))
        screen.feed(FRAMES["baseline"])
        reason = screen.composer_reason(NOTICE)
        self.assertIsNotNone(reason)
        self.assertEqual(self.diagnostic(), {
            "status": "diagnostic", "current": "phase_paste", "phase": "paste",
            "busy_count": 0, "last_busy": None,
        })
        self.assertEqual(self.status(pending), "busy")
        expected = {"status": "diagnostic", "current": "phase_rollback",
                    "phase": "rollback", "busy_count": 1, "last_busy": reason}
        self.assertEqual(self.diagnostic(), expected)
        self.assertEqual(self.diagnostic(), expected)
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])

    def test_timeout_with_echo_reports_the_foreground_guard(self):
        pending = self.begin_paste()
        self.command("same_group")
        self.assertEqual(json.loads(self.reader.readline()), "foreground")
        self.paint(ECHO)
        self.assertEqual(self.status(pending), "busy")
        report = self.diagnostic()
        self.assertEqual(report["last_busy"], "tty_not_exclusive")
        self.assertEqual(report["busy_count"], 1)
        self.assertEqual(report["phase"], "rollback")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])

    def test_diagnose_cli_observes_stop_and_continue_without_input(self):
        self.paint(FRAMES["baseline"])
        time.sleep(QUIET + 0.06)
        for sig, expected in ((signal.SIGSTOP, "child_stopped"),
                              (signal.SIGCONT, "ready")):
            os.kill(self.meta["self"], sig)
            report = subprocess.run(
                [sys.executable, str(SCRIPTS / "xats-agy"), "--diagnose",
                 self.ident["launch_id"], "--name", self.ident["name"],
                 "--team", self.ident["team"]],
                check=True, capture_output=True, timeout=2)
            self.assertEqual(json.loads(report.stdout), {
                "status": "diagnostic", "current": expected,
                "phase": "idle", "last_busy": None, "busy_count": 0,
            })
            self.assertEqual(self.status(self.send("probe")),
                             "ready" if sig == signal.SIGCONT else "unavailable")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])

    def test_cancel_records_user_input_before_rollback(self):
        pending = self.begin_paste()
        os.write(self.master, b"x\r")
        self.assertEqual(self.status(pending), "busy")
        self.assertEqual(self.diagnostic()["last_busy"], "user_input")
        self.assertFalse(select.select([self.wire], [], [], QUIET)[0])


class GuardTest(unittest.TestCase):
    def test_prepared_wake_counts_once_and_diagnosis_is_read_only(self):
        child = Mock()
        child.image_reason.return_value = None
        binding = Mock(bound=False)
        with patch("agy_session.window_size", return_value=struct.pack("4H", 35, 110, 0, 0)):
            session = Session(None, binding, child)
        for status in ("busy", "diagnose", "diagnose"):
            client = Mock()
            client.read.return_value = b'{}\n'
            binding.operation.return_value = {"status": status}
            session.clients[client.sock] = client
            session.request(client.sock)
            if status == "busy":
                client.finish.assert_called_once_with("busy")
            else:
                client.finish.assert_called_once_with(
                    "diagnostic", current="not_committed", phase="idle",
                    busy_count=1, last_busy="not_committed")
        self.assertFalse(session.await_change)
        self.assertIsNone(session.pending)

    def test_foreground_reason_does_not_drain_queued_bytes(self):
        child = Child.__new__(Child)
        child.master, child.slave = os.openpty()
        self.addCleanup(os.close, child.master)
        self.addCleanup(os.close, child.slave)
        child.pid = os.getpid()
        tty.setraw(child.slave)
        with patch("agy_process.exclusive_tty", return_value=True) as exclusive, \
             patch("agy_process.os.tcgetpgrp", return_value=child.pid) as group:
            self.assertIsNone(child.foreground_reason())
            os.write(child.master, b"x\r")
            self.assertTrue(select.select([child.slave], [], [], 1)[0])
            self.assertEqual(child.foreground_reason(), "tty_queued")
            self.assertFalse(child.foreground())
            self.assertEqual(os.read(child.slave, 2), b"x\r")
            attrs = termios.tcgetattr(child.slave)
            attrs[3] |= termios.ICANON
            termios.tcsetattr(child.slave, termios.TCSANOW, attrs)
            self.assertEqual(child.foreground_reason(), "tty_canonical")
            group.return_value = child.pid + 1
            self.assertEqual(child.foreground_reason(), "tty_foreground")
            exclusive.return_value = False
            self.assertEqual(child.foreground_reason(), "tty_not_exclusive")

    def test_failed_diagnostics_leave_session_available_for_the_next_request(self):
        child = Child.__new__(Child)
        child.pid, child.status, child.stopped = os.getpid(), None, False
        binding = Mock(bound=True)
        binding.operation.return_value = {"status": "diagnose"}
        with patch("agy_session.window_size", return_value=struct.pack("4H", 35, 110, 0, 0)):
            session = Session(None, binding, child)

        def query(current):
            client = Mock()
            client.read.return_value = b'{"op":"diagnose"}\n'
            session.clients[client.sock] = client
            session.request(client.sock)
            client.finish.assert_called_once_with(
                "diagnostic", current=current, phase="idle", last_busy=None, busy_count=0)

        with patch("agy_process.os.waitid", create=True, side_effect=ChildProcessError()):
            self.assertEqual(child._peek_state(), "child_state_unavailable")
            query("child_state_unavailable")
        with patch("agy_process.os.waitid", None, create=True):
            for error in (OSError("private details"), subprocess.TimeoutExpired("ps", 1)):
                with patch("agy_process.subprocess.run", side_effect=error) as run:
                    self.assertEqual(child._peek_state(), "child_state_unavailable")
                    query("child_state_unavailable")
                    self.assertGreater(run.call_args.kwargs["timeout"], 0)
            for code, stdout in ((1, b"R"), (0, b""), (0, b"?")):
                with patch("agy_process.subprocess.run",
                           return_value=Mock(returncode=code, stdout=stdout)):
                    self.assertEqual(child._peek_state(), "child_state_unavailable")
        with patch.object(child, "image_reason", return_value=None), \
             patch.object(session, "wake_reason", side_effect=ValueError("bad fd")):
            query("child_state_unavailable")
        with patch.object(child, "image_reason", return_value=None), \
             patch.object(session, "wake_reason", return_value=None):
            query("ready")
        self.assertFalse(session.await_change)
        self.assertIsNone(session.pending)

    def test_state_peek_leaves_stop_and_continue_for_waitpid(self):
        with subprocess.Popen(["/bin/sleep", "30"]) as process:
            child = Child.__new__(Child)
            child.pid, child.status, child.stopped = process.pid, None, False
            try:
                for sig, reason in ((signal.SIGSTOP, "child_stopped"),
                                    (signal.SIGCONT, None)):
                    os.kill(child.pid, sig)
                    until = time.monotonic() + 2
                    while child._peek_state() != reason:
                        self.assertLess(time.monotonic(), until)
                        time.sleep(0.01)
                    self.assertEqual(child._peek_state(), reason)
                    self.assertEqual(child.stopped, sig == signal.SIGCONT)
                    child.poll()
                    self.assertEqual(child.stopped, sig == signal.SIGSTOP)
            finally:
                process.kill()


if __name__ == "__main__":
    unittest.main()
