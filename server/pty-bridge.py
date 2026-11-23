#!/usr/bin/env python3
"""
Lightweight zero-dependency PTY bridge for Nook Console.
- stdin: newline-delimited JSON control frames:
    {"t":"i","d":"<base64 bytes>"}   -> write to PTY master
    {"t":"r","c":120,"r":40}         -> resize PTY window (TIOCSWINSZ + SIGWINCH)
    {"t":"k","s":"TERM"|"KILL"|"INT"} -> signal child process group
- stdout: raw PTY byte stream (binary-safe, zero encoding overhead)
"""
import argparse
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd: int, rows: int, cols: int) -> None:
    rows = max(2, min(500, int(rows)))
    cols = max(10, min(500, int(cols)))
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
    except OSError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cols", type=int, default=100)
    parser.add_argument("--rows", type=int, default=30)
    parser.add_argument("--cwd", type=str, default="/root/.workspace")
    parser.add_argument("--cmd", type=str, default='["/bin/bash","-l"]')
    args = parser.parse_args()

    try:
        cmd = json.loads(args.cmd)
        if not isinstance(cmd, list) or not cmd or not all(isinstance(x, str) for x in cmd):
            cmd = ["/bin/bash", "-l"]
    except Exception:
        cmd = ["/bin/bash", "-l"]

    pid, master_fd = pty.fork()
    if pid == 0:
        try:
            if args.cwd and os.path.isdir(args.cwd):
                os.chdir(args.cwd)
        except OSError:
            pass
        os.environ.setdefault("TERM", "xterm-256color")
        os.environ.setdefault("COLORTERM", "truecolor")
        os.environ.setdefault("LANG", "C.UTF-8")
        try:
            os.execvp(cmd[0], cmd)
        except Exception as exc:
            sys.stderr.write(f"Failed to exec {cmd[0]}: {exc}\n")
            os._exit(127)

    set_winsize(master_fd, args.rows, args.cols)

    # Set non-blocking on master_fd and stdin
    for fd in (master_fd, sys.stdin.fileno()):
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def forward_shutdown(_signum, _frame):
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass

    signal.signal(signal.SIGTERM, forward_shutdown)
    signal.signal(signal.SIGINT, forward_shutdown)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_buf = b""
    stdin_open = True

    def write_all(fd: int, data: bytes) -> None:
        view = memoryview(data)
        total = 0
        while total < len(data):
            try:
                n = os.write(fd, view[total:])
                if n <= 0:
                    break
                total += n
            except BlockingIOError:
                select.select([], [fd], [], 0.05)
            except OSError:
                break

    def handle_control_line(line: bytes) -> None:
        line = line.strip()
        if not line:
            return
        try:
            msg = json.loads(line.decode("utf-8"))
        except Exception:
            return
        msg_type = msg.get("t")
        if msg_type == "i":
            raw_b64 = msg.get("d")
            if isinstance(raw_b64, str) and raw_b64:
                try:
                    data = base64.b64decode(raw_b64)
                    write_all(master_fd, data)
                except Exception:
                    pass
        elif msg_type == "r":
            cols = msg.get("c", 100)
            rows = msg.get("r", 30)
            set_winsize(master_fd, rows, cols)
            try:
                os.killpg(pid, signal.SIGWINCH)
            except OSError:
                pass
        elif msg_type == "k":
            sig_name = str(msg.get("s", "TERM")).upper()
            sig_map = {
                "INT": signal.SIGINT,
                "TERM": signal.SIGTERM,
                "KILL": signal.SIGKILL,
                "HUP": signal.SIGHUP,
            }
            sig = sig_map.get(sig_name, signal.SIGTERM)
            try:
                os.killpg(pid, sig)
            except OSError:
                pass

    exit_code = 0
    try:
        while True:
            read_fds = [master_fd]
            if stdin_open:
                read_fds.append(stdin_fd)
            try:
                rlist, _, _ = select.select(read_fds, [], [], 0.2)
            except InterruptedError:
                continue

            if master_fd in rlist:
                try:
                    chunk = os.read(master_fd, 16384)
                    if not chunk:
                        break
                    write_all(stdout_fd, chunk)
                except OSError as exc:
                    if exc.errno in (errno.EIO, errno.EBADF):
                        break
                    if exc.errno != errno.EAGAIN:
                        break

            if stdin_open and stdin_fd in rlist:
                try:
                    incoming = os.read(stdin_fd, 16384)
                    if not incoming:
                        stdin_open = False
                        try:
                            os.killpg(pid, signal.SIGHUP)
                        except OSError:
                            pass
                        break
                    stdin_buf += incoming
                    while b"\n" in stdin_buf:
                        line, stdin_buf = stdin_buf.split(b"\n", 1)
                        handle_control_line(line)
                except OSError as exc:
                    if exc.errno != errno.EAGAIN:
                        stdin_open = False

            # Check child status non-blocking
            try:
                wpid, status = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    # Drain any remaining buffered output on master_fd
                    while True:
                        try:
                            rem = os.read(master_fd, 16384)
                            if not rem:
                                break
                            write_all(stdout_fd, rem)
                        except OSError:
                            break
                    if os.WIFEXITED(status):
                        exit_code = os.WEXITSTATUS(status)
                    elif os.WIFSIGNALED(status):
                        exit_code = 128 + os.WTERMSIG(status)
                    else:
                        exit_code = 0
                    break
            except ChildProcessError:
                break
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid == 0:
                try:
                    os.killpg(pid, signal.SIGTERM)
                except OSError:
                    pass
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
            elif wpid == pid:
                if os.WIFEXITED(status):
                    exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    exit_code = 128 + os.WTERMSIG(status)
        except ChildProcessError:
            pass

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
