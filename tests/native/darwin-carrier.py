import os
import pathlib
import pty
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
import uuid


class DarwinCarrierTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.codex = pathlib.Path(cls.directory.name, "codex")
        subprocess.run(
            ["/usr/bin/clang", "-x", "c", "-", "-o", cls.codex],
            input="#include <unistd.h>\nint main(void) { for (;;) pause(); }",
            text=True, check=True,
        )

    def carrier(self, executable, *args, proof=True):
        launch = str(uuid.uuid4())
        read_fd, write_fd = os.pipe()
        pid, master = pty.fork()
        if pid == 0:
            try:
                os.close(read_fd)
                os.write(write_fd, os.ttyname(0).encode())
                marker = f'xats.agent_id="{launch}"'
                options = ["--remote", "ws://localhost", "-c", marker] if proof else []
                argv = [marker if arg == "MARKER" else arg for arg in args]
                os.execv(executable, ["codex", *argv, *options])
            finally:
                os._exit(1)
        os.close(write_fd)
        self.addCleanup(os.close, master)

        def reap():
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)

        self.addCleanup(reap)
        with os.fdopen(read_fd, "r") as stream:
            tty = pathlib.Path(stream.read()).name
        script = "console.log(require(process.argv[1]).verify(" \
                 "process.argv[2], Number(process.argv[3]), process.argv[4]))"

        def verify():
            return subprocess.check_output(
                [NODE, "-e", script, ADDON, tty, str(pid), launch], text=True
            ).strip()
        return pid, verify

    def test_directory_named_app_server_and_stop(self):
        pid, verify = self.carrier(self.codex, "-C", "app-server")
        self.assertEqual(verify(), "ok")
        os.kill(pid, signal.SIGSTOP)
        os.waitpid(pid, os.WUNTRACED)
        self.assertEqual(verify(), "stale")

    def test_replaced_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            image = pathlib.Path(directory, "codex")
            shutil.copy2(self.codex, image)
            _, verify = self.carrier(image)
            self.assertEqual(verify(), "ok")
            image.unlink()
            shutil.copy2(self.codex, image)
            self.assertEqual(verify(), "ok")

    def test_server_subcommand(self):
        _, verify = self.carrier(self.codex, "--no-alt-screen", "app-server")
        self.assertEqual(verify(), "stale")

    def test_positional_remote(self):
        _, verify = self.carrier(self.codex, "-c", "MARKER", "--", "--remote",
                                 proof=False)
        self.assertEqual(verify(), "stale")

    def test_positional_marker(self):
        _, verify = self.carrier(self.codex, "--remote=ws://local", "MARKER",
                                 proof=False)
        self.assertEqual(verify(), "stale")

    def test_executable_identity(self):
        other = self.codex.with_name("other")
        shutil.copy2(self.codex, other)
        _, verify = self.carrier(other)
        self.assertEqual(verify(), "stale")


if __name__ == "__main__":
    NODE = shutil.which("node")
    ADDON = str(pathlib.Path(sys.argv.pop(1)).resolve())
    unittest.main()
