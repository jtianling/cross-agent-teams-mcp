import json
import select
import subprocess
import time
import unittest

from test_xats_agy import FRAMES, QUIET, SCRIPTS, LauncherFixture


class DiagnoseTest(LauncherFixture):
    def run_diagnostic(self, name):
        return subprocess.run(
            [str(SCRIPTS / "xats-agy"), "--diagnose", self.ident["launch_id"],
             "--name", name, "--team", self.ident["team"]],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=3)

    def snapshot(self):
        result = self.run_diagnostic(self.ident["name"])
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(set(report), {"status", "current", "last_busy", "busy_count", "phase"})
        self.assertEqual(report["status"], "diagnostic")
        return report

    def test_read_only_cli_distinguishes_current_from_previous_refusal(self):
        self.paint(FRAMES["baseline"])
        time.sleep(QUIET + 0.06)
        first = self.snapshot()
        self.assertEqual(first["current"], "ready")
        self.assertEqual(first["busy_count"], 0)
        self.assertIsNone(first["last_busy"])
        self.paint(FRAMES["draft"])
        time.sleep(QUIET + 0.06)
        draft = self.snapshot()
        self.assertNotEqual(draft["current"], "ready")
        self.assertEqual(self.status(self.send("wake")), "busy")
        self.paint(FRAMES["clear"])
        time.sleep(QUIET + 0.06)
        cleared = self.snapshot()
        self.assertEqual(cleared["current"], "ready")
        self.assertEqual(cleared["last_busy"], draft["current"])
        self.assertEqual(cleared["busy_count"], 1)
        self.assertNotEqual(self.run_diagnostic("someone-else").returncode, 0)
        self.assertEqual(self.snapshot(), cleared)
        self.assertFalse(select.select([self.wire], [], [], 0)[0])


if __name__ == "__main__":
    unittest.main()
