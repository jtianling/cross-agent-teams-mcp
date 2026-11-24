import fcntl
import json
import os
import select
import signal
import socket
import struct
import sys
import termios
import tty


def main():
    tty.setraw(0)
    with socket.socket(socket.AF_UNIX) as wire:
        wire.connect(sys.argv[1])
        meta = {k: os.environ.get("XATS_AGY_" + k.upper())
                for k in ("name", "team", "launch_id", "pid")}
        meta["defer"] = os.environ.get("XATS_AGY_DEFER_REGISTRATION")
        meta["inherited"] = [k for k in ("XATS_AGY_IDENTITY_KEY", "XATS_IDENTITY_KEY",
                                         "AGY_NAME", "AGY_TEAM") if k in os.environ]
        meta["argv"] = sys.argv[2:]
        meta["self"] = os.getpid()
        wire.sendall(json.dumps(meta).encode() + b"\n")
        control = wire.makefile("rb", buffering=0)
        while True:
            ready, _, _ = select.select([0, wire], [], [])
            if 0 in ready:
                wire.sendall(json.dumps(os.read(0, 65536).hex()).encode() + b"\n")
            if wire not in ready:
                continue
            line = control.readline()
            if not line:
                return 1
            cmd, *args = json.loads(line)
            if cmd == "paint":
                os.write(1, bytes.fromhex(args[0]))
            elif cmd == "size":
                size = fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))
                rows, cols, _, _ = struct.unpack("HHHH", size)
                wire.sendall(json.dumps([rows, cols]).encode() + b"\n")
            elif cmd == "replace":
                os.execv("/bin/cat", ["cat"])
            elif cmd in ("foreground", "same_group"):
                child = os.fork()
                if child == 0:
                    if cmd == "foreground":
                        os.setpgid(0, 0)
                    signal.pause()
                    os._exit(0)
                if cmd == "foreground":
                    os.setpgid(child, child)
                    os.tcsetpgrp(0, child)
                wire.sendall(b'"foreground"\n')
            elif cmd == "ignore_hup":
                signal.signal(signal.SIGHUP, signal.SIG_IGN)
                signal.signal(signal.SIGINT, signal.SIG_IGN)
                wire.sendall(b'"ignored"\n')
            elif cmd == "exit":
                os.write(1, b"last output\n")
                return 23


if __name__ == "__main__":
    sys.exit(main())
