"""Own one SSH forwarding session and release it if its controller disappears.

Launched with `exec` by sshd, so its direct parent must be the user-owned
sshd child for this connection. It never inspects or terminates port owners.
"""
import os
import re
import select
import signal
import sys
import time


def parent_identity(pid):
    """Return a process birth marker only for our own immediate sshd parent."""
    try:
        if pid <= 1 or os.getppid() != pid:
            return None
        proc = '/proc/%d' % pid
        if os.stat(proc).st_uid != os.getuid():
            return None
        with open(proc + '/comm', encoding='ascii') as f:
            if f.read().strip() != 'sshd':
                return None
        with open(proc + '/stat', encoding='ascii') as f:
            stat = f.read()
        # After the final ')' come state (field 3) through starttime (22).
        return stat[stat.rfind(')') + 2:].split()[19]
    except (OSError, IndexError, ValueError):
        return None


def main():
    try:
        timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 45.0
        if not 1 <= timeout <= 600:
            raise ValueError('invalid timeout')
    except ValueError:
        return 2
    parent = os.getppid()
    birth = parent_identity(parent)
    if birth is None:
        # Do not operate if the process tree differs from the expected SSH tree.
        print('UNSAFE', flush=True)
        return 2
    deadline = time.monotonic() + timeout
    buffer = b''
    try:
        print('READY', flush=True)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([sys.stdin.fileno()], [], [], remaining)
            if not ready:
                break
            data = os.read(sys.stdin.fileno(), 4096)
            if not data:
                break
            buffer += data
            if len(buffer) > 8192:
                break
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                if not re.fullmatch(b'PING [0-9a-f]{24}', line):
                    continue
                deadline = time.monotonic() + timeout
                print('PONG ' + line[5:].decode('ascii'), flush=True)
    except (OSError, BrokenPipeError):
        pass
    finally:
        # sshd may otherwise keep remote-forward listeners alive for blocked
        # channels. Recheck identity and birth to rule out PID reuse/reparenting.
        if parent_identity(parent) == birth:
            try:
                os.kill(parent, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
