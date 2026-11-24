import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from test_xats_agy import SCRIPTS, interpreter

BIND_CLI = SCRIPTS / "xats-agy-channel-bind"
sys.dont_write_bytecode = True


def _write_fake_agentapi_exe(root: Path, log_path: Path, fail_flag: Path, slow_flag: Path):
    exe = root / "fake-agentapi"
    exe.write_text(f"""#!{sys.executable}
import json, os, sys, time
from pathlib import Path

if Path({str(slow_flag)!r}).exists():
    time.sleep(5)
entry = {{
    "argv": sys.argv[1:],
    "ls": os.environ.get("ANTIGRAVITY_LS_ADDRESS"),
    "csrf": os.environ.get("ANTIGRAVITY_CSRF_TOKEN"),
    "conv": os.environ.get("ANTIGRAVITY_CONVERSATION_ID"),
}}
with open({str(log_path)!r}, "a") as fh:
    fh.write(json.dumps(entry) + "\\n")
if Path({str(fail_flag)!r}).exists():
    sys.stderr.write("send failed\\n")
    sys.exit(1)
print(json.dumps({{"response": {{"sendMessage": {{"recipientId": entry["conv"]}}}}}}))
sys.exit(0)
""")
    exe.chmod(0o755)
    return exe


def _write_child_script(root: Path):
    script = root / "child_fixture.py"
    script.write_text("""import json, os, signal, sys, time
from pathlib import Path

ready = Path(sys.argv[1])
meta = {
    "launch_id": os.environ.get("XATS_AGY_LAUNCH_ID"),
    "bind_token": os.environ.get("XATS_AGY_BIND_TOKEN"),
    "agentapi": os.environ.get("XATS_AGY_AGENTAPI"),
    "pid": os.environ.get("XATS_AGY_PID"),
    "self": os.getpid(),
    "has_key": "XATS_AGY_IDENTITY_KEY" in os.environ,
    "argv": sys.argv[2:],
}
ready.write_text(json.dumps(meta))
signal.signal(signal.SIGHUP, signal.SIG_IGN)
while True:
    time.sleep(0.1)
""")
    return script


class AgentApiLauncherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.log_path = self.root / "agentapi.jsonl"
        self.fail_flag = self.root / "fail_send"
        self.slow_flag = self.root / "slow_send"
        self.ready = self.root / "ready.json"
        (self.root / "agy").symlink_to(interpreter())
        self.child_script = _write_child_script(self.root)
        self.fake_agentapi = _write_fake_agentapi_exe(
            self.root, self.log_path, self.fail_flag, self.slow_flag)
        self.proc = None

    def _start(self, *launcher_args, extra_env=None):
        env = os.environ.copy()
        env["PATH"] = f"{self.root}:{env['PATH']}"
        if extra_env:
            env.update(extra_env)
        # stdin=DEVNULL proves --agentapi does NOT require a TTY!
        self.proc = subprocess.Popen(
            [sys.executable, str(SCRIPTS / "xats-agy"), "--agentapi",
             *launcher_args, "--", "-I", "-S", str(self.child_script),
             str(self.ready), "--conversation", "conv-arg"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        self.addCleanup(self._cleanup_proc)
        until = time.monotonic() + 3.0
        while not self.ready.exists():
            self.assertLess(time.monotonic(), until, "fake agy did not start")
            time.sleep(0.02)
        meta = json.loads(self.ready.read_text())
        sock_path = Path("/tmp", f"xats-agy-{os.getuid()}", f"{meta['launch_id']}.sock")
        return meta, sock_path

    def _cleanup_proc(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()

    def _rpc(self, sock_path, payload):
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(3.0)
            sock.connect(str(sock_path))
            sock.sendall(json.dumps(payload).encode("utf-8") + b"\n")
            with sock.makefile("rb") as stream:
                return json.loads(stream.readline())

    def test_named_agentapi_bind_wake_update_and_fast_sighup_release(self):
        meta, sock_path = self._start("--name", "worker", "--team", "demo")
        self.assertEqual(meta["agentapi"], "1")
        self.assertEqual(int(meta["pid"]), meta["self"])
        self.assertEqual(meta["argv"], ["--conversation", "conv-arg"])
        launch_id = meta["launch_id"]

        # Probe succeeds immediately; wake is busy until xats-agy-channel-bind runs
        self.assertEqual(
            self._rpc(sock_path, {"op": "probe", "launch_id": launch_id, "name": "worker", "team": "demo"}),
            {"status": "ready"},
        )
        self.assertEqual(
            self._rpc(sock_path, {"op": "wake", "launch_id": launch_id, "name": "worker", "team": "demo"}),
            {"status": "busy"},
        )
        diag = self._rpc(sock_path, {"op": "diagnose", "launch_id": launch_id, "name": "worker", "team": "demo"})
        self.assertEqual(diag["current"], "awaiting_agentapi_bind")
        self.assertEqual(diag["last_busy"], "awaiting_agentapi_bind")
        self.assertEqual(diag["busy_count"], 1)

        # Invalid bind token is rejected
        conv1 = str(uuid.uuid4())
        bad_env = {
            **os.environ,
            "XATS_AGY_LAUNCH_ID": launch_id,
            "XATS_AGY_BIND_TOKEN": "wrong-token",
            "ANTIGRAVITY_CONVERSATION_ID": conv1,
            "ANTIGRAVITY_LS_ADDRESS": "127.0.0.1:43210",
            "ANTIGRAVITY_CSRF_TOKEN": "csrf-secret",
            "ANTIGRAVITY_AGENTAPI_EXE": str(self.fake_agentapi),
        }
        bad = subprocess.run([sys.executable, str(BIND_CLI)], env=bad_env, capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1)
        self.assertIn("invalid_token", bad.stderr)
        self.assertNotIn("csrf-secret", bad.stderr)

        # Zero-arg xats-agy-channel-bind succeeds with valid env
        good_env = {**bad_env, "XATS_AGY_BIND_TOKEN": meta["bind_token"]}
        good = subprocess.run([sys.executable, str(BIND_CLI)], env=good_env, capture_output=True, text=True)
        self.assertEqual(good.returncode, 0, good.stderr)
        self.assertIn("bound", good.stdout)
        self.assertNotIn("csrf-secret", good.stdout)

        # Diagnose is now ready, and wake delivers natively via agentapi send-message
        diag2 = self._rpc(sock_path, {"op": "diagnose", "launch_id": launch_id, "name": "worker", "team": "demo"})
        self.assertEqual(diag2["current"], "ready")
        self.assertEqual(
            self._rpc(sock_path, {"op": "wake", "launch_id": launch_id, "name": "worker", "team": "demo"}),
            {"status": "delivered"},
        )
        entries = [json.loads(line) for line in self.log_path.read_text().splitlines()]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["conv"], conv1)
        self.assertEqual(entries[0]["ls"], "127.0.0.1:43210")
        self.assertEqual(entries[0]["csrf"], "csrf-secret")
        self.assertEqual(entries[0]["argv"][:3], ["agentapi", "send-message", "--title=xats"])
        self.assertEqual(entries[0]["argv"][3], conv1)

        # --update-conversation <uuid> switches target conversation_id in memory
        conv2 = str(uuid.uuid4())
        upd = subprocess.run(
            [sys.executable, str(BIND_CLI), "--update-conversation", conv2],
            env=good_env,
            capture_output=True, text=True,
        )
        self.assertEqual(upd.returncode, 0, upd.stderr)
        self.assertEqual(
            self._rpc(sock_path, {"op": "wake", "launch_id": launch_id, "name": "worker", "team": "demo"}),
            {"status": "delivered"},
        )
        entries = [json.loads(line) for line in self.log_path.read_text().splitlines()]
        self.assertEqual(entries[-1]["conv"], conv2)

        # Failing agentapi send-message honestly reports unavailable
        self.fail_flag.write_text("1")
        failed = self._rpc(sock_path, {"op": "wake", "launch_id": launch_id, "name": "worker", "team": "demo"})
        self.assertEqual(failed["status"], "unavailable")
        self.fail_flag.unlink()

        # Slow agentapi send-message (e.g. Gatekeeper scan after agy auto-update)
        # returns busy so the daemon retries automatically
        self.slow_flag.write_text("1")
        timed_out = self._rpc(sock_path, {"op": "wake", "launch_id": launch_id, "name": "worker", "team": "demo"})
        self.assertEqual(timed_out, {"status": "busy"})
        diag3 = self._rpc(sock_path, {"op": "diagnose", "launch_id": launch_id, "name": "worker", "team": "demo"})
        self.assertEqual(diag3["last_busy"], "agentapi_timeout")
        self.slow_flag.unlink()

        # SIGHUP immediately unlinks socket even while child ignores SIGHUP
        self.proc.send_signal(signal.SIGHUP)
        until = time.monotonic() + 0.4
        while sock_path.exists():
            self.assertLess(time.monotonic(), until)
            time.sleep(0.01)
        self.assertIsNone(self.proc.poll())
        self.proc.wait(timeout=3.0)

    def test_deferred_agentapi_strips_identity_key_from_child(self):
        meta, _ = self._start(
            "--defer-registration",
            extra_env={"XATS_AGY_IDENTITY_KEY": "slot-secret-key-0123456789"},
        )
        self.assertFalse(meta["has_key"])
        self.assertEqual(meta["agentapi"], "1")


if __name__ == "__main__":
    unittest.main()
