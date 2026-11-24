import hmac
import json
import os
import runpy
import select
import socket
import subprocess
import sys
import time
import unittest
import uuid
from argparse import Namespace
from unittest.mock import patch

from test_xats_agy import ECHO, FRAMES, PASTE, QUIET, SCRIPTS, LauncherFixture


KEY = "测试用-slot-key-0123456789"
STALE = {"XATS_AGY_IDENTITY_KEY": KEY, "XATS_IDENTITY_KEY": "old-key",
         "XATS_AGY_NAME": "old", "XATS_AGY_TEAM": "old",
         "AGY_NAME": "old", "AGY_TEAM": "old", "XATS_AGY_DEFER_REGISTRATION": "old",
         "XATS_AGY_LAUNCH_ID": "old", "XATS_AGY_PID": "old"}


class DeferredTest(LauncherFixture):
    launcher_args = ("--defer-registration",)
    launcher_env = STALE

    def setUp(self):
        super().setUp()
        self.labels = {"name": "收件人", "team": "甲组"}

    def signed(self, op, attempt=None, **labels):
        request = {"op": op, "launch_id": self.ident["launch_id"],
                   "attempt": attempt or str(uuid.uuid4())}
        if op != "status":
            request.update({**self.labels, **labels})
        message = "\0".join(("xats-agy-defer-v1", op, request["launch_id"],
                             request.get("name", ""), request.get("team", ""),
                             request["attempt"]))
        digest = hmac.new(KEY.encode(), message.encode(), "sha256")
        request["proof"] = digest.hexdigest()
        return request

    def connect(self, request):
        sock = socket.socket(socket.AF_UNIX)
        self.addCleanup(sock.close)
        sock.settimeout(3)
        sock.connect(str(self.path))
        sock.sendall(json.dumps(request).encode() + b"\n")
        return sock

    def exchange(self, request):
        with self.connect(request) as sock, sock.makefile("rb") as incoming:
            return json.loads(incoming.readline())

    def claim(self, op, attempt=None, **labels):
        return self.exchange(self.signed(op, attempt, **labels))

    def reject(self, result):
        self.assertEqual(set(result), {"status", "detail"})
        self.assertEqual(result["status"], "unavailable")
        self.assertRegex(result["detail"], r"^[a-z_]+$")

    def public(self, op, **labels):
        return {"op": op, "launch_id": self.ident["launch_id"], **self.labels, **labels}

    def test_bind_then_fresh_bridge_status_and_delivery(self):
        self.assertIsNone(self.meta["name"])
        self.assertIsNone(self.meta["team"])
        self.assertEqual(self.meta["defer"], "1")
        self.assertEqual(self.meta["inherited"], [])
        self.assertEqual(self.meta["pid"], str(self.meta["self"]))
        self.assertEqual(uuid.UUID(self.ident["launch_id"]).version, 4)
        self.assertEqual(self.claim("status"), {"status": "unbound"})
        attempt = str(uuid.uuid4())
        for op in ("probe", "wake"):
            self.reject(self.exchange(self.public(op)))
        self.assertEqual(self.claim("prepare", attempt), {"status": "prepared"})
        self.assertEqual(self.claim("status"), {"status": "unbound"})
        self.assertEqual(self.exchange(self.public("probe")), {"status": "ready"})
        self.reject(self.exchange(self.public("probe", team="乙组")))
        self.paint(FRAMES["baseline"])
        time.sleep(QUIET + 0.06)
        self.assertEqual(self.exchange(self.public("wake")), {"status": "busy"})
        self.assertFalse(select.select([self.wire], [], [], 0)[0])
        self.assertEqual(self.claim("commit", attempt), {"status": "bound"})
        recovered = self.claim("status")
        self.assertEqual(recovered, {"status": "bound", **self.labels})
        self.assertEqual(self.claim("prepare"), {"status": "bound"})
        self.reject(self.claim("prepare", name="乙"))
        self.reject(self.claim("abort", attempt))
        self.assertEqual(self.claim("commit", attempt), {"status": "bound"})
        with self.connect(self.public("wake", name=recovered["name"])) as pending:
            self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), PASTE)
            self.paint(ECHO)
            self.assertEqual(json.loads(pending.recv(1024)), {"status": "delivered"})
            self.assertEqual(bytes.fromhex(json.loads(self.reader.readline())), b"\r")

    def test_bound_status_fits_bridge_frame_for_unicode_labels(self):
        self.labels = {"name": "🍊" * 256, "team": "🍋" * 256}
        attempt = str(uuid.uuid4())
        self.assertEqual(self.claim("prepare", attempt), {"status": "prepared"})
        self.assertEqual(self.claim("commit", attempt), {"status": "bound"})
        with self.connect(self.signed("status")) as sock, sock.makefile("rb") as reply:
            line = reply.readline(4097)
        self.assertLessEqual(len(line), 4096)
        self.assertEqual(json.loads(line), {"status": "bound", **self.labels})

    def test_lost_prepare_reply_and_retry_fences(self):
        first, retry, last = (str(uuid.uuid4()) for _ in range(3))
        self.connect(self.signed("prepare", first)).close()
        until = time.monotonic() + 2
        while self.exchange(self.public("probe"))["status"] != "ready":
            self.assertLess(time.monotonic(), until)
        self.reject(self.claim("prepare", retry, team="乙组"))
        for attempt in (retry, retry, last):
            self.assertEqual(self.claim("prepare", attempt), {"status": "prepared"})
            self.reject(self.claim("abort", attempt))
        for op in ("prepare", "commit", "abort"):
            for stale in (first, retry):
                self.reject(self.claim(op, stale))
        self.assertEqual(self.claim("commit", last), {"status": "bound"})
        self.reject(self.claim("commit", first))

    def test_first_attempt_release_and_replays(self):
        attempt = str(uuid.uuid4())
        for _ in range(2):
            self.assertEqual(self.claim("prepare", attempt), {"status": "prepared"})
        self.claim("status")
        for _ in range(2):
            self.assertEqual(self.claim("abort", attempt), {"status": "released"})
        self.assertEqual(self.claim("status"), {"status": "unbound"})
        self.reject(self.claim("prepare", attempt))
        self.reject(self.claim("commit", attempt))
        new = str(uuid.uuid4())
        self.assertEqual(self.claim("prepare", new, name="乙"), {"status": "prepared"})
        self.reject(self.claim("abort", attempt))
        self.assertEqual(self.claim("commit", new, name="乙"), {"status": "bound"})

    def test_strict_signed_schema(self):
        good = self.signed("prepare")
        for field, bad in (("op", "commit"), ("name", "乙"), ("team", "乙"),
                           ("launch_id", str(uuid.uuid4())),
                           ("attempt", str(uuid.uuid4())),
                           ("proof", good["proof"].upper()), ("proof", "f" * 64),
                           ("extra", True)):
            self.reject(self.exchange({**good, field: bad}))
        for op in ("prepare", "commit", "abort", "status"):
            req = self.signed(op)
            for field in req:
                self.reject(self.exchange({k: v for k, v in req.items() if k != field}))
            self.reject(self.exchange({**req, "proof": "0" * 64}))
        for bad in ("", " x", "x ", "x\0y", "z" * 257):
            for key in self.labels:
                self.reject(self.claim("prepare", **{key: bad}))
        self.reject(self.claim("prepare", "00000000-0000-1000-8000-000000000000"))
        self.reject(self.exchange({**self.signed("status"), **self.labels}))
        self.reject(self.exchange({**good, "name": "\ud800"}))
        self.reject(self.exchange({**good, "op": "status"}))
        self.assertEqual(self.claim("status"), {"status": "unbound"})
        self.assertEqual(self.claim("prepare", name="🍊" * 256, team="🍋" * 256),
                         {"status": "prepared"})

    def test_replaced_image_rejects_every_operation(self):
        attempt = str(uuid.uuid4())
        self.assertEqual(self.claim("prepare", attempt), {"status": "prepared"})
        self.command("replace")
        self.reader.readline()
        for op in ("prepare", "commit", "abort", "status"):
            self.reject(self.claim(op, attempt))
        self.reject(self.exchange(self.public("probe")))


class NamedTest(LauncherFixture):
    launcher_env = STALE

    def test_named_environment_and_public_protocol(self):
        self.assertIsNone(self.meta["defer"])
        self.assertIn("XATS_AGY_IDENTITY_KEY", self.meta["inherited"])
        self.assertIn("XATS_IDENTITY_KEY", self.meta["inherited"])
        self.assertEqual(self.ident["name"], "worker")
        self.assertEqual(self.ident["team"], "test")
        with self.send("probe") as sock:
            self.assertEqual(json.loads(sock.recv(1024)), {"status": "ready"})
        with self.send("probe", name="other") as sock:
            self.assertEqual(json.loads(sock.recv(1024)), {"status": "unavailable"})


class CliTest(unittest.TestCase):
    def cli(self, *args, key=b""):
        return subprocess.run([sys.executable, str(SCRIPTS / "xats-agy"), *args],
                              env={b"PATH": b"", b"XATS_AGY_IDENTITY_KEY": key},
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=3)

    def test_capability_without_key_terminal_or_agy(self):
        result = self.cli("--capabilities-json")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout),
                         {"defer_registration": 1, "agentapi_channel": 1})
        self.assertEqual(result.stderr, b"")

    def test_deferred_key_removed_from_launcher_environment(self):
        registration = runpy.run_path(str(SCRIPTS / "xats-agy"))["registration"]
        options = Namespace(name=None, team=None, defer_registration=True)
        for size in (16, 256):
            with patch.dict(os.environb, {b"XATS_AGY_IDENTITY_KEY": b"a" * size,
                                         b"XATS_IDENTITY_KEY": b"older"}, clear=True):
                _, binding = registration(options, None)
                self.assertTrue(binding.deferred)
                self.assertNotIn(b"XATS_AGY_IDENTITY_KEY", os.environb)
                self.assertNotIn(b"XATS_IDENTITY_KEY", os.environb)

    def test_invalid_key_and_option_combinations(self):
        for key in (b"", b"x" * 15, "界".encode() * 86, b"\xff" * 16):
            result = self.cli("--defer-registration", key=key)
            self.assertEqual(result.returncode, 2)
            self.assertIn(b"XATS_AGY_IDENTITY_KEY", result.stderr)
        for option in ("--name", "--team"):
            result = self.cli("--defer-registration", option, "value", key=KEY.encode())
            self.assertEqual(result.returncode, 2)
            self.assertIn(b"conflicts", result.stderr)


if __name__ == "__main__":
    unittest.main()
