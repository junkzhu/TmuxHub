import os, pty, sys, json, base64, select, fcntl, termios, struct, signal, tty, time

cmd = json.loads(base64.b64decode(sys.argv[1]))
if cmd[0] == "ssh.exe":
    cmd[0] = "ssh"
if cmd[0] == "ssh" and len(cmd) > 2:
    # Remote scripts may be saved by a Windows editor; POSIX shells need LF.
    cmd[-1] = cmd[-1].replace("\r\n", "\n").replace("\r", "\n")
pid, fd = pty.fork()
if pid == 0:
    tty.setraw(sys.stdin.fileno())
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLORTERM"] = "truecolor"
    try:
        os.execvp(cmd[0], cmd)
    except OSError as error:
        print(str(error), file=sys.stderr, flush=True)
        os._exit(127)


class StopBridge(Exception):
    pass


def stop_bridge(_signal, _frame):
    raise StopBridge()


signal.signal(signal.SIGTERM, stop_bridge)
signal.signal(signal.SIGHUP, stop_bridge)

def size(rows, cols):
    rows, cols = max(1, min(1000, int(rows))), max(2, min(2000, int(cols)))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

stdin_fd = sys.stdin.fileno()
pending = b""
status = None
pty_ended = False
try:
    size(35, 110)
    while True:
        ready, _, _ = select.select([fd, stdin_fd], [], [])
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                pty_ended = True
                break
            if not data:
                pty_ended = True
                break
            print(json.dumps({"data": base64.b64encode(data).decode()}), flush=True)
        if stdin_fd in ready:
            chunk = os.read(stdin_fd, 65536)
            if not chunk:
                break
            pending += chunk
            # Drain every complete message, including coalesced key/resize events.
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(msg, dict):
                    continue
                if "data" in msg:
                    try:
                        data = base64.b64decode(msg["data"])
                    except (TypeError, ValueError):
                        continue
                    while data:
                        written = os.write(fd, data)
                        data = data[written:]
                if "cols" in msg:
                    try:
                        size(msg["rows"], msg["cols"])
                    except (TypeError, ValueError, KeyError):
                        continue
except (StopBridge, BrokenPipeError, OSError):
    pass
finally:
    # Preserve a naturally exiting SSH process's status (notably 255 for a lost
    # connection). On browser disconnect, close the PTY and reap the client only;
    # the tmux server has its own session and stays alive.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    def wait_for_child(timeout):
        deadline = time.monotonic() + timeout
        while True:
            child, child_status = os.waitpid(pid, os.WNOHANG)
            if child:
                return child_status
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.01)

    if pty_ended:
        status = wait_for_child(0.2)
    os.close(fd)
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
        if status is not None:
            break
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            pass
        status = wait_for_child(0.5)
    if status is None:
        _, status = os.waitpid(pid, 0)

exit_code = os.waitstatus_to_exitcode(status)
sys.exit(exit_code if exit_code >= 0 else 128 - exit_code)
